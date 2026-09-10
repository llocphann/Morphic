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
	if (result.status !== "prepared") throw new Error("Expected prepared raw HTML patch");
	return result;
}

function commitValue(range: RetainedRawHtmlTransactionRange, html: string): void {
	const prepared = expectPrepared(range.prepare(raw(html)));
	expect(prepared.commit(new RetainedCommitTransaction(() => true))).toEqual({
		status: "committed",
	});
}

describe("RetainedRawHtmlTransactionRange reentrant authority", () => {
	it("restores exact newer committed nodes when an older multi-node apply resumes after reentry", () => {
		const parent = window.document.createElement("div");
		const range = new RetainedRawHtmlTransactionRange(parent);
		commitValue(range, '<span id="stable">Stable</span>');
		const older = expectPrepared(range.prepare(raw(
			'<i id="older-a">Older A</i><i id="older-b">Older B</i>',
		)));
		const originalInsertBefore = parent.insertBefore;
		let nestedStarted = false;
		let nestedResult: ReturnType<RetainedPreparedRawHtmlPatch["commit"]> | undefined;
		let newerNode: Node | undefined;

		parent.insertBefore = function <T extends Node>(
			this: HTMLElement,
			newNode: T,
			referenceNode: Node | null,
		): T {
			const inserted = originalInsertBefore.call(this, newNode, referenceNode) as T;
			if (!nestedStarted
				&& newNode.nodeType === 1
				&& (newNode as unknown as Element).id === "older-a") {
				nestedStarted = true;
				const newer = expectPrepared(range.prepare(raw(
					'<strong id="newer">Newer</strong>',
				)));
				nestedResult = newer.commit(new RetainedCommitTransaction(() => true));
				newerNode = range.nodes[0];
			}
			return inserted;
		};

		let outerResult;
		try {
			outerResult = older.commit(new RetainedCommitTransaction(() => true));
		} finally {
			parent.insertBefore = originalInsertBefore;
		}

		expect(nestedResult).toEqual({ status: "committed" });
		expect(outerResult).toEqual({ status: "stale" });
		expect(range.currentHtml).toBe('<strong id="newer">Newer</strong>');
		expect(range.nodes).toHaveLength(1);
		expect(range.nodes[0]).toBe(newerNode);
		expect((range.nodes[0] as Element).id).toBe("newer");
		expect(range.isPoisoned).toBe(false);
	});

	it("preserves a newer commit made after the older raw participant adopted", () => {
		const parent = window.document.createElement("div");
		const range = new RetainedRawHtmlTransactionRange(parent);
		commitValue(range, '<span id="stable">Stable</span>');
		const older = expectPrepared(range.prepare(raw('<em id="older">Older</em>')));
		let nestedResult: ReturnType<RetainedPreparedRawHtmlPatch["commit"]> | undefined;
		let newerNode: Node | undefined;
		const triggerRollback = vi.fn();
		const trigger: RetainedCommitParticipant = {
			isCurrent: () => true,
			apply: vi.fn(),
			adopt: () => {
				const newer = expectPrepared(range.prepare(raw(
					'<strong id="newer-adopted">Newer adopted</strong>',
				)));
				nestedResult = newer.commit(new RetainedCommitTransaction(() => true));
				newerNode = range.nodes[0];
			},
			rollback: triggerRollback,
			finalize: vi.fn(),
			discard: vi.fn(),
		};

		const result = new RetainedCommitTransaction(() => true).commit([
			older.toCommitParticipant(),
			trigger,
		]);

		expect(nestedResult).toEqual({ status: "committed" });
		expect(result).toEqual({ status: "stale" });
		expect(triggerRollback).toHaveBeenCalledTimes(1);
		expect(range.currentHtml).toBe('<strong id="newer-adopted">Newer adopted</strong>');
		expect(range.nodes).toHaveLength(1);
		expect(range.nodes[0]).toBe(newerNode);
		expect((range.nodes[0] as Element).id).toBe("newer-adopted");
		expect(range.isPoisoned).toBe(false);
	});
});
