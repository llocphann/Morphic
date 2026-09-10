import { describe, expect, it, vi } from "vitest";
import {
	RetainedCommitTransaction,
	type RetainedCommitParticipant,
} from "../render/retained-commit-transaction";
import {
	RetainedRawHtmlTransactionRange,
	type RetainedPreparedRawHtmlPatch,
	type RetainedRawHtmlTransactionPreparationResult,
} from "../render/retained-raw-html-transaction-range";
import type { ExplicitRawHtml } from "../render/retained-slot-runtime";

function raw(html: string): ExplicitRawHtml {
	return { explicitRawHtml: true, html };
}

function expectPrepared(
	result: RetainedRawHtmlTransactionPreparationResult,
): RetainedPreparedRawHtmlPatch {
	expect(result.status).toBe("prepared");
	if (result.status !== "prepared") throw new Error("Expected a prepared raw HTML patch");
	return result;
}

function commitValue(
	range: RetainedRawHtmlTransactionRange,
	html: string | null,
): RetainedPreparedRawHtmlPatch {
	const prepared = expectPrepared(range.prepare(html === null ? null : raw(html)));
	expect(prepared.commit(new RetainedCommitTransaction(() => true))).toEqual({
		status: "committed",
	});
	return prepared;
}

describe("RetainedRawHtmlTransactionRange", () => {
	it("keeps parsed raw nodes detached until the owner transaction commits", () => {
		const ownerDocument = window.document;
		const parent = ownerDocument.createElement("div");
		const before = ownerDocument.createElement("i");
		const after = ownerDocument.createElement("i");
		parent.append(before, after);
		const range = new RetainedRawHtmlTransactionRange(parent, { before: after });

		const prepared = expectPrepared(range.prepare(raw("<span>A</span><em>B</em>")));
		expect(range.nodes).toHaveLength(0);
		expect(range.currentHtml).toBeNull();

		expect(prepared.commit(new RetainedCommitTransaction(() => true))).toEqual({
			status: "committed",
		});
		expect(range.currentHtml).toBe("<span>A</span><em>B</em>");
		expect(range.nodes).toHaveLength(2);
		expect((range.nodes[0] as Element).tagName).toBe("SPAN");
		expect((range.nodes[1] as Element).tagName).toBe("EM");
		expect(before.parentNode).toBe(parent);
		expect(after.parentNode).toBe(parent);
	});

	it("retains exact node identity for an unchanged committed value", () => {
		const parent = window.document.createElement("div");
		const range = new RetainedRawHtmlTransactionRange(parent);
		commitValue(range, "<strong>Stable</strong><!--Tail-->");
		const stableNodes = [...range.nodes];

		expect(range.prepare(raw("<strong>Stable</strong><!--Tail-->"))).toEqual({
			status: "unchanged",
		});
		expect(range.nodes[0]).toBe(stableNodes[0]);
		expect(range.nodes[1]).toBe(stableNodes[1]);
	});

	it("an unchanged newest request makes an older different prepared patch stale", () => {
		const parent = window.document.createElement("div");
		const range = new RetainedRawHtmlTransactionRange(parent);
		commitValue(range, '<span id="stable">Stable</span>');
		const stableNode = range.nodes[0];
		const older = expectPrepared(range.prepare(raw('<em id="older">Older</em>')));

		expect(range.prepare(raw('<span id="stable">Stable</span>'))).toEqual({
			status: "unchanged",
		});
		expect(older.commit(new RetainedCommitTransaction(() => true))).toEqual({
			status: "stale",
		});
		expect(range.nodes[0]).toBe(stableNode);
		expect(range.currentHtml).toBe('<span id="stable">Stable</span>');
	});

	it("rolls back an earlier raw range by exact Node identity when a later raw apply fails", () => {
		const ownerDocument = window.document;
		const firstParent = ownerDocument.createElement("div");
		const secondParent = ownerDocument.createElement("div");
		const firstRange = new RetainedRawHtmlTransactionRange(firstParent);
		const secondRange = new RetainedRawHtmlTransactionRange(secondParent);
		commitValue(firstRange, '<span id="first-stable">First stable</span>');
		commitValue(secondRange, '<span id="second-stable">Second stable</span>');
		const firstStable = firstRange.nodes[0];
		const secondStable = secondRange.nodes[0];
		const firstNext = expectPrepared(firstRange.prepare(raw('<em id="first-next">First next</em>')));
		const secondNext = expectPrepared(secondRange.prepare(raw('<em data-fail="true">Second next</em>')));
		const originalInsertBefore = secondParent.insertBefore;

		secondParent.insertBefore = function <T extends Node>(
			this: HTMLElement,
			newNode: T,
			referenceNode: Node | null,
		): T {
			if (newNode.nodeType === 1 && (newNode as unknown as Element).hasAttribute("data-fail")) {
				throw new Error("Synthetic second raw apply failure");
			}
			return originalInsertBefore.call(this, newNode, referenceNode) as T;
		};

		try {
			const transaction = new RetainedCommitTransaction(() => true);
			const result = transaction.commit([
				firstNext.toCommitParticipant(),
				secondNext.toCommitParticipant(),
			]);
			expect(result.status).toBe("failed");
			expect((result.error as Error).message).toBe("Synthetic second raw apply failure");
		} finally {
			secondParent.insertBefore = originalInsertBefore;
		}

		expect(firstRange.nodes[0]).toBe(firstStable);
		expect(secondRange.nodes[0]).toBe(secondStable);
		expect(firstRange.currentHtml).toBe('<span id="first-stable">First stable</span>');
		expect(secondRange.currentHtml).toBe('<span id="second-stable">Second stable</span>');
	});

	it("undoes adopted raw metadata and DOM when a later participant adoption fails", () => {
		const parent = window.document.createElement("div");
		const range = new RetainedRawHtmlTransactionRange(parent);
		commitValue(range, '<span id="stable">Stable</span>');
		const stableNode = range.nodes[0];
		const prepared = expectPrepared(range.prepare(raw('<strong id="next">Next</strong>')));
		const adoptionFailure = new Error("Synthetic adoption failure");
		const failing: RetainedCommitParticipant = {
			isCurrent: () => true,
			apply: vi.fn(),
			adopt: () => {
				throw adoptionFailure;
			},
			rollback: vi.fn(),
			finalize: vi.fn(),
			discard: vi.fn(),
		};

		const result = new RetainedCommitTransaction(() => true).commit([
			prepared.toCommitParticipant(),
			failing,
		]);
		expect(result.status).toBe("failed");
		expect(result.error).toBe(adoptionFailure);
		expect(range.nodes[0]).toBe(stableNode);
		expect(range.currentHtml).toBe('<span id="stable">Stable</span>');
	});

	it("rolls back when the owner becomes stale reentrantly during raw apply", () => {
		const parent = window.document.createElement("div");
		const range = new RetainedRawHtmlTransactionRange(parent);
		commitValue(range, '<span id="stable">Stable</span>');
		const stableNode = range.nodes[0];
		const prepared = expectPrepared(range.prepare(raw('<em id="next">Next</em>')));
		let ownerCurrent = true;
		const originalInsertBefore = parent.insertBefore;

		parent.insertBefore = function <T extends Node>(
			this: HTMLElement,
			newNode: T,
			referenceNode: Node | null,
		): T {
			const inserted = originalInsertBefore.call(this, newNode, referenceNode) as T;
			if (newNode.nodeType === 1 && (newNode as unknown as Element).id === "next") {
				ownerCurrent = false;
			}
			return inserted;
		};

		try {
			expect(prepared.commit(new RetainedCommitTransaction(() => ownerCurrent))).toEqual({
				status: "stale",
			});
		} finally {
			parent.insertBefore = originalInsertBefore;
		}

		expect(range.nodes[0]).toBe(stableNode);
		expect(range.currentHtml).toBe('<span id="stable">Stable</span>');
	});

	it("rolls back and returns disposed when the transaction is disposed during raw apply", () => {
		const parent = window.document.createElement("div");
		const range = new RetainedRawHtmlTransactionRange(parent);
		commitValue(range, '<span id="stable">Stable</span>');
		const stableNode = range.nodes[0];
		const prepared = expectPrepared(range.prepare(raw('<em id="next">Next</em>')));
		const transaction = new RetainedCommitTransaction(() => true);
		const originalInsertBefore = parent.insertBefore;

		parent.insertBefore = function <T extends Node>(
			this: HTMLElement,
			newNode: T,
			referenceNode: Node | null,
		): T {
			const inserted = originalInsertBefore.call(this, newNode, referenceNode) as T;
			if (newNode.nodeType === 1 && (newNode as unknown as Element).id === "next") {
				transaction.dispose();
			}
			return inserted;
		};

		try {
			expect(prepared.commit(transaction)).toEqual({ status: "disposed" });
		} finally {
			parent.insertBefore = originalInsertBefore;
		}

		expect(range.nodes[0]).toBe(stableNode);
		expect(range.currentHtml).toBe('<span id="stable">Stable</span>');
	});

	it("participates in transactional clear without disturbing outside siblings", () => {
		const ownerDocument = window.document;
		const parent = ownerDocument.createElement("div");
		const before = ownerDocument.createElement("i");
		const after = ownerDocument.createElement("i");
		parent.append(before, after);
		const range = new RetainedRawHtmlTransactionRange(parent, { before: after });
		commitValue(range, "<span>Value</span>");

		const prepared = expectPrepared(range.prepare(null));
		expect(prepared.commit(new RetainedCommitTransaction(() => true))).toEqual({
			status: "committed",
		});
		expect(range.currentHtml).toBeNull();
		expect(range.nodes).toHaveLength(0);
		expect(before.parentNode).toBe(parent);
		expect(after.parentNode).toBe(parent);
	});

	it("imports head and body nodes into a foreign ownerDocument without wrappers", () => {
		const foreignDocument = window.document.implementation.createHTMLDocument("popout");
		const parent = foreignDocument.createElement("div");
		foreignDocument.body.append(parent);
		const range = new RetainedRawHtmlTransactionRange(parent);

		commitValue(range, "<style>.x{display:block}</style><p>Body</p>");
		expect(range.nodes).toHaveLength(2);
		expect(range.nodes.every((node) => node.ownerDocument === foreignDocument)).toBe(true);
		expect((range.nodes[0] as Element).tagName).toBe("STYLE");
		expect((range.nodes[1] as Element).tagName).toBe("P");
	});

	it("never copies raw source into Morphic diagnostic anchors", () => {
		const parent = window.document.createElement("div");
		const range = new RetainedRawHtmlTransactionRange(parent, { label: "explicit" });
		const secret = "sensitive-raw-source";

		commitValue(range, `<span data-secret="${secret}">Visible</span>`);
		const comments = Array.from(parent.childNodes)
			.filter((node) => node.nodeType === 8)
			.map((node) => node.textContent ?? "");
		expect(comments.join("\n")).not.toContain(secret);
	});

	it("poisons the range when rollback cannot restore the prior Node identities", () => {
		const parent = window.document.createElement("div");
		const range = new RetainedRawHtmlTransactionRange(parent);
		commitValue(range, '<span id="stable">Stable</span>');
		const stableNode = range.nodes[0];
		const prepared = expectPrepared(range.prepare(raw('<em id="next">Next</em>')));
		let ownerCurrent = true;
		let failRollback = false;
		const originalInsertBefore = parent.insertBefore;

		parent.insertBefore = function <T extends Node>(
			this: HTMLElement,
			newNode: T,
			referenceNode: Node | null,
		): T {
			if (failRollback && newNode === stableNode) {
				throw new Error("Synthetic rollback failure");
			}
			const inserted = originalInsertBefore.call(this, newNode, referenceNode) as T;
			if (newNode.nodeType === 1 && (newNode as unknown as Element).id === "next") {
				ownerCurrent = false;
				failRollback = true;
			}
			return inserted;
		};

		try {
			const result = prepared.commit(new RetainedCommitTransaction(() => ownerCurrent));
			expect(result.status).toBe("poisoned");
			expect(result.rollbackErrors).toHaveLength(1);
		} finally {
			parent.insertBefore = originalInsertBefore;
		}

		expect(range.isPoisoned).toBe(true);
		expect(range.prepare(raw("<strong>Late</strong>")).status).toBe("failed");
	});

	it("detects external anchor loss and refuses further reusable commits", () => {
		const parent = window.document.createElement("div");
		const range = new RetainedRawHtmlTransactionRange(parent);
		const start = Array.from(parent.childNodes).find(
			(node) => node.nodeType === 8 && node.textContent?.startsWith("morphic-raw-start"),
		);
		expect(start).toBeDefined();
		start?.remove();

		const result = range.prepare(raw("<span>Late</span>"));
		expect(result.status).toBe("failed");
		expect(range.isPoisoned).toBe(true);
	});

	it("disposes idempotently, stales prepared work, and leaves committed DOM to owner teardown", () => {
		const parent = window.document.createElement("div");
		const range = new RetainedRawHtmlTransactionRange(parent);
		commitValue(range, "<span>Committed</span>");
		const committed = range.nodes[0];
		const pending = expectPrepared(range.prepare(raw("<em>Pending</em>")));

		range.dispose();
		range.dispose();
		expect(range.isDisposed).toBe(true);
		expect(range.currentHtml).toBeNull();
		expect(range.nodes).toHaveLength(0);
		expect(pending.commit(new RetainedCommitTransaction(() => true))).toEqual({
			status: "stale",
		});
		expect(range.prepare(raw("<strong>Late</strong>"))).toEqual({ status: "disposed" });
		expect(committed.parentNode).toBe(parent);
	});
});
