import type {
	CompiledExpression,
	StaticDependencyHints,
} from "./expression-compiler";
import type {
	CompiledRuleDependencies,
	CompiledRuleGroup,
} from "./rule-compiler";

/**
 * Typed template IR contract shared with the retained renderer.
 *
 * Dynamic values never imply HTML interpolation. The node kind defines the
 * rendering context so the DOM runtime can choose textContent, setAttribute,
 * MarkdownRenderer, or the explicit raw-HTML path deliberately.
 */
export interface TemplateIR {
	readonly version: 1;
	readonly sourceHash: string;
	readonly nodes: readonly TemplateIRNode[];
	readonly dependencyHints: StaticDependencyHints;
}

/**
 * Unified compiler handoff for Bot 1 / Bot 3.
 *
 * Template and matcher hints stay structurally separate because their revision
 * domains are not identical, but callers have one stable exported contract to
 * retain alongside CompiledView.
 */
export interface DependencyHints {
	readonly template: StaticDependencyHints;
	readonly matcher: CompiledRuleDependencies;
}

/** Backwards-compatible name used by earlier Core V2 compiler consumers. */
export type CompiledViewDependencies = DependencyHints;

/**
 * Immutable compiler handoff object for Bot 1 / Bot 4.
 * Recompile only when the supplied configuration revision changes.
 */
export interface CompiledView {
	readonly viewId: string;
	readonly configRevision: string | number;
	readonly template: TemplateIR;
	readonly matcher: CompiledRuleGroup;
	readonly matcherId: string;
	readonly dependencyHints: DependencyHints;
}

export interface StaticFragment {
	readonly kind: "static-fragment";
	/** Compiler-owned invariant markup only; never concatenate dynamic values. */
	readonly html: string;
}

export interface TextSlot extends ExpressionBackedSlot {
	readonly kind: "text-slot";
}

/**
 * Static source bytes inside an HTML attribute value.
 *
 * The value intentionally remains encoded as authored source. Retained DOM
 * consumers must preserve DOMParser-equivalent attribute decoding instead of
 * treating these bytes as already-decoded DOM attribute text.
 */
export interface AttributeStaticPart {
	readonly kind: "static";
	readonly value: string;
	readonly encoding: "html-attribute-source";
}

/** One evaluated expression in source order inside an assembled attribute. */
export interface AttributeExpressionPart {
	readonly kind: "expression";
	readonly expression: CompiledExpression;
}

export type AttributeValuePart = AttributeStaticPart | AttributeExpressionPart;

export interface AttributeSlot extends ExpressionBackedSlot {
	readonly kind: "attribute-slot";
	readonly attribute: string;
	/** Compiler key identifying the retained element receiving the attribute. */
	readonly targetKey?: string;
	/**
	 * Original attribute quoting mode. Present with `parts` when the compiler has
	 * a complete flat attribute-value assembly contract.
	 */
	readonly quote?: "\"" | "'" | null;
	/**
	 * Complete static/dynamic attribute value in source order for retained leaf
	 * rendering. Structural templates may intentionally omit this until their
	 * branch/loop attribute adapter is compiled; consumers must fall back then.
	 */
	readonly parts?: readonly AttributeValuePart[];
}

export interface MarkdownSlot extends ExpressionBackedSlot {
	readonly kind: "markdown-slot";
}

export interface ContentSlot extends ExpressionBackedSlot {
	readonly kind: "content-slot";
}

export interface RawHtmlSlot extends ExpressionBackedSlot {
	readonly kind: "raw-html-slot";
	/** Forces callers/renderers to acknowledge that this path is trusted raw HTML. */
	readonly explicitRawHtml: true;
}

export interface ExpressionSlot extends ExpressionBackedSlot {
	readonly kind: "expression-slot";
	readonly context: "text" | "attribute" | "markdown" | "content";
	readonly attribute?: string;
}

export interface IfNode {
	readonly kind: "if";
	readonly branches: readonly IfBranch[];
}

export interface IfBranch {
	/** null represents the final else branch. */
	readonly condition: CompiledExpression | null;
	readonly children: readonly TemplateIRNode[];
}

export interface ForNode {
	readonly kind: "for";
	readonly iterable: CompiledExpression;
	readonly itemVariable: string;
	readonly indexVariable?: string;
	/** Optional stable identity expression for keyed retained reconciliation. */
	readonly key?: CompiledExpression;
	readonly children: readonly TemplateIRNode[];
}

/**
 * Compile-time representation of Clipper-style `{% set name = expression %}`.
 * Keeping assignment explicit preserves existing template capability while
 * allowing the renderer to evaluate it without reparsing the source tag.
 */
export interface SetNode {
	readonly kind: "set";
	readonly variable: string;
	readonly expression: CompiledExpression;
}

interface ExpressionBackedSlot {
	readonly id: string;
	readonly expression: CompiledExpression;
}

export type TemplateIRNode =
	| StaticFragment
	| TextSlot
	| AttributeSlot
	| MarkdownSlot
	| ContentSlot
	| RawHtmlSlot
	| ExpressionSlot
	| IfNode
	| ForNode
	| SetNode;
