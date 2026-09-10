import { describe, expect, it, vi } from "vitest";
import {
	RetainedCommitTransaction,
	type RetainedCommitParticipant,
} from "../render/retained-commit-transaction";
import {
	RetainedKeyedTransactionRange,
	type RetainedKeyedTransactionCreateContext,
	type RetainedPreparedKeyedTransaction,
} from "../render/retained-keyed-transaction-range";
import type { RetainedKeyedSlotScope } from "../render/scoped-keyed-slot-runtime";

function createOwnerDocument(): Document {
	return new DOMParser().parseFromString(
		"<!doctype html><html><body></body></html>",
		"text/html",
	);
}

function mountEntry(
	context: RetainedKeyedTransactionCreateContext<string>,
	label = context.key,
): readonly Node[] {
	return context.slots.mount(({ ownerDocument, fragment, textSlot }) => {
		const row = ownerDocument.createElement("p");
		row.dataset.key = context.key;
		row.appendChild(textSlot("label", label));
		fragment.appendChild(row);
	});
}

function expectPrepared<K extends string | number>(
	result: ReturnType<RetainedKeyedTransactionRange<K>["prepare"]>,
): RetainedPreparedKeyedTransaction<K> {
	expect(result.status).toBe("prepared");
	if (result.status !== "prepared") throw new Error("Expected prepared keyed transaction");
	return result;
}

function commitPrepared<K extends string | number>(prepared: RetainedPreparedKeyedTransaction<K>) {
	return prepared.commit(new RetainedCommitTransaction(() => true));
}

describe("RetainedKeyedTransactionRange", () => {
	it("builds new keyed slot scopes detached and commits them atomically", () => {
		const ownerDocument = createOwnerDocument();
		const parent = ownerDocument.createElement("div");
		const range = new RetainedKeyedTransactionRange<string>(parent);
		const prepared = expectPrepared(range.prepare(["a", "b"], mountEntry));
		expect(range.keys).toEqual([]);
		expect(prepared.entries.every((entry) => entry.start.parentNode === null)).toBe(true);
		expect(prepared.entries.every((entry) => entry.start.ownerDocument === ownerDocument)).toBe(true);
		expect(commitPrepared(prepared)).toEqual({ status: "committed" });
		expect(range.keys).toEqual(["a", "b"]);
		expect(range.entry("a")?.slots.patchText("label", "A2")).toBe("patched");
		expect(range.nodesFor("a")[0]?.textContent).toBe("A2");
	});

	it("returns unchanged for the same order without rebuilding entries", () => {
		const ownerDocument = createOwnerDocument();
		const parent = ownerDocument.createElement("div");
		const range = new RetainedKeyedTransactionRange<string>(parent);
		expect(commitPrepared(expectPrepared(range.prepare(["a", "b"], mountEntry))).status).toBe("committed");
		const entry = range.entry("a");
		const node = range.nodesFor("a")[0];
		const builder = vi.fn();
		expect(range.prepare(["a", "b"], builder).status).toBe("unchanged");
		expect(builder).not.toHaveBeenCalled();
		expect(range.entry("a")).toBe(entry);
		expect(range.nodesFor("a")[0]).toBe(node);
	});

	it("reorders survivor entries by exact node and slot-scope identity", () => {
		const ownerDocument = createOwnerDocument();
		const parent = ownerDocument.createElement("div");
		const range = new RetainedKeyedTransactionRange<string>(parent);
		expect(commitPrepared(expectPrepared(range.prepare(["a", "b"], mountEntry))).status).toBe("committed");
		const a = { entry: range.entry("a"), node: range.nodesFor("a")[0] };
		const b = { entry: range.entry("b"), node: range.nodesFor("b")[0] };
		const builder = vi.fn();
		expect(commitPrepared(expectPrepared(range.prepare(["b", "a"], builder)))).toEqual({ status: "committed" });
		expect(builder).not.toHaveBeenCalled();
		expect(range.keys).toEqual(["b", "a"]);
		expect(range.entry("a")).toBe(a.entry);
		expect(range.entry("b")).toBe(b.entry);
		expect(range.nodesFor("a")[0]).toBe(a.node);
		expect(range.nodesFor("b")[0]).toBe(b.node);
	});

	it("keeps removed scopes alive through apply and disposes them only after finalization", () => {
		const ownerDocument = createOwnerDocument();
		const parent = ownerDocument.createElement("div");
		const range = new RetainedKeyedTransactionRange<string>(parent);
		expect(commitPrepared(expectPrepared(range.prepare(["a", "b"], mountEntry))).status).toBe("committed");
		const removedScope = range.entry("a")!.slots;
		const prepared = expectPrepared(range.prepare(["b", "c"], mountEntry));
		const observer: RetainedCommitParticipant = {
			isCurrent: () => true,
			apply: () => expect(removedScope.isDisposed).toBe(false),
			adopt: () => expect(removedScope.isDisposed).toBe(false),
			rollback: vi.fn(),
			finalize: vi.fn(),
			discard: vi.fn(),
		};
		expect(new RetainedCommitTransaction(() => true).commit([prepared.toCommitParticipant(), observer])).toEqual({ status: "committed" });
		expect(removedScope.isDisposed).toBe(true);
	});

	it("rolls back exact old order and scopes when a later apply fails", () => {
		const ownerDocument = createOwnerDocument();
		const parent = ownerDocument.createElement("div");
		const range = new RetainedKeyedTransactionRange<string>(parent);
		expect(commitPrepared(expectPrepared(range.prepare(["a", "b"], mountEntry))).status).toBe("committed");
		const oldEntry = range.entry("a")!;
		const oldNodes = [range.nodesFor("a")[0], range.nodesFor("b")[0]];
		const holder: { scope: RetainedKeyedSlotScope | null } = { scope: null };
		const prepared = expectPrepared(range.prepare(["b", "c"], (context) => {
			holder.scope = context.slots;
			return mountEntry(context);
		}));
		const failure = new Error("Later apply failed");
		const later: RetainedCommitParticipant = {
			isCurrent: () => true,
			apply: () => { throw failure; },
			rollback: vi.fn(),
			finalize: vi.fn(),
			discard: vi.fn(),
		};
		const result = new RetainedCommitTransaction(() => true).commit([prepared.toCommitParticipant(), later]);
		expect(result.status).toBe("failed");
		expect(result.error).toBe(failure);
		expect(range.keys).toEqual(["a", "b"]);
		expect(range.entry("a")).toBe(oldEntry);
		expect(range.nodesFor("a")[0]).toBe(oldNodes[0]);
		expect(range.nodesFor("b")[0]).toBe(oldNodes[1]);
		expect(oldEntry.slots.isDisposed).toBe(false);
		expect(holder.scope?.isDisposed).toBe(true);
	});

	it("preserves stable UI and disposes staged scope when a new-entry builder fails", () => {
		const ownerDocument = createOwnerDocument();
		const parent = ownerDocument.createElement("div");
		const range = new RetainedKeyedTransactionRange<string>(parent);
		expect(commitPrepared(expectPrepared(range.prepare(["a"], mountEntry))).status).toBe("committed");
		const stableNode = range.nodesFor("a")[0];
		const holder: { scope: RetainedKeyedSlotScope | null } = { scope: null };
		const failure = new Error("Builder failed");
		const result = range.prepare(["a", "b"], (context) => {
			holder.scope = context.slots;
			mountEntry(context);
			throw failure;
		});
		expect(result.status).toBe("failed");
		if (result.status === "prepared") throw new Error("Builder failure unexpectedly prepared work");
		expect(result.error).toBe(failure);
		expect(range.keys).toEqual(["a"]);
		expect(range.nodesFor("a")[0]).toBe(stableNode);
		expect(holder.scope?.isDisposed).toBe(true);
	});

	it("rejects duplicate keys before staging or live mutation", () => {
		const ownerDocument = createOwnerDocument();
		const range = new RetainedKeyedTransactionRange<string>(ownerDocument.createElement("div"));
		const builder = vi.fn();
		const result = range.prepare(["a", "a"], builder);
		expect(result.status).toBe("failed");
		expect(builder).not.toHaveBeenCalled();
		expect(range.keys).toEqual([]);
		expect(range.isPoisoned).toBe(false);
	});

	it("supersedes older prepared list work when a newer generation is prepared", () => {
		const ownerDocument = createOwnerDocument();
		const range = new RetainedKeyedTransactionRange<string>(ownerDocument.createElement("div"));
		const older = expectPrepared(range.prepare(["a"], mountEntry));
		const newer = expectPrepared(range.prepare(["b"], mountEntry));
		expect(older.isCurrent()).toBe(false);
		expect(older.commit(new RetainedCommitTransaction(() => true))).toEqual({ status: "stale" });
		expect(range.keys).toEqual([]);
		expect(commitPrepared(newer)).toEqual({ status: "committed" });
		expect(range.keys).toEqual(["b"]);
	});

	it("keeps a reentrant newer keyed commit authoritative when the older transaction rolls back", () => {
		const ownerDocument = createOwnerDocument();
		const range = new RetainedKeyedTransactionRange<string>(ownerDocument.createElement("div"));
		expect(commitPrepared(expectPrepared(range.prepare(["a", "b"], mountEntry))).status).toBe("committed");
		const older = expectPrepared(range.prepare(["b", "c"], mountEntry));
		let newerCNode: Node | undefined;
		const reentrant: RetainedCommitParticipant = {
			isCurrent: () => true,
			apply: vi.fn(),
			adopt: () => {
				const newer = expectPrepared(range.prepare(["c", "d"], mountEntry));
				expect(commitPrepared(newer).status).toBe("committed");
				newerCNode = range.nodesFor("c")[0];
			},
			rollback: vi.fn(),
			finalize: vi.fn(),
			discard: vi.fn(),
		};
		expect(new RetainedCommitTransaction(() => true).commit([older.toCommitParticipant(), reentrant]).status).toBe("stale");
		expect(range.keys).toEqual(["c", "d"]);
		expect(range.nodesFor("c")[0]).toBe(newerCNode);
	});

	it("carries removed-scope cleanup debt into a reentrant newer commit", () => {
		const ownerDocument = createOwnerDocument();
		const range = new RetainedKeyedTransactionRange<string>(ownerDocument.createElement("div"));
		expect(commitPrepared(expectPrepared(range.prepare(["a", "b"], mountEntry))).status).toBe("committed");
		const removedScope = range.entry("a")!.slots;
		const older = expectPrepared(range.prepare(["b", "c"], mountEntry));
		const reentrant: RetainedCommitParticipant = {
			isCurrent: () => true,
			apply: vi.fn(),
			adopt: () => {
				expect(removedScope.isDisposed).toBe(false);
				expect(commitPrepared(expectPrepared(range.prepare(["c", "d"], mountEntry))).status).toBe("committed");
			},
			rollback: vi.fn(),
			finalize: vi.fn(),
			discard: vi.fn(),
		};
		expect(new RetainedCommitTransaction(() => true).commit([older.toCommitParticipant(), reentrant]).status).toBe("stale");
		expect(range.keys).toEqual(["c", "d"]);
		expect(removedScope.isDisposed).toBe(true);
	});

	it("clears all entries transactionally", () => {
		const ownerDocument = createOwnerDocument();
		const range = new RetainedKeyedTransactionRange<string>(ownerDocument.createElement("div"));
		expect(commitPrepared(expectPrepared(range.prepare(["a", "b"], mountEntry))).status).toBe("committed");
		const aScope = range.entry("a")!.slots;
		const clear = expectPrepared(range.clear());
		expect(range.keys).toEqual(["a", "b"]);
		expect(commitPrepared(clear)).toEqual({ status: "committed" });
		expect(range.keys).toEqual([]);
		expect(aScope.isDisposed).toBe(true);
		expect(range.clear().status).toBe("unchanged");
	});

	it("rolls back keyed live mutation when the transaction is disposed reentrantly", () => {
		const ownerDocument = createOwnerDocument();
		const range = new RetainedKeyedTransactionRange<string>(ownerDocument.createElement("div"));
		expect(commitPrepared(expectPrepared(range.prepare(["a"], mountEntry))).status).toBe("committed");
		const stableNode = range.nodesFor("a")[0];
		const prepared = expectPrepared(range.prepare(["b"], mountEntry));
		let transaction!: RetainedCommitTransaction;
		const disposer: RetainedCommitParticipant = {
			isCurrent: () => true,
			apply: () => transaction.dispose(),
			rollback: vi.fn(),
			finalize: vi.fn(),
			discard: vi.fn(),
		};
		transaction = new RetainedCommitTransaction(() => true);
		expect(transaction.commit([prepared.toCommitParticipant(), disposer])).toEqual({ status: "disposed" });
		expect(range.keys).toEqual(["a"]);
		expect(range.nodesFor("a")[0]).toBe(stableNode);
	});

	it("poisons instead of overwriting unowned nodes between committed entries", () => {
		const ownerDocument = createOwnerDocument();
		const parent = ownerDocument.createElement("div");
		const range = new RetainedKeyedTransactionRange<string>(parent);
		expect(commitPrepared(expectPrepared(range.prepare(["a", "b"], mountEntry))).status).toBe("committed");
		const rogue = ownerDocument.createElement("aside");
		rogue.textContent = "Rogue";
		parent.insertBefore(rogue, range.entry("b")!.start);
		expect(range.prepare(["b", "a"], mountEntry).status).toBe("failed");
		expect(range.isPoisoned).toBe(true);
		expect(rogue.parentNode).toBe(parent);
		expect(range.prepare(["a", "b"], mountEntry).status).toBe("failed");
	});

	it("flattens detached DocumentFragments and keeps key text out of comment diagnostics", () => {
		const ownerDocument = createOwnerDocument();
		const parent = ownerDocument.createElement("div");
		const range = new RetainedKeyedTransactionRange<string>(parent);
		const secretKey = "private/key?token=abc";
		const prepared = expectPrepared(range.prepare([secretKey], ({ ownerDocument: doc }) => {
			const fragment = doc.createDocumentFragment();
			fragment.append(doc.createTextNode("One"), doc.createElement("hr"), doc.createTextNode("Two"));
			return fragment;
		}));
		expect(commitPrepared(prepared).status).toBe("committed");
		expect(range.nodesFor(secretKey).map((node) => node.nodeType)).toEqual([3, 1, 3]);
		const comments = Array.from(parent.childNodes)
			.filter((node): node is Comment => node.nodeType === 8)
			.map((comment) => comment.data);
		expect(comments.some((value) => value.includes(secretKey))).toBe(false);
	});

	it("uses the actual owner document and leaves committed DOM to outer teardown on dispose", () => {
		const primaryDocument = createOwnerDocument();
		const ownerDocument = createOwnerDocument();
		const parent = ownerDocument.createElement("div");
		primaryDocument.body.appendChild(primaryDocument.createElement("div"));
		const range = new RetainedKeyedTransactionRange<string>(parent);
		expect(commitPrepared(expectPrepared(range.prepare(["a"], mountEntry))).status).toBe("committed");
		const entry = range.entry("a")!;
		const liveNode = range.nodesFor("a")[0];
		const pending = expectPrepared(range.prepare(["b"], mountEntry));
		expect(entry.start.ownerDocument).toBe(ownerDocument);
		expect(liveNode.ownerDocument).toBe(ownerDocument);
		range.dispose();
		expect(pending.commit(new RetainedCommitTransaction(() => true))).toEqual({ status: "disposed" });
		expect(entry.slots.isDisposed).toBe(true);
		expect(liveNode.parentNode).toBe(parent);
	});
});
