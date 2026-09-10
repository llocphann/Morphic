import {
	evaluateCompiledExpression,
	type CompiledExpression,
} from "../compiler/expression-compiler";
import type { TemplateIRNode } from "../compiler/template-ir";
import type { ExprContext, ExprValue } from "../expression";
import { resultToString } from "../renderer";
import type { RetainedStructureBuilder } from "./retained-slot-runtime";
import {
	RetainedTemplateDomPlan,
	decodeRetainedHtmlAttributeSource,
	type RetainedTemplateAttributeSlot,
	type RetainedTemplateIrLike,
	type RetainedTemplateIrNode,
} from "./retained-template-dom-plan";

export type RetainedConditionalMixedBranchUnsupportedCode =
	| "attribute-slot"
	| "raw-html-range"
	| "nested-structural-control-flow"
	| "non-text-expression-context";

export interface RetainedConditionalMixedBranchSupported {
	readonly supported: true;
}

export interface RetainedConditionalMixedBranchUnsupported {
	readonly supported: false;
	readonly code: RetainedConditionalMixedBranchUnsupportedCode;
	readonly path: string;
	readonly message: string;
}

export type RetainedConditionalMixedBranchSupport =
	| RetainedConditionalMixedBranchSupported
	| RetainedConditionalMixedBranchUnsupported;

export interface RetainedConditionalMixedSyncSlot {
	readonly id: string;
	readonly kind: "text" | "attribute";
}

export interface RetainedConditionalMixedAsyncSlot {
	readonly id: string;
	readonly kind: "markdown" | "content";
	readonly expression: CompiledExpression;
}

export interface RetainedConditionalMixedBranchResolvedValues {
	readonly status: "resolved";
	readonly syncValues: ReadonlyMap<string, string>;
	readonly asyncValues: ReadonlyMap<string, string>;
}

export interface RetainedConditionalMixedBranchStaleValues {
	readonly status: "stale";
}

export interface RetainedConditionalMixedBranchFailedValues {
	readonly status: "failed";
	readonly error: unknown;
}

export type RetainedConditionalMixedBranchEvaluationResult =
	| RetainedConditionalMixedBranchResolvedValues
	| RetainedConditionalMixedBranchStaleValues
	| RetainedConditionalMixedBranchFailedValues;

export type RetainedConditionalMixedBranchEvaluator = (
	expression: CompiledExpression,
	context: ExprContext,
) => Promise<ExprValue>;

export class RetainedConditionalMixedBranchPlanError extends Error {
	constructor(
		message: string,
		readonly code: RetainedConditionalMixedBranchUnsupportedCode,
		readonly path: string,
	) {
		super(message);
		this.name = "RetainedConditionalMixedBranchPlanError";
	}
}

/**
 * Detached branch plan for retained conditionals that mixes synchronous leaves
 * with Markdown/content placeholders.
 *
 * This primitive deliberately stops before MarkdownRenderer creation. It keeps
 * branch DOM construction and lexical expression evaluation deterministic while
 * returning evaluated Markdown/content strings to the owner layer, which is the
 * authority for sourcePath/revisionKey/renderKey and renderer resource creation.
 * Raw HTML and nested structural control flow remain explicit fallback surfaces.
 */
export class RetainedProductionConditionalMixedBranchPlan {
	readonly plan: RetainedTemplateDomPlan<CompiledExpression>;
	readonly syncSlots: readonly RetainedConditionalMixedSyncSlot[];
	readonly asyncSlots: readonly RetainedConditionalMixedAsyncSlot[];

	private readonly nodes: readonly TemplateIRNode[];

	constructor(
		private readonly ownerDocument: Document,
		outerSourceHash: string,
		branchIndex: number,
		children: readonly TemplateIRNode[],
	) {
		const support = inspectRetainedProductionConditionalMixedBranchSupport(children);
		if (!support.supported) {
			throw new RetainedConditionalMixedBranchPlanError(
				support.message,
				support.code,
				support.path,
			);
		}

		this.nodes = Object.freeze([...children]);
		const retainedNodes = this.nodes.map(toRetainedNode);
		const ir: RetainedTemplateIrLike<CompiledExpression> = {
			version: 1,
			sourceHash: JSON.stringify([
				"morphic-production-if-mixed-branch-v1",
				outerSourceHash,
				branchIndex,
			]),
			nodes: retainedNodes,
		};
		this.plan = new RetainedTemplateDomPlan(ir);
		this.syncSlots = Object.freeze(retainedNodes.flatMap((node): RetainedConditionalMixedSyncSlot[] => {
			if (node.kind === "text-slot" || node.kind === "expression-slot") {
				return [{ id: node.id, kind: "text" }];
			}
			if (node.kind === "attribute-slot") return [{ id: node.id, kind: "attribute" }];
			return [];
		}));
		this.asyncSlots = Object.freeze(retainedNodes.flatMap((node): RetainedConditionalMixedAsyncSlot[] => {
			if (node.kind === "markdown-slot" || node.kind === "content-slot") {
				return [{ id: node.id, kind: node.kind === "markdown-slot" ? "markdown" : "content", expression: node.expression }];
			}
			return [];
		}));
	}

	builder(): RetainedStructureBuilder {
		return this.plan.builder();
	}

	async evaluate(
		expressionContext: ExprContext,
		evaluateExpression: RetainedConditionalMixedBranchEvaluator = evaluateCompiledExpression,
		isCurrent: () => boolean = () => true,
	): Promise<RetainedConditionalMixedBranchEvaluationResult> {
		if (!isCurrent()) return { status: "stale" };

		const syncValues = new Map<string, string>();
		const asyncValues = new Map<string, string>();
		const context: ExprContext = {
			...expressionContext,
			variables: { ...expressionContext.variables },
		};

		try {
			for (const node of this.nodes) {
				if (!isCurrent()) return { status: "stale" };
				switch (node.kind) {
					case "static-fragment":
						break;
					case "set": {
						const value = await evaluateExpression(node.expression, context);
						if (!isCurrent()) return { status: "stale" };
						context.variables[node.variable] = value;
						break;
					}
					case "text-slot":
					case "expression-slot": {
						const value = await evaluateExpression(node.expression, context);
						if (!isCurrent()) return { status: "stale" };
						syncValues.set(node.id, resultToString(value));
						break;
					}
					case "attribute-slot": {
						const complete = getCompleteAttributeSlot(node);
						if (!complete) throw new Error(`Incomplete retained conditional attribute slot: ${node.id}`);
						let assembled = "";
						for (const part of complete.parts) {
							if (part.kind === "static") {
								assembled += decodeRetainedHtmlAttributeSource(
									this.ownerDocument,
									part.value,
									complete.quote,
								);
								continue;
							}
							if (part.kind !== "expression") {
								throw new Error(`Unsupported conditional attribute part: ${part.kind}`);
							}
							const value = await evaluateExpression(part.expression, context);
							if (!isCurrent()) return { status: "stale" };
							assembled += resultToString(value);
						}
						syncValues.set(node.id, assembled);
						break;
					}
					case "markdown-slot":
					case "content-slot": {
						const value = await evaluateExpression(node.expression, context);
						if (!isCurrent()) return { status: "stale" };
						asyncValues.set(node.id, resultToString(value));
						break;
					}
					case "raw-html-slot":
					case "if":
					case "for":
						throw new Error(`Unsupported conditional mixed child reached evaluation: ${node.kind}`);
				}
			}
			return { status: "resolved", syncValues, asyncValues };
		} catch (error) {
			return { status: "failed", error };
		}
	}
}

export function inspectRetainedProductionConditionalMixedBranchSupport(
	children: readonly TemplateIRNode[],
): RetainedConditionalMixedBranchSupport {
	for (let index = 0; index < children.length; index++) {
		const child = children[index];
		const path = `children[${index}]`;
		switch (child.kind) {
			case "attribute-slot":
				if (!getCompleteAttributeSlot(child)) {
					return unsupported(
						"attribute-slot",
						path,
						"requires complete compiler targetKey/quote/parts metadata",
					);
				}
				break;
			case "raw-html-slot":
				return unsupported(
					"raw-html-range",
					path,
					"requires retained raw-HTML child range composition",
				);
			case "if":
			case "for":
				return unsupported(
					"nested-structural-control-flow",
					path,
					"requires recursive retained structural child composition",
				);
			case "expression-slot":
				if (child.context !== "text") {
					return unsupported(
						"non-text-expression-context",
						path,
						`has unsupported expression context '${child.context}'`,
					);
				}
				break;
			case "static-fragment":
			case "text-slot":
			case "markdown-slot":
			case "content-slot":
			case "set":
				break;
		}
	}
	return { supported: true };
}

function toRetainedNode(node: TemplateIRNode): RetainedTemplateIrNode<CompiledExpression> {
	switch (node.kind) {
		case "static-fragment":
			return { kind: "static-fragment", html: node.html };
		case "set":
			return { kind: "set", variable: node.variable, expression: node.expression };
		case "text-slot":
			return { kind: "text-slot", id: node.id, expression: node.expression };
		case "expression-slot":
			return {
				kind: "expression-slot",
				id: node.id,
				expression: node.expression,
				context: "text",
			};
		case "attribute-slot": {
			const complete = getCompleteAttributeSlot(node);
			if (!complete) throw new Error(`Incomplete retained conditional attribute slot: ${node.id}`);
			return complete;
		}
		case "markdown-slot":
			return { kind: "markdown-slot", id: node.id, expression: node.expression };
		case "content-slot":
			return { kind: "content-slot", id: node.id, expression: node.expression };
		case "raw-html-slot":
		case "if":
		case "for":
			throw new Error(`Unsupported retained conditional mixed child: ${node.kind}`);
	}
}

function getCompleteAttributeSlot(
	node: TemplateIRNode,
): RetainedTemplateAttributeSlot<CompiledExpression> | null {
	if (node.kind !== "attribute-slot") return null;
	if (typeof node.targetKey !== "string" || node.targetKey.length === 0) return null;
	if (node.quote !== "\"" && node.quote !== "'" && node.quote !== null) return null;
	const parts = node.parts;
	if (!parts || parts.length === 0) return null;
	for (const part of parts) {
		if (part.kind === "static") {
			if (part.encoding !== "html-attribute-source") return null;
			continue;
		}
		if (part.kind !== "expression") return null;
	}
	return {
		kind: "attribute-slot",
		id: node.id,
		attribute: node.attribute,
		targetKey: node.targetKey,
		quote: node.quote,
		parts,
	};
}

function unsupported(
	code: RetainedConditionalMixedBranchUnsupportedCode,
	path: string,
	reason: string,
): RetainedConditionalMixedBranchUnsupported {
	return {
		supported: false,
		code,
		path,
		message: `${path} ${reason}`,
	};
}
