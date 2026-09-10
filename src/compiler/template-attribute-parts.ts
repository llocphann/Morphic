import type {
	AttributeExpressionPart,
	AttributeSlot,
	AttributeStaticPart,
	AttributeValuePart,
	SetNode,
	TemplateIRNode,
} from "./template-ir";

interface TemplateExpressionMatch {
	readonly start: number;
	readonly end: number;
}

interface TemplateMaskRange {
	readonly start: number;
	readonly end: number;
}

interface AttributeValueRange {
	readonly attribute: string;
	readonly targetKey: string;
	readonly quote: "\"" | "'" | null;
	readonly valueStart: number;
	readonly valueEnd: number;
}

interface LocalAttributeStart {
	readonly quote: "\"" | "'" | null;
	readonly valueStart: number;
}

interface LocalAttributeAssembly {
	readonly slot: AttributeSlot;
	readonly before: string;
	readonly after: string;
	readonly endIndex: number;
}

const TEMPLATE_EXPR_RE = /\{\{((?:[^{}]|\{[^{]|\}[^}])*?)\}\}/g;
const LOGIC_TAG_RE = /\{%\s*([\s\S]*?)\s*%\}/g;
const SET_TAG_RE = /\{%\s*set\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*([\s\S]*?)\s*%\}/g;

/**
 * Correct expression-slot HTML attribute context using a source mask that treats
 * template syntax as opaque bytes while preserving exact source offsets.
 *
 * The strict parser historically used raw `<` / `>` delimiters around earlier
 * interpolation source. Expressions such as `{{score>10}}` could therefore make
 * a later interpolation on the same start tag look like text instead of an
 * AttributeSlot. Production compatibility compilation normalizes that context
 * before complete attribute assembly without changing expression ASTs or source
 * bytes retained in static parts.
 */
export function normalizeAttributeSlotContexts(
	source: string,
	nodes: readonly TemplateIRNode[],
): readonly TemplateIRNode[] {
	const bodySource = stripSetPrelude(source);
	const matches = collectExpressionMatches(bodySource);
	const expressionNodes: ExpressionBackedNode[] = [];
	collectExpressionNodes(nodes, expressionNodes);
	if (matches.length === 0 || matches.length !== expressionNodes.length) return nodes;

	const maskedSource = maskTemplateSyntax(bodySource);
	const contexts = new Map<string, AttributeValueRange>();
	for (let index = 0; index < matches.length; index++) {
		const match = matches[index];
		const range = detectAttributeValueRange(maskedSource, match.start, match.end);
		if (range) contexts.set(expressionNodes[index].id, range);
	}
	if (contexts.size === 0) return nodes;

	return rewriteAttributeContexts(nodes, contexts);
}

/**
 * Enrich flat AttributeSlot nodes with the complete source-order attribute value.
 *
 * The legacy renderer resolves every interpolation first and then parses the
 * resulting HTML string. Retained rendering therefore needs more than one
 * expression: it needs the exact static source around every dynamic expression,
 * the original quoting mode, and one stable target key for the receiving element.
 *
 * Structural control flow deliberately stays untouched here. A separate node-list
 * pass can enrich branch/loop-local attributes only when their complete value is
 * visible inside one structural child list.
 */
export function assembleFlatAttributeParts(
	source: string,
	nodes: readonly TemplateIRNode[],
): TemplateIRNode[] {
	const setNodes = nodes.filter((node): node is SetNode => node.kind === "set");
	const bodyNodes = nodes.filter((node) => node.kind !== "set");
	if (containsStructuralControlFlow(bodyNodes)) return [...nodes];

	const bodySource = stripSetPrelude(source);
	const maskedBodySource = maskTemplateSyntax(bodySource);
	const matches = collectExpressionMatches(bodySource);
	const expressionNodes = bodyNodes.filter(isExpressionBackedNode);
	if (matches.length === 0 || matches.length !== expressionNodes.length) return [...nodes];
	if (!expressionNodes.some((node) => node.kind === "attribute-slot")) return [...nodes];

	const rebuilt: TemplateIRNode[] = [...setNodes];
	let cursor = 0;
	let matchIndex = 0;

	while (matchIndex < matches.length) {
		const match = matches[matchIndex];
		const node = expressionNodes[matchIndex];
		if (node.kind !== "attribute-slot") {
			pushStatic(rebuilt, bodySource.slice(cursor, match.start));
			rebuilt.push(node);
			cursor = match.end;
			matchIndex += 1;
			continue;
		}

		const range = detectAttributeValueRange(maskedBodySource, match.start, match.end);
		if (!range || range.attribute !== node.attribute || range.targetKey !== node.targetKey) {
			pushStatic(rebuilt, bodySource.slice(cursor, match.start));
			rebuilt.push(node);
			cursor = match.end;
			matchIndex += 1;
			continue;
		}

		const groupEnd = findAttributeGroupEnd(
			matches,
			expressionNodes,
			matchIndex,
			range,
			maskedBodySource,
		);
		pushStatic(rebuilt, bodySource.slice(cursor, range.valueStart));
		rebuilt.push(buildAssembledAttributeSlot(
			bodySource,
			matches,
			expressionNodes,
			matchIndex,
			groupEnd,
			range,
		));
		cursor = range.valueEnd;
		matchIndex = groupEnd;
	}

	pushStatic(rebuilt, bodySource.slice(cursor));
	return rebuilt;
}

/**
 * Enrich AttributeSlot values inside structural child lists without reparsing
 * branch/loop source or crossing a structural boundary.
 *
 * Each child list retains the exact static source immediately around its dynamic
 * nodes. That is sufficient to reconstruct an attribute only when the opening
 * value prefix, every interpolation, and the closing delimiter all live in the
 * same list. If a nested if/for splits an attribute value, the slot remains
 * deliberately incomplete so production capability checks continue to fall back.
 */
export function assembleStructuralAttributeParts(
	nodes: readonly TemplateIRNode[],
): readonly TemplateIRNode[] {
	if (!containsStructuralControlFlow(nodes)) return nodes;
	return assembleStructuralNodeList(nodes);
}

function collectExpressionNodes(
	nodes: readonly TemplateIRNode[],
	result: ExpressionBackedNode[],
): void {
	for (const node of nodes) {
		if (isExpressionBackedNode(node)) {
			result.push(node);
			continue;
		}
		if (node.kind === "if") {
			for (const branch of node.branches) collectExpressionNodes(branch.children, result);
			continue;
		}
		if (node.kind === "for") collectExpressionNodes(node.children, result);
	}
}

function rewriteAttributeContexts(
	nodes: readonly TemplateIRNode[],
	contexts: ReadonlyMap<string, AttributeValueRange>,
): TemplateIRNode[] {
	return nodes.map((node): TemplateIRNode => {
		if (isExpressionBackedNode(node)) {
			const range = contexts.get(node.id);
			if (!range) return node;
			if (
				node.kind === "attribute-slot"
				&& node.attribute === range.attribute
				&& node.targetKey === range.targetKey
			) {
				return node;
			}
			return {
				kind: "attribute-slot",
				id: node.id,
				expression: node.expression,
				attribute: range.attribute,
				targetKey: range.targetKey,
			};
		}
		if (node.kind === "if") {
			return {
				...node,
				branches: node.branches.map((branch) => ({
					...branch,
					children: rewriteAttributeContexts(branch.children, contexts),
				})),
			};
		}
		if (node.kind === "for") {
			return {
				...node,
				children: rewriteAttributeContexts(node.children, contexts),
			};
		}
		return node;
	});
}

function assembleStructuralNodeList(nodes: readonly TemplateIRNode[]): TemplateIRNode[] {
	const nested = nodes.map((node): TemplateIRNode => {
		if (node.kind === "if") {
			return {
				...node,
				branches: node.branches.map((branch) => ({
					...branch,
					children: assembleStructuralNodeList(branch.children),
				})),
			};
		}
		if (node.kind === "for") {
			return {
				...node,
				children: assembleStructuralNodeList(node.children),
			};
		}
		return node;
	});

	return assembleLocalAttributeParts(nested);
}

function assembleLocalAttributeParts(nodes: readonly TemplateIRNode[]): TemplateIRNode[] {
	const rebuilt: TemplateIRNode[] = [];

	for (let index = 0; index < nodes.length; index++) {
		const node = nodes[index];
		if (node.kind !== "attribute-slot" || node.parts) {
			rebuilt.push(node);
			continue;
		}

		const previous = rebuilt[rebuilt.length - 1];
		if (!previous || previous.kind !== "static-fragment") {
			rebuilt.push(node);
			continue;
		}

		const assembly = tryAssembleLocalAttribute(nodes, index, previous.html);
		if (!assembly) {
			rebuilt.push(node);
			continue;
		}

		if (assembly.before) {
			rebuilt[rebuilt.length - 1] = { kind: "static-fragment", html: assembly.before };
		} else {
			rebuilt.pop();
		}
		rebuilt.push(assembly.slot);
		pushStatic(rebuilt, assembly.after);
		index = assembly.endIndex;
	}

	return rebuilt;
}

function tryAssembleLocalAttribute(
	nodes: readonly TemplateIRNode[],
	startIndex: number,
	previousHtml: string,
): LocalAttributeAssembly | null {
	const first = nodes[startIndex];
	if (first.kind !== "attribute-slot" || first.parts) return null;

	const start = detectLocalAttributeStart(previousHtml, first.attribute);
	if (!start) return null;

	const parts: AttributeValuePart[] = [];
	pushAttributeStatic(parts, previousHtml.slice(start.valueStart));

	let index = startIndex;
	while (index < nodes.length) {
		const current = nodes[index];
		if (
			current.kind !== "attribute-slot"
			|| current.parts
			|| current.attribute !== first.attribute
			|| current.targetKey !== first.targetKey
		) {
			return null;
		}

		parts.push({ kind: "expression", expression: current.expression });

		const next = nodes[index + 1];
		if (!next) return null;
		if (next.kind === "attribute-slot") {
			index += 1;
			continue;
		}
		if (next.kind !== "static-fragment") return null;

		const closeIndex = findLocalAttributeClose(next.html, start.quote);
		if (closeIndex >= 0) {
			pushAttributeStatic(parts, next.html.slice(0, closeIndex));
			return {
				slot: {
					kind: "attribute-slot",
					id: first.id,
					expression: first.expression,
					attribute: first.attribute,
					targetKey: first.targetKey,
					quote: start.quote,
					parts,
				},
				before: previousHtml.slice(0, start.valueStart),
				after: next.html.slice(closeIndex),
				endIndex: index + 1,
			};
		}

		pushAttributeStatic(parts, next.html);
		const following = nodes[index + 2];
		if (!following || following.kind !== "attribute-slot") return null;
		index += 2;
	}

	return null;
}

function detectLocalAttributeStart(html: string, attribute: string): LocalAttributeStart | null {
	const doubleQuoted = html.match(/([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*"([^"]*)$/);
	if (doubleQuoted?.[1] === attribute) {
		return {
			quote: '"',
			valueStart: html.length - doubleQuoted[2].length,
		};
	}

	const singleQuoted = html.match(/([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*'([^']*)$/);
	if (singleQuoted?.[1] === attribute) {
		return {
			quote: "'",
			valueStart: html.length - singleQuoted[2].length,
		};
	}

	const unquoted = html.match(/([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*([^\s"'=<>`]*)$/);
	if (unquoted?.[1] !== attribute) return null;
	return {
		quote: null,
		valueStart: html.length - unquoted[2].length,
	};
}

function findLocalAttributeClose(html: string, quote: "\"" | "'" | null): number {
	if (quote) return html.indexOf(quote);
	for (let index = 0; index < html.length; index++) {
		if (/\s|>/.test(html[index])) return index;
	}
	return -1;
}

function buildAssembledAttributeSlot(
	source: string,
	matches: readonly TemplateExpressionMatch[],
	nodes: readonly ExpressionBackedNode[],
	startIndex: number,
	endIndex: number,
	range: AttributeValueRange,
): AttributeSlot {
	const first = nodes[startIndex];
	if (first.kind !== "attribute-slot") {
		throw new Error("Expected attribute slot at assembled attribute start");
	}

	const parts: AttributeValuePart[] = [];
	let cursor = range.valueStart;
	for (let index = startIndex; index < endIndex; index++) {
		const match = matches[index];
		const node = nodes[index];
		if (node.kind !== "attribute-slot") break;
		pushAttributeStatic(parts, source.slice(cursor, match.start));
		const expressionPart: AttributeExpressionPart = {
			kind: "expression",
			expression: node.expression,
		};
		parts.push(expressionPart);
		cursor = match.end;
	}
	pushAttributeStatic(parts, source.slice(cursor, range.valueEnd));

	return {
		kind: "attribute-slot",
		id: first.id,
		// Compatibility field retained for existing consumers. `parts` is the
		// authoritative complete attribute assembly contract.
		expression: first.expression,
		attribute: range.attribute,
		targetKey: range.targetKey,
		quote: range.quote,
		parts,
	};
}

function findAttributeGroupEnd(
	matches: readonly TemplateExpressionMatch[],
	nodes: readonly ExpressionBackedNode[],
	startIndex: number,
	range: AttributeValueRange,
	source: string,
): number {
	let index = startIndex + 1;
	while (index < matches.length && matches[index].start < range.valueEnd) {
		const node = nodes[index];
		if (node.kind !== "attribute-slot") break;
		const nextRange = detectAttributeValueRange(source, matches[index].start, matches[index].end);
		if (!sameAttributeRange(range, nextRange)) break;
		index += 1;
	}
	return index;
}

function detectAttributeValueRange(
	source: string,
	expressionStart: number,
	expressionEnd: number,
): AttributeValueRange | null {
	const tagStart = source.lastIndexOf("<", expressionStart);
	const tagEnd = source.lastIndexOf(">", expressionStart);
	if (tagStart < 0 || tagStart < tagEnd) return null;
	if (source.slice(tagStart, expressionStart).startsWith("<!--")) return null;

	const prefix = source.slice(tagStart, expressionStart);
	const doubleQuoted = prefix.match(/([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*"([^"]*)$/);
	if (doubleQuoted) {
		const valueEnd = source.indexOf('"', expressionEnd);
		if (valueEnd < 0) return null;
		return {
			attribute: doubleQuoted[1],
			targetKey: `element-${tagStart}`,
			quote: '"',
			valueStart: expressionStart - doubleQuoted[2].length,
			valueEnd,
		};
	}

	const singleQuoted = prefix.match(/([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*'([^']*)$/);
	if (singleQuoted) {
		const valueEnd = source.indexOf("'", expressionEnd);
		if (valueEnd < 0) return null;
		return {
			attribute: singleQuoted[1],
			targetKey: `element-${tagStart}`,
			quote: "'",
			valueStart: expressionStart - singleQuoted[2].length,
			valueEnd,
		};
	}

	const unquoted = prefix.match(/([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*([^\s"'=<>`]*)$/);
	if (!unquoted) return null;
	let valueEnd = expressionEnd;
	while (valueEnd < source.length && !/[\s>]/.test(source[valueEnd])) valueEnd += 1;
	return {
		attribute: unquoted[1],
		targetKey: `element-${tagStart}`,
		quote: null,
		valueStart: expressionStart - unquoted[2].length,
		valueEnd,
	};
}

function collectExpressionMatches(source: string): TemplateExpressionMatch[] {
	const matches: TemplateExpressionMatch[] = [];
	TEMPLATE_EXPR_RE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = TEMPLATE_EXPR_RE.exec(source)) !== null) {
		matches.push({ start: match.index, end: match.index + match[0].length });
	}
	TEMPLATE_EXPR_RE.lastIndex = 0;
	return matches;
}

function maskTemplateSyntax(source: string): string {
	const ranges: TemplateMaskRange[] = [];
	collectMaskRanges(source, TEMPLATE_EXPR_RE, ranges);
	collectMaskRanges(source, LOGIC_TAG_RE, ranges);
	if (ranges.length === 0) return source;
	ranges.sort((left, right) => left.start - right.start || left.end - right.end);

	let masked = "";
	let cursor = 0;
	for (const range of ranges) {
		if (range.start < cursor) continue;
		masked += source.slice(cursor, range.start);
		masked += "x".repeat(range.end - range.start);
		cursor = range.end;
	}
	masked += source.slice(cursor);
	return masked;
}

function collectMaskRanges(
	source: string,
	regex: RegExp,
	ranges: TemplateMaskRange[],
): void {
	regex.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = regex.exec(source)) !== null) {
		ranges.push({ start: match.index, end: match.index + match[0].length });
	}
	regex.lastIndex = 0;
}

function stripSetPrelude(source: string): string {
	SET_TAG_RE.lastIndex = 0;
	const stripped = source.replace(SET_TAG_RE, "");
	SET_TAG_RE.lastIndex = 0;
	return stripped;
}

type ExpressionBackedNode = Extract<TemplateIRNode, {
	kind: "text-slot" | "attribute-slot" | "markdown-slot" | "content-slot" | "raw-html-slot" | "expression-slot";
}>;

function isExpressionBackedNode(node: TemplateIRNode): node is ExpressionBackedNode {
	return node.kind === "text-slot"
		|| node.kind === "attribute-slot"
		|| node.kind === "markdown-slot"
		|| node.kind === "content-slot"
		|| node.kind === "raw-html-slot"
		|| node.kind === "expression-slot";
}

function containsStructuralControlFlow(nodes: readonly TemplateIRNode[]): boolean {
	return nodes.some((node) => node.kind === "if" || node.kind === "for");
}

function sameAttributeRange(
	left: AttributeValueRange,
	right: AttributeValueRange | null,
): boolean {
	return !!right
		&& left.attribute === right.attribute
		&& left.targetKey === right.targetKey
		&& left.quote === right.quote
		&& left.valueStart === right.valueStart
		&& left.valueEnd === right.valueEnd;
}

function pushStatic(nodes: TemplateIRNode[], html: string): void {
	if (html) nodes.push({ kind: "static-fragment", html });
}

function pushAttributeStatic(parts: AttributeValuePart[], value: string): void {
	if (!value) return;
	const part: AttributeStaticPart = {
		kind: "static",
		value,
		encoding: "html-attribute-source",
	};
	parts.push(part);
}