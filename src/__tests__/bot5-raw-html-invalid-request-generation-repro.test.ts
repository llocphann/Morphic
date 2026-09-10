import { TFile, type App } from "obsidian";
import { describe, expect, it } from "vitest";
import { compileTemplateCompat } from "../compiler/template-compat";
import type { RawHtmlSlot } from "../compiler/template-ir";
import type { ExprContext } from "../expression";
import { RetainedCommitTransaction } from "../render/retained-commit-transaction";
import { RetainedProductionRawHtmlAdapter } from "../render/retained-production-raw-html-adapter";

function rawSlot(): RawHtmlSlot {
	const ir = compileTemplateCompat("{{ html('<strong>Old</strong>') }}");
	const slot = ir.nodes.find((node): node is RawHtmlSlot => node.kind === "raw-html-slot");
	if (!slot) throw new Error("Expected compiler RawHtmlSlot");
	return slot;
}

function context(ownerDocument: Document): ExprContext {
	const fileValue: unknown = Object.create(TFile.prototype);
	if (!(fileValue instanceof TFile)) throw new Error("Expected TFile fixture");
	Object.assign(fileValue, {
		path: "Notes/Test.md",
		name: "Test.md",
		basename: "Test",
		extension: "md",
		stat: { ctime: 1, mtime: 2, size: 3 },
		parent: { path: "Notes" },
	});
	return {
		app: { workspace: { activeWindow: ownerDocument.defaultView } } as unknown as App,
		file: fileValue,
		frontmatter: undefined,
		bodyContent: "Body",
		variables: {},
	};
}

describe("Bot 5 production raw HTML generation fencing", () => {
	it("stales an older prepared patch when a newer malformed request begins", async () => {
		const ownerDocument = new DOMParser().parseFromString(
			"<!doctype html><html><body></body></html>",
			"text/html",
		);
		const parent = ownerDocument.createElement("div");
		ownerDocument.body.append(parent);
		const adapter = new RetainedProductionRawHtmlAdapter(parent, {
			evaluateExpression: async () => "<strong>Old</strong>",
		});
		const slot = rawSlot();
		const older = await adapter.prepare(slot, context(ownerDocument));
		expect(older.status).toBe("prepared");
		if (older.status !== "prepared") throw new Error("Expected prepared older patch");

		const malformed = { ...slot, explicitRawHtml: false } as unknown as RawHtmlSlot;
		const newer = await adapter.prepare(malformed, context(ownerDocument));
		expect(newer.status).toBe("failed");

		expect(older.isCurrent()).toBe(false);
		expect(older.commit(new RetainedCommitTransaction(() => true))).toEqual({ status: "stale" });
		expect(adapter.nodes).toHaveLength(0);
	});
});
