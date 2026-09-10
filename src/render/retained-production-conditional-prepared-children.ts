import type {
	RetainedCommitParticipant,
	RetainedCommitTransaction,
	RetainedCommitTransactionResult,
} from "./retained-commit-transaction";
import type {
	RetainedKeyedPreparedIslandClaim,
	RetainedPreparedKeyedIslandBatch,
} from "./retained-keyed-prepared-island-batch";
import type {
	RetainedPreparedProductionConditionalSyncChildren,
	RetainedProductionConditionalSyncParticipantClaim,
} from "./retained-production-conditional-sync-children";

export type RetainedProductionConditionalPreparedChildrenTerminalStatus =
	| "stale"
	| "failed"
	| "disposed";

export interface RetainedProductionConditionalPreparedChildrenTerminalResult {
	readonly status: RetainedProductionConditionalPreparedChildrenTerminalStatus;
	readonly error?: unknown;
}

export interface RetainedProductionConditionalPreparedChildrenClaim {
	readonly selectedIndex: number | null;
	readonly participantCount: number;
	readonly syncParticipantCount: number;
	readonly islandParticipantCount: number;
	isCurrent(): boolean;
	toCommitParticipants(): readonly RetainedCommitParticipant[];
	dispose(): void;
}

export type RetainedProductionConditionalPreparedChildrenClaimResult =
	| {
		readonly status: "claimed";
		readonly claim: RetainedProductionConditionalPreparedChildrenClaim;
	}
	| RetainedProductionConditionalPreparedChildrenTerminalResult;

/**
 * Transfer one prepared synchronous conditional generation and one prepared
 * branch-local Markdown/content batch into one owner transaction claim.
 *
 * Synchronous branch structure/value participants are emitted before async
 * island participants. A branch switch therefore makes the selected branch
 * targets live before island DOM applies, while reverse rollback restores the
 * islands before structural branch ownership.
 *
 * This coordinator deliberately owns no generation counter. Currentness remains
 * authoritative in both transferred source claims and is projected into every
 * outer transaction barrier by an internal no-op participant. Claim cleanup is
 * island-first so staged MarkdownRenderer resources cannot outlive a discarded
 * branch-local slot scope.
 */
export function claimRetainedProductionConditionalPreparedChildren(
	sync: RetainedPreparedProductionConditionalSyncChildren,
	islands: RetainedPreparedKeyedIslandBatch,
): RetainedProductionConditionalPreparedChildrenClaimResult {
	const syncResult = sync.claimParticipants();
	if (syncResult.status !== "claimed") {
		disposeBestEffort(() => islands.dispose());
		return { status: "stale" };
	}

	const islandResult = islands.claimParticipants();
	if (islandResult.status !== "claimed") {
		disposeBestEffort(() => syncResult.claim.dispose());
		return terminalFromIslandClaim(islandResult);
	}

	return combinePreparedClaims(sync.selectedIndex, syncResult.claim, islandResult.claim);
}

/**
 * Claim both prepared sources, commit them through one retained transaction,
 * then release the transferred claim regardless of commit outcome.
 */
export function commitRetainedProductionConditionalPreparedChildren(
	sync: RetainedPreparedProductionConditionalSyncChildren,
	islands: RetainedPreparedKeyedIslandBatch,
	transaction: RetainedCommitTransaction,
): RetainedCommitTransactionResult {
	const claimed = claimRetainedProductionConditionalPreparedChildren(sync, islands);
	if (claimed.status !== "claimed") {
		return {
			status: claimed.status,
			...(claimed.error === undefined ? {} : { error: claimed.error }),
		};
	}

	try {
		return transaction.commit(claimed.claim.toCommitParticipants());
	} finally {
		claimed.claim.dispose();
	}
}

function combinePreparedClaims(
	selectedIndex: number | null,
	sync: RetainedProductionConditionalSyncParticipantClaim,
	islands: RetainedKeyedPreparedIslandClaim,
): RetainedProductionConditionalPreparedChildrenClaimResult {
	const syncParticipants = sync.toCommitParticipants();
	const islandParticipants = islands.toCommitParticipants();
	const sourceParticipants = Object.freeze([
		...syncParticipants,
		...islandParticipants,
	]);

	if (new Set(sourceParticipants).size !== sourceParticipants.length) {
		disposeClaims(sync, islands);
		return {
			status: "failed",
			error: new Error("Duplicate retained conditional prepared child participant"),
		};
	}

	let terminal = false;
	const sourcesCurrent = () => !terminal && sync.isCurrent() && islands.isCurrent();
	const currentnessGuard: RetainedCommitParticipant = {
		isCurrent: sourcesCurrent,
		apply: () => undefined,
		adopt: () => undefined,
		rollback: () => undefined,
		finalize: () => undefined,
		discard: () => undefined,
	};
	const transactionParticipants = Object.freeze([
		currentnessGuard,
		...sourceParticipants,
	]);
	const claim: RetainedProductionConditionalPreparedChildrenClaim = {
		selectedIndex,
		// Public accounting excludes the internal currentness guard because it owns
		// no DOM/resource state and exists only to gate the outer transaction.
		participantCount: sourceParticipants.length,
		syncParticipantCount: syncParticipants.length,
		islandParticipantCount: islandParticipants.length,
		isCurrent: sourcesCurrent,
		toCommitParticipants: () => transactionParticipants,
		dispose: () => {
			if (terminal) return;
			terminal = true;
			disposeClaims(sync, islands);
		},
	};

	if (!claim.isCurrent()) {
		claim.dispose();
		return { status: "stale" };
	}

	return { status: "claimed", claim };
}

function disposeClaims(
	sync: RetainedProductionConditionalSyncParticipantClaim,
	islands: RetainedKeyedPreparedIslandClaim,
): void {
	// Release async render resources before the conditional structural claim can
	// dispose the selected branch-local slot scope. Cleanup is terminal best-effort:
	// one failing child disposer must never prevent sibling ownership release.
	disposeBestEffort(
		() => islands.dispose(),
		() => sync.dispose(),
	);
}

function disposeBestEffort(...disposers: readonly (() => void)[]): void {
	for (const dispose of disposers) {
		try {
			dispose();
		} catch {
			// Child cleanup diagnostics remain child-owned. This composition boundary
			// must preserve its authoritative terminal result and sibling teardown.
		}
	}
}

function terminalFromIslandClaim(
	result: Exclude<
		ReturnType<RetainedPreparedKeyedIslandBatch["claimParticipants"]>,
		{ readonly status: "claimed" }
	>,
): RetainedProductionConditionalPreparedChildrenTerminalResult {
	return {
		status: result.status,
		...(result.error === undefined ? {} : { error: result.error }),
	};
}
