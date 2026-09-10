import type {
	RetainedDomRuntime,
	RetainedStructureBuilder,
	RetainedStructureContext,
} from "./retained-slot-runtime";

/**
 * Structural subset of Bot 2's TemplateIR contract consumed by the DOM adapter.
 *
 * The renderer intentionally depends on this structural shape instead of the
 * compiler module itself. Once the compiler stack lands, its TemplateIR is
 * assignable to this contract without Bot 4 duplicating parser/evaluator code.
 */
export interface RetainedTemplateIrLike<E = unknown> {
	readonly version: number;
	readonly sourceHash: string;
	readonly nodes: readonly RetainedTemplateIrNode<E>[];
}

export interface RetainedTemplateStaticFragment {
	readonly kind: "static-fragment";
	readonly html: string;
}

export interface RetainedTemplateExpressionSlot<E> {
	readonly kind: "text-slot" | "markdown-slot" | "content-slot" | "raw-html-slot";
	readonly id: string;
	readonly expression: E;
}

export interface RetainedTemplateContextExpressionSlot<E> {
	readonly kind: "expression-slot";
	readonly id: string;
	readonly expression: E;
	readonly context: "text" | "attribute" | "markdown" | "content";
	readonly attribute?: string;
}

export interface RetainedTemplateAttributeStaticPart {
	readonly kind: "static";
	readonly value: string;
	readonly encoding: "html-attribute-source";
}

export interface RetainedTemplateAttributeExpressionPart<E> {
	readonly kind: "expression";
	readonly expression: E;
}

export interface RetainedTemplateAttributeIfBranch<E> {
	readonly condition: E | null;
	readonly children: readonly RetainedTemplateAttributeValuePart<E>[];
}

export interface RetainedTemplateAttributeIfPart<E> {
	readonly kind: "if";
	readonly branches: readonly RetainedTemplateAttributeIfBranch<E>[];
}

export interface RetainedTemplateAttributeForPart<E> {
	readonly kind: "for";
	readonly iterable: E;
	readonly itemVariable: string;
	readonly children: readonly RetainedTemplateAttributeValuePart<E>[];
}

export type RetainedTemplateAttributeValuePart<E> =
	| RetainedTemplateAttributeStaticPart
	| RetainedTemplateAttributeExpressionPart<E>
	| RetainedTemplateAttributeIfPart<E>
	| RetainedTemplateAttributeForPart<E>;

export interface RetainedTemplateAttributeSlot<E> {
	readonly kind: "attribute-slot";
	readonly id: string;
	readonly attribute: string;
	readonly targetKey: string;
	readonly quote: "\"" | "'" | null;
	readonly parts: readonly RetainedTemplateAttributeValuePart<E>[];
}

export interface RetainedTemplateIfBranch<E> {
	readonly condition: E | null;
	readonly children: readonly RetainedTemplateIrNode<E>[];
}

export interface RetainedTemplateIfNode<E> {
	readonly kind: "if";
	readonly branches: readonly RetainedTemplateIfBranch<E>[];
}

export interface RetainedTemplateForNode<E> {
	readonly kind: "for";
	readonly iterable: E;
	readonly itemVariable: string;
	readonly indexVariable?: string;
	readonly key?: E;
	readonly children: readonly RetainedTemplateIrNode<E>[];
}

export interface RetainedTemplateSetNode<E> {
	readonly kind: "set";
	readonly variable: string;
	readonly expression: E;
}

export type RetainedTemplateIrNode<E> =
	| RetainedTemplateStaticFragment
	| RetainedTemplateExpressionSlot<E>
	| RetainedTemplateContextExpressionSlot<E>
	| RetainedTemplateAttributeSlot<E>
	| RetainedTemplateIfNode<E>
	| RetainedTemplateForNode<E>
	| RetainedTemplateSetNode<E>;

export type RetainedTemplateDomUnsupportedCode =
	| "structural-control-flow"
	| "raw-html-range"
	| "non-text-expression-context";

export interface RetainedTemplateDomSupported {
	readonly supported: true;
}

export interface RetainedTemplateDomUnsupported {
	readonly supported: false;
	readonly code: RetainedTemplateDomUnsupportedCode;
	readonly path: string;
	readonly message: string;
}

export type RetainedTemplateDomSupport =
	| RetainedTemplateDomSupported
	| RetainedTemplateDomUnsupported;

export class RetainedTemplateDomPlanError extends Error {
	constructor(
		message: string,
		readonly code:
			| RetainedTemplateDomUnsupportedCode
			| "duplicate-slot-id"
			| "marker-missing"
			| "marker-collision"
			| "target-key-conflict"
			| "attribute-decode-failed",
	) {
		super(message);
		this.name = "RetainedTemplateDomPlanError";
	}
}

interface SlotMarker {
	readonly comment: string;
	readonly attribute: string;
}

/**
 * Compiler-facing DOM structure plan for the retained leaf-slot subset.
 *
 * This slice deliberately does not evaluate expressions. Bot 2 remains the
 * semantic authority; callers patch the registered retained slots after their
 * compiler/runtime evaluator resolves values. Structural `{% if %}` / `{% for %}`
 * nodes and explicit raw HTML are reported as measurable fallback requirements
 * instead of being silently rendered with weaker semantics.
 */
export class RetainedTemplateDomPlan<E = unknown> {
	readonly structureKey: string;
	private readonly markers = new Map<string, SlotMarker>();
	private readonly markerSource: string;

	constructor(readonly ir: RetainedTemplateIrLike<E>) {
		const support = inspectRetainedTemplateDomSupport(ir);
		if (!support.supported) {
			throw new RetainedTemplateDomPlanError(support.message, support.code);
		}

		this.structureKey = JSON.stringify([
			"morphic-retained-template-dom-plan-v1",
			ir.version,
			ir.sourceHash,
		]);
		this.validateAndCreateMarkers();
		this.markerSource = this.buildMarkerSource();
	}

	/** Mount into the canonical retained runtime; same structure key is reused. */
	mount(runtime: RetainedDomRuntime): "mounted" | "reused" | "disposed" {
		return runtime.mountStructure(this.structureKey, this.builder());
	}

	/** Builder form composes with keyed/conditional retained slot scopes later. */
	builder(): RetainedStructureBuilder {
		return (context) => this.build(context);
	}

	private validateAndCreateMarkers(): void {
		let ordinal = 0;
		for (const node of this.ir.nodes) {
			if (!isDomSlotNode(node)) continue;
			if (this.markers.has(node.id)) {
				throw new RetainedTemplateDomPlanError(
					`Duplicate retained template slot id: ${node.id}`,
					"duplicate-slot-id",
				);
			}

			const suffix = `${encodeMarkerPart(this.ir.sourceHash)}-${ordinal++}`;
			this.markers.set(node.id, {
				comment: `morphic-slot-${suffix}`,
				attribute: `\uE000morphic-attribute-${suffix}\uE001`,
			});
		}
	}

	private buildMarkerSource(): string {
		let source = "";
		for (const node of this.ir.nodes) {
			switch (node.kind) {
				case "static-fragment":
					source += node.html;
					break;
				case "set":
					// Set nodes are evaluator-only prelude state and emit no DOM.
					break;
				case "attribute-slot":
					source += this.requireMarker(node.id).attribute;
					break;
				case "text-slot":
				case "expression-slot":
				case "markdown-slot":
				case "content-slot":
					source += `<!--${this.requireMarker(node.id).comment}-->`;
					break;
				case "raw-html-slot":
				case "if":
				case "for":
					throw new RetainedTemplateDomPlanError(
						`Unsupported retained template node reached builder: ${node.kind}`,
						node.kind === "raw-html-slot" ? "raw-html-range" : "structural-control-flow",
					);
			}
		}
		return source;
	}

	private build(context: RetainedStructureContext): void {
		this.validateMarkerSourceUniqueness();
		const parsed = parseHtmlBodyFragment(context.ownerDocument, this.markerSource);
		const targetKeys = new Map<string, Element>();

		for (const node of this.ir.nodes) {
			switch (node.kind) {
				case "static-fragment":
				case "set":
					break;
				case "text-slot":
				case "expression-slot": {
					const marker = this.findUniqueComment(parsed, node.id);
					const text = context.textSlot(node.id);
					marker.replaceWith(text);
					break;
				}
				case "attribute-slot": {
					const element = this.findUniqueAttributeTarget(parsed, node);
					const prior = targetKeys.get(node.targetKey);
					if (prior && prior !== element) {
						throw new RetainedTemplateDomPlanError(
							`Attribute target key ${node.targetKey} resolved to multiple elements`,
							"target-key-conflict",
						);
					}
					targetKeys.set(node.targetKey, element);
					// Never allow an internal marker to reach committed/live DOM.
					element.removeAttribute(node.attribute);
					context.attributeSlot(node.id, element, node.attribute);
					break;
				}
				case "markdown-slot": {
					const marker = this.findUniqueComment(parsed, node.id);
					const element = context.ownerDocument.win.createSpan();
					context.markdownSlot(node.id, element);
					marker.replaceWith(element);
					break;
				}
				case "content-slot": {
					const marker = this.findUniqueComment(parsed, node.id);
					const element = context.ownerDocument.win.createDiv();
					element.classList.add(
						"markdown-rendered-content",
						"markdown-preview-view",
						"markdown-rendered",
					);
					context.contentSlot(node.id, element);
					marker.replaceWith(element);
					break;
				}
				case "raw-html-slot":
				case "if":
				case "for":
					throw new RetainedTemplateDomPlanError(
						`Unsupported retained template node reached DOM build: ${node.kind}`,
						node.kind === "raw-html-slot" ? "raw-html-range" : "structural-control-flow",
					);
			}
		}

		context.fragment.append(...Array.from(parsed.childNodes));
	}

	private validateMarkerSourceUniqueness(): void {
		for (const node of this.ir.nodes) {
			if (!isDomSlotNode(node)) continue;
			const marker = this.requireMarker(node.id);
			const sourceMarker = node.kind === "attribute-slot"
				? marker.attribute
				: `<!--${marker.comment}-->`;
			if (countOccurrences(this.markerSource, sourceMarker) !== 1) {
				throw new RetainedTemplateDomPlanError(
					`Retained template marker for slot ${node.id} collides with template source`,
					"marker-collision",
				);
			}
		}
	}

	private findUniqueComment(root: DocumentFragment, id: string): Comment {
		const expected = this.requireMarker(id).comment;
		const matches = collectComments(root).filter((comment) => comment.data === expected);
		if (matches.length === 0) {
			throw new RetainedTemplateDomPlanError(
				`Retained template marker for slot ${id} was not preserved by HTML parsing`,
				"marker-missing",
			);
		}
		if (matches.length !== 1) {
			throw new RetainedTemplateDomPlanError(
				`Retained template marker for slot ${id} is ambiguous`,
				"marker-collision",
			);
		}
		return matches[0];
	}

	private findUniqueAttributeTarget(
		root: DocumentFragment,
		node: RetainedTemplateAttributeSlot<E>,
	): Element {
		const expected = this.requireMarker(node.id).attribute;
		const matches = collectElements(root).filter(
			(element) => element.getAttribute(node.attribute) === expected,
		);
		if (matches.length === 0) {
			throw new RetainedTemplateDomPlanError(
				`Retained attribute marker for slot ${node.id} was not preserved by HTML parsing`,
				"marker-missing",
			);
		}
		if (matches.length !== 1) {
			throw new RetainedTemplateDomPlanError(
				`Retained attribute marker for slot ${node.id} is ambiguous`,
				"marker-collision",
			);
		}
		return matches[0];
	}

	private requireMarker(id: string): SlotMarker {
		const marker = this.markers.get(id);
		if (!marker) {
			throw new RetainedTemplateDomPlanError(
				`Missing retained template marker metadata for slot ${id}`,
				"marker-missing",
			);
		}
		return marker;
	}
}

/**
 * Explicit capability check for production fallback accounting.
 * Unsupported nodes are never silently downgraded to full-string interpolation.
 */
export function inspectRetainedTemplateDomSupport<E>(
	ir: RetainedTemplateIrLike<E>,
): RetainedTemplateDomSupport {
	for (let index = 0; index < ir.nodes.length; index++) {
		const node = ir.nodes[index];
		const path = `nodes[${index}]`;
		if (node.kind === "if" || node.kind === "for") {
			return {
				supported: false,
				code: "structural-control-flow",
				path,
				message: `${path} requires the keyed/conditional TemplateIR adapter`,
			};
		}
		if (node.kind === "raw-html-slot") {
			return {
				supported: false,
				code: "raw-html-range",
				path,
				message: `${path} requires an anchor-bounded raw HTML retained range`,
			};
		}
		if (node.kind === "expression-slot" && node.context !== "text") {
			return {
				supported: false,
				code: "non-text-expression-context",
				path,
				message: `${path} has unsupported expression context '${node.context}'`,
			};
		}
	}
	return { supported: true };
}

/**
 * Decode compiler-owned static attribute source in the actual owner document.
 *
 * Bot 2 marks these pieces as `html-attribute-source`; callers must decode them
 * before concatenating evaluated dynamic parts and issuing one atomic
 * `patchAttribute()` call.
 */
export function decodeRetainedHtmlAttributeSource(
	ownerDocument: Document,
	source: string,
	quote: "\"" | "'" | null = "\"",
): string {
	const delimiter = quote === "'" ? "'" : "\"";
	const attributeName = "data-morphic-decode";
	const fragment = parseHtmlBodyFragment(
		ownerDocument,
		`<span ${attributeName}=${delimiter}${source}${delimiter}></span>`,
	);
	const decoded = fragment.firstElementChild?.getAttribute(attributeName);
	if (decoded === null || decoded === undefined) {
		throw new RetainedTemplateDomPlanError(
			"Could not decode retained HTML attribute source",
			"attribute-decode-failed",
		);
	}
	return decoded;
}

function parseHtmlBodyFragment(ownerDocument: Document, source: string): DocumentFragment {
	// Keep parser semantics aligned with the legacy renderer's DOMParser path.
	// A real pop-out document supplies its own DOMParser constructor; synthetic
	// detached documents used in tests fall back to the current window parser.
	const Parser = ownerDocument.defaultView?.DOMParser ?? DOMParser;
	const parsedDocument = new Parser().parseFromString(source, "text/html");
	const fragment = ownerDocument.win.createFragment();
	for (const child of Array.from(parsedDocument.body.childNodes)) {
		fragment.appendChild(ownerDocument.importNode(child, true));
	}
	return fragment;
}

function isDomSlotNode<E>(
	node: RetainedTemplateIrNode<E>,
): node is
	| RetainedTemplateExpressionSlot<E>
	| RetainedTemplateContextExpressionSlot<E>
	| RetainedTemplateAttributeSlot<E> {
	return node.kind === "text-slot"
		|| node.kind === "markdown-slot"
		|| node.kind === "content-slot"
		|| node.kind === "raw-html-slot"
		|| node.kind === "expression-slot"
		|| node.kind === "attribute-slot";
}

function encodeMarkerPart(value: string): string {
	let encoded = "";
	for (const char of value) {
		if (encoded) encoded += "_";
		encoded += char.codePointAt(0)?.toString(16) ?? "0";
	}
	return encoded || "empty";
}

function countOccurrences(source: string, needle: string): number {
	let count = 0;
	let offset = 0;
	while (offset <= source.length) {
		const index = source.indexOf(needle, offset);
		if (index === -1) return count;
		count++;
		offset = index + needle.length;
	}
	return count;
}

function collectComments(root: Node): Comment[] {
	const comments: Comment[] = [];
	walkNodes(root, (node) => {
		if (node.nodeType === 8) comments.push(node as Comment);
	});
	return comments;
}

function collectElements(root: Node): Element[] {
	const elements: Element[] = [];
	walkNodes(root, (node) => {
		if (node.nodeType === 1) elements.push(node as Element);
	});
	return elements;
}

function walkNodes(root: Node, visitor: (node: Node) => void): void {
	for (const child of Array.from(root.childNodes)) {
		visitor(child);
		walkNodes(child, visitor);
	}
}
