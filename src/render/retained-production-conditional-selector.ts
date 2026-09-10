import {
	evaluateCompiledExpression,
	type CompiledExpression,
} from "../compiler/expression-compiler";
import type { IfBranch, IfNode } from "../compiler/template-ir";
import type { ExprContext, ExprValue } from "../expression";
import type {
	RetainedCommitParticipant,
	RetainedCommitTransaction,
	RetainedCommitTransactionResult,
} from "./retained-commit-transaction";
import {
	RetainedConditionalTransactionRange,
	type RetainedConditionalTransactionRangeOptions,
} from "./retained-conditional-transaction-range";
import type { RetainedKeyedSlotScope } from "./scoped-keyed-slot-runtime";
import type { RetainedStructureBuilder } from "./retained-slot-runtime";

export type RetainedProductionConditionalStatus =
	| "prepared"
	| "unchanged"
	| "stale"
	| "failed"
	| "disposed";

export interface RetainedProductionConditionalTerminalResult {
	readonly status: Exclude<RetainedProductionConditionalStatus, "prepared">;
	readonly selectedIndex: number | null;
	readonly slots: RetainedKeyedSlotScope | null;
	readonly error?: unknown;
}

export interface RetainedPreparedProductionConditional {
	readonly status: "prepared";
	readonly selectedIndex: number | null;
	readonly slots: RetainedKeyedSlotScope | null;
	isCurrent(): boolean;
	toCommitParticipant(): RetainedCommitParticipant;
	commit(transaction: RetainedCommitTransaction): RetainedCommitTransactionResult;
	dispose(): void;
}

export type RetainedProductionConditionalPreparationResult =
	| RetainedPreparedProductionConditional
	| RetainedProductionConditionalTerminalResult;

export type RetainedProductionConditionalEvaluator = (
	expression: CompiledExpression,
	context: ExprContext,
) => Promise<ExprValue>;

export type RetainedProductionConditionalBranchBuilder = (
	branch: IfBranch,
	index: number,
) => RetainedStructureBuilder;

export interface RetainedProductionConditionalSelectorOptions
	extends RetainedConditionalTransactionRangeOptions {
	/** Test seam only; production uses Bot 2's compiled evaluator. */
	readonly evaluateExpression?: RetainedProductionConditionalEvaluator;
}

/**
 * Production-facing selector from compiler `IfNode` to the rollback-capable
 * retained conditional range.
 *
 * This adapter owns branch selection only. It evaluates conditions lazily in
 * source order using legacy truthiness, reserves generation authority before
 * validation/evaluation, and exposes the selected branch's collision-free slot
 * scope through the canonical conditional transaction handle.
 *
 * Child rendering is deliberately supplied by the next composition layer. That
 * keeps nested structural/raw/async capability fail-closed rather than silently
 * weakening compiler semantics inside this selector.
 */
export class RetainedProductionConditionalSelector {
	private readonly range: RetainedConditionalTransactionRange<number>;
	private readonly evaluateExpression: RetainedProductionConditionalEvaluator;
	private preparationGeneration = 0;
	private disposed = false;

	constructor(
		parent: HTMLElement,
		options: RetainedProductionConditionalSelectorOptions = {},
	) {
		const { evaluateExpression, ...rangeOptions } = options;
		this.range = new RetainedConditionalTransactionRange<number>(parent, rangeOptions);
		this.evaluateExpression = evaluateExpression ?? evaluateCompiledExpression;
	}

	get isDisposed(): boolean {
		return this.disposed;
	}

	get activeIndex(): number | null {
		return this.range.activeKey;
	}

	get activeSlots(): RetainedKeyedSlotScope | null {
		return this.range.activeSlots;
	}

	get nodes(): readonly Node[] {
		return this.range.nodes;
	}

	async prepare(
		node: IfNode,
		context: ExprContext,
		buildBranch: RetainedProductionConditionalBranchBuilder,
	): Promise<RetainedProductionConditionalPreparationResult> {
		if (this.disposed) return this.terminal("disposed");

		// A newer request owns selection authority even when it is malformed or
		// resolves to the already-active branch. Older prepared work must stale.
		const generation = ++this.preparationGeneration;
		const validationError = validateIfNode(node);
		if (validationError) return this.terminal("failed", validationError);

		let selectedIndex: number | null;
		try {
			selectedIndex = await this.selectBranch(node, context, generation);
		} catch (error) {
			if (!this.isPreparationCurrent(generation)) {
				return this.terminal(this.disposed ? "disposed" : "stale");
			}
			return this.terminal("failed", error);
		}

		if (!this.isPreparationCurrent(generation)) {
			return this.terminal(this.disposed ? "disposed" : "stale");
		}

		if (selectedIndex === null) {
			return this.wrapRangeResult(this.range.clear(), generation);
		}

		if (Object.is(this.range.activeKey, selectedIndex)) {
			// Same-branch selection is a zero-build path. The range checks identity
			// before touching this sentinel builder, so the caller factory is not run.
			return this.wrapRangeResult(
				this.range.select(selectedIndex, () => {
					throw new Error("Same conditional branch unexpectedly rebuilt");
				}),
				generation,
			);
		}

		let builder: RetainedStructureBuilder;
		try {
			builder = buildBranch(node.branches[selectedIndex], selectedIndex);
		} catch (error) {
			return this.terminal("failed", error);
		}
		if (!this.isPreparationCurrent(generation)) {
			return this.terminal(this.disposed ? "disposed" : "stale");
		}

		return this.wrapRangeResult(this.range.select(selectedIndex, builder), generation);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.preparationGeneration += 1;
		this.range.dispose();
	}

	private async selectBranch(
		node: IfNode,
		context: ExprContext,
		generation: number,
	): Promise<number | null> {
		for (let index = 0; index < node.branches.length; index++) {
			const branch = node.branches[index];
			if (branch.condition === null) return index;

			const value = await this.evaluateExpression(branch.condition, context);
			if (!this.isPreparationCurrent(generation)) return null;
			if (isLegacyTruthy(value)) return index;
		}
		return null;
	}

	private wrapRangeResult(
		result: ReturnType<RetainedConditionalTransactionRange<number>["select"]>,
		generation: number,
	): RetainedProductionConditionalPreparationResult {
		if (result.status !== "prepared") {
			return {
				status: result.status,
				selectedIndex: result.activeKey,
				slots: result.slots,
				...(result.error === undefined ? {} : { error: result.error }),
			};
		}

		const base = result.toCommitParticipant();
		let terminal = false;
		const participant: RetainedCommitParticipant = {
			isCurrent: () => !terminal
				&& this.isPreparationCurrent(generation)
				&& base.isCurrent(),
			apply: () => base.apply(),
			adopt: base.adopt ? () => base.adopt?.() : undefined,
			rollback: () => base.rollback(),
			finalize: () => base.finalize(),
			discard: () => base.discard(),
		};

		return {
			status: "prepared",
			selectedIndex: result.key,
			slots: result.slots,
			isCurrent: () => participant.isCurrent(),
			toCommitParticipant: () => participant,
			commit: (transaction) => {
				if (terminal) return { status: this.disposed ? "disposed" : "stale" };
				if (!this.isPreparationCurrent(generation)) {
					terminal = true;
					participant.discard();
					return { status: this.disposed ? "disposed" : "stale" };
				}
				const commitResult = transaction.commit([participant]);
				terminal = true;
				return commitResult;
			},
			dispose: () => {
				if (terminal) return;
				terminal = true;
				participant.discard();
			},
		};
	}

	private terminal(
		status: Exclude<RetainedProductionConditionalStatus, "prepared">,
		error?: unknown,
	): RetainedProductionConditionalTerminalResult {
		return {
			status,
			selectedIndex: this.activeIndex,
			slots: this.activeSlots,
			...(error === undefined ? {} : { error }),
		};
	}

	private isPreparationCurrent(generation: number): boolean {
		return !this.disposed && generation === this.preparationGeneration;
	}
}

function validateIfNode(node: IfNode): Error | null {
	if (node.kind !== "if") {
		return new Error("Retained production conditional selector requires an IfNode");
	}

	let sawElse = false;
	for (let index = 0; index < node.branches.length; index++) {
		if (node.branches[index].condition !== null) continue;
		if (sawElse || index !== node.branches.length - 1) {
			return new Error("Retained conditional else branch must be unique and final");
		}
		sawElse = true;
	}
	return null;
}

/** Must remain byte-for-behavior compatible with expression-compiler truthiness. */
function isLegacyTruthy(value: ExprValue): boolean {
	if (value === null || value === undefined || value === false) return false;
	if (value === 0 || value === "") return false;
	if (Array.isArray(value) && value.length === 0) return false;
	return true;
}
