import type {
	RetainedCommitParticipant,
	RetainedCommitTransaction,
	RetainedCommitTransactionResult,
} from "./retained-commit-transaction";
import type { RetainedLeafTemplateParticipantClaim } from "./retained-leaf-template-transaction";
import type { RetainedPreparedStructuralChange } from "./retained-structural-transaction-batch";

export interface RetainedUnifiedTransactionSources {
	readonly leafClaims?: readonly RetainedLeafTemplateParticipantClaim[];
	readonly structuralChanges?: readonly RetainedPreparedStructuralChange[];
}

export interface RetainedUnifiedTransactionBatchOptions {
	onCleanupError?: (error: unknown) => void;
}

export type RetainedUnifiedTransactionBatchPreparationResult =
	| { readonly status: "prepared"; readonly batch: RetainedUnifiedTransactionBatch }
	| { readonly status: "unchanged" }
	| {
		readonly status: "failed";
		readonly error: unknown;
		readonly cleanupErrors?: readonly unknown[];
	};

export class RetainedUnifiedTransactionBatchError extends Error {
	constructor(
		message: string,
		readonly code:
			| "duplicate-source"
			| "duplicate-participant"
			| "participant-failed",
		readonly cause?: unknown,
	) {
		super(message);
		this.name = "RetainedUnifiedTransactionBatchError";
	}
}

interface RetainedUnifiedTransactionSource {
	isCurrent(): boolean;
	dispose(): void;
}

interface CurrentCheck {
	readonly status: "current" | "stale" | "failed";
	readonly error?: unknown;
}

/**
 * One-shot composition boundary for leaf and structural retained work.
 *
 * Leaf claims already own their exact sync/Markdown/content participants, while
 * raw-HTML/conditional/keyed structural handles expose one participant each.
 * This batch flattens both source families into a single participant list and
 * delegates exactly one synchronous live mutation phase to
 * `RetainedCommitTransaction`.
 *
 * The source handles remain the staging owners until this batch becomes
 * terminal. After commit, stale preflight, failure, or explicit disposal, every
 * source is disposed once. Participant finalization/discard is idempotent, so
 * source terminalization cannot undo an authoritative transaction result.
 */
export class RetainedUnifiedTransactionBatch {
	private terminal = false;

	private constructor(
		private readonly sources: readonly RetainedUnifiedTransactionSource[],
		private readonly participants: readonly RetainedCommitParticipant[],
		private readonly options: RetainedUnifiedTransactionBatchOptions,
	) {}

	static prepare(
		sources: RetainedUnifiedTransactionSources,
		options: RetainedUnifiedTransactionBatchOptions = {},
	): RetainedUnifiedTransactionBatchPreparationResult {
		const leafClaims = sources.leafClaims ?? [];
		const structuralChanges = sources.structuralChanges ?? [];
		if (leafClaims.length === 0 && structuralChanges.length === 0) {
			return { status: "unchanged" };
		}

		const allSources: RetainedUnifiedTransactionSource[] = [
			...leafClaims,
			...structuralChanges,
		];
		const uniqueSources = [...new Set(allSources)];
		if (uniqueSources.length !== allSources.length) {
			const error = new RetainedUnifiedTransactionBatchError(
				"Retained unified transaction batch contains a duplicate prepared source",
				"duplicate-source",
			);
			const cleanupErrors = cleanupSources(uniqueSources, options.onCleanupError);
			return withPreparationCleanupErrors({ status: "failed", error }, cleanupErrors);
		}

		const participants: RetainedCommitParticipant[] = [];
		try {
			for (const claim of leafClaims) {
				participants.push(...claim.toCommitParticipants());
			}
			for (const change of structuralChanges) {
				participants.push(change.toCommitParticipant());
			}
		} catch (cause) {
			const error = new RetainedUnifiedTransactionBatchError(
				"Retained unified transaction participant collection failed",
				"participant-failed",
				cause,
			);
			const cleanupErrors = cleanupSources(uniqueSources, options.onCleanupError);
			return withPreparationCleanupErrors({ status: "failed", error }, cleanupErrors);
		}

		if (new Set(participants).size !== participants.length) {
			const error = new RetainedUnifiedTransactionBatchError(
				"Retained unified transaction batch contains a duplicate commit participant",
				"duplicate-participant",
			);
			const cleanupErrors = cleanupSources(uniqueSources, options.onCleanupError);
			return withPreparationCleanupErrors({ status: "failed", error }, cleanupErrors);
		}

		return {
			status: "prepared",
			batch: new RetainedUnifiedTransactionBatch(
				uniqueSources,
				Object.freeze([...participants]),
				options,
			),
		};
	}

	get sourceCount(): number {
		return this.sources.length;
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
			const cleanupErrors = this.cleanupSources();
			return withResultCleanupErrors(
				current.status === "stale"
					? { status: "stale" }
					: { status: "failed", error: current.error },
				cleanupErrors,
			);
		}

		const result = transaction.commit(this.participants);
		this.terminal = true;
		const cleanupErrors = this.cleanupSources();
		return withResultCleanupErrors(result, cleanupErrors);
	}

	dispose(): void {
		if (this.terminal) return;
		this.terminal = true;
		this.cleanupSources();
	}

	private checkCurrent(): CurrentCheck {
		try {
			for (const source of this.sources) {
				if (!source.isCurrent()) return { status: "stale" };
			}
			for (const participant of this.participants) {
				if (!participant.isCurrent()) return { status: "stale" };
			}
			return { status: "current" };
		} catch (error) {
			return { status: "failed", error };
		}
	}

	private cleanupSources(): unknown[] {
		return cleanupSources(this.sources, this.options.onCleanupError);
	}
}

function cleanupSources(
	sources: readonly RetainedUnifiedTransactionSource[],
	onCleanupError?: (error: unknown) => void,
): unknown[] {
	const errors: unknown[] = [];
	for (const source of sources) {
		try {
			source.dispose();
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
	result: Extract<RetainedUnifiedTransactionBatchPreparationResult, { status: "failed" }>,
	cleanupErrors: readonly unknown[],
): Extract<RetainedUnifiedTransactionBatchPreparationResult, { status: "failed" }> {
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
