import type {
	RetainedCommitParticipant,
	RetainedCommitTransaction,
	RetainedCommitTransactionResult,
} from "./retained-commit-transaction";

/**
 * Minimal structural contract implemented by prepared raw-HTML, conditional,
 * and keyed transaction ranges.
 *
 * This deliberately excludes leaf/async batches: those currently own multiple
 * internal participants and require a separate ownership-transfer contract
 * before they can join this batch without nested commits.
 */
export interface RetainedPreparedStructuralChange {
	isCurrent(): boolean;
	toCommitParticipant(): RetainedCommitParticipant;
	dispose(): void;
}

export interface RetainedStructuralTransactionBatchOptions {
	onCleanupError?: (error: unknown) => void;
}

export type RetainedStructuralTransactionBatchPreparationResult =
	| { readonly status: "prepared"; readonly batch: RetainedStructuralTransactionBatch }
	| { readonly status: "unchanged" }
	| {
		readonly status: "failed";
		readonly error: unknown;
		readonly cleanupErrors?: readonly unknown[];
	};

export class RetainedStructuralTransactionBatchError extends Error {
	constructor(
		message: string,
		readonly code:
			| "duplicate-change"
			| "duplicate-participant"
			| "participant-failed",
		readonly cause?: unknown,
	) {
		super(message);
		this.name = "RetainedStructuralTransactionBatchError";
	}
}

interface CurrentCheck {
	readonly status: "current" | "stale" | "failed";
	readonly error?: unknown;
}

/**
 * One-shot owner of already-prepared structural transaction handles.
 *
 * The batch performs a no-mutation preflight across every source handle and
 * participant before delegating all live work to one RetainedCommitTransaction.
 * This is the composition boundary for raw HTML, conditional ranges and keyed
 * ranges: they either cross the same owner/currentness barrier together or the
 * transaction rolls every entered structural mutation back in reverse order.
 *
 * Source handles are terminalized after commit by calling their idempotent
 * dispose paths after their participants have already finalized/discarded. This
 * prevents accidental reuse of a prepared handle without changing live state.
 */
export class RetainedStructuralTransactionBatch {
	private terminal = false;

	private constructor(
		private readonly changes: readonly RetainedPreparedStructuralChange[],
		private readonly participants: readonly RetainedCommitParticipant[],
		private readonly options: RetainedStructuralTransactionBatchOptions,
	) {}

	static prepare(
		changes: readonly RetainedPreparedStructuralChange[],
		options: RetainedStructuralTransactionBatchOptions = {},
	): RetainedStructuralTransactionBatchPreparationResult {
		if (changes.length === 0) return { status: "unchanged" };

		const uniqueChanges = [...new Set(changes)];
		if (uniqueChanges.length !== changes.length) {
			const error = new RetainedStructuralTransactionBatchError(
				"Retained structural transaction batch contains a duplicate prepared change",
				"duplicate-change",
			);
			const cleanupErrors = cleanupChanges(uniqueChanges, options.onCleanupError);
			return withPreparationCleanupErrors({ status: "failed", error }, cleanupErrors);
		}

		const participants: RetainedCommitParticipant[] = [];
		try {
			for (const change of changes) participants.push(change.toCommitParticipant());
		} catch (cause) {
			const error = new RetainedStructuralTransactionBatchError(
				"Retained structural transaction participant creation failed",
				"participant-failed",
				cause,
			);
			const cleanupErrors = cleanupChanges(uniqueChanges, options.onCleanupError);
			return withPreparationCleanupErrors({ status: "failed", error }, cleanupErrors);
		}

		if (new Set(participants).size !== participants.length) {
			const error = new RetainedStructuralTransactionBatchError(
				"Retained structural transaction batch contains a duplicate commit participant",
				"duplicate-participant",
			);
			const cleanupErrors = cleanupChanges(uniqueChanges, options.onCleanupError);
			return withPreparationCleanupErrors({ status: "failed", error }, cleanupErrors);
		}

		return {
			status: "prepared",
			batch: new RetainedStructuralTransactionBatch(
				uniqueChanges,
				participants,
				options,
			),
		};
	}

	get participantCount(): number {
		return this.participants.length;
	}

	get isTerminal(): boolean {
		return this.terminal;
	}

	isCurrent(): boolean {
		return !this.terminal && this.checkCurrent().status === "current";
	}

	commit(transaction: RetainedCommitTransaction): RetainedCommitTransactionResult {
		if (this.terminal) return { status: "stale" };

		const current = this.checkCurrent();
		if (current.status !== "current") {
			this.terminal = true;
			const cleanupErrors = this.cleanupChanges();
			return withResultCleanupErrors(
				current.status === "stale"
					? { status: "stale" }
					: { status: "failed", error: current.error },
				cleanupErrors,
			);
		}

		const result = transaction.commit(this.participants);
		this.terminal = true;
		const cleanupErrors = this.cleanupChanges();
		return withResultCleanupErrors(result, cleanupErrors);
	}

	dispose(): void {
		if (this.terminal) return;
		this.terminal = true;
		this.cleanupChanges();
	}

	private checkCurrent(): CurrentCheck {
		try {
			for (const change of this.changes) {
				if (!change.isCurrent()) return { status: "stale" };
			}
			for (const participant of this.participants) {
				if (!participant.isCurrent()) return { status: "stale" };
			}
			return { status: "current" };
		} catch (error) {
			return { status: "failed", error };
		}
	}

	private cleanupChanges(): unknown[] {
		return cleanupChanges(this.changes, this.options.onCleanupError);
	}
}

function cleanupChanges(
	changes: readonly RetainedPreparedStructuralChange[],
	onCleanupError?: (error: unknown) => void,
): unknown[] {
	const errors: unknown[] = [];
	for (const change of changes) {
		try {
			change.dispose();
		} catch (error) {
			errors.push(error);
			if (!onCleanupError) continue;
			try {
				onCleanupError(error);
			} catch {
				// Cleanup reporting is diagnostic only and cannot interrupt sibling cleanup.
			}
		}
	}
	return errors;
}

function withPreparationCleanupErrors(
	result: Extract<RetainedStructuralTransactionBatchPreparationResult, { status: "failed" }>,
	cleanupErrors: readonly unknown[],
): Extract<RetainedStructuralTransactionBatchPreparationResult, { status: "failed" }> {
	return cleanupErrors.length > 0 ? { ...result, cleanupErrors } : result;
}

function withResultCleanupErrors(
	result: RetainedCommitTransactionResult,
	cleanupErrors: readonly unknown[],
): RetainedCommitTransactionResult {
	if (cleanupErrors.length === 0) return result;
	const combined = [...(result.cleanupErrors ?? []), ...cleanupErrors];
	return { ...result, cleanupErrors: combined };
}
