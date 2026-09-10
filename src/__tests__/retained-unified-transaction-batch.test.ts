import { describe, expect, it, vi } from "vitest";
import {
	RetainedCommitTransaction,
	type RetainedCommitParticipant,
} from "../render/retained-commit-transaction";
import {
	RetainedLeafTemplateTransactionSurface,
	type RetainedLeafAsyncRequest,
	type RetainedLeafTemplateParticipantClaim,
	type RetainedPreparedLeafTemplateUpdate,
} from "../render/retained-leaf-template-transaction";
import { RetainedRawHtmlTransactionRange } from "../render/retained-raw-html-transaction-range";
import { RetainedDomRuntime } from "../render/retained-slot-runtime";
import type { RetainedPreparedStructuralChange } from "../render/retained-structural-transaction-batch";
import type { RetainedTemplateIrLike } from "../render/retained-template-dom-plan";
import {
	RetainedUnifiedTransactionBatch,
	RetainedUnifiedTransactionBatchError,
} from "../render/retained-unified-transaction-batch";

type TestExpression = string;

function createOwnerDocument(): Document {
	return new DOMParser().parseFromString(
		"<!doctype html><html><body></body></html>",
		"text/html",
	);
}

function leafTemplate(): RetainedTemplateIrLike<TestExpression> {
	return {
		version: 1,
		sourceHash: "unified-retained-transaction",
		nodes: [
			{ kind: "static-fragment", html: '<article data-state="' },
			{
				kind: "attribute-slot",
				id: "state",
				attribute: "data-state",
				targetKey: "article",
				quote: '"',
				parts: [{ kind: "expression", expression: "state" }],
			},
			{ kind: "static-fragment", html: '"><h1>' },
			{ kind: "text-slot", id: "title", expression: "title" },
			{ kind: "static-fragment", html: "</h1>" },
			{ kind: "markdown-slot", id: "summary", expression: "summary" },
			{ kind: "content-slot", id: "body", expression: "content" },
			{ kind: "static-fragment", html: "</article>" },
		],
	};
}

function values(title: string, state: string) {
	return new Map<string, string>([
		["title", title],
		["state", state],
	]);
}

function islands(
	summaryKey: string,
	summary: string,
	bodyKey: string,
	body: string,
	options: {
		summaryCleanup?: () => void;
		bodyCleanup?: () => void;
	} = {},
): ReadonlyMap<string, RetainedLeafAsyncRequest> {
	return new Map([
		["summary", {
			renderKey: summaryKey,
			renderer: ({ container, resources }) => {
				container.textContent = summary;
				if (options.summaryCleanup) resources.register(options.summaryCleanup);
			},
		}],
		["body", {
			renderKey: bodyKey,
			renderer: ({ container, resources }) => {
				container.textContent = body;
				if (options.bodyCleanup) resources.register(options.bodyCleanup);
			},
		}],
	]);
}

function requirePreparedLeaf(
	result: Awaited<ReturnType<RetainedLeafTemplateTransactionSurface<TestExpression>["prepareUpdate"]>>,
): RetainedPreparedLeafTemplateUpdate {
	if (result.status !== "prepared") {
		throw new Error(`Expected prepared leaf update, received ${result.status}`);
	}
	return result;
}

function requireLeafClaim(update: RetainedPreparedLeafTemplateUpdate): RetainedLeafTemplateParticipantClaim {
	const result = update.claimParticipants();
	if (result.status !== "claimed") throw new Error("Expected retained leaf participant claim");
	return result.claim;
}

function requirePreparedRaw(
	result: ReturnType<RetainedRawHtmlTransactionRange["prepare"]>,
) {
	if (result.status !== "prepared") {
		throw new Error(`Expected prepared raw HTML update, received ${result.status}`);
	}
	return result;
}

function createLeafSurface(ownerDocument: Document) {
	const root = ownerDocument.createElement("div");
	ownerDocument.body.appendChild(root);
	const runtime = new RetainedDomRuntime(root);
	const surface = new RetainedLeafTemplateTransactionSurface(runtime, leafTemplate());
	expect(surface.initialize(values("Stable title", "stable"))).toEqual({ status: "mounted" });
	return { root, runtime, surface };
}

async function seedStableIslands(runtime: RetainedDomRuntime) {
	await runtime.patchMarkdown("summary", "summary-stable", ({ container }) => {
		container.textContent = "Stable summary";
	});
	await runtime.patchContent("body", "body-stable", ({ container }) => {
		container.textContent = "Stable body";
	});
}

function createRawRange(ownerDocument: Document) {
	const parent = ownerDocument.createElement("section");
	ownerDocument.body.appendChild(parent);
	const range = new RetainedRawHtmlTransactionRange(parent);
	const seed = requirePreparedRaw(range.prepare({
		explicitRawHtml: true,
		html: "<em>Stable raw</em>",
	}));
	expect(seed.commit(new RetainedCommitTransaction(() => true)).status).toBe("committed");
	return { parent, range };
}

function failingStructuralChange(
	failure: Error,
	options: { onApply?: () => void; onDispose?: () => void } = {},
): RetainedPreparedStructuralChange {
	let terminal = false;
	const participant: RetainedCommitParticipant = {
		isCurrent: () => !terminal,
		apply: () => {
			options.onApply?.();
			throw failure;
		},
		rollback: vi.fn(),
		finalize: vi.fn(),
		discard: () => {
			terminal = true;
		},
	};
	return {
		isCurrent: () => !terminal,
		toCommitParticipant: () => participant,
		dispose: () => {
			terminal = true;
			options.onDispose?.();
		},
	};
}

function passiveStructuralChange(
	participant: RetainedCommitParticipant,
	overrides: {
		isCurrent?: () => boolean;
		dispose?: () => void;
	} = {},
): RetainedPreparedStructuralChange {
	return {
		isCurrent: overrides.isCurrent ?? (() => true),
		toCommitParticipant: () => participant,
		dispose: overrides.dispose ?? (() => undefined),
	};
}

describe("RetainedUnifiedTransactionBatch", () => {
	it("returns unchanged when no retained work is supplied", () => {
		expect(RetainedUnifiedTransactionBatch.prepare({})).toEqual({ status: "unchanged" });
	});

	it("commits leaf sync/islands and real raw HTML through one outer transaction", async () => {
		const ownerDocument = createOwnerDocument();
		const { root, runtime, surface } = createLeafSurface(ownerDocument);
		await seedStableIslands(runtime);
		const { range } = createRawRange(ownerDocument);
		const article = root.querySelector("article");
		const heading = root.querySelector("h1");
		const leaf = requireLeafClaim(requirePreparedLeaf(await surface.prepareUpdate(
			values("Unified title", "unified"),
			islands("summary-unified", "Unified summary", "body-unified", "Unified body"),
		)));
		const raw = requirePreparedRaw(range.prepare({
			explicitRawHtml: true,
			html: "<strong>Unified raw</strong>",
		}));
		const prepared = RetainedUnifiedTransactionBatch.prepare({
			leafClaims: [leaf],
			structuralChanges: [raw],
		});
		if (prepared.status !== "prepared") throw new Error("Expected unified batch");

		expect(prepared.batch.sourceCount).toBe(2);
		expect(prepared.batch.participantCount).toBe(4);
		expect(prepared.batch.commit(new RetainedCommitTransaction(() => true))).toEqual({
			status: "committed",
		});
		expect(root.querySelector("article")).toBe(article);
		expect(root.querySelector("h1")).toBe(heading);
		expect(article?.getAttribute("data-state")).toBe("unified");
		expect(root.textContent).toContain("Unified title");
		expect(root.textContent).toContain("Unified summary");
		expect(root.textContent).toContain("Unified body");
		expect(range.currentHtml).toBe("<strong>Unified raw</strong>");
		expect(range.nodes[0]?.textContent).toBe("Unified raw");
	});

	it("rolls leaf and raw HTML back when a later structural participant fails", async () => {
		const ownerDocument = createOwnerDocument();
		const { root, runtime, surface } = createLeafSurface(ownerDocument);
		await seedStableIslands(runtime);
		const { range } = createRawRange(ownerDocument);
		const stableRawNode = range.nodes[0];
		const failure = new Error("Synthetic unified structural failure");
		const leaf = requireLeafClaim(requirePreparedLeaf(await surface.prepareUpdate(
			values("Broken title", "broken"),
			islands("summary-broken", "Broken summary", "body-broken", "Broken body"),
		)));
		const raw = requirePreparedRaw(range.prepare({
			explicitRawHtml: true,
			html: "<strong>Broken raw</strong>",
		}));
		const prepared = RetainedUnifiedTransactionBatch.prepare({
			leafClaims: [leaf],
			structuralChanges: [raw, failingStructuralChange(failure)],
		});
		if (prepared.status !== "prepared") throw new Error("Expected unified batch");

		const result = prepared.batch.commit(new RetainedCommitTransaction(() => true));

		expect(result.status).toBe("failed");
		expect(result.error).toBe(failure);
		expect(root.querySelector("h1")?.textContent).toBe("Stable title");
		expect(root.querySelector("article")?.getAttribute("data-state")).toBe("stable");
		expect(root.textContent).toContain("Stable summary");
		expect(root.textContent).toContain("Stable body");
		expect(range.currentHtml).toBe("<em>Stable raw</em>");
		expect(range.nodes[0]).toBe(stableRawNode);
	});

	it("rolls every entered source back when owner validity changes reentrantly", async () => {
		const ownerDocument = createOwnerDocument();
		const { root, runtime, surface } = createLeafSurface(ownerDocument);
		await seedStableIslands(runtime);
		const { range } = createRawRange(ownerDocument);
		const stableRawNode = range.nodes[0];
		let ownerCurrent = true;
		const leaf = requireLeafClaim(requirePreparedLeaf(await surface.prepareUpdate(
			values("Stale title", "stale"),
			islands("summary-stale", "Stale summary", "body-stale", "Stale body"),
		)));
		const raw = requirePreparedRaw(range.prepare({
			explicitRawHtml: true,
			html: "<strong>Stale raw</strong>",
		}));
		const staleTrigger: RetainedCommitParticipant = {
			isCurrent: () => true,
			apply: () => {
				ownerCurrent = false;
			},
			rollback: vi.fn(),
			finalize: vi.fn(),
			discard: vi.fn(),
		};
		const prepared = RetainedUnifiedTransactionBatch.prepare({
			leafClaims: [leaf],
			structuralChanges: [raw, passiveStructuralChange(staleTrigger)],
		});
		if (prepared.status !== "prepared") throw new Error("Expected unified batch");

		expect(prepared.batch.commit(new RetainedCommitTransaction(() => ownerCurrent))).toEqual({
			status: "stale",
		});
		expect(root.querySelector("h1")?.textContent).toBe("Stable title");
		expect(root.textContent).toContain("Stable summary");
		expect(root.textContent).toContain("Stable body");
		expect(range.currentHtml).toBe("<em>Stable raw</em>");
		expect(range.nodes[0]).toBe(stableRawNode);
	});

	it("rolls every entered source back when the transaction is disposed reentrantly", async () => {
		const ownerDocument = createOwnerDocument();
		const { root, runtime, surface } = createLeafSurface(ownerDocument);
		await seedStableIslands(runtime);
		const { range } = createRawRange(ownerDocument);
		const stableRawNode = range.nodes[0];
		const leaf = requireLeafClaim(requirePreparedLeaf(await surface.prepareUpdate(
			values("Disposed title", "disposed"),
			islands("summary-disposed", "Disposed summary", "body-disposed", "Disposed body"),
		)));
		const raw = requirePreparedRaw(range.prepare({
			explicitRawHtml: true,
			html: "<strong>Disposed raw</strong>",
		}));
		let transaction!: RetainedCommitTransaction;
		const disposeTrigger: RetainedCommitParticipant = {
			isCurrent: () => true,
			apply: () => transaction.dispose(),
			rollback: vi.fn(),
			finalize: vi.fn(),
			discard: vi.fn(),
		};
		const prepared = RetainedUnifiedTransactionBatch.prepare({
			leafClaims: [leaf],
			structuralChanges: [raw, passiveStructuralChange(disposeTrigger)],
		});
		if (prepared.status !== "prepared") throw new Error("Expected unified batch");
		transaction = new RetainedCommitTransaction(() => true);

		expect(prepared.batch.commit(transaction)).toEqual({ status: "disposed" });
		expect(root.querySelector("h1")?.textContent).toBe("Stable title");
		expect(root.textContent).toContain("Stable summary");
		expect(root.textContent).toContain("Stable body");
		expect(range.currentHtml).toBe("<em>Stable raw</em>");
		expect(range.nodes[0]).toBe(stableRawNode);
	});

	it("rejects duplicate source identity and cleans that source once", async () => {
		const ownerDocument = createOwnerDocument();
		const { runtime, surface } = createLeafSurface(ownerDocument);
		await seedStableIslands(runtime);
		const summaryCleanup = vi.fn();
		const bodyCleanup = vi.fn();
		const leaf = requireLeafClaim(requirePreparedLeaf(await surface.prepareUpdate(
			values("Duplicate title", "duplicate"),
			islands(
				"summary-duplicate",
				"Duplicate summary",
				"body-duplicate",
				"Duplicate body",
				{ summaryCleanup, bodyCleanup },
			),
		)));

		const result = RetainedUnifiedTransactionBatch.prepare({ leafClaims: [leaf, leaf] });

		expect(result.status).toBe("failed");
		if (result.status !== "failed") return;
		expect(result.error).toBeInstanceOf(RetainedUnifiedTransactionBatchError);
		expect((result.error as RetainedUnifiedTransactionBatchError).code).toBe("duplicate-source");
		expect(summaryCleanup).toHaveBeenCalledTimes(1);
		expect(bodyCleanup).toHaveBeenCalledTimes(1);
	});

	it("rejects participant aliasing across leaf and structural sources before live mutation", async () => {
		const ownerDocument = createOwnerDocument();
		const { root, runtime, surface } = createLeafSurface(ownerDocument);
		await seedStableIslands(runtime);
		const leaf = requireLeafClaim(requirePreparedLeaf(await surface.prepareUpdate(
			values("Aliased title", "aliased"),
			islands("summary-aliased", "Aliased summary", "body-aliased", "Aliased body"),
		)));
		const aliasedParticipant = leaf.toCommitParticipants()[0];
		const structuralDispose = vi.fn();
		const structural = passiveStructuralChange(aliasedParticipant, {
			dispose: structuralDispose,
		});

		const result = RetainedUnifiedTransactionBatch.prepare({
			leafClaims: [leaf],
			structuralChanges: [structural],
		});

		expect(result.status).toBe("failed");
		if (result.status !== "failed") return;
		expect(result.error).toBeInstanceOf(RetainedUnifiedTransactionBatchError);
		expect((result.error as RetainedUnifiedTransactionBatchError).code).toBe("duplicate-participant");
		expect(structuralDispose).toHaveBeenCalledTimes(1);
		expect(root.querySelector("h1")?.textContent).toBe("Stable title");
		expect(root.textContent).toContain("Stable summary");
		expect(root.textContent).toContain("Stable body");
	});

	it("turns a throwing source currentness check into failure and cleans every source", async () => {
		const ownerDocument = createOwnerDocument();
		const { root, runtime, surface } = createLeafSurface(ownerDocument);
		await seedStableIslands(runtime);
		const leaf = requireLeafClaim(requirePreparedLeaf(await surface.prepareUpdate(
			values("Guarded title", "guarded"),
			islands("summary-guarded", "Guarded summary", "body-guarded", "Guarded body"),
		)));
		const failure = new Error("Synthetic source gate failure");
		const structuralDispose = vi.fn();
		const participant: RetainedCommitParticipant = {
			isCurrent: () => true,
			apply: vi.fn(),
			rollback: vi.fn(),
			finalize: vi.fn(),
			discard: vi.fn(),
		};
		const structural = passiveStructuralChange(participant, {
			isCurrent: () => {
				throw failure;
			},
			dispose: structuralDispose,
		});
		const prepared = RetainedUnifiedTransactionBatch.prepare({
			leafClaims: [leaf],
			structuralChanges: [structural],
		});
		if (prepared.status !== "prepared") throw new Error("Expected unified batch");

		const result = prepared.batch.commit(new RetainedCommitTransaction(() => true));

		expect(result.status).toBe("failed");
		expect(result.error).toBe(failure);
		expect(structuralDispose).toHaveBeenCalledTimes(1);
		expect(root.querySelector("h1")?.textContent).toBe("Stable title");
		expect(root.textContent).toContain("Stable summary");
		expect(root.textContent).toContain("Stable body");
	});

	it("isolates throwing cleanup reporters while collecting every source cleanup error", () => {
		const firstFailure = new Error("First source cleanup failed");
		const secondFailure = new Error("Second source cleanup failed");
		const reported: unknown[] = [];
		const participant = (): RetainedCommitParticipant => ({
			isCurrent: () => true,
			apply: vi.fn(),
			rollback: vi.fn(),
			finalize: vi.fn(),
			discard: vi.fn(),
		});
		const first = passiveStructuralChange(participant(), {
			isCurrent: () => false,
			dispose: () => {
				throw firstFailure;
			},
		});
		const second = passiveStructuralChange(participant(), {
			dispose: () => {
				throw secondFailure;
			},
		});
		const prepared = RetainedUnifiedTransactionBatch.prepare(
			{ structuralChanges: [first, second] },
			{
				onCleanupError(error) {
					reported.push(error);
					throw new Error("Reporter failed");
				},
			},
		);
		if (prepared.status !== "prepared") throw new Error("Expected unified batch");

		const result = prepared.batch.commit(new RetainedCommitTransaction(() => true));

		expect(result.status).toBe("stale");
		expect(result.cleanupErrors).toEqual([firstFailure, secondFailure]);
		expect(reported).toEqual([firstFailure, secondFailure]);
	});
});
