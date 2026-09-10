import { describe, expect, it, vi } from "vitest";
import {
	RetainedLeafGenerationCoordinator,
	type RetainedPreparedLeafOwnerGeneration,
} from "../render/retained-leaf-generation-coordinator";
import type { RetainedLeafAsyncRequest } from "../render/retained-leaf-template-transaction";
import type { RetainedTemplateIrLike } from "../render/retained-template-dom-plan";

type TestExpression = string;

function createOwnerDocument(): Document {
	return new DOMParser().parseFromString(
		"<!doctype html><html><body></body></html>",
		"text/html",
	);
}

function leafTemplate(
	sourceHash: string,
	options: { async?: boolean } = {},
): RetainedTemplateIrLike<TestExpression> {
	const async = options.async ?? true;
	return {
		version: 1,
		sourceHash,
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
			...(async
				? [
					{ kind: "markdown-slot", id: "summary", expression: "summary" } as const,
					{ kind: "content-slot", id: "body", expression: "content" } as const,
				]
				: []),
			{ kind: "static-fragment", html: "</article>" },
		],
	};
}

function values(title: string, state: string): ReadonlyMap<string, string> {
	return new Map([
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
		onRender?: (container: HTMLElement) => void;
	} = {},
): ReadonlyMap<string, RetainedLeafAsyncRequest> {
	return new Map([
		["summary", {
			renderKey: summaryKey,
			renderer: ({ container, resources }) => {
				options.onRender?.(container);
				container.textContent = summary;
				if (options.summaryCleanup) resources.register(options.summaryCleanup);
			},
		}],
		["body", {
			renderKey: bodyKey,
			renderer: ({ container, resources }) => {
				options.onRender?.(container);
				container.textContent = body;
				if (options.bodyCleanup) resources.register(options.bodyCleanup);
			},
		}],
	]);
}

function requirePrepared(
	result: Awaited<ReturnType<RetainedLeafGenerationCoordinator<TestExpression>["prepare"]>>,
): RetainedPreparedLeafOwnerGeneration {
	if (result.status !== "prepared") {
		throw new Error(`Expected prepared owner generation, received ${result.status}`);
	}
	return result;
}

function createCoordinator(ownerDocument: Document = createOwnerDocument()) {
	const root = ownerDocument.createElement("div");
	const native = ownerDocument.createElement("p");
	native.textContent = "Native stable";
	root.appendChild(native);
	ownerDocument.body.appendChild(root);
	return {
		ownerDocument,
		root,
		native,
		coordinator: new RetainedLeafGenerationCoordinator<TestExpression>(root),
	};
}

async function commitInitial(
	coordinator: RetainedLeafGenerationCoordinator<TestExpression>,
	template = leafTemplate("initial"),
) {
	const prepared = requirePrepared(await coordinator.prepare(
		template,
		values("Stable title", "stable"),
		template.nodes.some((node) => node.kind === "markdown-slot")
			? islands("summary-stable", "Stable summary", "body-stable", "Stable body")
			: new Map(),
	));
	expect(prepared.commit(() => true).status).toBe("committed");
	return prepared;
}

describe("RetainedLeafGenerationCoordinator", () => {
	it("fully prepares the first leaf generation off DOM before one live commit", async () => {
		const { root, native, coordinator } = createCoordinator();
		const stagedConnections: boolean[] = [];
		const prepared = requirePrepared(await coordinator.prepare(
			leafTemplate("first"),
			values("First title", "first"),
			islands("summary-first", "First summary", "body-first", "First body", {
				onRender: (container) => stagedConnections.push(container.isConnected),
			}),
		));

		expect(prepared.mode).toBe("replace");
		expect(stagedConnections).toEqual([false, false]);
		expect(root.firstChild).toBe(native);
		expect(root.textContent).toBe("Native stable");

		expect(prepared.commit(() => true)).toEqual({ status: "committed" });
		expect(root.querySelector("h1")?.textContent).toBe("First title");
		expect(root.textContent).toContain("First summary");
		expect(root.textContent).toContain("First body");
	});

	it("reuses static DOM identity for same-structure sync and async patches", async () => {
		const { root, coordinator } = createCoordinator();
		await commitInitial(coordinator);
		const article = root.querySelector("article");
		const heading = root.querySelector("h1");

		const prepared = requirePrepared(await coordinator.prepare(
			leafTemplate("initial"),
			values("Next title", "next"),
			islands("summary-next", "Next summary", "body-next", "Next body"),
		));
		expect(prepared.mode).toBe("patch");
		expect(root.querySelector("h1")?.textContent).toBe("Stable title");

		expect(prepared.commit(() => true).status).toBe("committed");
		expect(root.querySelector("article")).toBe(article);
		expect(root.querySelector("h1")).toBe(heading);
		expect(article?.getAttribute("data-state")).toBe("next");
		expect(root.textContent).toContain("Next title");
		expect(root.textContent).toContain("Next summary");
		expect(root.textContent).toContain("Next body");
	});

	it("keeps previous resources alive until a replacement generation commits", async () => {
		const { root, coordinator } = createCoordinator();
		const oldSummaryCleanup = vi.fn();
		const oldBodyCleanup = vi.fn();
		const first = requirePrepared(await coordinator.prepare(
			leafTemplate("old"),
			values("Old title", "old"),
			islands("summary-old", "Old summary", "body-old", "Old body", {
				summaryCleanup: oldSummaryCleanup,
				bodyCleanup: oldBodyCleanup,
			}),
		));
		expect(first.commit(() => true).status).toBe("committed");
		const oldArticle = root.querySelector("article");

		const replacement = requirePrepared(await coordinator.prepare(
			leafTemplate("new"),
			values("New title", "new"),
			islands("summary-new", "New summary", "body-new", "New body"),
		));
		expect(oldSummaryCleanup).not.toHaveBeenCalled();
		expect(oldBodyCleanup).not.toHaveBeenCalled();
		expect(root.querySelector("article")).toBe(oldArticle);

		expect(replacement.commit(() => true).status).toBe("committed");
		expect(root.querySelector("article")).not.toBe(oldArticle);
		expect(root.textContent).toContain("New title");
		expect(oldSummaryCleanup).toHaveBeenCalledTimes(1);
		expect(oldBodyCleanup).toHaveBeenCalledTimes(1);
	});

	it("preserves last-known-good live UI when replacement async preparation fails", async () => {
		const { root, coordinator } = createCoordinator();
		await commitInitial(coordinator);
		const article = root.querySelector("article");
		const stagedCleanup = vi.fn();
		const failure = new Error("Synthetic replacement render failure");
		const requests = new Map<string, RetainedLeafAsyncRequest>([
			["summary", {
				renderKey: "summary-broken",
				renderer: ({ container, resources }) => {
					container.textContent = "Prepared summary";
					resources.register(stagedCleanup);
				},
			}],
			["body", {
				renderKey: "body-broken",
				renderer: () => {
					throw failure;
				},
			}],
		]);

		const result = await coordinator.prepare(
			leafTemplate("broken"),
			values("Broken title", "broken"),
			requests,
		);
		expect(result).toEqual({ status: "failed", error: failure });
		expect(root.querySelector("article")).toBe(article);
		expect(root.textContent).toContain("Stable title");
		expect(stagedCleanup).toHaveBeenCalledTimes(1);
	});

	it("rolls a prepared replacement back when the final owner gate is stale", async () => {
		const { root, coordinator } = createCoordinator();
		await commitInitial(coordinator);
		const article = root.querySelector("article");
		const replacement = requirePrepared(await coordinator.prepare(
			leafTemplate("stale"),
			values("Stale title", "stale"),
			islands("summary-stale", "Stale summary", "body-stale", "Stale body"),
		));

		expect(replacement.commit(() => false).status).toBe("stale");
		expect(root.querySelector("article")).toBe(article);
		expect(root.textContent).toContain("Stable title");
	});

	it("makes an older same-structure patch stale when a newer replacement is prepared", async () => {
		const { root, coordinator } = createCoordinator();
		await commitInitial(coordinator);
		const patch = requirePrepared(await coordinator.prepare(
			leafTemplate("initial"),
			values("Old pending", "pending"),
			islands("summary-pending", "Pending summary", "body-pending", "Pending body"),
		));
		const replacement = requirePrepared(await coordinator.prepare(
			leafTemplate("replacement"),
			values("Replacement title", "replacement"),
			islands("summary-replacement", "Replacement summary", "body-replacement", "Replacement body"),
		));

		expect(patch.isCurrent()).toBe(false);
		expect(patch.commit(() => true).status).toBe("stale");
		expect(root.textContent).toContain("Stable title");
		expect(replacement.commit(() => true).status).toBe("committed");
		expect(root.textContent).toContain("Replacement title");
	});

	it("supersedes a pending replacement when a newer active-structure patch arrives", async () => {
		const { root, coordinator } = createCoordinator();
		await commitInitial(coordinator);
		const replacement = requirePrepared(await coordinator.prepare(
			leafTemplate("pending-replacement"),
			values("Pending replacement", "pending"),
			islands("summary-pending-r", "Pending replacement summary", "body-pending-r", "Pending replacement body"),
		));
		const patch = requirePrepared(await coordinator.prepare(
			leafTemplate("initial"),
			values("Newest title", "newest"),
			islands("summary-newest", "Newest summary", "body-newest", "Newest body"),
		));

		expect(replacement.isCurrent()).toBe(false);
		expect(replacement.commit(() => true).status).toBe("stale");
		expect(patch.commit(() => true).status).toBe("committed");
		expect(root.textContent).toContain("Newest title");
	});

	it("rolls back an older live replacement when a newer generation is prepared reentrantly", async () => {
		const { root, coordinator } = createCoordinator();
		const initialTemplate = leafTemplate("simple-initial", { async: false });
		await commitInitial(coordinator, initialTemplate);
		const stableArticle = root.querySelector("article");
		const older = requirePrepared(await coordinator.prepare(
			leafTemplate("simple-older", { async: false }),
			values("Older title", "older"),
			new Map(),
		));

		const reentrant: { promise?: ReturnType<typeof coordinator.prepare> } = {};
		let triggered = false;
		const originalReplace = root.replaceChildren.bind(root);
		vi.spyOn(root, "replaceChildren").mockImplementation((...nodes) => {
			originalReplace(...nodes);
			if (triggered) return;
			triggered = true;
			reentrant.promise = coordinator.prepare(
				leafTemplate("simple-newer", { async: false }),
				values("Newer title", "newer"),
				new Map(),
			);
		});

		expect(older.commit(() => true).status).toBe("stale");
		expect(root.querySelector("article")).toBe(stableArticle);
		expect(root.textContent).toContain("Stable title");
		const newerPromise = reentrant.promise;
		if (!newerPromise) throw new Error("Expected reentrant newer preparation");
		const newer = requirePrepared(await newerPromise);
		expect(newer.commit(() => true).status).toBe("committed");
		expect(root.textContent).toContain("Newer title");
	});

	it("keeps detached and live DOM in the supplied popout-like ownerDocument", async () => {
		const ownerDocument = createOwnerDocument();
		const { root, coordinator } = createCoordinator(ownerDocument);
		let renderDocument: Document | null = null;
		const prepared = requirePrepared(await coordinator.prepare(
			leafTemplate("popup"),
			values("Popup title", "popup"),
			islands("summary-popup", "Popup summary", "body-popup", "Popup body", {
				onRender: (container) => {
					renderDocument = container.ownerDocument;
				},
			}),
		));

		expect(renderDocument).toBe(ownerDocument);
		expect(prepared.commit(() => true).status).toBe("committed");
		expect(root.querySelector("article")?.ownerDocument).toBe(ownerDocument);
	});

	it("disposes active retained resources without removing outer owner DOM", async () => {
		const { root, coordinator } = createCoordinator();
		const summaryCleanup = vi.fn();
		const bodyCleanup = vi.fn();
		const prepared = requirePrepared(await coordinator.prepare(
			leafTemplate("teardown"),
			values("Teardown title", "teardown"),
			islands("summary-teardown", "Teardown summary", "body-teardown", "Teardown body", {
				summaryCleanup,
				bodyCleanup,
			}),
		));
		expect(prepared.commit(() => true).status).toBe("committed");
		const article = root.querySelector("article");

		coordinator.dispose();
		coordinator.dispose();
		expect(summaryCleanup).toHaveBeenCalledTimes(1);
		expect(bodyCleanup).toHaveBeenCalledTimes(1);
		expect(root.querySelector("article")).toBe(article);
		expect((await coordinator.prepare(
			leafTemplate("after-dispose"),
			values("After dispose", "disposed"),
			islands("summary-disposed", "Disposed summary", "body-disposed", "Disposed body"),
		)).status).toBe("disposed");
	});
});
