import { describe, expect, it, vi } from "vitest";
import {
	RetainedCommitTransaction,
	createRetainedDomReplacementParticipant,
	type RetainedCommitParticipant,
} from "../render/retained-commit-transaction";
import type {
	RetainedKeyedPreparedIslandClaim,
	RetainedPreparedKeyedIslandBatch,
} from "../render/retained-keyed-prepared-island-batch";
import {
	claimRetainedProductionConditionalPreparedChildren,
	commitRetainedProductionConditionalPreparedChildren,
} from "../render/retained-production-conditional-prepared-children";
import type {
	RetainedPreparedProductionConditionalSyncChildren,
	RetainedProductionConditionalSyncParticipantClaim,
} from "../render/retained-production-conditional-sync-children";

function createOwnerDocument(): Document {
	return new DOMParser().parseFromString(
		"<!doctype html><html><body></body></html>",
		"text/html",
	);
}

function lifecycleParticipant(
	name: string,
	events: string[],
	options: {
		readonly current?: () => boolean;
		readonly onApply?: () => void;
	} = {},
): RetainedCommitParticipant {
	type State = "prepared" | "applied" | "adopted" | "rolled-back" | "finalized" | "discarded";
	let state: State = "prepared";
	return {
		isCurrent: () => state !== "rolled-back"
			&& state !== "finalized"
			&& state !== "discarded"
			&& (options.current?.() ?? true),
		apply: () => {
			events.push(`${name}:apply`);
			state = "applied";
			options.onApply?.();
		},
		adopt: () => {
			events.push(`${name}:adopt`);
			state = "adopted";
		},
		rollback: () => {
			if (state !== "applied" && state !== "adopted") return;
			events.push(`${name}:rollback`);
			state = "rolled-back";
		},
		finalize: () => {
			if (state !== "adopted") return;
			events.push(`${name}:finalize`);
			state = "finalized";
		},
		discard: () => {
			if (state === "finalized" || state === "discarded") return;
			events.push(`${name}:discard`);
			state = "discarded";
		},
	};
}

function throwingParticipant(error: Error): RetainedCommitParticipant {
	return {
		isCurrent: () => true,
		apply: () => {
			throw error;
		},
		rollback: vi.fn(),
		finalize: vi.fn(),
		discard: vi.fn(),
	};
}

interface ConditionalPreparedStub {
	readonly source: RetainedPreparedProductionConditionalSyncChildren;
	readonly sourceDispose: ReturnType<typeof vi.fn>;
	readonly claimDispose: ReturnType<typeof vi.fn>;
	readonly claimCalls: ReturnType<typeof vi.fn>;
	setSourceCurrent(value: boolean): void;
	setClaimCurrent(value: boolean): void;
}

function conditionalPrepared(
	participants: readonly RetainedCommitParticipant[],
	selectedIndex: number | null = 0,
	options: { readonly disposeEvents?: string[] } = {},
): ConditionalPreparedStub {
	let ownership: "owned" | "claimed" | "terminal" = "owned";
	let sourceCurrent = true;
	let claimCurrent = true;
	const claimCalls = vi.fn();
	const disposeParticipants = () => {
		for (const participant of participants) participant.discard();
	};
	const claimDispose = vi.fn(() => {
		options.disposeEvents?.push("conditional-dispose");
		claimCurrent = false;
		disposeParticipants();
	});
	const sourceDispose = vi.fn(() => {
		if (ownership !== "owned") return;
		ownership = "terminal";
		disposeParticipants();
	});
	const source: RetainedPreparedProductionConditionalSyncChildren = {
		status: "prepared",
		selectedIndex,
		participantCount: participants.length,
		isCurrent: () => ownership === "owned" && sourceCurrent,
		claimParticipants: () => {
			claimCalls();
			if (ownership !== "owned" || !sourceCurrent) {
				if (ownership === "owned") {
					ownership = "terminal";
					disposeParticipants();
				}
				return { status: "stale" };
			}
			ownership = "claimed";
			const claim: RetainedProductionConditionalSyncParticipantClaim = {
				participantCount: participants.length,
				isCurrent: () => claimCurrent,
				toCommitParticipants: () => participants,
				dispose: claimDispose,
			};
			return { status: "claimed", claim };
		},
		commit: (transaction) => transaction.commit(participants),
		dispose: sourceDispose,
	};
	return {
		source,
		sourceDispose,
		claimDispose,
		claimCalls,
		setSourceCurrent: (value) => {
			sourceCurrent = value;
		},
		setClaimCurrent: (value) => {
			claimCurrent = value;
		},
	};
}

interface IslandPreparedStub {
	readonly source: RetainedPreparedKeyedIslandBatch;
	readonly sourceDispose: ReturnType<typeof vi.fn>;
	readonly claimDispose: ReturnType<typeof vi.fn>;
	readonly claimCalls: ReturnType<typeof vi.fn>;
	setClaimCurrent(value: boolean): void;
}

function islandPrepared(
	participants: readonly RetainedCommitParticipant[],
	options: {
		readonly terminal?: "stale" | "failed" | "disposed";
		readonly error?: unknown;
		readonly disposeEvents?: string[];
	} = {},
): IslandPreparedStub {
	let ownership: "owned" | "claimed" | "terminal" = "owned";
	let claimCurrent = true;
	const claimCalls = vi.fn();
	const disposeParticipants = () => {
		for (const participant of participants) participant.discard();
	};
	const claimDispose = vi.fn(() => {
		options.disposeEvents?.push("island-dispose");
		claimCurrent = false;
		disposeParticipants();
	});
	const sourceDispose = vi.fn(() => {
		if (ownership !== "owned") return;
		ownership = "terminal";
		disposeParticipants();
	});
	const source: RetainedPreparedKeyedIslandBatch = {
		status: "prepared",
		requestCount: participants.length,
		participantCount: participants.length,
		isCurrent: () => ownership === "owned",
		claimParticipants: () => {
			claimCalls();
			if (ownership !== "owned") return { status: "stale" };
			if (options.terminal) {
				ownership = "terminal";
				disposeParticipants();
				return {
					status: options.terminal,
					...(options.error === undefined ? {} : { error: options.error }),
				};
			}
			ownership = "claimed";
			const claim: RetainedKeyedPreparedIslandClaim = {
				participantCount: participants.length,
				isCurrent: () => claimCurrent,
				toCommitParticipants: () => participants,
				dispose: claimDispose,
			};
			return { status: "claimed", claim };
		},
		commit: (transaction) => transaction.commit(participants),
		dispose: sourceDispose,
	};
	return {
		source,
		sourceDispose,
		claimDispose,
		claimCalls,
		setClaimCurrent: (value) => {
			claimCurrent = value;
		},
	};
}

describe("retained production conditional prepared children", () => {
	it("commits conditional sync participants before async islands through one transaction", () => {
		const events: string[] = [];
		const conditional = conditionalPrepared([lifecycleParticipant("conditional", events)], 1);
		const islands = islandPrepared([lifecycleParticipant("island", events)]);

		expect(commitRetainedProductionConditionalPreparedChildren(
			conditional.source,
			islands.source,
			new RetainedCommitTransaction(() => true),
		)).toEqual({ status: "committed" });
		expect(events).toEqual([
			"conditional:apply",
			"island:apply",
			"conditional:adopt",
			"island:adopt",
			"conditional:finalize",
			"island:finalize",
		]);
	});

	it("disposes unclaimed island staging when the conditional source is stale", () => {
		const conditional = conditionalPrepared([]);
		const islands = islandPrepared([]);
		conditional.setSourceCurrent(false);

		expect(claimRetainedProductionConditionalPreparedChildren(
			conditional.source,
			islands.source,
		)).toEqual({ status: "stale" });
		expect(conditional.claimCalls).toHaveBeenCalledTimes(1);
		expect(islands.claimCalls).not.toHaveBeenCalled();
		expect(islands.sourceDispose).toHaveBeenCalledTimes(1);
	});

	it("returns conditional cleanup authority when island claiming fails", () => {
		const error = new Error("Island claim failed");
		const conditional = conditionalPrepared([lifecycleParticipant("conditional", [])]);
		const islands = islandPrepared([], { terminal: "failed", error });

		const result = claimRetainedProductionConditionalPreparedChildren(
			conditional.source,
			islands.source,
		);
		expect(result.status).toBe("failed");
		if (result.status !== "failed") return;
		expect(result.error).toBe(error);
		expect(conditional.claimDispose).toHaveBeenCalledTimes(1);
	});

	it("rejects duplicate participant identity across conditional and island claims", () => {
		const participant = lifecycleParticipant("shared", []);
		const conditional = conditionalPrepared([participant]);
		const islands = islandPrepared([participant]);

		const result = claimRetainedProductionConditionalPreparedChildren(
			conditional.source,
			islands.source,
		);
		expect(result.status).toBe("failed");
		if (result.status !== "failed") return;
		expect(result.error).toBeInstanceOf(Error);
		expect(conditional.claimDispose).toHaveBeenCalledTimes(1);
		expect(islands.claimDispose).toHaveBeenCalledTimes(1);
	});

	it("rejects an immediately stale transferred island claim and cleans both sources", () => {
		const conditional = conditionalPrepared([lifecycleParticipant("conditional", [])]);
		const islands = islandPrepared([lifecycleParticipant("island", [])]);
		islands.setClaimCurrent(false);

		expect(claimRetainedProductionConditionalPreparedChildren(
			conditional.source,
			islands.source,
		)).toEqual({ status: "stale" });
		expect(conditional.claimDispose).toHaveBeenCalledTimes(1);
		expect(islands.claimDispose).toHaveBeenCalledTimes(1);
	});

	it("releases island resources before the conditional structural claim", () => {
		const disposeEvents: string[] = [];
		const conditional = conditionalPrepared([], 0, { disposeEvents });
		const islands = islandPrepared([], { disposeEvents });
		const claimed = claimRetainedProductionConditionalPreparedChildren(
			conditional.source,
			islands.source,
		);
		expect(claimed.status).toBe("claimed");
		if (claimed.status !== "claimed") return;

		claimed.claim.dispose();
		claimed.claim.dispose();
		expect(disposeEvents).toEqual(["island-dispose", "conditional-dispose"]);
	});

	it("rolls back island DOM before conditional DOM when a later owner participant fails", () => {
		const ownerDocument = createOwnerDocument();
		const conditionalTarget = ownerDocument.createElement("div");
		const islandTarget = ownerDocument.createElement("div");
		const conditionalOld = ownerDocument.createElement("span");
		const islandOld = ownerDocument.createElement("span");
		const conditionalNew = ownerDocument.createElement("strong");
		const islandNew = ownerDocument.createElement("strong");
		conditionalTarget.appendChild(conditionalOld);
		islandTarget.appendChild(islandOld);
		const conditionalStaging = ownerDocument.createElement("div");
		const islandStaging = ownerDocument.createElement("div");
		conditionalStaging.appendChild(conditionalNew);
		islandStaging.appendChild(islandNew);

		const conditional = conditionalPrepared([
			createRetainedDomReplacementParticipant(conditionalTarget, conditionalStaging),
		]);
		const islands = islandPrepared([
			createRetainedDomReplacementParticipant(islandTarget, islandStaging),
		]);
		const claimed = claimRetainedProductionConditionalPreparedChildren(
			conditional.source,
			islands.source,
		);
		expect(claimed.status).toBe("claimed");
		if (claimed.status !== "claimed") return;
		const failure = new Error("Outer owner failed");
		const result = new RetainedCommitTransaction(() => true).commit([
			...claimed.claim.toCommitParticipants(),
			throwingParticipant(failure),
		]);

		expect(result.status).toBe("failed");
		expect(result.error).toBe(failure);
		expect(conditionalTarget.firstChild).toBe(conditionalOld);
		expect(islandTarget.firstChild).toBe(islandOld);
		claimed.claim.dispose();
	});

	it("projects transferred claim currentness into every outer transaction barrier", () => {
		const events: string[] = [];
		const conditional = conditionalPrepared([], 0);
		const islands = islandPrepared([lifecycleParticipant("island", events)]);
		const syncParticipant = lifecycleParticipant("conditional", events, {
			onApply: () => islands.setClaimCurrent(false),
		});
		const conditionalWithParticipant = conditionalPrepared([syncParticipant], 0);
		const claimed = claimRetainedProductionConditionalPreparedChildren(
			conditionalWithParticipant.source,
			islands.source,
		);
		expect(claimed.status).toBe("claimed");
		if (claimed.status !== "claimed") return;

		expect(new RetainedCommitTransaction(() => true).commit(
			claimed.claim.toCommitParticipants(),
		)).toEqual({ status: "stale" });
		expect(events).toEqual([
			"conditional:apply",
			"conditional:rollback",
			"conditional:discard",
			"island:discard",
		]);
		claimed.claim.dispose();
		conditional.source.dispose();
	});

	it("lets the outer transaction reject a claim that becomes stale before commit", () => {
		const events: string[] = [];
		const conditional = conditionalPrepared([lifecycleParticipant("conditional", events)]);
		const islands = islandPrepared([lifecycleParticipant("island", events)]);
		const claimed = claimRetainedProductionConditionalPreparedChildren(
			conditional.source,
			islands.source,
		);
		expect(claimed.status).toBe("claimed");
		if (claimed.status !== "claimed") return;
		conditional.setClaimCurrent(false);

		expect(new RetainedCommitTransaction(() => true).commit(
			claimed.claim.toCommitParticipants(),
		)).toEqual({ status: "stale" });
		expect(events).toEqual(["conditional:discard", "island:discard"]);
		claimed.claim.dispose();
	});

	it("preserves selected branch identity and source participant accounting", () => {
		const conditional = conditionalPrepared([
			lifecycleParticipant("conditional-a", []),
			lifecycleParticipant("conditional-b", []),
		], null);
		const islands = islandPrepared([
			lifecycleParticipant("island-a", []),
			lifecycleParticipant("island-b", []),
			lifecycleParticipant("island-c", []),
		]);
		const claimed = claimRetainedProductionConditionalPreparedChildren(
			conditional.source,
			islands.source,
		);
		expect(claimed.status).toBe("claimed");
		if (claimed.status !== "claimed") return;

		expect(claimed.claim.selectedIndex).toBeNull();
		expect(claimed.claim.syncParticipantCount).toBe(2);
		expect(claimed.claim.islandParticipantCount).toBe(3);
		expect(claimed.claim.participantCount).toBe(5);
		claimed.claim.dispose();
	});
});
