import { describe, expect, it, vi } from "vitest";
import { RetainedCommitTransaction } from "../render/retained-commit-transaction";
import {
	RetainedLeafTemplateTransactionSurface,
	type RetainedLeafAsyncRequest,
} from "../render/retained-leaf-template-transaction";
import {
	RetainedDomRuntime,
	type RetainedIslandPreparationResult,
	type RetainedIslandRenderer,
	type RetainedPreparedIslandPatch,
} from "../render/retained-slot-runtime";
import type { RetainedTemplateIrLike } from "../render/retained-template-dom-plan";

function createOwnerDocument(): Document {
	return new DOMParser().parseFromString(
		"<!doctype html><html><body></body></html>",
		"text/html",
	);
}

function requirePrepared(result: RetainedIslandPreparationResult): RetainedPreparedIslandPatch {
	if (result.status !== "prepared") {
		throw new Error(`Expected prepared island, received ${result.status}`);
	}
	return result;
}

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function createMarkdownRuntime() {
	const ownerDocument = createOwnerDocument();
	const root = ownerDocument.createElement("div");
	const runtime = new RetainedDomRuntime(root);
	runtime.mountStructure("claim", ({ fragment, ownerDocument: doc, markdownSlot }) => {
		const slot = doc.createElement("div");
		markdownSlot("body", slot);
		fragment.appendChild(slot);
	});
	return { root, runtime };
}

function leafTemplate(): RetainedTemplateIrLike<string> {
	return {
		version: 1,
		sourceHash: "prepared-island-claim-leaf",
		nodes: [
			{ kind: "static-fragment", html: "<article>" },
			{ kind: "markdown-slot", id: "body", expression: "body" },
			{ kind: "static-fragment", html: "</article>" },
		],
	};
}

function leafRequest(
	renderKey: string,
	text: string,
	render: ReturnType<typeof vi.fn<RetainedIslandRenderer>>,
): ReadonlyMap<string, RetainedLeafAsyncRequest> {
	return new Map([
		["body", {
			renderKey,
			renderer: async (context) => {
				await render(context);
				context.container.textContent = text;
			},
		}],
	]);
}

describe("prepared retained island participant claims", () => {
	it("continues to deduplicate the same key while async rendering is still in flight", async () => {
		const { runtime } = createMarkdownRuntime();
		const gate = deferred();
		const render = vi.fn<RetainedIslandRenderer>(async ({ container }) => {
			await gate.promise;
			container.textContent = "Shared in flight";
		});

		const firstPromise = runtime.prepareMarkdown("body", "shared", render);
		const secondPromise = runtime.prepareMarkdown("body", "shared", render);
		expect(secondPromise).toBe(firstPromise);

		gate.resolve();
		const first = requirePrepared(await firstPromise);
		const second = requirePrepared(await secondPromise);
		expect(second).toBe(first);
		expect(render).toHaveBeenCalledTimes(1);
	});

	it("stops sharing a resolved patch after it is claimed as a commit participant", async () => {
		const { root, runtime } = createMarkdownRuntime();
		const firstCleanup = vi.fn();
		const first = requirePrepared(await runtime.prepareMarkdown(
			"body",
			"shared",
			({ container, resources }) => {
				container.textContent = "First prepared";
				resources.register(firstCleanup);
			},
		));
		const participant = first.toCommitParticipant();
		expect(first.toCommitParticipant()).toBe(participant);
		expect(first.isCurrent()).toBe(true);

		const secondRender = vi.fn<RetainedIslandRenderer>(({ container }) => {
			container.textContent = "Second prepared";
		});
		const second = requirePrepared(await runtime.prepareMarkdown("body", "shared", secondRender));

		expect(second).not.toBe(first);
		expect(secondRender).toHaveBeenCalledTimes(1);
		expect(firstCleanup).toHaveBeenCalledTimes(1);
		expect(first.isCurrent()).toBe(false);
		expect(first.commit()).toEqual({ status: "stale" });
		expect(root.textContent).toBe("");
		expect(second.commit()).toEqual({ status: "patched" });
		expect(root.textContent).toBe("Second prepared");
	});

	it("preserves cleanup-reentrant newer preparation authority during supersession", async () => {
		const { root, runtime } = createMarkdownRuntime();
		const reentrant = {
			promise: null as Promise<RetainedIslandPreparationResult> | null,
		};
		const first = requirePrepared(await runtime.prepareMarkdown(
			"body",
			"claimed",
			({ container, resources }) => {
				container.textContent = "Claimed staging";
				resources.register(() => {
					reentrant.promise = runtime.prepareMarkdown(
						"body",
						"cleanup-newer",
						({ container: cleanupContainer }) => {
							cleanupContainer.textContent = "Cleanup newer";
						},
					);
				});
			},
		));
		first.toCommitParticipant();

		const outerRender = vi.fn<RetainedIslandRenderer>(({ container }) => {
			container.textContent = "Outer older";
		});
		const outer = await runtime.prepareMarkdown("body", "outer-older", outerRender);
		expect(outer).toEqual({ status: "stale" });
		expect(outerRender).not.toHaveBeenCalled();

		const reentrantPromise = reentrant.promise;
		if (!reentrantPromise) throw new Error("Expected cleanup-reentrant preparation");
		const newer = requirePrepared(await reentrantPromise);
		expect(first.isCurrent()).toBe(false);
		expect(newer.isCurrent()).toBe(true);
		expect(newer.commit()).toEqual({ status: "patched" });
		expect(root.textContent).toBe("Cleanup newer");
	});

	it("keeps a claimed patch committable when no newer generation supersedes it", async () => {
		const { root, runtime } = createMarkdownRuntime();
		const prepared = requirePrepared(await runtime.prepareMarkdown(
			"body",
			"claimed",
			({ container }) => {
				container.textContent = "Claimed";
			},
		));
		const participant = prepared.toCommitParticipant();
		const transaction = new RetainedCommitTransaction(() => true);

		expect(transaction.commit([participant])).toEqual({ status: "committed" });
		expect(root.textContent).toBe("Claimed");
	});

	it("makes sequential leaf generations own distinct same-key island participants", async () => {
		const ownerDocument = createOwnerDocument();
		const root = ownerDocument.createElement("div");
		const runtime = new RetainedDomRuntime(root);
		const surface = new RetainedLeafTemplateTransactionSurface(runtime, leafTemplate());
		expect(surface.initialize(new Map())).toEqual({ status: "mounted" });

		const firstRender = vi.fn<RetainedIslandRenderer>();
		const first = await surface.prepareUpdate(
			new Map(),
			leafRequest("same-key", "First leaf", firstRender),
		);
		expect(first.status).toBe("prepared");
		if (first.status !== "prepared") throw new Error("Expected first prepared leaf update");

		const secondRender = vi.fn<RetainedIslandRenderer>();
		const second = await surface.prepareUpdate(
			new Map(),
			leafRequest("same-key", "Second leaf", secondRender),
		);
		expect(second.status).toBe("prepared");
		if (second.status !== "prepared") throw new Error("Expected second prepared leaf update");

		expect(firstRender).toHaveBeenCalledTimes(1);
		expect(secondRender).toHaveBeenCalledTimes(1);
		expect(first.isCurrent()).toBe(false);
		expect(second.isCurrent()).toBe(true);
		first.dispose();
		expect(second.commit(new RetainedCommitTransaction(() => true)).status).toBe("committed");
		expect(root.textContent).toContain("Second leaf");
	});
});
