import { describe, expect, it, vi } from "vitest";
import { RetainedCommitTransaction } from "../render/retained-commit-transaction";
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
		sourceHash: "leaf-transaction",
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

function createSurface(ownerDocument: Document = createOwnerDocument()) {
	const root = ownerDocument.createElement("div");
	ownerDocument.body.appendChild(root);
	const runtime = new RetainedDomRuntime(root);
	const surface = new RetainedLeafTemplateTransactionSurface(runtime, leafTemplate());
	expect(surface.initialize(values("Stable title", "stable"))).toEqual({ status: "mounted" });
	return { ownerDocument, root, runtime, surface };
}

async function seedStableIslands(runtime: RetainedDomRuntime) {
	await runtime.patchMarkdown("summary", "summary-stable", ({ container }) => {
		container.textContent = "Stable summary";
	});
	await runtime.patchContent("body", "body-stable", ({ container }) => {
		container.textContent = "Stable body";
	});
}

describe("RetainedLeafTemplateTransactionSurface", () => {
	it("initializes one static leaf tree with synchronous values in the owner document", () => {
		const ownerDocument = createOwnerDocument();
		const { root, surface } = createSurface(ownerDocument);
		const article = root.querySelector("article");

		expect(article?.ownerDocument).toBe(ownerDocument);
		expect(article?.getAttribute("data-state")).toBe("stable");
		expect(article?.querySelector("h1")?.textContent).toBe("Stable title");
		expect(article?.querySelector("span")).not.toBeNull();
		expect(article?.querySelector(".markdown-rendered-content")).not.toBeNull();
		expect(surface.isInitialized).toBe(true);
		expect(surface.isPoisoned).toBe(false);
	});

	it("commits sync leaves, Markdown, and content behind one transaction while retaining static identity", async () => {
		const { root, runtime, surface } = createSurface();
		await seedStableIslands(runtime);
		const article = root.querySelector("article");
		const heading = root.querySelector("h1");

		const prepared = requirePrepared(await surface.prepareUpdate(
			values("Next title", "next"),
			islands("summary-next", "Next summary", "body-next", "Next body"),
		));

		expect(prepared.participantCount).toBe(3);
		expect(root.textContent).toContain("Stable title");
		expect(root.textContent).toContain("Stable summary");
		expect(root.textContent).toContain("Stable body");

		const transaction = new RetainedCommitTransaction(() => true);
		expect(prepared.commit(transaction).status).toBe("committed");
		expect(root.querySelector("article")).toBe(article);
		expect(root.querySelector("h1")).toBe(heading);
		expect(article?.getAttribute("data-state")).toBe("next");
		expect(root.textContent).toContain("Next title");
		expect(root.textContent).toContain("Next summary");
		expect(root.textContent).toContain("Next body");
	});

	it("rolls sync and earlier island mutations back when a later island apply throws", async () => {
		const { root, runtime, surface } = createSurface();
		await seedStableIslands(runtime);
		const summary = root.querySelector("article > span") as HTMLElement;
		const body = root.querySelector(".markdown-rendered-content") as HTMLElement;
		const stableSummaryNode = summary.firstChild;
		const stableBodyNode = body.firstChild;
		const stagedSummaryCleanup = vi.fn();
		const stagedBodyCleanup = vi.fn();

		const prepared = requirePrepared(await surface.prepareUpdate(
			values("Broken title", "broken"),
			islands(
				"summary-broken",
				"Broken summary",
				"body-broken",
				"Broken body",
				{ summaryCleanup: stagedSummaryCleanup, bodyCleanup: stagedBodyCleanup },
			),
		));

		const originalReplaceChildren = body.replaceChildren.bind(body);
		let replaceCalls = 0;
		body.replaceChildren = (...nodes: (Node | string)[]) => {
			replaceCalls += 1;
			if (replaceCalls === 1) throw new Error("Synthetic content apply failure");
			originalReplaceChildren(...nodes);
		};

		const result = prepared.commit(new RetainedCommitTransaction(() => true));
		expect(result.status).toBe("failed");
		expect(root.querySelector("h1")?.textContent).toBe("Stable title");
		expect(root.querySelector("article")?.getAttribute("data-state")).toBe("stable");
		expect(summary.firstChild).toBe(stableSummaryNode);
		expect(body.firstChild).toBe(stableBodyNode);
		expect(summary.textContent).toBe("Stable summary");
		expect(body.textContent).toBe("Stable body");
		expect(stagedSummaryCleanup).toHaveBeenCalledTimes(1);
		expect(stagedBodyCleanup).toHaveBeenCalledTimes(1);
	});

	it("performs zero live mutation and discards staging when the owner gate is stale", async () => {
		const { root, runtime, surface } = createSurface();
		await seedStableIslands(runtime);
		const stagedSummaryCleanup = vi.fn();
		const stagedBodyCleanup = vi.fn();
		const article = root.querySelector("article");

		const prepared = requirePrepared(await surface.prepareUpdate(
			values("Stale title", "stale"),
			islands(
				"summary-stale",
				"Stale summary",
				"body-stale",
				"Stale body",
				{ summaryCleanup: stagedSummaryCleanup, bodyCleanup: stagedBodyCleanup },
			),
		));

		expect(prepared.commit(new RetainedCommitTransaction(() => false)).status).toBe("stale");
		expect(root.querySelector("article")).toBe(article);
		expect(root.querySelector("h1")?.textContent).toBe("Stable title");
		expect(root.textContent).toContain("Stable summary");
		expect(root.textContent).toContain("Stable body");
		expect(stagedSummaryCleanup).toHaveBeenCalledTimes(1);
		expect(stagedBodyCleanup).toHaveBeenCalledTimes(1);
	});

	it("preserves live state when async preparation fails and cleans successful siblings", async () => {
		const { root, runtime, surface } = createSurface();
		await seedStableIslands(runtime);
		const stagedSummaryCleanup = vi.fn();
		const failure = new Error("Synthetic body preparation failure");
		const requests = new Map<string, RetainedLeafAsyncRequest>([
			["summary", {
				renderKey: "summary-next",
				renderer: ({ container, resources }) => {
					container.textContent = "Prepared summary";
					resources.register(stagedSummaryCleanup);
				},
			}],
			["body", {
				renderKey: "body-next",
				renderer: () => {
					throw failure;
				},
			}],
		]);

		const result = await surface.prepareUpdate(values("Next title", "next"), requests);
		expect(result).toEqual({ status: "failed", error: failure });
		expect(root.querySelector("h1")?.textContent).toBe("Stable title");
		expect(root.textContent).toContain("Stable summary");
		expect(root.textContent).toContain("Stable body");
		expect(stagedSummaryCleanup).toHaveBeenCalledTimes(1);
	});

	it("lets a newer same-key preparation own runtime-deduplicated island handles", async () => {
		const { root, runtime, surface } = createSurface();
		await seedStableIslands(runtime);
		const sharedRequests = islands("summary-shared", "Shared summary", "body-shared", "Shared body");
		const first = requirePrepared(await surface.prepareUpdate(values("First title", "first"), sharedRequests));
		const second = requirePrepared(await surface.prepareUpdate(values("Second title", "second"), sharedRequests));

		expect(first.isCurrent()).toBe(false);
		first.dispose();
		expect(second.isCurrent()).toBe(true);
		expect(second.commit(new RetainedCommitTransaction(() => true)).status).toBe("committed");
		expect(root.querySelector("h1")?.textContent).toBe("Second title");
		expect(root.textContent).toContain("Shared summary");
		expect(root.textContent).toContain("Shared body");
	});

	it("rejects incomplete or extra resolved inputs before starting async rendering", async () => {
		const { surface } = createSurface();
		const renderer = vi.fn();

		const missingValue = await surface.prepareUpdate(
			new Map([["title", "Only title"]]),
			islands("summary", "Summary", "body", "Body"),
		);
		expect(missingValue.status).toBe("failed");

		const missingIsland = await surface.prepareUpdate(
			values("Title", "state"),
			new Map([
				["summary", { renderKey: "summary", renderer }],
			]),
		);
		expect(missingIsland.status).toBe("failed");
		expect(renderer).not.toHaveBeenCalled();

		const extraIsland = new Map(islands("summary", "Summary", "body", "Body"));
		extraIsland.set("unexpected", { renderKey: "extra", renderer });
		expect((await surface.prepareUpdate(values("Title", "state"), extraIsland)).status).toBe("failed");
		expect(renderer).not.toHaveBeenCalled();
	});

	it("marks a prepared batch stale when another structure replaces its retained runtime", async () => {
		const { root, runtime, surface } = createSurface();
		await seedStableIslands(runtime);
		const prepared = requirePrepared(await surface.prepareUpdate(
			values("Next title", "next"),
			islands("summary-next", "Next summary", "body-next", "Next body"),
		));

		expect(runtime.mountStructure("replacement", ({ fragment, ownerDocument, textSlot }) => {
			const paragraph = ownerDocument.createElement("p");
			paragraph.appendChild(textSlot("replacement", "Replacement"));
			fragment.appendChild(paragraph);
		})).toBe("mounted");

		expect(prepared.isCurrent()).toBe(false);
		expect(prepared.commit(new RetainedCommitTransaction(() => true)).status).toBe("stale");
		expect(root.textContent).toBe("Replacement");
	});

	it("keeps all staging and committed DOM in a popout-like ownerDocument", async () => {
		const ownerDocument = createOwnerDocument();
		const { root, runtime, surface } = createSurface(ownerDocument);
		await seedStableIslands(runtime);
		let markdownDocument: Document | null = null;
		let contentDocument: Document | null = null;
		const requests = new Map<string, RetainedLeafAsyncRequest>([
			["summary", {
				renderKey: "summary-popup",
				renderer: ({ container, ownerDocument: contextDocument }) => {
					markdownDocument = container.ownerDocument;
					expect(contextDocument).toBe(ownerDocument);
					container.textContent = "Popup summary";
				},
			}],
			["body", {
				renderKey: "body-popup",
				renderer: ({ container, ownerDocument: contextDocument }) => {
					contentDocument = container.ownerDocument;
					expect(contextDocument).toBe(ownerDocument);
					container.textContent = "Popup body";
				},
			}],
		]);

		const prepared = requirePrepared(await surface.prepareUpdate(values("Popup title", "popup"), requests));
		expect(prepared.commit(new RetainedCommitTransaction(() => true)).status).toBe("committed");
		expect(markdownDocument).toBe(ownerDocument);
		expect(contentDocument).toBe(ownerDocument);
		expect(root.querySelector("article")?.ownerDocument).toBe(ownerDocument);
		expect(root.textContent).toContain("Popup title");
	});
});
