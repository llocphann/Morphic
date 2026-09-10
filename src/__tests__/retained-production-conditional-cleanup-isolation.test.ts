import { describe, expect, it, vi } from "vitest";
import type { RetainedCommitParticipant } from "../render/retained-commit-transaction";
import type {
	RetainedKeyedPreparedIslandClaim,
	RetainedPreparedKeyedIslandBatch,
} from "../render/retained-keyed-prepared-island-batch";
import { claimRetainedProductionConditionalPreparedChildren } from "../render/retained-production-conditional-prepared-children";
import type {
	RetainedPreparedProductionConditionalSyncChildren,
	RetainedProductionConditionalSyncParticipantClaim,
} from "../render/retained-production-conditional-sync-children";

function createParticipant(): RetainedCommitParticipant {
	return {
		isCurrent: () => true,
		apply: () => undefined,
		adopt: () => undefined,
		rollback: () => undefined,
		finalize: () => undefined,
		discard: () => undefined,
	};
}

function createPreparedSources(
	participants: readonly RetainedCommitParticipant[],
	islandDispose: () => void,
	syncDispose: () => void,
): {
	readonly sync: RetainedPreparedProductionConditionalSyncChildren;
	readonly islands: RetainedPreparedKeyedIslandBatch;
} {
	const syncClaim: RetainedProductionConditionalSyncParticipantClaim = {
		participantCount: participants.length,
		isCurrent: () => true,
		toCommitParticipants: () => participants,
		dispose: syncDispose,
	};
	const islandClaim: RetainedKeyedPreparedIslandClaim = {
		participantCount: participants.length,
		isCurrent: () => true,
		toCommitParticipants: () => participants,
		dispose: islandDispose,
	};
	return {
		sync: {
			status: "prepared",
			selectedIndex: 0,
			participantCount: participants.length,
			isCurrent: () => true,
			claimParticipants: () => ({ status: "claimed", claim: syncClaim }),
			commit: (transaction) => transaction.commit(participants),
			dispose: () => undefined,
		},
		islands: {
			status: "prepared",
			requestCount: participants.length,
			participantCount: participants.length,
			isCurrent: () => true,
			claimParticipants: () => ({ status: "claimed", claim: islandClaim }),
			commit: (transaction) => transaction.commit(participants),
			dispose: () => undefined,
		},
	};
}

describe("retained conditional claim cleanup isolation", () => {
	it("attempts conditional cleanup when island claim disposal throws", () => {
		const failure = new Error("Island cleanup failed");
		const islandDispose = vi.fn(() => {
			throw failure;
		});
		const syncDispose = vi.fn();
		const sources = createPreparedSources([], islandDispose, syncDispose);
		const result = claimRetainedProductionConditionalPreparedChildren(
			sources.sync,
			sources.islands,
		);
		expect(result.status).toBe("claimed");
		if (result.status !== "claimed") return;

		expect(() => result.claim.dispose()).not.toThrow();
		expect(islandDispose).toHaveBeenCalledTimes(1);
		expect(syncDispose).toHaveBeenCalledTimes(1);
		expect(() => result.claim.dispose()).not.toThrow();
		expect(islandDispose).toHaveBeenCalledTimes(1);
		expect(syncDispose).toHaveBeenCalledTimes(1);
	});

	it("isolates cleanup failures on duplicate-participant rejection", () => {
		const shared = createParticipant();
		const islandDispose = vi.fn(() => {
			throw new Error("Island cleanup failed");
		});
		const syncDispose = vi.fn();
		const sources = createPreparedSources([shared], islandDispose, syncDispose);

		expect(() => {
			const result = claimRetainedProductionConditionalPreparedChildren(
				sources.sync,
				sources.islands,
			);
			expect(result.status).toBe("failed");
		}).not.toThrow();
		expect(islandDispose).toHaveBeenCalledTimes(1);
		expect(syncDispose).toHaveBeenCalledTimes(1);
	});

	it("preserves stale sync authority when unclaimed island cleanup throws", () => {
		const islandDispose = vi.fn(() => {
			throw new Error("Unclaimed island cleanup failed");
		});
		const sync: RetainedPreparedProductionConditionalSyncChildren = {
			status: "prepared",
			selectedIndex: 0,
			participantCount: 0,
			isCurrent: () => false,
			claimParticipants: () => ({ status: "stale" }),
			commit: (transaction) => transaction.commit([]),
			dispose: () => undefined,
		};
		const islands: RetainedPreparedKeyedIslandBatch = {
			status: "prepared",
			requestCount: 1,
			participantCount: 1,
			isCurrent: () => true,
			claimParticipants: () => {
				throw new Error("Island claim must not run after stale sync claim");
			},
			commit: (transaction) => transaction.commit([]),
			dispose: islandDispose,
		};

		expect(() => {
			expect(claimRetainedProductionConditionalPreparedChildren(sync, islands)).toEqual({
				status: "stale",
			});
		}).not.toThrow();
		expect(islandDispose).toHaveBeenCalledTimes(1);
	});

	it("preserves island failure authority when transferred sync cleanup throws", () => {
		const islandFailure = new Error("Island claim failed");
		const syncDispose = vi.fn(() => {
			throw new Error("Transferred sync cleanup failed");
		});
		const syncClaim: RetainedProductionConditionalSyncParticipantClaim = {
			participantCount: 0,
			isCurrent: () => true,
			toCommitParticipants: () => [],
			dispose: syncDispose,
		};
		const sync: RetainedPreparedProductionConditionalSyncChildren = {
			status: "prepared",
			selectedIndex: 0,
			participantCount: 0,
			isCurrent: () => true,
			claimParticipants: () => ({ status: "claimed", claim: syncClaim }),
			commit: (transaction) => transaction.commit([]),
			dispose: () => undefined,
		};
		const islands: RetainedPreparedKeyedIslandBatch = {
			status: "prepared",
			requestCount: 1,
			participantCount: 1,
			isCurrent: () => false,
			claimParticipants: () => ({ status: "failed", error: islandFailure }),
			commit: (transaction) => transaction.commit([]),
			dispose: () => undefined,
		};

		expect(() => {
			expect(claimRetainedProductionConditionalPreparedChildren(sync, islands)).toEqual({
				status: "failed",
				error: islandFailure,
			});
		}).not.toThrow();
		expect(syncDispose).toHaveBeenCalledTimes(1);
	});
});
