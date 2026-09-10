import { describe, expect, it, vi } from "vitest";
import {
	RetainedCommitTransaction,
	type RetainedCommitParticipant,
} from "../render/retained-commit-transaction";
import { RetainedKeyedTransactionRange } from "../render/retained-keyed-transaction-range";
import { RetainedRawHtmlTransactionRange } from "../render/retained-raw-html-transaction-range";
import {
	RetainedStructuralTransactionBatch,
	type RetainedPreparedStructuralChange,
} from "../render/retained-structural-transaction-batch";

function createOwnerDocument(): Document {
	return new DOMParser().parseFromString(
		"<!doctype html><html><body></body></html>",
		"text/html",
	);
}

function createSyntheticChange(input: {
	participant: RetainedCommitParticipant;
	current?: () => boolean;
	dispose?: () => void;
}): RetainedPreparedStructuralChange {
	return {
		isCurrent: input.current ?? (() => true),
		toCommitParticipant: () => input.participant,
		dispose: input.dispose ?? (() => {}),
	};
}

function createPassiveParticipant(overrides: Partial<RetainedCommitParticipant> = {}): RetainedCommitParticipant {
	return {
		isCurrent: () => true,
		apply: () => {},
		adopt: () => {},
		rollback: () => {},
		finalize: () => {},
		discard: () => {},
		...overrides,
	};
}

describe("RetainedStructuralTransactionBatch", () => {
	it("commits two raw structural ranges through one owner transaction", () => {
		const ownerDocument = createOwnerDocument();
		const parent = ownerDocument.createElement("section");
		ownerDocument.body.appendChild(parent);
		const first = new RetainedRawHtmlTransactionRange(parent, { label: "first" });
		const second = new RetainedRawHtmlTransactionRange(parent, { label: "second" });
		const firstPrepared = first.prepare({ explicitRawHtml: true, html: "<strong>First</strong>" });
		const secondPrepared = second.prepare({ explicitRawHtml: true, html: "<em>Second</em>" });
		expect(firstPrepared.status).toBe("prepared");
		expect(secondPrepared.status).toBe("prepared");
		if (firstPrepared.status !== "prepared" || secondPrepared.status !== "prepared") return;

		const prepared = RetainedStructuralTransactionBatch.prepare([firstPrepared, secondPrepared]);
		expect(prepared.status).toBe("prepared");
		if (prepared.status !== "prepared") return;
		expect(prepared.batch.participantCount).toBe(2);
		expect(prepared.batch.commit(new RetainedCommitTransaction(() => true))).toEqual({
			status: "committed",
		});
		expect(first.nodes[0]?.textContent).toBe("First");
		expect(second.nodes[0]?.textContent).toBe("Second");
	});

	it("composes keyed loop structure with another retained structural range", () => {
		const ownerDocument = createOwnerDocument();
		const parent = ownerDocument.createElement("section");
		ownerDocument.body.appendChild(parent);
		const raw = new RetainedRawHtmlTransactionRange(parent);
		const keyed = new RetainedKeyedTransactionRange<string>(parent);
		const rawPrepared = raw.prepare({ explicitRawHtml: true, html: "<i>Prefix</i>" });
		const keyedPrepared = keyed.prepare(["a", "b"], ({ key, slots }) =>
			slots.mount(({ ownerDocument: doc, fragment }) => {
				const node = doc.createElement("span");
				node.textContent = key.toUpperCase();
				fragment.appendChild(node);
			}, `entry:${key}`));
		expect(rawPrepared.status).toBe("prepared");
		expect(keyedPrepared.status).toBe("prepared");
		if (rawPrepared.status !== "prepared" || keyedPrepared.status !== "prepared") return;

		const prepared = RetainedStructuralTransactionBatch.prepare([rawPrepared, keyedPrepared]);
		expect(prepared.status).toBe("prepared");
		if (prepared.status !== "prepared") return;
		expect(prepared.batch.commit(new RetainedCommitTransaction(() => true)).status).toBe("committed");
		expect(keyed.keys).toEqual(["a", "b"]);
		expect(keyed.nodesFor("a")[0]?.textContent).toBe("A");
		expect(keyed.nodesFor("b")[0]?.textContent).toBe("B");
		expect(raw.nodes[0]?.textContent).toBe("Prefix");
	});

	it("rolls an earlier structural mutation back when a later participant apply fails", () => {
		const ownerDocument = createOwnerDocument();
		const parent = ownerDocument.createElement("section");
		ownerDocument.body.appendChild(parent);
		const raw = new RetainedRawHtmlTransactionRange(parent);
		const rawPrepared = raw.prepare({ explicitRawHtml: true, html: "<b>Next</b>" });
		if (rawPrepared.status !== "prepared") throw new Error("Expected raw preparation");
		const failure = new Error("Later structural apply failed");
		const laterDiscard = vi.fn();
		const later = createSyntheticChange({
			participant: createPassiveParticipant({
				apply: () => {
					throw failure;
				},
				discard: laterDiscard,
			}),
		});
		const prepared = RetainedStructuralTransactionBatch.prepare([rawPrepared, later]);
		if (prepared.status !== "prepared") throw new Error("Expected structural batch");

		const result = prepared.batch.commit(new RetainedCommitTransaction(() => true));
		expect(result.status).toBe("failed");
		expect(result.error).toBe(failure);
		expect(raw.currentHtml).toBeNull();
		expect(raw.nodes).toHaveLength(0);
		expect(laterDiscard).toHaveBeenCalledTimes(1);
	});

	it("rejects a stale source before live mutation and terminalizes every staged handle", () => {
		const ownerDocument = createOwnerDocument();
		const parent = ownerDocument.createElement("section");
		ownerDocument.body.appendChild(parent);
		const raw = new RetainedRawHtmlTransactionRange(parent);
		const rawPrepared = raw.prepare({ explicitRawHtml: true, html: "<b>Staged</b>" });
		if (rawPrepared.status !== "prepared") throw new Error("Expected raw preparation");
		const staleDispose = vi.fn();
		const stale = createSyntheticChange({
			participant: createPassiveParticipant(),
			current: () => false,
			dispose: staleDispose,
		});
		const prepared = RetainedStructuralTransactionBatch.prepare([rawPrepared, stale]);
		if (prepared.status !== "prepared") throw new Error("Expected structural batch");

		expect(prepared.batch.commit(new RetainedCommitTransaction(() => true))).toEqual({ status: "stale" });
		expect(raw.currentHtml).toBeNull();
		expect(rawPrepared.commit(new RetainedCommitTransaction(() => true))).toEqual({ status: "stale" });
		expect(staleDispose).toHaveBeenCalledTimes(1);
	});

	it("rejects duplicate prepared handles before any participant can apply", () => {
		const apply = vi.fn();
		const dispose = vi.fn();
		const change = createSyntheticChange({
			participant: createPassiveParticipant({ apply }),
			dispose,
		});

		const result = RetainedStructuralTransactionBatch.prepare([change, change]);
		expect(result.status).toBe("failed");
		if (result.status !== "failed") return;
		expect(result.error).toMatchObject({ code: "duplicate-change" });
		expect(apply).not.toHaveBeenCalled();
		expect(dispose).toHaveBeenCalledTimes(1);
	});

	it("rejects participant aliasing across distinct prepared handles", () => {
		const participant = createPassiveParticipant();
		const firstDispose = vi.fn();
		const secondDispose = vi.fn();
		const result = RetainedStructuralTransactionBatch.prepare([
			createSyntheticChange({ participant, dispose: firstDispose }),
			createSyntheticChange({ participant, dispose: secondDispose }),
		]);

		expect(result.status).toBe("failed");
		if (result.status !== "failed") return;
		expect(result.error).toMatchObject({ code: "duplicate-participant" });
		expect(firstDispose).toHaveBeenCalledTimes(1);
		expect(secondDispose).toHaveBeenCalledTimes(1);
	});

	it("rolls back the first real range when owner currentness changes before the second range", () => {
		const ownerDocument = createOwnerDocument();
		const parent = ownerDocument.createElement("section");
		ownerDocument.body.appendChild(parent);
		const first = new RetainedRawHtmlTransactionRange(parent, { label: "first" });
		const second = new RetainedRawHtmlTransactionRange(parent, { label: "second" });
		const firstPrepared = first.prepare({ explicitRawHtml: true, html: "<strong>Transient</strong>" });
		const secondPrepared = second.prepare({ explicitRawHtml: true, html: "<em>Never committed</em>" });
		if (firstPrepared.status !== "prepared" || secondPrepared.status !== "prepared") {
			throw new Error("Expected structural preparations");
		}

		let ownerCurrent = true;
		const originalInsert = parent.insertBefore.bind(parent);
		vi.spyOn(parent, "insertBefore").mockImplementation((node, before) => {
			const inserted = originalInsert(node, before);
			if (node.nodeType !== 8) ownerCurrent = false;
			return inserted;
		});
		const prepared = RetainedStructuralTransactionBatch.prepare([firstPrepared, secondPrepared]);
		if (prepared.status !== "prepared") throw new Error("Expected structural batch");

		expect(prepared.batch.commit(new RetainedCommitTransaction(() => ownerCurrent))).toEqual({
			status: "stale",
		});
		expect(first.currentHtml).toBeNull();
		expect(first.nodes).toHaveLength(0);
		expect(second.currentHtml).toBeNull();
		expect(second.nodes).toHaveLength(0);
	});

	it("propagates reentrant transaction disposal and prevents later structural apply", () => {
		let transaction!: RetainedCommitTransaction;
		const secondApply = vi.fn();
		const firstRollback = vi.fn();
		const first = createSyntheticChange({
			participant: createPassiveParticipant({
				apply: () => transaction.dispose(),
				rollback: firstRollback,
			}),
		});
		const second = createSyntheticChange({
			participant: createPassiveParticipant({ apply: secondApply }),
		});
		const prepared = RetainedStructuralTransactionBatch.prepare([first, second]);
		if (prepared.status !== "prepared") throw new Error("Expected structural batch");
		transaction = new RetainedCommitTransaction(() => true);

		expect(prepared.batch.commit(transaction)).toEqual({ status: "disposed" });
		expect(firstRollback).toHaveBeenCalledTimes(1);
		expect(secondApply).not.toHaveBeenCalled();
	});

	it("isolates throwing cleanup reporters and keeps sibling terminalization running", () => {
		const cleanupFailure = new Error("Handle cleanup failed");
		const firstDispose = vi.fn(() => {
			throw cleanupFailure;
		});
		const secondDispose = vi.fn();
		const reported: unknown[] = [];
		const prepared = RetainedStructuralTransactionBatch.prepare([
			createSyntheticChange({ participant: createPassiveParticipant(), dispose: firstDispose }),
			createSyntheticChange({ participant: createPassiveParticipant(), dispose: secondDispose }),
		], {
			onCleanupError(error) {
				reported.push(error);
				throw new Error("Reporter failed");
			},
		});
		if (prepared.status !== "prepared") throw new Error("Expected structural batch");

		const result = prepared.batch.commit(new RetainedCommitTransaction(() => true));
		expect(result.status).toBe("committed");
		expect(result.cleanupErrors).toEqual([cleanupFailure]);
		expect(firstDispose).toHaveBeenCalledTimes(1);
		expect(secondDispose).toHaveBeenCalledTimes(1);
		expect(reported).toEqual([cleanupFailure]);
	});

	it("disposes an uncommitted batch without touching live structural state", () => {
		const ownerDocument = createOwnerDocument();
		const parent = ownerDocument.createElement("section");
		ownerDocument.body.appendChild(parent);
		const first = new RetainedRawHtmlTransactionRange(parent, { label: "first" });
		const second = new RetainedRawHtmlTransactionRange(parent, { label: "second" });
		const firstPrepared = first.prepare({ explicitRawHtml: true, html: "<b>Staged first</b>" });
		const secondPrepared = second.prepare({ explicitRawHtml: true, html: "<i>Staged second</i>" });
		if (firstPrepared.status !== "prepared" || secondPrepared.status !== "prepared") {
			throw new Error("Expected structural preparations");
		}
		const prepared = RetainedStructuralTransactionBatch.prepare([firstPrepared, secondPrepared]);
		if (prepared.status !== "prepared") throw new Error("Expected structural batch");

		prepared.batch.dispose();
		expect(prepared.batch.isTerminal).toBe(true);
		expect(prepared.batch.isCurrent()).toBe(false);
		expect(prepared.batch.commit(new RetainedCommitTransaction(() => true))).toEqual({ status: "stale" });
		expect(first.currentHtml).toBeNull();
		expect(second.currentHtml).toBeNull();
	});
});
