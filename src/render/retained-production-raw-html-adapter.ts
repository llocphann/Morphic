import {
	evaluateCompiledExpression,
	type CompiledExpression,
} from "../compiler/expression-compiler";
import type { RawHtmlSlot } from "../compiler/template-ir";
import type { ExprContext, ExprValue } from "../expression";
import { resultToString } from "../renderer";
import type {
	RetainedCommitParticipant,
	RetainedCommitTransaction,
	RetainedCommitTransactionResult,
} from "./retained-commit-transaction";
import {
	RetainedRawHtmlTransactionRange,
	type RetainedPreparedRawHtmlPatch,
	type RetainedRawHtmlTransactionRangeOptions,
} from "./retained-raw-html-transaction-range";

export type RetainedProductionRawHtmlStatus =
	| "prepared"
	| "unchanged"
	| "stale"
	| "failed"
	| "disposed";

export interface RetainedProductionRawHtmlTerminalResult {
	readonly status: Exclude<RetainedProductionRawHtmlStatus, "prepared">;
	readonly error?: unknown;
}

export interface RetainedPreparedProductionRawHtmlPatch {
	readonly status: "prepared";
	isCurrent(): boolean;
	toCommitParticipant(): RetainedCommitParticipant;
	commit(transaction: RetainedCommitTransaction): RetainedCommitTransactionResult;
	dispose(): void;
}

export type RetainedProductionRawHtmlPreparationResult =
	| RetainedPreparedProductionRawHtmlPatch
	| RetainedProductionRawHtmlTerminalResult;

export type RetainedProductionRawHtmlEvaluator = (
	expression: CompiledExpression,
	context: ExprContext,
) => Promise<ExprValue>;

export interface RetainedProductionRawHtmlAdapterOptions
	extends RetainedRawHtmlTransactionRangeOptions {
	/** Test seam only; production uses Bot 2's compiled evaluator. */
	readonly evaluateExpression?: RetainedProductionRawHtmlEvaluator;
}

/**
 * Production-facing bridge from compiler `RawHtmlSlot` to the rollback-capable
 * retained raw-HTML range.
 *
 * The adapter deliberately does not own a full template or owner transaction.
 * It evaluates exactly one explicit raw-HTML expression, keeps parsing/staging
 * detached through `RetainedRawHtmlTransactionRange`, and exposes the resulting
 * participant for the caller's final synchronous owner commit.
 *
 * Every prepare request advances a local ticket before validation/evaluation.
 * That means an older already-prepared patch cannot commit after any newer
 * request, including a malformed request that fails before evaluation.
 */
export class RetainedProductionRawHtmlAdapter {
	private readonly range: RetainedRawHtmlTransactionRange;
	private readonly evaluateExpression: RetainedProductionRawHtmlEvaluator;
	private preparationGeneration = 0;
	private disposed = false;

	constructor(
		parent: HTMLElement,
		options: RetainedProductionRawHtmlAdapterOptions = {},
	) {
		const { evaluateExpression, ...rangeOptions } = options;
		this.range = new RetainedRawHtmlTransactionRange(parent, rangeOptions);
		this.evaluateExpression = evaluateExpression ?? evaluateCompiledExpression;
	}

	get isDisposed(): boolean {
		return this.disposed;
	}

	get currentHtml(): string | null {
		return this.range.currentHtml;
	}

	get nodes(): readonly Node[] {
		return this.range.nodes;
	}

	async prepare(
		slot: RawHtmlSlot,
		context: ExprContext,
	): Promise<RetainedProductionRawHtmlPreparationResult> {
		if (this.disposed) return { status: "disposed" };
		const generation = ++this.preparationGeneration;
		if (slot.kind !== "raw-html-slot" || slot.explicitRawHtml !== true) {
			return {
				status: "failed",
				error: new Error("Retained production raw HTML requires an explicit RawHtmlSlot"),
			};
		}

		let value: ExprValue;
		try {
			value = await this.evaluateExpression(slot.expression, context);
		} catch (error) {
			if (!this.isPreparationCurrent(generation)) {
				return { status: this.disposed ? "disposed" : "stale" };
			}
			return { status: "failed", error };
		}

		if (!this.isPreparationCurrent(generation)) {
			return { status: this.disposed ? "disposed" : "stale" };
		}

		const prepared = this.range.prepare({
			explicitRawHtml: true,
			html: resultToString(value),
		});
		if (prepared.status !== "prepared") return prepared;
		return this.wrapPrepared(prepared, generation);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.preparationGeneration += 1;
		this.range.dispose();
	}

	private wrapPrepared(
		prepared: RetainedPreparedRawHtmlPatch,
		generation: number,
	): RetainedPreparedProductionRawHtmlPatch {
		const base = prepared.toCommitParticipant();
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
			isCurrent: () => participant.isCurrent(),
			toCommitParticipant: () => participant,
			commit: (transaction) => {
				if (terminal) return { status: this.disposed ? "disposed" : "stale" };
				if (!this.isPreparationCurrent(generation)) {
					terminal = true;
					participant.discard();
					return { status: this.disposed ? "disposed" : "stale" };
				}
				const result = transaction.commit([participant]);
				terminal = true;
				return result;
			},
			dispose: () => {
				if (terminal) return;
				terminal = true;
				participant.discard();
			},
		};
	}

	private isPreparationCurrent(generation: number): boolean {
		return !this.disposed && generation === this.preparationGeneration;
	}
}
