import { TFile, type App } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { compileTemplateCompat } from "../compiler/template-compat";
import type { RawHtmlSlot, TemplateIRNode } from "../compiler/template-ir";
import type { ExprContext, ExprValue } from "../expression";
import {
	RetainedCommitTransaction,
	type RetainedCommitParticipant,
} from "../render/retained-commit-transaction";
import {
	RetainedProductionRawHtmlAdapter,
	type RetainedPreparedProductionRawHtmlPatch,
	type RetainedProductionRawHtmlEvaluator,
	type RetainedProductionRawHtmlPreparationResult,
} from "../render/retained-production-raw-html-adapter";

function createOwnerDocument(): Document {
	return new DOMParser().parseFromString(
		"<!doctype html><html><body></body></html>",
		"text/html",
	);
}

function createContext(ownerDocument: Document): ExprContext {
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

function rawSlot(template = "{{ html('<strong>Raw</strong>') }}"): RawHtmlSlot {
	const ir = compileTemplateCompat(template);
	const slot = ir.nodes.find((node): node is RawHtmlSlot => node.kind === "raw-html-slot");
	if (!slot) throw new Error("Expected compiler RawHtmlSlot");
	return slot;
}

function expectPrepared(
	result: RetainedProductionRawHtmlPreparationResult,
): RetainedPreparedProductionRawHtmlPatch {
	expect(result.status).toBe("prepared");
	if (result.status !== "prepared") throw new Error("Expected prepared raw HTML adapter patch");
	return result;
}

function commitPrepared(prepared: RetainedPreparedProductionRawHtmlPatch) {
	return prepared.commit(new RetainedCommitTransaction(() => true));
}

describe("RetainedProductionRawHtmlAdapter", () => {
	it("evaluates one compiler raw HTML slot and commits unwrapped nodes", async () => {
		const ownerDocument = createOwnerDocument();
		const parent = ownerDocument.createElement("div");
		ownerDocument.body.append(parent);
		const evaluateExpression = vi.fn(async () => "<strong>A</strong><em>B</em>");
		const adapter = new RetainedProductionRawHtmlAdapter(parent, { evaluateExpression });

		const prepared = expectPrepared(await adapter.prepare(rawSlot(), createContext(ownerDocument)));
		expect(adapter.nodes).toHaveLength(0);
		expect(commitPrepared(prepared)).toEqual({ status: "committed" });
		expect(evaluateExpression).toHaveBeenCalledTimes(1);
		expect(adapter.nodes).toHaveLength(2);
		expect((adapter.nodes[0] as Element).tagName).toBe("STRONG");
		expect((adapter.nodes[1] as Element).tagName).toBe("EM");
	});

	it("retains exact raw node identity when the evaluated HTML is unchanged", async () => {
		const ownerDocument = createOwnerDocument();
		const parent = ownerDocument.createElement("div");
		const evaluateExpression = vi.fn(async () => "<span>Stable</span>");
		const adapter = new RetainedProductionRawHtmlAdapter(parent, { evaluateExpression });
		const context = createContext(ownerDocument);

		expect(commitPrepared(expectPrepared(await adapter.prepare(rawSlot(), context)))).toEqual({
			status: "committed",
		});
		const stable = adapter.nodes[0];
		expect(await adapter.prepare(rawSlot(), context)).toEqual({ status: "unchanged" });
		expect(adapter.nodes[0]).toBe(stable);
		expect(evaluateExpression).toHaveBeenCalledTimes(2);
	});

	it("rejects a malformed non-explicit slot before expression evaluation", async () => {
		const ownerDocument = createOwnerDocument();
		const parent = ownerDocument.createElement("div");
		const evaluateExpression = vi.fn(async () => "<b>Unsafe</b>");
		const adapter = new RetainedProductionRawHtmlAdapter(parent, { evaluateExpression });
		const malformed = {
			...rawSlot(),
			explicitRawHtml: false,
		} as unknown as RawHtmlSlot;

		const result = await adapter.prepare(malformed, createContext(ownerDocument));
		expect(result.status).toBe("failed");
		expect(evaluateExpression).not.toHaveBeenCalled();
		expect(adapter.nodes).toHaveLength(0);
	});

	it("stales a slow older evaluation after a newer generation prepares and commits", async () => {
		const ownerDocument = createOwnerDocument();
		const parent = ownerDocument.createElement("div");
		let releaseOld!: (value: ExprValue) => void;
		let call = 0;
		const evaluateExpression: RetainedProductionRawHtmlEvaluator = async () => {
			call += 1;
			if (call === 1) {
				return new Promise<ExprValue>((resolve) => {
					releaseOld = resolve;
				});
			}
			return "<strong>New</strong>";
		};
		const adapter = new RetainedProductionRawHtmlAdapter(parent, { evaluateExpression });
		const context = createContext(ownerDocument);
		const older = adapter.prepare(rawSlot(), context);
		await Promise.resolve();

		const newer = expectPrepared(await adapter.prepare(rawSlot(), context));
		expect(commitPrepared(newer)).toEqual({ status: "committed" });
		releaseOld("<em>Old</em>");
		await expect(older).resolves.toEqual({ status: "stale" });
		expect((adapter.nodes[0] as Element).tagName).toBe("STRONG");
	});

	it("invalidates an older prepared patch even when the newer evaluation fails", async () => {
		const ownerDocument = createOwnerDocument();
		const parent = ownerDocument.createElement("div");
		let fail = false;
		const evaluateExpression: RetainedProductionRawHtmlEvaluator = async () => {
			if (fail) throw new Error("New evaluation failed");
			return "<span>Older</span>";
		};
		const adapter = new RetainedProductionRawHtmlAdapter(parent, { evaluateExpression });
		const context = createContext(ownerDocument);
		const older = expectPrepared(await adapter.prepare(rawSlot(), context));

		fail = true;
		const failed = await adapter.prepare(rawSlot(), context);
		expect(failed.status).toBe("failed");
		expect(older.commit(new RetainedCommitTransaction(() => true))).toEqual({ status: "stale" });
		expect(adapter.nodes).toHaveLength(0);
	});

	it("rolls raw HTML back by exact identity when a later transaction participant fails", async () => {
		const ownerDocument = createOwnerDocument();
		const parent = ownerDocument.createElement("div");
		let html = "<span>Stable</span>";
		const evaluateExpression = vi.fn(async () => html);
		const adapter = new RetainedProductionRawHtmlAdapter(parent, { evaluateExpression });
		const context = createContext(ownerDocument);
		expect(commitPrepared(expectPrepared(await adapter.prepare(rawSlot(), context)))).toEqual({
			status: "committed",
		});
		const stable = adapter.nodes[0];
		html = "<strong>Next</strong>";
		const next = expectPrepared(await adapter.prepare(rawSlot(), context));
		const failure = new Error("Later apply failed");
		const failing: RetainedCommitParticipant = {
			isCurrent: () => true,
			apply: () => {
				throw failure;
			},
			rollback: vi.fn(),
			finalize: vi.fn(),
			discard: vi.fn(),
		};

		const result = new RetainedCommitTransaction(() => true).commit([
			next.toCommitParticipant(),
			failing,
		]);
		expect(result.status).toBe("failed");
		expect(result.error).toBe(failure);
		expect(adapter.nodes[0]).toBe(stable);
		expect(adapter.currentHtml).toBe("<span>Stable</span>");
	});

	it("imports committed raw nodes into the adapter parent's ownerDocument", async () => {
		const ownerDocument = new DOMParser().parseFromString(
			"<!doctype html><html><body></body></html>",
			"text/html",
		);
		const parent = ownerDocument.createElement("div");
		ownerDocument.body.append(parent);
		const adapter = new RetainedProductionRawHtmlAdapter(parent, {
			evaluateExpression: async () => "<style>.x{display:block}</style><p>Body</p>",
		});

		expect(commitPrepared(expectPrepared(
			await adapter.prepare(rawSlot(), createContext(ownerDocument)),
		))).toEqual({ status: "committed" });
		expect(adapter.nodes).toHaveLength(2);
		expect(adapter.nodes.every((node) => node.ownerDocument === ownerDocument)).toBe(true);
	});

	it("returns disposed when teardown wins during expression evaluation", async () => {
		const ownerDocument = createOwnerDocument();
		const parent = ownerDocument.createElement("div");
		let release!: (value: ExprValue) => void;
		const evaluateExpression: RetainedProductionRawHtmlEvaluator = async () =>
			new Promise<ExprValue>((resolve) => {
				release = resolve;
			});
		const adapter = new RetainedProductionRawHtmlAdapter(parent, { evaluateExpression });
		const pending = adapter.prepare(rawSlot(), createContext(ownerDocument));
		await Promise.resolve();

		adapter.dispose();
		release("<strong>Late</strong>");
		await expect(pending).resolves.toEqual({ status: "disposed" });
		expect(adapter.nodes).toHaveLength(0);
	});

	it("does not accept arbitrary non-raw TemplateIR nodes through runtime casts", async () => {
		const ownerDocument = createOwnerDocument();
		const parent = ownerDocument.createElement("div");
		const evaluateExpression = vi.fn(async () => "<b>Wrong</b>");
		const adapter = new RetainedProductionRawHtmlAdapter(parent, { evaluateExpression });
		const node = compileTemplateCompat("{{name}}").nodes.find(
			(candidate): candidate is TemplateIRNode => candidate.kind === "text-slot",
		);
		if (!node) throw new Error("Expected text slot fixture");

		const result = await adapter.prepare(node as unknown as RawHtmlSlot, createContext(ownerDocument));
		expect(result.status).toBe("failed");
		expect(evaluateExpression).not.toHaveBeenCalled();
	});
});
