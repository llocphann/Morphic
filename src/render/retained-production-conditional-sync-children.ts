import {
	evaluateCompiledExpression,
	type CompiledExpression,
} from "../compiler/expression-compiler";
import type { IfNode, TemplateIRNode } from "../compiler/template-ir";
import type { ExprContext, ExprValue } from "../expression";
import { resultToString } from "../renderer";
import type {
	RetainedCommitParticipant,
	RetainedCommitTransaction,
	RetainedCommitTransactionResult,
} from "./retained-commit-transaction";
import {
	RetainedProductionConditionalSelector,
	type RetainedPreparedProductionConditional,
	type RetainedProductionConditionalEvaluator,
} from "./retained-production-conditional-selector";
import type { RetainedKeyedSlotScope } from "./scoped-keyed-slot-runtime";
import type { RetainedScalar } from "./retained-slot-runtime";
import {
	RetainedTemplateDomPlan,
	decodeRetainedHtmlAttributeSource,
	type RetainedTemplateAttributeSlot,
	type RetainedTemplateIrLike,
	type RetainedTemplateIrNode,
} from "./retained-template-dom-plan";

export type RetainedProductionConditionalSyncFallbackCode =
	| "attribute-slot"
	| "async-island"
	| "raw-html-range"
	| "nested-structural-control-flow"
	| "non-text-expression-context";

export interface RetainedProductionConditionalSyncFallback {
	readonly status: "fallback";
	readonly code: RetainedProductionConditionalSyncFallbackCode;
	readonly path: string;
	readonly message: string;
}

export type RetainedProductionConditionalSyncTerminalStatus =
	| "unchanged"
	| "stale"
	| "failed"
	| "disposed";

export interface RetainedProductionConditionalSyncTerminalResult {
	readonly status: RetainedProductionConditionalSyncTerminalStatus;
	readonly selectedIndex: number | null;
	readonly error?: unknown;
}

export interface RetainedProductionConditionalSyncParticipantClaim {
	readonly participantCount: number;
	isCurrent(): boolean;
	toCommitParticipants(): readonly RetainedCommitParticipant[];
	dispose(): void;
}

export type RetainedProductionConditionalSyncParticipantClaimResult =
	| {
		readonly status: "claimed";
		readonly claim: RetainedProductionConditionalSyncParticipantClaim;
	}
	| { readonly status: "stale" };

export interface RetainedPreparedProductionConditionalSyncChildren {
	readonly status: "prepared";
	readonly selectedIndex: number | null;
	readonly participantCount: number;
	isCurrent(): boolean;
	claimParticipants(): RetainedProductionConditionalSyncParticipantClaimResult;
	commit(transaction: RetainedCommitTransaction): RetainedCommitTransactionResult;
	dispose(): void;
}

export type RetainedProductionConditionalSyncPreparationResult =
	| RetainedPreparedProductionConditionalSyncChildren
	| RetainedProductionConditionalSyncTerminalResult
	| RetainedProductionConditionalSyncFallback;

export interface RetainedProductionConditionalSyncRequest {
	readonly node: IfNode;
	readonly sourceHash: string;
	readonly expressionContext: ExprContext;
}

export interface RetainedProductionConditionalSyncChildrenOptions {
	readonly evaluateExpression?: RetainedProductionConditionalEvaluator;
	readonly onCleanupError?: (error: unknown) => void;
	/** Optional owner-shell insertion point; must be a child of parent. */
	readonly before?: Node | null;
}

export type RetainedProductionConditionalSyncEvaluator = (
	expression: CompiledExpression,
	context: ExprContext,
) => Promise<ExprValue>;

type SyncSlotKind = "text" | "attribute";

interface SyncSlotSpec {
	readonly id: string;
	readonly kind: SyncSlotKind;
}

interface BranchPlan {
	readonly plan: RetainedTemplateDomPlan<CompiledExpression>;
	readonly nodes: readonly RetainedTemplateIrNode<CompiledExpression>[];
	readonly slots: readonly SyncSlotSpec[];
}

type PatchParticipantState =
	| "prepared"
	| "applying"
	| "applied"
	| "adopted"
	| "rolled-back"
	| "finalized"
	| "discarded";

type SnapshotParticipantState =
	| "prepared"
	| "applied"
	| "adopted"
	| "rolled-back"
	| "finalized"
	| "discarded";

/**
 * Synchronous child composer for the production retained `{% if %}` selector.
 * New branches initialize off-DOM; same-active updates become rollback-capable
 * owner-transaction participants. Unsupported children fail closed before any
 * condition expression executes.
 */
export class RetainedProductionConditionalSyncChildren {
	private readonly selector: RetainedProductionConditionalSelector;
	private readonly evaluateExpression: RetainedProductionConditionalEvaluator;
	private readonly ownerDocument: Document;
	private preparationGeneration = 0;
	private committedIndex: number | null = null;
	private committedValues = new Map<string, string>();
	private disposed = false;

	constructor(
		parent: HTMLElement,
		options: RetainedProductionConditionalSyncChildrenOptions = {},
	) {
		this.ownerDocument = parent.ownerDocument;
		this.evaluateExpression = options.evaluateExpression ?? evaluateCompiledExpression;
		this.selector = new RetainedProductionConditionalSelector(parent, {
			evaluateExpression: this.evaluateExpression,
			onCleanupError: options.onCleanupError,
			before: options.before,
		});
	}

	get isDisposed(): boolean {
		return this.disposed;
	}

	get activeIndex(): number | null {
		return this.selector.activeIndex;
	}

	get activeSlots(): RetainedKeyedSlotScope | null {
		return this.selector.activeSlots;
	}

	get nodes(): readonly Node[] {
		return this.selector.nodes;
	}

	async prepare(
		request: RetainedProductionConditionalSyncRequest,
	): Promise<RetainedProductionConditionalSyncPreparationResult> {
		if (this.disposed) return this.terminal("disposed");

		const generation = ++this.preparationGeneration;
		const support = inspectRetainedProductionConditionalSyncSupport(request.node);
		if (support) return support;

		let plans: readonly BranchPlan[];
		try {
			plans = request.node.branches.map((branch, index) =>
				createBranchPlan(request.sourceHash, index, branch.children));
		} catch (error) {
			return this.terminal("failed", error);
		}

		const selection = await this.selector.prepare(
			request.node,
			request.expressionContext,
			(_branch, index) => plans[index].plan.builder(),
		);
		if (!this.isPreparationCurrent(generation)) {
			if (selection.status === "prepared") selection.dispose();
			return this.terminal(this.disposed ? "disposed" : "stale");
		}
		if (selection.status === "failed") return this.terminal("failed", selection.error);
		if (selection.status === "stale" || selection.status === "disposed") {
			return this.terminal(selection.status);
		}

		const selectedIndex = selection.selectedIndex;
		if (selectedIndex === null) {
			if (selection.status !== "prepared") {
				if (this.committedIndex !== null) return this.stateMismatchFailure();
				return this.terminal("unchanged");
			}
			return this.prepareBranchChange(selection, null, new Map(), generation);
		}

		let nextValues: Map<string, string>;
		try {
			nextValues = await this.evaluateBranchValues(
				plans[selectedIndex],
				request.expressionContext,
				generation,
			);
		} catch (error) {
			if (selection.status === "prepared") selection.dispose();
			if (!this.isPreparationCurrent(generation)) {
				return this.terminal(this.disposed ? "disposed" : "stale");
			}
			return this.terminal("failed", error);
		}

		if (!this.isPreparationCurrent(generation)) {
			if (selection.status === "prepared") selection.dispose();
			return this.terminal(this.disposed ? "disposed" : "stale");
		}

		if (selection.status === "prepared") {
			if (!selection.slots) {
				selection.dispose();
				return this.terminal(
					"failed",
					new Error("Selected conditional branch has no retained slot scope"),
				);
			}
			try {
				seedDetachedValues(selection.slots, plans[selectedIndex].slots, nextValues);
			} catch (error) {
				selection.dispose();
				return this.terminal("failed", error);
			}
			return this.prepareBranchChange(selection, selectedIndex, nextValues, generation);
		}

		if (this.committedIndex !== selectedIndex || this.activeSlots !== selection.slots) {
			return this.stateMismatchFailure();
		}
		if (mapsEqual(this.committedValues, nextValues)) return this.terminal("unchanged");
		if (!selection.slots) return this.stateMismatchFailure();

		const participant = this.createLivePatchParticipant(
			selection.slots,
			plans[selectedIndex].slots,
			nextValues,
			selectedIndex,
			generation,
		);
		return this.createPrepared([participant], generation, selectedIndex, []);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.preparationGeneration += 1;
		this.selector.dispose();
		this.committedIndex = null;
		this.committedValues.clear();
	}

	private prepareBranchChange(
		selection: RetainedPreparedProductionConditional,
		nextIndex: number | null,
		nextValues: Map<string, string>,
		generation: number,
	): RetainedPreparedProductionConditionalSyncChildren {
		const structural = selection.toCommitParticipant();
		const snapshot = this.createSnapshotParticipant(
			nextIndex,
			nextValues,
			generation,
			() => selection.isCurrent(),
		);
		return this.createPrepared(
			[structural, snapshot],
			generation,
			nextIndex,
			[() => selection.dispose()],
		);
	}

	private createLivePatchParticipant(
		slots: RetainedKeyedSlotScope,
		specs: readonly SyncSlotSpec[],
		nextValues: Map<string, string>,
		selectedIndex: number,
		generation: number,
	): RetainedCommitParticipant {
		const previousValues = new Map(this.committedValues);
		const changed = specs.filter((spec) => previousValues.get(spec.id) !== nextValues.get(spec.id));
		const applied: SyncSlotSpec[] = [];
		let state: PatchParticipantState = "prepared";
		let snapshotAdopted = false;
		const patch = (spec: SyncSlotSpec, value: string): void => {
			const status = spec.kind === "text"
				? slots.patchText(spec.id, value)
				: slots.patchAttribute(spec.id, value);
			if (status === "disposed") {
				throw new Error(`Retained conditional slot ${spec.id} was disposed during live patch`);
			}
		};

		return {
			isCurrent: () => state !== "finalized"
				&& state !== "discarded"
				&& this.isPreparationCurrent(generation)
				&& this.selector.activeIndex === selectedIndex
				&& this.selector.activeSlots === slots,
			apply: () => {
				if (state !== "prepared") throw new Error("Conditional sync child patch is not prepared");
				state = "applying";
				for (const spec of changed) {
					patch(spec, nextValues.get(spec.id) ?? "");
					applied.push(spec);
				}
				state = "applied";
			},
			adopt: () => {
				if (state !== "applied") throw new Error("Conditional sync child patch was not applied");
				this.committedValues = new Map(nextValues);
				this.committedIndex = selectedIndex;
				snapshotAdopted = true;
				state = "adopted";
			},
			rollback: () => {
				if (state !== "applying" && state !== "applied" && state !== "adopted") return;
				for (let index = applied.length - 1; index >= 0; index--) {
					const spec = applied[index];
					patch(spec, previousValues.get(spec.id) ?? "");
				}
				if (snapshotAdopted) {
					this.committedValues = previousValues;
					this.committedIndex = selectedIndex;
					snapshotAdopted = false;
				}
				state = "rolled-back";
			},
			finalize: () => {
				if (state === "adopted") state = "finalized";
			},
			discard: () => {
				if (state === "finalized" || state === "discarded") return;
				state = "discarded";
			},
		};
	}

	private createSnapshotParticipant(
		nextIndex: number | null,
		nextValues: Map<string, string>,
		generation: number,
		isStructuralCurrent: () => boolean,
	): RetainedCommitParticipant {
		const previousIndex = this.committedIndex;
		const previousValues = new Map(this.committedValues);
		let state: SnapshotParticipantState = "prepared";
		return {
			isCurrent: () => state !== "finalized"
				&& state !== "discarded"
				&& this.isPreparationCurrent(generation)
				&& isStructuralCurrent(),
			apply: () => {
				if (state !== "prepared") throw new Error("Conditional snapshot participant is not prepared");
				state = "applied";
			},
			adopt: () => {
				if (state !== "applied") throw new Error("Conditional snapshot participant was not applied");
				this.committedIndex = nextIndex;
				this.committedValues = new Map(nextValues);
				state = "adopted";
			},
			rollback: () => {
				if (state === "adopted") {
					this.committedIndex = previousIndex;
					this.committedValues = previousValues;
				}
				if (state === "applied" || state === "adopted") state = "rolled-back";
			},
			finalize: () => {
				if (state === "adopted") state = "finalized";
			},
			discard: () => {
				if (state === "finalized" || state === "discarded") return;
				state = "discarded";
			},
		};
	}

	private createPrepared(
		participants: readonly RetainedCommitParticipant[],
		generation: number,
		selectedIndex: number | null,
		sourceDisposers: readonly (() => void)[],
	): RetainedPreparedProductionConditionalSyncChildren {
		type Ownership = "owned" | "claimed" | "terminal";
		let ownership: Ownership = "owned";
		const frozenParticipants = Object.freeze([...participants]);
		const participantsCurrent = () => this.isPreparationCurrent(generation)
			&& frozenParticipants.every((participant) => participant.isCurrent());
		const disposeSources = () => {
			for (const dispose of sourceDisposers) dispose();
		};
		const disposeParticipants = () => {
			for (const participant of frozenParticipants) participant.discard();
			disposeSources();
		};

		return {
			status: "prepared",
			selectedIndex,
			participantCount: frozenParticipants.length,
			isCurrent: () => ownership === "owned" && participantsCurrent(),
			claimParticipants: () => {
				if (ownership !== "owned" || !participantsCurrent()) {
					if (ownership === "owned") {
						ownership = "terminal";
						disposeParticipants();
					}
					return { status: "stale" };
				}
				ownership = "claimed";
				let terminal = false;
				return {
					status: "claimed",
					claim: {
						participantCount: frozenParticipants.length,
						isCurrent: () => !terminal && participantsCurrent(),
						toCommitParticipants: () => frozenParticipants,
						dispose: () => {
							if (terminal) return;
							terminal = true;
							disposeParticipants();
						},
					},
				};
			},
			commit: (transaction) => {
				if (ownership !== "owned") return { status: "stale" };
				if (!participantsCurrent()) {
					ownership = "terminal";
					disposeParticipants();
					return { status: this.disposed ? "disposed" : "stale" };
				}
				const result = transaction.commit(frozenParticipants);
				ownership = "terminal";
				disposeSources();
				return result;
			},
			dispose: () => {
				if (ownership !== "owned") return;
				ownership = "terminal";
				disposeParticipants();
			},
		};
	}

	private async evaluateBranchValues(
		branch: BranchPlan,
		expressionContext: ExprContext,
		generation: number,
	): Promise<Map<string, string>> {
		const values = new Map<string, string>();
		const context: ExprContext = {
			...expressionContext,
			variables: { ...expressionContext.variables },
		};
		for (const node of branch.nodes) {
			if (!this.isPreparationCurrent(generation)) break;
			switch (node.kind) {
				case "static-fragment":
					break;
				case "set": {
					const value = await this.evaluateExpression(node.expression, context);
					if (!this.isPreparationCurrent(generation)) break;
					context.variables[node.variable] = value;
					break;
				}
				case "text-slot":
				case "expression-slot": {
					const value = await this.evaluateExpression(node.expression, context);
					if (!this.isPreparationCurrent(generation)) break;
					values.set(node.id, resultToString(value));
					break;
				}
				case "attribute-slot": {
					let assembled = "";
					for (const part of node.parts) {
						if (part.kind === "static") {
							assembled += decodeRetainedHtmlAttributeSource(
								this.ownerDocument,
								part.value,
								node.quote,
							);
							continue;
						}
						if (part.kind !== "expression") {
							throw new Error(`Unsupported conditional attribute part: ${part.kind}`);
						}
						const value = await this.evaluateExpression(part.expression, context);
						if (!this.isPreparationCurrent(generation)) break;
						assembled += resultToString(value);
					}
					if (this.isPreparationCurrent(generation)) values.set(node.id, assembled);
					break;
				}
				case "markdown-slot":
				case "content-slot":
				case "raw-html-slot":
				case "if":
				case "for":
					throw new Error(`Unsupported conditional sync child reached evaluation: ${node.kind}`);
			}
		}
		return values;
	}

	private isPreparationCurrent(generation: number): boolean {
		return !this.disposed && generation === this.preparationGeneration;
	}

	private terminal(
		status: RetainedProductionConditionalSyncTerminalStatus,
		error?: unknown,
	): RetainedProductionConditionalSyncTerminalResult {
		return {
			status,
			selectedIndex: this.activeIndex,
			...(error === undefined ? {} : { error }),
		};
	}

	private stateMismatchFailure(): RetainedProductionConditionalSyncTerminalResult {
		return this.terminal(
			"failed",
			new Error("Retained conditional child snapshot does not match active branch authority"),
		);
	}
}

export function inspectRetainedProductionConditionalSyncSupport(
	node: IfNode,
): RetainedProductionConditionalSyncFallback | null {
	for (let branchIndex = 0; branchIndex < node.branches.length; branchIndex++) {
		const children = node.branches[branchIndex].children;
		for (let childIndex = 0; childIndex < children.length; childIndex++) {
			const child = children[childIndex];
			const path = `branches[${branchIndex}].children[${childIndex}]`;
			switch (child.kind) {
				case "attribute-slot":
					if (!getCompleteAttributeSlot(child)) {
						return fallback(
							"attribute-slot",
							path,
							"requires complete compiler targetKey/quote/parts metadata",
						);
					}
					break;
				case "markdown-slot":
				case "content-slot":
					return fallback(
						"async-island",
						path,
						"requires prepared async-island child composition",
					);
				case "raw-html-slot":
					return fallback(
						"raw-html-range",
						path,
						"requires retained raw-HTML child range composition",
					);
				case "if":
				case "for":
					return fallback(
						"nested-structural-control-flow",
						path,
						"requires recursive retained structural child composition",
					);
				case "expression-slot":
					if (child.context !== "text") {
						return fallback(
							"non-text-expression-context",
							path,
							`has unsupported expression context '${child.context}'`,
						);
					}
					break;
				case "static-fragment":
				case "text-slot":
				case "set":
					break;
			}
		}
	}
	return null;
}

function createBranchPlan(
	outerSourceHash: string,
	branchIndex: number,
	children: readonly TemplateIRNode[],
): BranchPlan {
	const nodes = children.map(toRetainedNode);
	const ir: RetainedTemplateIrLike<CompiledExpression> = {
		version: 1,
		sourceHash: JSON.stringify([
			"morphic-production-if-sync-branch-v1",
			outerSourceHash,
			branchIndex,
		]),
		nodes,
	};
	const plan = new RetainedTemplateDomPlan(ir);
	return {
		plan,
		nodes,
		slots: nodes.flatMap((node): SyncSlotSpec[] => {
			if (node.kind === "text-slot" || node.kind === "expression-slot") {
				return [{ id: node.id, kind: "text" }];
			}
			if (node.kind === "attribute-slot") return [{ id: node.id, kind: "attribute" }];
			return [];
		}),
	};
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
		case "content-slot":
		case "raw-html-slot":
		case "if":
		case "for":
			throw new Error(`Unsupported retained conditional sync child: ${node.kind}`);
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

function seedDetachedValues(
	slots: RetainedKeyedSlotScope,
	specs: readonly SyncSlotSpec[],
	values: ReadonlyMap<string, string>,
): void {
	for (const spec of specs) {
		const value: RetainedScalar = values.get(spec.id) ?? "";
		const status = spec.kind === "text"
			? slots.patchText(spec.id, value)
			: slots.patchAttribute(spec.id, value);
		if (status === "disposed") {
			throw new Error(`Retained conditional slot ${spec.id} was disposed during detached initialization`);
		}
	}
}

function fallback(
	code: RetainedProductionConditionalSyncFallbackCode,
	path: string,
	reason: string,
): RetainedProductionConditionalSyncFallback {
	return {
		status: "fallback",
		code,
		path,
		message: `${path} ${reason}`,
	};
}

function mapsEqual(left: ReadonlyMap<string, string>, right: ReadonlyMap<string, string>): boolean {
	if (left.size !== right.size) return false;
	for (const [key, value] of left) {
		if (!right.has(key) || right.get(key) !== value) return false;
	}
	return true;
}
