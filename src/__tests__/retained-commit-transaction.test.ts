import { describe, expect, it, vi } from "vitest";
import {
	RetainedCommitTransaction,
	createRetainedDomReplacementParticipant,
	type RetainedCommitParticipant,
} from "../render/retained-commit-transaction";

function createOwnerDocument(): Document {
	return new DOMParser().parseFromString(
		"<!doctype html><html><body></body></html>",
		"text/html",
	);
}

function createDomPair(ownerDocument: Document, currentText: string, nextText: string) {
	const target = ownerDocument.createElement("div");
	const current = ownerDocument.createElement("span");
	current.textContent = currentText;
	target.appendChild(current);
	const staging = ownerDocument.createElement("div");
	const next = ownerDocument.createElement("strong");
	next.textContent = nextText;
	staging.appendChild(next);
	return { target, current, staging, next };
}

describe("RetainedCommitTransaction", () => {
	it("commits multiple DOM replacements before irreversible finalization", () => {
		const ownerDocument = createOwnerDocument();
		const first = createDomPair(ownerDocument, "First old", "First new");
		const second = createDomPair(ownerDocument, "Second old", "Second new");
		const finalizeOrder: string[] = [];
		const transaction = new RetainedCommitTransaction(() => true);

		const firstParticipant = createRetainedDomReplacementParticipant(
			first.target,
			first.staging,
			{
				finalize: () => {
					expect(first.target.firstChild).toBe(first.next);
					expect(second.target.firstChild).toBe(second.next);
					finalizeOrder.push("first");
				},
			},
		);
		const secondParticipant = createRetainedDomReplacementParticipant(
			second.target,
			second.staging,
			{ finalize: () => finalizeOrder.push("second") },
		);

		expect(transaction.commit([firstParticipant, secondParticipant])).toEqual({
			status: "committed",
		});
		expect(first.target.firstChild).toBe(first.next);
		expect(second.target.firstChild).toBe(second.next);
		expect(finalizeOrder).toEqual(["first", "second"]);
	});

	it("rejects owner staleness before any live mutation and discards staging", () => {
		const ownerDocument = createOwnerDocument();
		const pair = createDomPair(ownerDocument, "Stable", "Staged");
		const discard = vi.fn();
		const participant = createRetainedDomReplacementParticipant(
			pair.target,
			pair.staging,
			{ discard },
		);
		const transaction = new RetainedCommitTransaction(() => false);

		expect(transaction.commit([participant])).toEqual({ status: "stale" });
		expect(pair.target.firstChild).toBe(pair.current);
		expect(discard).toHaveBeenCalledTimes(1);
	});

	it("rejects participant staleness before any live mutation and discards every participant", () => {
		const ownerDocument = createOwnerDocument();
		const first = createDomPair(ownerDocument, "First old", "First new");
		const second = createDomPair(ownerDocument, "Second old", "Second new");
		const firstDiscard = vi.fn();
		const secondDiscard = vi.fn();
		const transaction = new RetainedCommitTransaction(() => true);
		const firstParticipant = createRetainedDomReplacementParticipant(
			first.target,
			first.staging,
			{ discard: firstDiscard },
		);
		const secondParticipant = createRetainedDomReplacementParticipant(
			second.target,
			second.staging,
			{ isCurrent: () => false, discard: secondDiscard },
		);

		expect(transaction.commit([firstParticipant, secondParticipant])).toEqual({
			status: "stale",
		});
		expect(first.target.firstChild).toBe(first.current);
		expect(second.target.firstChild).toBe(second.current);
		expect(firstDiscard).toHaveBeenCalledTimes(1);
		expect(secondDiscard).toHaveBeenCalledTimes(1);
	});

	it("rolls back earlier live DOM by Node identity when a later apply throws", () => {
		const ownerDocument = createOwnerDocument();
		const first = createDomPair(ownerDocument, "First old", "First new");
		const second = createDomPair(ownerDocument, "Second old", "Second new");
		const failure = new Error("Second apply failed");
		const firstDiscard = vi.fn();
		const secondDiscard = vi.fn();
		vi.spyOn(second.target, "replaceChildren").mockImplementationOnce(() => {
			throw failure;
		});
		const transaction = new RetainedCommitTransaction(() => true);

		const result = transaction.commit([
			createRetainedDomReplacementParticipant(first.target, first.staging, {
				discard: firstDiscard,
			}),
			createRetainedDomReplacementParticipant(second.target, second.staging, {
				discard: secondDiscard,
			}),
		]);

		expect(result.status).toBe("failed");
		expect(result.error).toBe(failure);
		expect(result.rollbackErrors).toBeUndefined();
		expect(first.target.firstChild).toBe(first.current);
		expect(second.target.firstChild).toBe(second.current);
		expect(firstDiscard).toHaveBeenCalledTimes(1);
		expect(secondDiscard).toHaveBeenCalledTimes(1);
	});

	it("rolls back when the owner becomes stale reentrantly between live mutations", () => {
		const ownerDocument = createOwnerDocument();
		const first = createDomPair(ownerDocument, "First old", "First new");
		const second = createDomPair(ownerDocument, "Second old", "Second new");
		let ownerCurrent = true;
		const originalReplace = first.target.replaceChildren.bind(first.target);
		vi.spyOn(first.target, "replaceChildren").mockImplementation((...nodes) => {
			originalReplace(...nodes);
			ownerCurrent = false;
		});
		const transaction = new RetainedCommitTransaction(() => ownerCurrent);

		expect(transaction.commit([
			createRetainedDomReplacementParticipant(first.target, first.staging),
			createRetainedDomReplacementParticipant(second.target, second.staging),
		])).toEqual({ status: "stale" });
		expect(first.target.firstChild).toBe(first.current);
		expect(second.target.firstChild).toBe(second.current);
	});

	it("surfaces rollback failure as poisoned instead of claiming a stable surface", () => {
		const applyFailure = new Error("Apply failed");
		const rollbackFailure = new Error("Rollback failed");
		const firstDiscard = vi.fn();
		const secondDiscard = vi.fn();
		const first: RetainedCommitParticipant = {
			isCurrent: () => true,
			apply: vi.fn(),
			rollback: () => {
				throw rollbackFailure;
			},
			finalize: vi.fn(),
			discard: firstDiscard,
		};
		const second: RetainedCommitParticipant = {
			isCurrent: () => true,
			apply: () => {
				throw applyFailure;
			},
			rollback: vi.fn(),
			finalize: vi.fn(),
			discard: secondDiscard,
		};
		const transaction = new RetainedCommitTransaction(() => true);

		const result = transaction.commit([first, second]);
		expect(result.status).toBe("poisoned");
		expect(result.error).toBe(applyFailure);
		expect(result.rollbackErrors).toEqual([rollbackFailure]);
		expect(firstDiscard).toHaveBeenCalledTimes(1);
		expect(secondDiscard).toHaveBeenCalledTimes(1);
	});

	it("keeps a successful live commit authoritative when finalization cleanup throws", () => {
		const ownerDocument = createOwnerDocument();
		const first = createDomPair(ownerDocument, "First old", "First new");
		const second = createDomPair(ownerDocument, "Second old", "Second new");
		const cleanupFailure = new Error("Old resource cleanup failed");
		const reported: unknown[] = [];
		const secondFinalize = vi.fn();
		const transaction = new RetainedCommitTransaction(() => true, {
			onCleanupError(error) {
				reported.push(error);
				throw new Error("Reporter failed");
			},
		});

		const result = transaction.commit([
			createRetainedDomReplacementParticipant(first.target, first.staging, {
				finalize: () => {
					throw cleanupFailure;
				},
			}),
			createRetainedDomReplacementParticipant(second.target, second.staging, {
				finalize: secondFinalize,
			}),
		]);

		expect(result.status).toBe("committed");
		expect(result.cleanupErrors).toEqual([cleanupFailure]);
		expect(first.target.firstChild).toBe(first.next);
		expect(second.target.firstChild).toBe(second.next);
		expect(secondFinalize).toHaveBeenCalledTimes(1);
		expect(reported).toEqual([cleanupFailure]);
	});

	it("rejects duplicate participants before live mutation and discards once", () => {
		const apply = vi.fn();
		const discard = vi.fn();
		const participant: RetainedCommitParticipant = {
			isCurrent: () => true,
			apply,
			rollback: vi.fn(),
			finalize: vi.fn(),
			discard,
		};
		const transaction = new RetainedCommitTransaction(() => true);

		const result = transaction.commit([participant, participant]);
		expect(result.status).toBe("failed");
		expect(apply).not.toHaveBeenCalled();
		expect(discard).toHaveBeenCalledTimes(1);
	});

	it("treats a throwing owner gate as failure and cleans staging without live mutation", () => {
		const gateFailure = new Error("Owner gate failed");
		const apply = vi.fn();
		const discard = vi.fn();
		const participant: RetainedCommitParticipant = {
			isCurrent: () => true,
			apply,
			rollback: vi.fn(),
			finalize: vi.fn(),
			discard,
		};
		const transaction = new RetainedCommitTransaction(() => {
			throw gateFailure;
		});

		const result = transaction.commit([participant]);
		expect(result.status).toBe("failed");
		expect(result.error).toBe(gateFailure);
		expect(apply).not.toHaveBeenCalled();
		expect(discard).toHaveBeenCalledTimes(1);
	});

	it("discards incoming staged participants after transaction disposal", () => {
		const apply = vi.fn();
		const discard = vi.fn();
		const participant: RetainedCommitParticipant = {
			isCurrent: () => true,
			apply,
			rollback: vi.fn(),
			finalize: vi.fn(),
			discard,
		};
		const transaction = new RetainedCommitTransaction(() => true);
		transaction.dispose();
		transaction.dispose();

		expect(transaction.commit([participant])).toEqual({ status: "disposed" });
		expect(apply).not.toHaveBeenCalled();
		expect(discard).toHaveBeenCalledTimes(1);
	});
});
