import { describe, expect, it, vi } from "vitest";
import {
	RetainedCommitTransaction,
	type RetainedCommitParticipant,
} from "../render/retained-commit-transaction";
import {
	RetainedLeafTemplateTransactionSurface,
	type RetainedLeafAsyncRequest,
	type RetainedPreparedLeafTemplateUpdate,
} from "../render/retained-leaf-template-transaction";
import { RetainedDomRuntime } from "../render/retained-slot-runtime";
import type { RetainedTemplateIrLike } from "../render/retained-template-dom-plan";

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
		sourceHash: "leaf-participant-transfer",
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

function requirePrepared(
	result: Awaited<ReturnType<RetainedLeafTemplateTransactionSurface<TestExpression>["prepareUpdate"]>>,
): RetainedPreparedLeafTemplateUpdate {
	if (result.status !== "prepared") {
		throw new Error(`Expected prepared leaf update, received ${result.status}`);
	}
	return result;
}

function requireClaimed(update: RetainedPreparedLeafTemplateUpdate) {
	const result = update.claimParticipants();
	if (result.status !== "claimed") throw new Error("Expected retained leaf participant claim");
	return result.claim;
}

function createSurface() {
	const ownerDocument = createOwnerDocument();
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

describe("Retained leaf participant ownership transfer", () => {
	it("claims one immutable participant group without mutating the live surface", async () => {
		const { root, runtime, surface } = createSurface();
		await seedStableIslands(runtime);
		const article = root.querySelector("article");
		const prepared = requirePrepared(await surface.prepareUpdate(
			values("Next title", "next"),
			islands("summary-next", "Next summary", "body-next", "Next body"),
		));

		const claim = requireClaimed(prepared);
		const participants = claim.toCommitParticipants();

		expect(claim.participantCount).toBe(3);
		expect(participants).toHaveLength(3);
		expect(claim.toCommitParticipants()).toBe(participants);
		expect(Object.isFrozen(participants)).toBe(true);
		expect(root.querySelector("article")).toBe(article);
		expect(root.querySelector("h1")?.textContent).toBe("Stable title");
		expect(root.textContent).toContain("Stable summary");
		expect(root.textContent).toContain("Stable body");
		expect(prepared.isCurrent()).toBe(false);
		expect(prepared.claimParticipants()).toEqual({ status: "stale" });
		expect(prepared.commit(new RetainedCommitTransaction(() => true))).toEqual({ status: "stale" });
		expect(claim.isCurrent()).toBe(true);

		claim.dispose();
	});

	it("commits transferred sync and island participants through an outer transaction", async () => {
		const { root, runtime, surface } = createSurface();
		await seedStableIslands(runtime);
		const article = root.querySelector("article");
		const heading = root.querySelector("h1");
		const prepared = requirePrepared(await surface.prepareUpdate(
			values("Transferred title", "transferred"),
			islands("summary-transfer", "Transferred summary", "body-transfer", "Transferred body"),
		));
		const claim = requireClaimed(prepared);

		const result = new RetainedCommitTransaction(() => true)
			.commit(claim.toCommitParticipants());

		expect(result.status).toBe("committed");
		expect(root.querySelector("article")).toBe(article);
		expect(root.querySelector("h1")).toBe(heading);
		expect(article?.getAttribute("data-state")).toBe("transferred");
		expect(root.textContent).toContain("Transferred title");
		expect(root.textContent).toContain("Transferred summary");
		expect(root.textContent).toContain("Transferred body");
		expect(claim.isCurrent()).toBe(false);

		claim.dispose();
	});

	it("discards transferred staging exactly once while preserving last-known-good UI", async () => {
		const { root, runtime, surface } = createSurface();
		await seedStableIslands(runtime);
		const summaryCleanup = vi.fn();
		const bodyCleanup = vi.fn();
		const prepared = requirePrepared(await surface.prepareUpdate(
			values("Discarded title", "discarded"),
			islands(
				"summary-discarded",
				"Discarded summary",
				"body-discarded",
				"Discarded body",
				{ summaryCleanup, bodyCleanup },
			),
		));
		const claim = requireClaimed(prepared);

		claim.dispose();
		claim.dispose();

		expect(summaryCleanup).toHaveBeenCalledTimes(1);
		expect(bodyCleanup).toHaveBeenCalledTimes(1);
		expect(root.querySelector("h1")?.textContent).toBe("Stable title");
		expect(root.textContent).toContain("Stable summary");
		expect(root.textContent).toContain("Stable body");
		expect(claim.isCurrent()).toBe(false);
	});

	it("rolls transferred leaf participants back when a later external participant fails", async () => {
		const { root, runtime, surface } = createSurface();
		await seedStableIslands(runtime);
		const summary = root.querySelector("article > span") as HTMLElement;
		const body = root.querySelector(".markdown-rendered-content") as HTMLElement;
		const stableSummaryNode = summary.firstChild;
		const stableBodyNode = body.firstChild;
		const summaryCleanup = vi.fn();
		const bodyCleanup = vi.fn();
		const failure = new Error("Synthetic external apply failure");
		const prepared = requirePrepared(await surface.prepareUpdate(
			values("Broken title", "broken"),
			islands(
				"summary-broken",
				"Broken summary",
				"body-broken",
				"Broken body",
				{ summaryCleanup, bodyCleanup },
			),
		));
		const claim = requireClaimed(prepared);
		const externalDiscard = vi.fn();
		const external: RetainedCommitParticipant = {
			isCurrent: () => true,
			apply: () => {
				throw failure;
			},
			rollback: vi.fn(),
			finalize: vi.fn(),
			discard: externalDiscard,
		};

		const result = new RetainedCommitTransaction(() => true).commit([
			...claim.toCommitParticipants(),
			external,
		]);

		expect(result.status).toBe("failed");
		expect(result.error).toBe(failure);
		expect(root.querySelector("h1")?.textContent).toBe("Stable title");
		expect(root.querySelector("article")?.getAttribute("data-state")).toBe("stable");
		expect(summary.firstChild).toBe(stableSummaryNode);
		expect(body.firstChild).toBe(stableBodyNode);
		expect(summary.textContent).toBe("Stable summary");
		expect(body.textContent).toBe("Stable body");
		expect(summaryCleanup).toHaveBeenCalledTimes(1);
		expect(bodyCleanup).toHaveBeenCalledTimes(1);
		expect(externalDiscard).toHaveBeenCalledTimes(1);

		claim.dispose();
	});

	it("lets a newer generation supersede a transferred claim without sharing its staging", async () => {
		const { root, runtime, surface } = createSurface();
		await seedStableIslands(runtime);
		const oldSummaryCleanup = vi.fn();
		const oldBodyCleanup = vi.fn();
		const oldPrepared = requirePrepared(await surface.prepareUpdate(
			values("Old staged title", "old-staged"),
			islands(
				"summary-shared",
				"Old staged summary",
				"body-shared",
				"Old staged body",
				{ summaryCleanup: oldSummaryCleanup, bodyCleanup: oldBodyCleanup },
			),
		));
		const oldClaim = requireClaimed(oldPrepared);

		const newerPrepared = requirePrepared(await surface.prepareUpdate(
			values("Newest title", "newest"),
			islands("summary-shared", "Newest summary", "body-shared", "Newest body"),
		));

		expect(oldClaim.isCurrent()).toBe(false);
		expect(oldSummaryCleanup).toHaveBeenCalledTimes(1);
		expect(oldBodyCleanup).toHaveBeenCalledTimes(1);
		oldClaim.dispose();
		expect(oldSummaryCleanup).toHaveBeenCalledTimes(1);
		expect(oldBodyCleanup).toHaveBeenCalledTimes(1);

		expect(newerPrepared.commit(new RetainedCommitTransaction(() => true)).status).toBe("committed");
		expect(root.querySelector("h1")?.textContent).toBe("Newest title");
		expect(root.textContent).toContain("Newest summary");
		expect(root.textContent).toContain("Newest body");
	});

	it("cleans an already-stale source handle instead of leaking claimed participant staging", async () => {
		const { root, runtime, surface } = createSurface();
		await seedStableIslands(runtime);
		const summaryCleanup = vi.fn();
		const bodyCleanup = vi.fn();
		const prepared = requirePrepared(await surface.prepareUpdate(
			values("Stale title", "stale"),
			islands(
				"summary-stale",
				"Stale summary",
				"body-stale",
				"Stale body",
				{ summaryCleanup, bodyCleanup },
			),
		));

		runtime.mountStructure("replacement", ({ fragment, ownerDocument, textSlot }) => {
			const paragraph = ownerDocument.createElement("p");
			paragraph.appendChild(textSlot("replacement", "Replacement"));
			fragment.appendChild(paragraph);
		});

		expect(prepared.claimParticipants()).toEqual({ status: "stale" });
		expect(summaryCleanup).toHaveBeenCalledTimes(1);
		expect(bodyCleanup).toHaveBeenCalledTimes(1);
		expect(root.textContent).toBe("Replacement");
	});
});
