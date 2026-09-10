import { describe, expect, it, vi } from "vitest";
import {
	RetainedCommitTransaction,
	type RetainedCommitParticipant,
} from "../render/retained-commit-transaction";
import {
	RetainedConditionalTransactionRange,
} from "../render/retained-conditional-transaction-range";
import type { RetainedStructureBuilder } from "../render/retained-slot-runtime";

function createOwnerDocument(): Document {
	return new DOMParser().parseFromString(
		"<!doctype html><html><body></body></html>",
		"text/html",
	);
}

function createParent(ownerDocument: Document): HTMLElement {
	const parent = ownerDocument.createElement("div");
	ownerDocument.body.appendChild(parent);
	return parent;
}

function branchBuilder(tag: string, text: string): RetainedStructureBuilder {
	return (context) => {
		const element = context.ownerDocument.createElement(tag);
		element.appendChild(context.textSlot("title", text));
		context.fragment.appendChild(element);
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

describe("RetainedConditionalTransactionRange", () => {
	it("stages the first branch off-DOM and commits its exact nodes and slot scope", () => {
		const ownerDocument = createOwnerDocument();
		const parent = createParent(ownerDocument);
		const range = new RetainedConditionalTransactionRange<string>(parent);
		const prepared = range.select("if", branchBuilder("article", "Alpha"));

		expect(prepared.status).toBe("prepared");
		if (prepared.status !== "prepared") throw new Error("Expected prepared branch");
		expect(parent.textContent).toBe("");
		expect(prepared.slots?.patchText("title", "Beta")).toBe("patched");

		const result = prepared.commit(new RetainedCommitTransaction(() => true));
		expect(result.status).toBe("committed");
		expect(range.activeKey).toBe("if");
		expect(range.activeSlots).toBe(prepared.slots);
		expect(parent.querySelector("article")?.textContent).toBe("Beta");
		expect(range.nodes).toHaveLength(1);
		expect(range.nodes[0].ownerDocument).toBe(ownerDocument);
	});

	it("returns unchanged for the retained branch without rebuilding or replacing identity", () => {
		const ownerDocument = createOwnerDocument();
		const parent = createParent(ownerDocument);
		const range = new RetainedConditionalTransactionRange<string>(parent);
		const first = range.select("if", branchBuilder("article", "Stable"));
		if (first.status !== "prepared") throw new Error("Expected first branch");
		expect(first.commit(new RetainedCommitTransaction(() => true)).status).toBe("committed");
		const node = range.nodes[0];
		const slots = range.activeSlots;
		const builder = vi.fn(branchBuilder("article", "Ignored"));

		const same = range.select("if", builder);
		expect(same.status).toBe("unchanged");
		expect(builder).not.toHaveBeenCalled();
		expect(range.nodes[0]).toBe(node);
		expect(range.activeSlots).toBe(slots);
	});

	it("switches branches transactionally and finalizes the previous branch scope", () => {
		const ownerDocument = createOwnerDocument();
		const parent = createParent(ownerDocument);
		const range = new RetainedConditionalTransactionRange<string>(parent);
		const first = range.select("if", branchBuilder("article", "First"));
		if (first.status !== "prepared") throw new Error("Expected first branch");
		first.commit(new RetainedCommitTransaction(() => true));
		const firstNode = range.nodes[0];
		const firstSlots = range.activeSlots;

		const second = range.select("else", branchBuilder("section", "Second"));
		if (second.status !== "prepared") throw new Error("Expected second branch");
		expect(range.nodes[0]).toBe(firstNode);
		expect(firstSlots?.isDisposed).toBe(false);
		expect(second.commit(new RetainedCommitTransaction(() => true)).status).toBe("committed");

		expect(range.activeKey).toBe("else");
		expect(range.nodes[0]).not.toBe(firstNode);
		expect(parent.querySelector("section")?.textContent).toBe("Second");
		expect(firstSlots?.isDisposed).toBe(true);
		expect(second.slots?.isDisposed).toBe(false);
	});

	it("rolls a branch switch back by exact Node identity when a later participant fails", () => {
		const ownerDocument = createOwnerDocument();
		const parent = createParent(ownerDocument);
		const range = new RetainedConditionalTransactionRange<string>(parent);
		const first = range.select("if", branchBuilder("article", "Stable"));
		if (first.status !== "prepared") throw new Error("Expected first branch");
		first.commit(new RetainedCommitTransaction(() => true));
		const stableNode = range.nodes[0];
		const stableSlots = range.activeSlots;
		const next = range.select("else", branchBuilder("section", "Staged"));
		if (next.status !== "prepared") throw new Error("Expected staged branch");
		const stagedSlots = next.slots;
		const failure = new Error("Later participant failed");

		const result = new RetainedCommitTransaction(() => true).commit([
			next.toCommitParticipant(),
			throwingParticipant(failure),
		]);

		expect(result.status).toBe("failed");
		expect(result.error).toBe(failure);
		expect(range.activeKey).toBe("if");
		expect(range.nodes[0]).toBe(stableNode);
		expect(range.activeSlots).toBe(stableSlots);
		expect(stableSlots?.isDisposed).toBe(false);
		expect(stagedSlots?.isDisposed).toBe(true);
	});

	it("discards detached branch resources when owner currentness rejects the transaction", () => {
		const ownerDocument = createOwnerDocument();
		const parent = createParent(ownerDocument);
		const range = new RetainedConditionalTransactionRange<string>(parent);
		const prepared = range.select("if", branchBuilder("article", "Staged"));
		if (prepared.status !== "prepared") throw new Error("Expected prepared branch");
		const stagedSlots = prepared.slots;

		const result = prepared.commit(new RetainedCommitTransaction(() => false));
		expect(result.status).toBe("stale");
		expect(range.activeKey).toBeNull();
		expect(parent.textContent).toBe("");
		expect(stagedSlots?.isDisposed).toBe(true);
	});

	it("clears a committed branch through the same reversible transaction barrier", () => {
		const ownerDocument = createOwnerDocument();
		const parent = createParent(ownerDocument);
		const range = new RetainedConditionalTransactionRange<string>(parent);
		const first = range.select("if", branchBuilder("article", "Visible"));
		if (first.status !== "prepared") throw new Error("Expected first branch");
		first.commit(new RetainedCommitTransaction(() => true));
		const oldSlots = range.activeSlots;

		const clear = range.clear();
		expect(clear.status).toBe("prepared");
		if (clear.status !== "prepared") throw new Error("Expected prepared clear");
		expect(clear.key).toBeNull();
		expect(clear.slots).toBeNull();
		expect(clear.commit(new RetainedCommitTransaction(() => true)).status).toBe("committed");
		expect(range.activeKey).toBeNull();
		expect(range.activeSlots).toBeNull();
		expect(range.nodes).toHaveLength(0);
		expect(oldSlots?.isDisposed).toBe(true);
	});

	it("preserves the committed branch when detached branch construction throws", () => {
		const ownerDocument = createOwnerDocument();
		const parent = createParent(ownerDocument);
		const range = new RetainedConditionalTransactionRange<string>(parent);
		const first = range.select("if", branchBuilder("article", "Stable"));
		if (first.status !== "prepared") throw new Error("Expected first branch");
		first.commit(new RetainedCommitTransaction(() => true));
		const stableNode = range.nodes[0];
		const failure = new Error("Builder failed");

		const result = range.select("else", () => {
			throw failure;
		});
		expect(result.status).toBe("failed");
		if (result.status !== "failed") throw new Error("Expected failed result");
		expect(result.error).toBe(failure);
		expect(range.activeKey).toBe("if");
		expect(range.nodes[0]).toBe(stableNode);
	});

	it("a newer unchanged request stales an older prepared branch and cleans its staging", () => {
		const ownerDocument = createOwnerDocument();
		const parent = createParent(ownerDocument);
		const range = new RetainedConditionalTransactionRange<string>(parent);
		const first = range.select("if", branchBuilder("article", "Stable"));
		if (first.status !== "prepared") throw new Error("Expected first branch");
		first.commit(new RetainedCommitTransaction(() => true));
		const stableNode = range.nodes[0];
		const older = range.select("else", branchBuilder("section", "Old staged"));
		if (older.status !== "prepared") throw new Error("Expected older staged branch");
		const olderSlots = older.slots;

		expect(range.select("if", branchBuilder("article", "Ignored")).status).toBe("unchanged");
		expect(older.isCurrent()).toBe(false);
		expect(older.commit(new RetainedCommitTransaction(() => true)).status).toBe("stale");
		expect(olderSlots?.isDisposed).toBe(true);
		expect(range.nodes[0]).toBe(stableNode);
	});

	it("rejects externally damaged anchors and poisons the structural range", () => {
		const ownerDocument = createOwnerDocument();
		const parent = createParent(ownerDocument);
		const range = new RetainedConditionalTransactionRange<string>(parent);
		const comments = Array.from(parent.childNodes).filter((node): node is Comment => node.nodeType === 8);
		parent.removeChild(comments[1]);

		const result = range.select("if", branchBuilder("article", "Never"));
		expect(result.status).toBe("failed");
		expect(range.isPoisoned).toBe(true);
	});

	it("keeps staging and committed nodes in the parent ownerDocument", () => {
		const ownerDocument = createOwnerDocument();
		const parent = createParent(ownerDocument);
		const range = new RetainedConditionalTransactionRange<string>(parent);
		const prepared = range.select("if", branchBuilder("article", "Popout"));
		if (prepared.status !== "prepared") throw new Error("Expected prepared branch");
		expect(prepared.slots?.ownerDocument).toBe(ownerDocument);
		expect(prepared.commit(new RetainedCommitTransaction(() => true)).status).toBe("committed");
		expect(range.nodes.every((node) => node.ownerDocument === ownerDocument)).toBe(true);
	});

	it("owner disposal invalidates prepared work and disposes committed branch resources", () => {
		const ownerDocument = createOwnerDocument();
		const parent = createParent(ownerDocument);
		const range = new RetainedConditionalTransactionRange<string>(parent);
		const first = range.select("if", branchBuilder("article", "Stable"));
		if (first.status !== "prepared") throw new Error("Expected first branch");
		first.commit(new RetainedCommitTransaction(() => true));
		const committedSlots = range.activeSlots;
		const pending = range.select("else", branchBuilder("section", "Pending"));
		if (pending.status !== "prepared") throw new Error("Expected pending branch");
		const pendingSlots = pending.slots;

		range.dispose();
		expect(range.isDisposed).toBe(true);
		expect(committedSlots?.isDisposed).toBe(true);
		expect(pending.isCurrent()).toBe(false);
		pending.dispose();
		expect(pendingSlots?.isDisposed).toBe(true);
	});
});
