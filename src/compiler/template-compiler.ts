import {
	compileExpression,
	type CompiledExpression,
	type ExpressionVolatility,
	type StaticDependencyHints,
} from "./expression-compiler";
import type {
	AttributeSlot,
	ContentSlot,
	ExpressionSlot,
	ForNode,
	IfBranch,
	IfNode,
	MarkdownSlot,
	RawHtmlSlot,
	SetNode,
	StaticFragment,
	TemplateIR,
	TemplateIRNode,
	TextSlot,
} from "./template-ir";

interface TemplateToken {
	readonly kind: "expression" | "logic";
	readonly start: number;
	readonly end: number;
	readonly raw: string;
	readonly content: string;
}

interface ParseStop {
	readonly kind: "elif" | "else" | "endif" | "endfor";
	readonly expression?: string;
}

interface ParseResult {
	readonly nodes: TemplateIRNode[];
	readonly stop: ParseStop | null;
}

interface AttributeContext {
	readonly attribute: string;
	readonly targetKey: string;
}

interface MutableHints {
	candidateSelfProperties: Set<string>;
	usesSelfMetadata: boolean;
	usesSelfContent: boolean;
	staticLinkedFileTargets: Set<string>;
	usesDynamicLinkedFile: boolean;
	usesLinkedMetadata: boolean;
	usesLinkedContent: boolean;
	usesBases: boolean;
	volatility: Set<ExpressionVolatility>;
}

const TEMPLATE_EXPR_RE = /\{\{((?:[^{}]|\{[^{]|\}[^}])*?)\}\}/g;
const LOGIC_TAG_RE = /\{%\s*([\s\S]*?)\s*%\}/g;
const SET_TAG_RE = /\{%\s*set\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*([\s\S]*?)\s*%\}/g;
const SIMPLE_TEXT_EXPRESSION_RE = /^[a-zA-Z_][a-zA-Z0-9_-]*(?:\.[a-zA-Z_][a-zA-Z0-9_-]*|\[\d+\])*$/;
const MARKDOWN_FILTERS = new Set([
	"blockquote",
	"callout",
	"footnote",
	"fragment_link",
	"image",
	"link",
	"markdown",
	"table",
	"wikilink",
]);

/** Error surfaced when invariant template syntax cannot be compiled safely. */
export class TemplateCompileError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TemplateCompileError";
	}
}

/**
 * Compile invariant template syntax once into renderer-facing typed IR.
 *
 * This compiler deliberately does not build DOM. It records rendering context,
 * compiled expressions, structured control flow, and conservative dependencies.
 */
export function compileTemplate(source: string): TemplateIR {
	const hints = createMutableHints();
	const prelude = extractSetPrelude(source, hints);
	const parser = new TemplateParser(prelude.template, hints, prelude.variables);
	const parsed = parser.parse();

	return {
		version: 1,
		sourceHash: hashTemplateSource(source),
		nodes: [...prelude.nodes, ...parsed],
		dependencyHints: freezeHints(hints),
	};
}

class TemplateParser {
	private readonly tokens: TemplateToken[];
	private tokenIndex = 0;
	private sourcePosition = 0;
	private slotSequence = 0;

	constructor(
		private readonly source: string,
		private readonly hints: MutableHints,
		private readonly rootVariables: ReadonlySet<string>,
	) {
		this.tokens = tokenizeTemplate(source);
	}

	parse(): TemplateIRNode[] {
		const result = this.parseNodes(new Set(), new Set(this.rootVariables));
		if (result.stop) {
			throw new TemplateCompileError(`Unexpected template tag: ${result.stop.kind}`);
		}
		return result.nodes;
	}

	private parseNodes(stops: ReadonlySet<ParseStop["kind"]>, scope: Set<string>): ParseResult {
		const nodes: TemplateIRNode[] = [];

		while (this.tokenIndex < this.tokens.length) {
			const token = this.tokens[this.tokenIndex];
			this.pushStatic(nodes, this.sourcePosition, token.start);
			this.tokenIndex++;
			this.sourcePosition = token.end;

			if (token.kind === "expression") {
				nodes.push(this.compileSlot(token, scope));
				continue;
			}

			const directive = parseDirective(token.content);
			if (directive.stop && stops.has(directive.stop.kind)) {
				return { nodes, stop: directive.stop };
			}

			if (directive.ifExpression !== null) {
				nodes.push(this.parseIf(directive.ifExpression, scope));
				continue;
			}

			if (directive.forBinding) {
				nodes.push(this.parseFor(directive.forBinding.variable, directive.forBinding.expression, scope));
				continue;
			}

			if (directive.stop) {
				throw new TemplateCompileError(`Unexpected template tag: ${directive.stop.kind}`);
			}

			// Unknown logic tags remain literal during migration rather than silently
			// deleting user-authored content or inventing new semantics.
			nodes.push({ kind: "static-fragment", html: token.raw });
		}

		this.pushStatic(nodes, this.sourcePosition, this.source.length);
		this.sourcePosition = this.source.length;
		return { nodes, stop: null };
	}

	private parseIf(conditionSource: string, scope: Set<string>): IfNode {
		const branches: IfBranch[] = [];
		let condition: CompiledExpression | null = this.compileScopedExpression(conditionSource, scope);

		while (true) {
			const branch = this.parseNodes(new Set(["elif", "else", "endif"]), new Set(scope));
			branches.push({ condition, children: branch.nodes });

			if (!branch.stop) {
				throw new TemplateCompileError("Unclosed {% if %} block");
			}
			if (branch.stop.kind === "endif") break;

			if (branch.stop.kind === "elif") {
				condition = this.compileScopedExpression(branch.stop.expression ?? "", scope);
				continue;
			}

			const elseBranch = this.parseNodes(new Set(["endif"]), new Set(scope));
			branches.push({ condition: null, children: elseBranch.nodes });
			if (elseBranch.stop?.kind !== "endif") {
				throw new TemplateCompileError("Unclosed {% if %} block after {% else %}");
			}
			break;
		}

		return { kind: "if", branches };
	}

	private parseFor(variable: string, expressionSource: string, scope: Set<string>): ForNode {
		const iterable = this.compileScopedExpression(expressionSource, scope);
		const loopScope = new Set(scope);
		loopScope.add(variable);
		loopScope.add("loop");

		const body = this.parseNodes(new Set(["endfor"]), loopScope);
		if (body.stop?.kind !== "endfor") {
			throw new TemplateCompileError("Unclosed {% for %} block");
		}

		return {
			kind: "for",
			iterable,
			itemVariable: variable,
			children: body.nodes,
		};
	}

	private compileSlot(token: TemplateToken, scope: Set<string>): TemplateIRNode {
		const expression = this.compileScopedExpression(token.content.trim(), scope);
		const id = `slot-${this.slotSequence++}`;
		const attributeContext = detectAttributeContext(this.source, token.start);

		if (attributeContext) {
			const slot: AttributeSlot = {
				kind: "attribute-slot",
				id,
				expression,
				attribute: attributeContext.attribute,
				targetKey: attributeContext.targetKey,
			};
			return slot;
		}

		if (isUnfilteredContentExpression(expression)) {
			const slot: ContentSlot = { kind: "content-slot", id, expression };
			return slot;
		}

		if (isExplicitRawHtmlExpression(expression)) {
			const slot: RawHtmlSlot = {
				kind: "raw-html-slot",
				id,
				expression,
				explicitRawHtml: true,
			};
			return slot;
		}

		if (isMarkdownExpression(expression)) {
			const slot: MarkdownSlot = { kind: "markdown-slot", id, expression };
			return slot;
		}

		if (SIMPLE_TEXT_EXPRESSION_RE.test(expression.expressionSource) && !expression.pipeFilters) {
			const slot: TextSlot = { kind: "text-slot", id, expression };
			return slot;
		}

		const slot: ExpressionSlot = {
			kind: "expression-slot",
			id,
			expression,
			context: "text",
		};
		return slot;
	}

	private compileScopedExpression(source: string, scope: ReadonlySet<string>): CompiledExpression {
		const trimmed = source.trim();
		if (!trimmed) throw new TemplateCompileError("Template expression cannot be empty");

		try {
			const compiled = compileExpression(trimmed);
			mergeHints(this.hints, compiled.dependencyHints, scope);
			return compiled;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new TemplateCompileError(`Cannot compile expression '${trimmed}': ${message}`);
		}
	}

	private pushStatic(nodes: TemplateIRNode[], start: number, end: number): void {
		if (end <= start) return;
		const html = this.source.slice(start, end);
		if (!html) return;
		const fragment: StaticFragment = { kind: "static-fragment", html };
		nodes.push(fragment);
	}
}

function extractSetPrelude(source: string, hints: MutableHints): {
	template: string;
	nodes: SetNode[];
	variables: Set<string>;
} {
	const nodes: SetNode[] = [];
	const variables = new Set<string>();
	let result = "";
	let cursor = 0;
	let match: RegExpExecArray | null;
	SET_TAG_RE.lastIndex = 0;

	while ((match = SET_TAG_RE.exec(source)) !== null) {
		result += source.slice(cursor, match.index);
		cursor = match.index + match[0].length;

		const variable = match[1];
		const expressionSource = match[2].trim();
		const expression = compileSetExpression(expressionSource);
		mergeHints(hints, expression.dependencyHints, variables);
		nodes.push({ kind: "set", variable, expression });
		variables.add(variable);
	}
	SET_TAG_RE.lastIndex = 0;
	result += source.slice(cursor);

	return { template: result, nodes, variables };
}

function compileSetExpression(source: string): CompiledExpression {
	try {
		return compileExpression(source);
	} catch {
		// Legacy `{% set %}` falls back to the literal expression text when parsing
		// fails. Compile that fallback as a string literal so the IR preserves it.
		return compileExpression(JSON.stringify(source));
	}
}

function tokenizeTemplate(source: string): TemplateToken[] {
	const tokens: TemplateToken[] = [];
	collectTokens(source, TEMPLATE_EXPR_RE, "expression", tokens);
	collectTokens(source, LOGIC_TAG_RE, "logic", tokens);
	tokens.sort((a, b) => a.start - b.start || a.end - b.end);
	return tokens;
}

function collectTokens(
	source: string,
	regex: RegExp,
	kind: TemplateToken["kind"],
	tokens: TemplateToken[],
): void {
	regex.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = regex.exec(source)) !== null) {
		tokens.push({
			kind,
			start: match.index,
			end: match.index + match[0].length,
			raw: match[0],
			content: match[1],
		});
	}
	regex.lastIndex = 0;
}

function parseDirective(content: string): {
	stop: ParseStop | null;
	ifExpression: string | null;
	forBinding: { variable: string; expression: string } | null;
} {
	const trimmed = content.trim();
	const ifMatch = trimmed.match(/^if\s+([\s\S]+)$/);
	if (ifMatch) return { stop: null, ifExpression: ifMatch[1].trim(), forBinding: null };

	const elifMatch = trimmed.match(/^elif\s+([\s\S]+)$/);
	if (elifMatch) {
		return {
			stop: { kind: "elif", expression: elifMatch[1].trim() },
			ifExpression: null,
			forBinding: null,
		};
	}
	if (trimmed === "else") return { stop: { kind: "else" }, ifExpression: null, forBinding: null };
	if (trimmed === "endif") return { stop: { kind: "endif" }, ifExpression: null, forBinding: null };
	if (trimmed === "endfor") return { stop: { kind: "endfor" }, ifExpression: null, forBinding: null };

	const forMatch = trimmed.match(/^for\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+in\s+([\s\S]+)$/);
	if (forMatch) {
		return {
			stop: null,
			ifExpression: null,
			forBinding: { variable: forMatch[1], expression: forMatch[2].trim() },
		};
	}

	return { stop: null, ifExpression: null, forBinding: null };
}

function detectAttributeContext(source: string, offset: number): AttributeContext | null {
	const tagStart = source.lastIndexOf("<", offset);
	const tagEnd = source.lastIndexOf(">", offset);
	if (tagStart < 0 || tagStart < tagEnd) return null;

	const prefix = source.slice(tagStart, offset);
	const doubleQuoted = prefix.match(/([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*"[^"]*$/);
	const singleQuoted = prefix.match(/([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*'[^']*$/);
	const unquoted = prefix.match(/([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*[^\s"'=<>`]*$/);
	const match = doubleQuoted ?? singleQuoted ?? unquoted;
	if (!match) return null;

	return {
		attribute: match[1],
		targetKey: `element-${tagStart}`,
	};
}

function isUnfilteredContentExpression(expression: CompiledExpression): boolean {
	return !expression.pipeFilters
		&& (expression.expressionSource === "content" || expression.expressionSource === "file.content");
}

function isExplicitRawHtmlExpression(expression: CompiledExpression): boolean {
	return /^html\s*\(/.test(expression.expressionSource);
}

function isMarkdownExpression(expression: CompiledExpression): boolean {
	if (/^(?:link|image)\s*\(/.test(expression.expressionSource)) return true;
	return expression.filterPipeline?.steps.some((step) => MARKDOWN_FILTERS.has(step.name)) ?? false;
}

function createMutableHints(): MutableHints {
	return {
		candidateSelfProperties: new Set(),
		usesSelfMetadata: false,
		usesSelfContent: false,
		staticLinkedFileTargets: new Set(),
		usesDynamicLinkedFile: false,
		usesLinkedMetadata: false,
		usesLinkedContent: false,
		usesBases: false,
		volatility: new Set(),
	};
}

function mergeHints(
	target: MutableHints,
	source: StaticDependencyHints,
	scope: ReadonlySet<string>,
): void {
	for (const property of source.candidateSelfProperties) {
		if (!scope.has(property)) target.candidateSelfProperties.add(property);
	}
	for (const linked of source.staticLinkedFileTargets) target.staticLinkedFileTargets.add(linked);
	for (const volatility of source.volatility) target.volatility.add(volatility);
	target.usesSelfMetadata ||= source.usesSelfMetadata;
	target.usesSelfContent ||= source.usesSelfContent;
	target.usesDynamicLinkedFile ||= source.usesDynamicLinkedFile;
	target.usesLinkedMetadata ||= source.usesLinkedMetadata;
	target.usesLinkedContent ||= source.usesLinkedContent;
	target.usesBases ||= source.usesBases;
}

function freezeHints(hints: MutableHints): StaticDependencyHints {
	return {
		candidateSelfProperties: [...hints.candidateSelfProperties].sort(),
		usesSelfMetadata: hints.usesSelfMetadata,
		usesSelfContent: hints.usesSelfContent,
		staticLinkedFileTargets: [...hints.staticLinkedFileTargets].sort(),
		usesDynamicLinkedFile: hints.usesDynamicLinkedFile,
		usesLinkedMetadata: hints.usesLinkedMetadata,
		usesLinkedContent: hints.usesLinkedContent,
		usesBases: hints.usesBases,
		volatility: [...hints.volatility].sort(),
	};
}

function hashTemplateSource(source: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < source.length; i++) {
		hash ^= source.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
