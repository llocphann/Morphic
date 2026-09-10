import { describe, expect, it, vi } from "vitest";
import {
	RetainedLeafOwnerRenderHost,
	type RetainedLeafOwnerRenderPreparationResult,
	type RetainedPreparedLeafOwnerRender,
} from "../render/retained-leaf-owner-render-host";
import type { RetainedLeafAsyncRequest } from "../render/retained-leaf-template-transaction";
import type { RetainedTemplateIrLike } from "../render/retained-template-dom-plan";

type TestExpression = string;

class FakeScope {
	isDisposed = false;
	private readonly disposers: Array<() => void> = [];

	registerDisposer(disposer: () => void): () => void {
		if (this.isDisposed) {
			disposer();
			return disposer;
		}
		this.disposers.push(disposer);
		return disposer;
	}

	dispose(): void {
		if (this.isDisposed) return;
		this.isDisposed = true;
		for (const disposer of this.disposers.splice(0)) disposer();
	}
}

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
	const async = options.async ?? false;
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
		bodyFailure?: Error;
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
				if (options.bodyFailure) throw options.bodyFailure;
				container.textContent = body;
				if (options.bodyCleanup) resources.register(options.bodyCleanup);
			},
		}],
	]);
}

function createRoot(ownerDocument: Document): HTMLElement {
	const root = ownerDocument.createElement("div");
	const native = ownerDocument.createElement("p");
	native.textContent = "Native stable";
	root.appendChild(native);
	ownerDocument.body.appendChild(root);
	return root;
}

function requirePrepared(
	result: RetainedLeafOwnerRenderPreparationResult,
): RetainedPreparedLeafOwnerRender {
	if (result.status !== "prepared") {
		throw new Error(`Expected prepared owner render, received ${result.status}`);
	}
	return result;
}

async function prepareSync(
	host: RetainedLeafOwnerRenderHost<object, TestExpression>,
	owner: object,
	root: HTMLElement,
	scope: FakeScope,
	generation: number,
	sourceHash: string,
	title: string,
	state: string,
) {
	return requirePrepared(await host.prepare(
		owner,
		root,
		scope,
		generation,
		leafTemplate(sourceHash),
		values(title, state),
		new Map(),
	));
}

describe("RetainedLeafOwnerRenderHost", () => {
	it("keeps first-generation retained DOM detached until the terminal owner commit", async () => {
		const doc = createOwnerDocument();
		const root = createRoot(doc);
		const native = root.firstChild;
		const owner = {};
		const scope = new FakeScope();
		const host = new RetainedLeafOwnerRenderHost<object, TestExpression>();
		const prepared = await prepareSync(host, owner, root, scope, 1, "first", "First title", "first");

		expect(prepared.mode).toBe("replace");
		expect(root.firstChild).toBe(native);
		expect(root.textContent).toBe("Native stable");
		expect(prepared.commit()).toEqual({ status: "committed" });
		expect(root.querySelector("h1")?.textContent).toBe("First title");
		expect(root.querySelector("article")?.getAttribute("data-state")).toBe("first");
		expect(host.size).toBe(1);

		scope.dispose();
		expect(host.size).toBe(0);
	});

	it("retains static Node identity while transferring cleanup authority across a patch", async () => {
		const doc = createOwnerDocument();
		const root = createRoot(doc);
		const owner = {};
		const firstScope = new FakeScope();
		const secondScope = new FakeScope();
		const host = new RetainedLeafOwnerRenderHost<object, TestExpression>();
		const first = await prepareSync(host, owner, root, firstScope, 1, "stable", "Stable title", "stable");
		expect(first.commit().status).toBe("committed");
		const article = root.querySelector("article");
		const heading = root.querySelector("h1");

		const second = await prepareSync(host, owner, root, secondScope, 2, "stable", "Next title", "next");
		expect(second.mode).toBe("patch");
		expect(second.commit().status).toBe("committed");
		expect(root.querySelector("article")).toBe(article);
		expect(root.querySelector("h1")).toBe(heading);
		expect(root.textContent).toContain("Next title");

		firstScope.dispose();
		expect(host.size).toBe(1);
		expect(host.registry.get(owner)?.isDisposed).toBe(false);
		secondScope.dispose();
		expect(host.size).toBe(0);
	});

	it("turns coordinator unchanged into an explicit scope handoff generation", async () => {
		const doc = createOwnerDocument();
		const root = createRoot(doc);
		const owner = {};
		const firstScope = new FakeScope();
		const secondScope = new FakeScope();
		const host = new RetainedLeafOwnerRenderHost<object, TestExpression>();
		const first = await prepareSync(host, owner, root, firstScope, 1, "stable", "Stable title", "stable");
		expect(first.commit().status).toBe("committed");
		const article = root.querySelector("article");

		const unchanged = await prepareSync(host, owner, root, secondScope, 2, "stable", "Stable title", "stable");
		expect(unchanged.mode).toBe("handoff");
		expect(unchanged.commit()).toEqual({ status: "unchanged" });
		expect(root.querySelector("article")).toBe(article);

		firstScope.dispose();
		expect(host.size).toBe(1);
		expect(host.registry.get(owner)?.isDisposed).toBe(false);
		secondScope.dispose();
		expect(host.size).toBe(0);
	});

	it("makes an older prepared owner render stale when a newer generation starts", async () => {
		const doc = createOwnerDocument();
		const root = createRoot(doc);
		const owner = {};
		const firstScope = new FakeScope();
		const secondScope = new FakeScope();
		const host = new RetainedLeafOwnerRenderHost<object, TestExpression>();
		const older = await prepareSync(host, owner, root, firstScope, 1, "older", "Older title", "older");
		const newer = await prepareSync(host, owner, root, secondScope, 2, "newer", "Newer title", "newer");

		expect(older.isCurrent()).toBe(false);
		expect(older.commit().status).toBe("stale");
		expect(root.textContent).toBe("Native stable");
		expect(newer.commit().status).toBe("committed");
		expect(root.textContent).toContain("Newer title");
	});

	it("preserves last-known-good UI and previous scope authority when async preparation fails", async () => {
		const doc = createOwnerDocument();
		const root = createRoot(doc);
		const owner = {};
		const firstScope = new FakeScope();
		const failedScope = new FakeScope();
		const host = new RetainedLeafOwnerRenderHost<object, TestExpression>();
		const first = await prepareSync(host, owner, root, firstScope, 1, "stable", "Stable title", "stable");
		expect(first.commit().status).toBe("committed");
		const article = root.querySelector("article");
		const failure = new Error("Synthetic body render failure");
		const stagedCleanup = vi.fn();

		const failed = await host.prepare(
			owner,
			root,
			failedScope,
			2,
			leafTemplate("broken", { async: true }),
			values("Broken title", "broken"),
			islands("summary-broken", "Prepared summary", "body-broken", "Broken body", {
				summaryCleanup: stagedCleanup,
				bodyFailure: failure,
			}),
		);
		expect(failed).toEqual({ status: "failed", generation: 2, error: failure });
		expect(root.querySelector("article")).toBe(article);
		expect(root.textContent).toContain("Stable title");
		expect(stagedCleanup).toHaveBeenCalledTimes(1);

		failedScope.dispose();
		expect(host.registry.get(owner)?.isDisposed).toBe(false);
		firstScope.dispose();
		expect(host.size).toBe(0);
	});

	it("rejects a prepared live update after its candidate scope is disposed", async () => {
		const doc = createOwnerDocument();
		const root = createRoot(doc);
		const owner = {};
		const firstScope = new FakeScope();
		const secondScope = new FakeScope();
		const host = new RetainedLeafOwnerRenderHost<object, TestExpression>();
		const first = await prepareSync(host, owner, root, firstScope, 1, "stable", "Stable title", "stable");
		expect(first.commit().status).toBe("committed");
		const article = root.querySelector("article");
		const second = await prepareSync(host, owner, root, secondScope, 2, "stable", "Next title", "next");

		secondScope.dispose();
		expect(second.commit().status).toBe("stale");
		expect(root.querySelector("article")).toBe(article);
		expect(root.textContent).toContain("Stable title");
		firstScope.dispose();
	});

	it("makes explicit owner release authoritative over prepared work", async () => {
		const doc = createOwnerDocument();
		const root = createRoot(doc);
		const owner = {};
		const scope = new FakeScope();
		const host = new RetainedLeafOwnerRenderHost<object, TestExpression>();
		const prepared = await prepareSync(host, owner, root, scope, 1, "first", "First title", "first");

		host.release(owner);
		expect(prepared.commit().status).toBe("disposed");
		expect(root.textContent).toBe("Native stable");
		expect(host.size).toBe(0);
	});

	it("isolates replacement-root authority from late cleanup of the old scope", async () => {
		const doc = createOwnerDocument();
		const firstRoot = createRoot(doc);
		const nextRoot = createRoot(doc);
		const owner = {};
		const firstScope = new FakeScope();
		const nextScope = new FakeScope();
		const host = new RetainedLeafOwnerRenderHost<object, TestExpression>();
		const first = await prepareSync(host, owner, firstRoot, firstScope, 1, "first", "First title", "first");
		expect(first.commit().status).toBe("committed");
		const firstCoordinator = host.registry.get(owner);

		const next = await prepareSync(host, owner, nextRoot, nextScope, 2, "next", "Next title", "next");
		expect(next.commit().status).toBe("committed");
		const nextCoordinator = host.registry.get(owner);
		expect(nextCoordinator).not.toBe(firstCoordinator);
		expect(firstCoordinator?.isDisposed).toBe(true);

		firstScope.dispose();
		expect(host.registry.get(owner)).toBe(nextCoordinator);
		expect(nextCoordinator?.isDisposed).toBe(false);
		nextScope.dispose();
		expect(host.size).toBe(0);
	});

	it("keeps independent owners isolated through commit and teardown", async () => {
		const doc = createOwnerDocument();
		const host = new RetainedLeafOwnerRenderHost<object, TestExpression>();
		const ownerA = {};
		const ownerB = {};
		const scopeA = new FakeScope();
		const scopeB = new FakeScope();
		const rootA = createRoot(doc);
		const rootB = createRoot(doc);
		const a = await prepareSync(host, ownerA, rootA, scopeA, 1, "a", "Owner A", "a");
		const b = await prepareSync(host, ownerB, rootB, scopeB, 1, "b", "Owner B", "b");

		expect(a.commit().status).toBe("committed");
		expect(b.commit().status).toBe("committed");
		expect(host.size).toBe(2);
		expect(rootA.textContent).toContain("Owner A");
		expect(rootB.textContent).toContain("Owner B");

		host.release(ownerA);
		expect(host.size).toBe(1);
		expect(host.registry.get(ownerB)?.isDisposed).toBe(false);
		scopeB.dispose();
		expect(host.size).toBe(0);
	});

	it("keeps the committing scope authoritative when finalization prepares a newer generation reentrantly", async () => {
		const doc = createOwnerDocument();
		const root = createRoot(doc);
		const host = new RetainedLeafOwnerRenderHost<object, TestExpression>();
		const owner = {};
		const firstScope = new FakeScope();
		const secondScope = new FakeScope();
		const thirdScope = new FakeScope();
		const thirdPreparation: {
			value: Promise<RetainedLeafOwnerRenderPreparationResult> | null;
		} = { value: null };
		const cleanup = vi.fn(() => {
			thirdPreparation.value = host.prepare(
				owner,
				root,
				thirdScope,
				3,
				leafTemplate("third"),
				values("Third title", "third"),
				new Map(),
			);
		});
		const first = requirePrepared(await host.prepare(
			owner,
			root,
			firstScope,
			1,
			leafTemplate("first", { async: true }),
			values("First title", "first"),
			islands("summary-first", "First summary", "body-first", "First body", {
				summaryCleanup: cleanup,
			}),
		));
		expect(first.commit().status).toBe("committed");

		const second = await prepareSync(host, owner, root, secondScope, 2, "second", "Second title", "second");
		expect(second.commit().status).toBe("committed");
		expect(cleanup).toHaveBeenCalledTimes(1);
		const pendingThird = thirdPreparation.value;
		if (!pendingThird) throw new Error("Expected reentrant third-generation preparation");

		firstScope.dispose();
		expect(host.registry.get(owner)?.isDisposed).toBe(false);
		const third = requirePrepared(await pendingThird);
		expect(third.commit().status).toBe("committed");
		secondScope.dispose();
		expect(host.registry.get(owner)?.isDisposed).toBe(false);
		thirdScope.dispose();
		expect(host.size).toBe(0);
	});

	it("converts scope registration failure into a terminal preparation failure without leaking ownership", async () => {
		const doc = createOwnerDocument();
		const root = createRoot(doc);
		const host = new RetainedLeafOwnerRenderHost<object, TestExpression>();
		const owner = {};
		const failure = new Error("Synthetic scope registration failure");
		const brokenScope = {
			isDisposed: false,
			registerDisposer() {
				throw failure;
			},
		};

		const result = await host.prepare(
			owner,
			root,
			brokenScope,
			1,
			leafTemplate("first"),
			values("First title", "first"),
			new Map(),
		);
		expect(result).toEqual({ status: "failed", generation: 1, error: failure });
		expect(host.size).toBe(0);
		expect(host.registry.size).toBe(0);
		expect(root.textContent).toBe("Native stable");
	});
});