import type { App } from "obsidian";
import {
	evaluateCompiledExpression,
	type CompiledExpression,
} from "../compiler/expression-compiler";
import type { TemplateIR } from "../compiler/template-ir";
import type { ExprContext, ExprValue } from "../expression";
import { resultToString } from "../renderer";
import { createObsidianContentIslandPatch } from "./obsidian-content-island";
import { createObsidianMarkdownIslandPatch } from "./obsidian-markdown-island";
import {
	RetainedLeafGenerationCoordinator,
	type RetainedLeafOwnerGenerationPreparationResult,
	type RetainedPreparedLeafOwnerGeneration,
} from "./retained-leaf-generation-coordinator";
import type { RetainedLeafAsyncRequest } from "./retained-leaf-template-transaction";
import type { RetainedDomRuntimeOptions, RetainedScalar } from "./retained-slot-runtime";
import {
	decodeRetainedHtmlAttributeSource,
	type RetainedTemplateIrLike,
	type RetainedTemplateIrNode,
} from "./retained-template-dom-plan";

export type RetainedProductionLeafFallbackCode =
	| "attribute-slot"
	| "structural-control-flow"
	| "raw-html-range"
	| "non-text-expression-context";

export interface RetainedProductionLeafFallback {
	readonly status: "fallback";
	readonly code: RetainedProductionLeafFallbackCode;
	readonly path: string;
	readonly message: string;
}

export type RetainedProductionLeafPreparationResult =
	| RetainedLeafOwnerGenerationPreparationResult
	| RetainedProductionLeafFallback;

export interface RetainedProductionLeafRequest {
	readonly ir: TemplateIR;
	readonly app: App;
	readonly expressionContext: ExprContext;
	readonly sourcePath: string;
	/** Runtime dependency/read-set revision identity owned by Bot 1 / Bot 3. */
	readonly revisionKey: string;
}

export type RetainedProductionExpressionEvaluator = (
	expression: CompiledExpression,
	context: ExprContext,
) => Promise<ExprValue>;

export interface RetainedProductionLeafRendererOptions {
	readonly runtime?: RetainedDomRuntimeOptions;
	/** Test seam only; production uses Bot 2's compiled evaluator. */
	readonly evaluateExpression?: RetainedProductionExpressionEvaluator;
}

interface PreparedLeafInputs {
	readonly ir: RetainedTemplateIrLike<CompiledExpression>;
	readonly values: ReadonlyMap<string, RetainedScalar>;
	readonly islands: ReadonlyMap<string, RetainedLeafAsyncRequest>;
}

interface CompleteProductionAttributeStaticPart {
	readonly kind: "static";
	readonly value: string;
	readonly encoding: "html-attribute-source";
}

interface CompleteProductionAttributeExpressionPart {
	readonly kind: "expression";
	readonly expression: CompiledExpression;
}

type CompleteProductionAttributePart =
	| CompleteProductionAttributeStaticPart
	| CompleteProductionAttributeExpressionPart;

interface CompleteProductionAttributeSlot {
	readonly kind: "attribute-slot";
	readonly id: string;
	readonly expression: CompiledExpression;
	readonly attribute: string;
	readonly targetKey: string;
	readonly quote: "\"" | "'" | null;
	readonly parts: readonly CompleteProductionAttributePart[];
}

/**
 * Production-facing retained renderer for the compiler leaf subset.
 *
 * The class deliberately owns renderer state only. Bot 1 remains responsible for
 * MarkdownView/Canvas owner lifetime, final owner-currentness gates, dependency
 * commit, and deciding when a `fallback` result must use the legacy renderer.
 *
 * Unsupported compiler constructs are rejected before expression evaluation so
 * fallback cannot cause duplicate side effects or hidden I/O. Supported templates
 * evaluate through Bot 2's compiled evaluator, then flow through the canonical
 * owner-level retained generation coordinator.
 */
export class RetainedProductionLeafRenderer {
	private readonly coordinator: RetainedLeafGenerationCoordinator<CompiledExpression>;
	private readonly evaluateExpression: RetainedProductionExpressionEvaluator;
	private readonly ownerDocument: Document;
	private preparationGeneration = 0;
	private disposed = false;

	constructor(
		root: HTMLElement,
		options: RetainedProductionLeafRendererOptions = {},
	) {
		this.ownerDocument = root.ownerDocument;
		this.coordinator = new RetainedLeafGenerationCoordinator(root, {
			runtime: options.runtime,
		});
		this.evaluateExpression = options.evaluateExpression ?? evaluateCompiledExpression;
	}

	get isDisposed(): boolean {
		return this.disposed;
	}

	get currentStructureKey(): string | null {
		return this.coordinator.currentStructureKey;
	}

	async prepare(
		request: RetainedProductionLeafRequest,
	): Promise<RetainedProductionLeafPreparationResult> {
		if (this.disposed) return { status: "disposed" };

		// Every live request owns a generation, including one that falls back before
		// evaluation. Otherwise a newer unsupported request could leave older leaf
		// preparation/commit authority current after the owner chose another path.
		const generation = ++this.preparationGeneration;
		const support = inspectRetainedProductionLeafSupport(request.ir);
		if (support) return support;

		let inputs: PreparedLeafInputs;
		try {
			inputs = await this.prepareInputs(request, generation);
		} catch (error) {
			if (!this.isPreparationCurrent(generation)) {
				return { status: this.disposed ? "disposed" : "stale" };
			}
			return { status: "failed", error };
		}

		if (!this.isPreparationCurrent(generation)) {
			return { status: this.disposed ? "disposed" : "stale" };
		}

		const prepared = await this.coordinator.prepare(inputs.ir, inputs.values, inputs.islands);
		if (!this.isPreparationCurrent(generation)) {
			if (prepared.status === "prepared") prepared.dispose();
			return { status: this.disposed ? "disposed" : "stale" };
		}
		if (prepared.status !== "prepared") return prepared;
		return this.bindPreparationGeneration(generation, prepared);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.preparationGeneration += 1;
		this.coordinator.dispose();
	}

	private bindPreparationGeneration(
		generation: number,
		prepared: RetainedPreparedLeafOwnerGeneration,
	): RetainedPreparedLeafOwnerGeneration {
		return {
			status: "prepared",
			mode: prepared.mode,
			structureKey: prepared.structureKey,
			isCurrent: () => this.isPreparationCurrent(generation) && prepared.isCurrent(),
			commit: (isOwnerCurrent) => {
				if (!this.isPreparationCurrent(generation)) {
					prepared.dispose();
					return { status: this.disposed ? "disposed" : "stale" };
				}
				return prepared.commit(
					() => this.isPreparationCurrent(generation) && isOwnerCurrent(),
				);
			},
			dispose: () => prepared.dispose(),
		};
	}

	private async prepareInputs(
		request: RetainedProductionLeafRequest,
		generation: number,
	): Promise<PreparedLeafInputs> {
		const retainedNodes: RetainedTemplateIrNode<CompiledExpression>[] = [];
		const values = new Map<string, RetainedScalar>();
		const islands = new Map<string, RetainedLeafAsyncRequest>();
		const context: ExprContext = {
			...request.expressionContext,
			variables: { ...request.expressionContext.variables },
		};

		for (const node of request.ir.nodes) {
			if (!this.isPreparationCurrent(generation)) break;

			switch (node.kind) {
				case "static-fragment":
					retainedNodes.push({ kind: "static-fragment", html: node.html });
					break;

				case "set": {
					const value = await this.evaluateExpression(node.expression, context);
					if (!this.isPreparationCurrent(generation)) break;
					context.variables[node.variable] = value;
					retainedNodes.push({
						kind: "set",
						variable: node.variable,
						expression: node.expression,
					});
					break;
				}

				case "text-slot":
				case "expression-slot": {
					const value = await this.evaluateExpression(node.expression, context);
					if (!this.isPreparationCurrent(generation)) break;
					values.set(node.id, resultToString(value));
					retainedNodes.push(node.kind === "text-slot"
						? { kind: "text-slot", id: node.id, expression: node.expression }
						: {
							kind: "expression-slot",
							id: node.id,
							expression: node.expression,
							context: "text",
						});
					break;
				}

				case "attribute-slot": {
					const attribute = getCompleteProductionAttributeSlot(node);
					if (!attribute) {
						throw new Error("Incomplete retained production attribute reached evaluation");
					}
					let assembled = "";
					for (const part of attribute.parts) {
						if (part.kind === "static") {
							assembled += decodeRetainedHtmlAttributeSource(
								this.ownerDocument,
								part.value,
								attribute.quote,
							);
							continue;
						}

						const value = await this.evaluateExpression(part.expression, context);
						if (!this.isPreparationCurrent(generation)) break;
						assembled += resultToString(value);
					}
					if (!this.isPreparationCurrent(generation)) break;
					values.set(node.id, assembled);
					retainedNodes.push({
						kind: "attribute-slot",
						id: node.id,
						attribute: node.attribute,
						targetKey: attribute.targetKey,
						quote: attribute.quote,
						parts: attribute.parts,
					});
					break;
				}

				case "markdown-slot": {
					const value = await this.evaluateExpression(node.expression, context);
					if (!this.isPreparationCurrent(generation)) break;
					const patch = createObsidianMarkdownIslandPatch({
						app: request.app,
						markdown: resultToString(value),
						sourcePath: request.sourcePath,
						revisionKey: request.revisionKey,
					});
					islands.set(node.id, patch);
					retainedNodes.push({
						kind: "markdown-slot",
						id: node.id,
						expression: node.expression,
					});
					break;
				}

				case "content-slot": {
					// The compiler emits ContentSlot only for exact unfiltered content/file.content.
					// Legacy renderTemplate bypasses expression coercion for this case, so use the
					// already-loaded source body directly and avoid an unnecessary second read.
					const patch = createObsidianContentIslandPatch({
						app: request.app,
						markdown: context.bodyContent,
						sourcePath: request.sourcePath,
						revisionKey: request.revisionKey,
					});
					islands.set(node.id, patch);
					retainedNodes.push({
						kind: "content-slot",
						id: node.id,
						expression: node.expression,
					});
					break;
				}

				case "raw-html-slot":
				case "if":
				case "for":
					throw new Error(`Unsupported retained production leaf node reached evaluation: ${node.kind}`);
			}
		}

		return {
			ir: {
				version: request.ir.version,
				sourceHash: request.ir.sourceHash,
				nodes: retainedNodes,
			},
			values,
			islands,
		};
	}

	private isPreparationCurrent(generation: number): boolean {
		return !this.disposed && generation === this.preparationGeneration;
	}
}

/**
 * Capability gate for the production-authoritative retained leaf subset.
 *
 * Attribute slots are accepted only when the compiler supplies the complete
 * target/quote/parts handoff. Older or incomplete AttributeSlot shapes remain on
 * legacy fallback before evaluation, so this consumer can land independently of
 * the compiler rollout without weakening attribute semantics.
 */
export function inspectRetainedProductionLeafSupport(
	ir: TemplateIR,
): RetainedProductionLeafFallback | null {
	for (let index = 0; index < ir.nodes.length; index++) {
		const node = ir.nodes[index];
		const path = `nodes[${index}]`;
		switch (node.kind) {
			case "attribute-slot":
				if (!getCompleteProductionAttributeSlot(node)) {
					return {
						status: "fallback",
						code: "attribute-slot",
						path,
						message: `${path} requires complete compiler targetKey/quote/parts metadata`,
					};
				}
				break;
			case "if":
			case "for":
				return {
					status: "fallback",
					code: "structural-control-flow",
					path,
					message: `${path} requires the production structural TemplateIR adapter`,
				};
			case "raw-html-slot":
				return {
					status: "fallback",
					code: "raw-html-range",
					path,
					message: `${path} requires the production raw-HTML range adapter`,
				};
			case "expression-slot":
				if (node.context !== "text") {
					return {
						status: "fallback",
						code: "non-text-expression-context",
						path,
						message: `${path} has unsupported expression context '${node.context}'`,
					};
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
	return null;
}

function getCompleteProductionAttributeSlot(
	node: TemplateIR["nodes"][number],
): CompleteProductionAttributeSlot | null {
	if (node.kind !== "attribute-slot") return null;
	const candidate = node as unknown as Record<string, unknown>;
	const targetKey = candidate.targetKey;
	const quote = candidate.quote;
	const candidateParts = candidate.parts;
	if (typeof targetKey !== "string" || targetKey.length === 0) return null;
	if (quote !== "\"" && quote !== "'" && quote !== null) return null;
	if (!Array.isArray(candidateParts) || candidateParts.length === 0) return null;

	const parts: CompleteProductionAttributePart[] = [];
	for (const candidatePart of candidateParts) {
		if (!candidatePart || typeof candidatePart !== "object") return null;
		const part = candidatePart as Record<string, unknown>;
		if (part.kind === "static") {
			if (typeof part.value !== "string" || part.encoding !== "html-attribute-source") {
				return null;
			}
			parts.push({
				kind: "static",
				value: part.value,
				encoding: "html-attribute-source",
			});
			continue;
		}
		if (part.kind === "expression" && isCompiledExpressionLike(part.expression)) {
			parts.push({ kind: "expression", expression: part.expression });
			continue;
		}
		return null;
	}

	return {
		kind: "attribute-slot",
		id: node.id,
		expression: node.expression,
		attribute: node.attribute,
		targetKey,
		quote,
		parts,
	};
}

function isCompiledExpressionLike(value: unknown): value is CompiledExpression {
	if (!value || typeof value !== "object") return false;
	const expression = value as Record<string, unknown>;
	return typeof expression.source === "string"
		&& typeof expression.expressionSource === "string"
		&& "ast" in expression;
}
