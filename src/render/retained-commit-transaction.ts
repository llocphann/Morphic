export type RetainedCommitTransactionStatus =
	| "committed"
	| "stale"
	| "failed"
	| "poisoned"
	| "disposed";

export interface RetainedCommitTransactionResult {
	readonly status: RetainedCommitTransactionStatus;
	readonly error?: unknown;
	readonly rollbackErrors?: readonly unknown[];
	readonly cleanupErrors?: readonly unknown[];
}

/**
 * One synchronous participant in a retained owner commit.
 *
 * Contract:
 * - `isCurrent()` is side-effect free and may be called repeatedly;
 * - `apply()` performs the live mutation and may throw after a partial mutation;
 * - optional `adopt()` transfers reversible ownership/metadata after every live
 *   mutation succeeds, but must not perform irreversible cleanup;
 * - `rollback()` must restore the pre-apply live state and undo any completed
 *   adoption; it must be safe after an entered `apply()`/`adopt()` that threw;
 * - `finalize()` runs only after every participant has adopted successfully;
 *   irreversible previous-resource cleanup belongs here;
 * - `discard()` releases staged resources after stale/failed/rolled-back work.
 */
export interface RetainedCommitParticipant {
	isCurrent(): boolean;
	apply(): void;
	adopt?(): void;
	rollback(): void;
	finalize(): void;
	discard(): void;
}

export interface RetainedCommitTransactionOptions {
	onCleanupError?: (error: unknown) => void;
}

interface CurrentCheck {
	readonly status: "current" | "stale" | "failed" | "disposed";
	readonly error?: unknown;
}

/**
 * Synchronous all-or-rollback commit coordinator for one retained owner.
 *
 * This primitive intentionally contains no async preparation. Callers finish
 * asynchronous staging first, then invoke `commit()` only after every intended
 * participant exists. The transaction performs repeated owner/currentness
 * barriers, applies live mutations synchronously, adopts all reversible resource
 * ownership before any irreversible cleanup, and rolls back in reverse on a
 * stale/failure/disposal before the adoption barrier completes.
 *
 * A rollback failure is surfaced as `poisoned`; callers must not claim the live
 * surface is stable in that state and should fall back to an outer owner reset.
 */
export class RetainedCommitTransaction {
	private readonly onCleanupError?: (error: unknown) => void;
	private disposed = false;

	constructor(
		private readonly isOwnerCurrent: () => boolean,
		options: RetainedCommitTransactionOptions = {},
	) {
		this.onCleanupError = options.onCleanupError;
	}

	get isDisposed(): boolean {
		return this.disposed;
	}

	commit(
		participants: readonly RetainedCommitParticipant[],
	): RetainedCommitTransactionResult {
		const unique = this.uniqueParticipants(participants);
		if (this.disposed) {
			const cleanupErrors = this.discardAll(unique);
			return this.withCleanupErrors({ status: "disposed" }, cleanupErrors);
		}

		if (unique.length !== participants.length) {
			const error = new Error("Duplicate retained commit participant");
			const cleanupErrors = this.discardAll(unique);
			return this.withCleanupErrors({ status: "failed", error }, cleanupErrors);
		}

		const initial = this.checkCurrent(participants);
		if (initial.status !== "current") {
			const cleanupErrors = this.discardAll(unique);
			return this.withCleanupErrors(this.resultFromCheck(initial), cleanupErrors);
		}

		const applied: RetainedCommitParticipant[] = [];
		for (const participant of participants) {
			const beforeApply = this.checkCurrent(participants);
			if (beforeApply.status !== "current") {
				return this.abortApplied(
					participants,
					applied,
					beforeApply.status,
					beforeApply.error,
				);
			}

			// Include the participant before entering apply so a throw after a partial
			// mutation still receives rollback.
			applied.push(participant);
			try {
				participant.apply();
			} catch (error) {
				return this.abortApplied(participants, applied, "failed", error);
			}
		}

		const afterApply = this.checkCurrent(participants);
		if (afterApply.status !== "current") {
			return this.abortApplied(
				participants,
				applied,
				afterApply.status,
				afterApply.error,
			);
		}

		// Reversible ownership adoption is a separate barrier from cleanup. Every
		// participant gets authority over the live state before any previous-resource
		// disposer can reenter the runtime and invalidate another participant.
		for (const participant of participants) {
			const beforeAdopt = this.checkCurrent(participants);
			if (beforeAdopt.status !== "current") {
				return this.abortApplied(
					participants,
					applied,
					beforeAdopt.status,
					beforeAdopt.error,
				);
			}

			try {
				participant.adopt?.();
			} catch (error) {
				return this.abortApplied(participants, applied, "failed", error);
			}
		}

		const afterAdopt = this.checkCurrent(participants);
		if (afterAdopt.status !== "current") {
			return this.abortApplied(
				participants,
				applied,
				afterAdopt.status,
				afterAdopt.error,
			);
		}

		// From here, every participant already owns the committed live state. Cleanup
		// may reenter and schedule/commit newer work, so it is diagnostic-only and
		// cannot revoke this transaction's successful adoption.
		const cleanupErrors: unknown[] = [];
		for (const participant of participants) {
			this.runCleanup(() => participant.finalize(), cleanupErrors);
		}

		return this.withCleanupErrors({ status: "committed" }, cleanupErrors);
	}

	dispose(): void {
		this.disposed = true;
	}

	private checkCurrent(
		participants: readonly RetainedCommitParticipant[],
	): CurrentCheck {
		if (this.disposed) return { status: "disposed" };
		try {
			if (!this.isOwnerCurrent()) return { status: "stale" };
			if (this.disposed) return { status: "disposed" };
			for (const participant of participants) {
				const isCurrent = participant.isCurrent();
				if (this.disposed) return { status: "disposed" };
				if (!isCurrent) return { status: "stale" };
			}
			return { status: "current" };
		} catch (error) {
			return this.disposed ? { status: "disposed" } : { status: "failed", error };
		}
	}

	private abortApplied(
		participants: readonly RetainedCommitParticipant[],
		applied: readonly RetainedCommitParticipant[],
		status: "stale" | "failed" | "disposed",
		error?: unknown,
	): RetainedCommitTransactionResult {
		const rollbackErrors: unknown[] = [];
		for (let index = applied.length - 1; index >= 0; index--) {
			try {
				applied[index].rollback();
			} catch (rollbackError) {
				rollbackErrors.push(rollbackError);
				this.reportCleanupError(rollbackError);
			}
		}

		const cleanupErrors = this.discardAll(this.uniqueParticipants(participants));
		if (rollbackErrors.length > 0) {
			return this.withCleanupErrors({
				status: "poisoned",
				error,
				rollbackErrors,
			}, cleanupErrors);
		}

		return this.withCleanupErrors(
			status === "disposed"
				? { status: "disposed" }
				: status === "stale"
					? { status: "stale" }
					: { status: "failed", error },
			cleanupErrors,
		);
	}

	private resultFromCheck(check: Exclude<CurrentCheck, { status: "current" }>): RetainedCommitTransactionResult {
		if (check.status === "disposed") return { status: "disposed" };
		if (check.status === "stale") return { status: "stale" };
		return { status: "failed", error: check.error };
	}

	private discardAll(
		participants: readonly RetainedCommitParticipant[],
	): unknown[] {
		const cleanupErrors: unknown[] = [];
		for (const participant of participants) {
			this.runCleanup(() => participant.discard(), cleanupErrors);
		}
		return cleanupErrors;
	}

	private runCleanup(cleanup: () => void, errors: unknown[]): void {
		try {
			cleanup();
		} catch (error) {
			errors.push(error);
			this.reportCleanupError(error);
		}
	}

	private reportCleanupError(error: unknown): void {
		if (!this.onCleanupError) return;
		try {
			this.onCleanupError(error);
		} catch {
			// Cleanup reporting is diagnostic only and must not alter transaction state.
		}
	}

	private uniqueParticipants(
		participants: readonly RetainedCommitParticipant[],
	): RetainedCommitParticipant[] {
		return [...new Set(participants)];
	}

	private withCleanupErrors(
		result: RetainedCommitTransactionResult,
		cleanupErrors: readonly unknown[],
	): RetainedCommitTransactionResult {
		return cleanupErrors.length > 0 ? { ...result, cleanupErrors } : result;
	}
}

export interface RetainedDomReplacementParticipantOptions {
	isCurrent?: () => boolean;
	finalize?: () => void;
	discard?: () => void;
}

type DomParticipantState =
	| "prepared"
	| "applying"
	| "applied"
	| "adopted"
	| "rolled-back"
	| "finalized"
	| "discarded";

/**
 * Create a rollback-capable DOM replacement participant.
 *
 * The previous live child Nodes are retained by identity during the synchronous
 * transaction. They are not cloned, so rollback restores the exact Node objects
 * (and therefore their listener/editor identity) when a later participant fails.
 * This participant has no ownership metadata to adopt, so `adopt()` only marks
 * the reversible barrier. Irreversible old-resource disposal belongs in
 * `finalize`; staged-resource cleanup belongs in `discard`.
 */
export function createRetainedDomReplacementParticipant(
	target: HTMLElement,
	staging: HTMLElement,
	options: RetainedDomReplacementParticipantOptions = {},
): RetainedCommitParticipant {
	if (target.ownerDocument !== staging.ownerDocument) {
		throw new Error("Retained DOM transaction requires one owner document");
	}

	let state: DomParticipantState = "prepared";
	let previousNodes: Node[] = [];

	return {
		isCurrent(): boolean {
			if (state === "finalized" || state === "discarded") return false;
			return options.isCurrent?.() ?? true;
		},
		apply(): void {
			if (state !== "prepared") {
				throw new Error("Retained DOM participant is not prepared");
			}
			previousNodes = Array.from(target.childNodes);
			const nextNodes = Array.from(staging.childNodes);
			state = "applying";
			target.replaceChildren(...nextNodes);
			state = "applied";
		},
		adopt(): void {
			if (state !== "applied") {
				throw new Error("Retained DOM participant is not ready to adopt");
			}
			state = "adopted";
		},
		rollback(): void {
			if (state !== "applying" && state !== "applied" && state !== "adopted") return;
			target.replaceChildren(...previousNodes);
			state = "rolled-back";
		},
		finalize(): void {
			if (state !== "adopted") return;
			state = "finalized";
			options.finalize?.();
		},
		discard(): void {
			if (state === "finalized" || state === "discarded") return;
			state = "discarded";
			options.discard?.();
		},
	};
}
