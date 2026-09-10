import { describe, expect, it, vi } from "vitest";
import {
	RetainedDomRuntime,
	type RetainedIslandPreparationResult,
	type RetainedIslandRenderer,
	type RetainedPreparedIslandPatch,
} from "../render/retained-slot-runtime";

function createOwnerDocument(): Document {
	return new DOMParser().parseFromString(
		"<!doctype html><html><body></body></html>",
		"text/html",
	);
}

function createMarkdownRuntime(ownerDocument: Document = createOwnerDocument()) {
	const root = ownerDocument.createElement("div");
	const runtime = new RetainedDomRuntime(root);
	runtime.mountStructure("markdown", ({ fragment, ownerDocument: doc, markdownSlot }) => {
		const slot = doc.createElement("div");
		markdownSlot("body", slot);
		fragment.appendChild(slot);
	});
	return {
		root,
		runtime,
		slot: root.firstElementChild as HTMLElement,
	};
}

function createContentRuntime(ownerDocument: Document = createOwnerDocument()) {
	const root = ownerDocument.createElement("div");
	const runtime = new RetainedDomRuntime(root);
	runtime.mountStructure("content", ({ fragment, ownerDocument: doc, contentSlot }) => {
		const slot = doc.createElement("section");
		contentSlot("body", slot);
		fragment.appendChild(slot);
	});
	return {
		root,
		runtime,
		slot: root.firstElementChild as HTMLElement,
	};
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

describe("RetainedDomRuntime prepared islands", () => {
	it("keeps prepared Markdown detached until a synchronous commit transfers resource ownership", async () => {
		const { root, runtime } = createMarkdownRuntime();
		const stableCleanup = vi.fn();
		await runtime.patchMarkdown("body", "stable", ({ container, resources }) => {
			container.textContent = "Stable";
			resources.register(stableCleanup);
		});

		const nextCleanup = vi.fn();
		const preparation = requirePrepared(await runtime.prepareMarkdown(
			"body",
			"next",
			({ container, resources }) => {
				expect(container.isConnected).toBe(false);
				container.textContent = "Next";
				resources.register(nextCleanup);
			},
		));

		expect(preparation.isCurrent()).toBe(true);
		expect(root.textContent).toBe("Stable");
		expect(stableCleanup).not.toHaveBeenCalled();
		expect(nextCleanup).not.toHaveBeenCalled();

		expect(preparation.commit()).toEqual({ status: "patched" });
		expect(preparation.isCurrent()).toBe(false);
		expect(root.textContent).toBe("Next");
		expect(stableCleanup).toHaveBeenCalledTimes(1);
		expect(nextCleanup).not.toHaveBeenCalled();

		preparation.dispose();
		expect(nextCleanup).not.toHaveBeenCalled();
		runtime.dispose();
		expect(nextCleanup).toHaveBeenCalledTimes(1);
	});

	it("discards a prepared generation without touching last-known-good DOM or resources", async () => {
		const { root, runtime } = createMarkdownRuntime();
		const stableCleanup = vi.fn();
		await runtime.patchMarkdown("body", "stable", ({ container, resources }) => {
			container.textContent = "Stable";
			resources.register(stableCleanup);
		});
		const stagedCleanup = vi.fn();
		const preparation = requirePrepared(await runtime.prepareMarkdown(
			"body",
			"discarded",
			({ container, resources }) => {
				container.textContent = "Discarded";
				resources.register(stagedCleanup);
			},
		));

		preparation.dispose();
		preparation.dispose();
		expect(stagedCleanup).toHaveBeenCalledTimes(1);
		expect(stableCleanup).not.toHaveBeenCalled();
		expect(root.textContent).toBe("Stable");
		expect(preparation.commit()).toEqual({ status: "stale" });

		runtime.dispose();
		expect(stableCleanup).toHaveBeenCalledTimes(1);
	});

	it("deduplicates one in-flight prepared key and makes the prepared commit idempotent", async () => {
		const { root, runtime } = createMarkdownRuntime();
		const gate = deferred();
		const render = vi.fn<RetainedIslandRenderer>(async ({ container }) => {
			await gate.promise;
			container.textContent = "Shared";
		});

		const firstPromise = runtime.prepareMarkdown("body", "shared", render);
		const secondPromise = runtime.prepareMarkdown("body", "shared", render);
		expect(secondPromise).toBe(firstPromise);

		gate.resolve();
		const first = requirePrepared(await firstPromise);
		const second = requirePrepared(await secondPromise);
		expect(second).toBe(first);
		expect(render).toHaveBeenCalledTimes(1);
		expect(root.textContent).toBe("");

		expect(first.commit()).toEqual({ status: "patched" });
		expect(second.commit()).toEqual({ status: "patched" });
		expect(root.textContent).toBe("Shared");
	});

	it("returns unchanged without rendering when the requested key is already committed", async () => {
		const { runtime } = createMarkdownRuntime();
		await runtime.patchMarkdown("body", "stable", ({ container }) => {
			container.textContent = "Stable";
		});
		const redundant = vi.fn<RetainedIslandRenderer>();

		expect(await runtime.prepareMarkdown("body", "stable", redundant)).toEqual({
			status: "unchanged",
		});
		expect(redundant).not.toHaveBeenCalled();
	});

	it("invalidates an older prepared generation before a newer generation commits", async () => {
		const { root, runtime } = createMarkdownRuntime();
		const oldCleanup = vi.fn();
		const oldPreparation = requirePrepared(await runtime.prepareMarkdown(
			"body",
			"old-generation",
			({ container, resources }) => {
				container.textContent = "Old generation";
				resources.register(oldCleanup);
			},
		));

		const newPreparation = requirePrepared(await runtime.prepareMarkdown(
			"body",
			"new-generation",
			({ container }) => {
				container.textContent = "New generation";
			},
		));

		expect(oldCleanup).toHaveBeenCalledTimes(1);
		expect(oldPreparation.isCurrent()).toBe(false);
		expect(oldPreparation.commit()).toEqual({ status: "stale" });
		expect(root.textContent).toBe("");
		expect(newPreparation.commit()).toEqual({ status: "patched" });
		expect(root.textContent).toBe("New generation");
	});

	it("preserves last-known-good state when preparation fails and permits a later retry", async () => {
		const { root, runtime } = createMarkdownRuntime();
		const stableCleanup = vi.fn();
		await runtime.patchMarkdown("body", "stable", ({ container, resources }) => {
			container.textContent = "Stable";
			resources.register(stableCleanup);
		});
		const failedCleanup = vi.fn();
		const failure = new Error("Synthetic prepare failure");

		const failed = await runtime.prepareMarkdown("body", "next", ({ container, resources }) => {
			container.textContent = "Broken";
			resources.register(failedCleanup);
			throw failure;
		});
		expect(failed).toEqual({ status: "failed", error: failure });
		expect(root.textContent).toBe("Stable");
		expect(failedCleanup).toHaveBeenCalledTimes(1);
		expect(stableCleanup).not.toHaveBeenCalled();

		const retry = requirePrepared(await runtime.prepareMarkdown("body", "next", ({ container }) => {
			container.textContent = "Recovered";
		}));
		expect(retry.commit()).toEqual({ status: "patched" });
		expect(root.textContent).toBe("Recovered");
		expect(stableCleanup).toHaveBeenCalledTimes(1);
	});

	it("invalidates and cleans prepared work when its retained structure is replaced", async () => {
		const { root, runtime } = createMarkdownRuntime();
		const stagedCleanup = vi.fn();
		const preparation = requirePrepared(await runtime.prepareMarkdown(
			"body",
			"pending",
			({ container, resources }) => {
				container.textContent = "Pending";
				resources.register(stagedCleanup);
			},
		));

		expect(runtime.mountStructure("replacement", ({ fragment, ownerDocument, textSlot }) => {
			const paragraph = ownerDocument.createElement("p");
			paragraph.appendChild(textSlot("label", "Replacement"));
			fragment.appendChild(paragraph);
		})).toBe("mounted");

		expect(stagedCleanup).toHaveBeenCalledTimes(1);
		expect(preparation.commit()).toEqual({ status: "disposed" });
		expect(root.textContent).toBe("Replacement");
	});

	it("invalidates prepared work when the retained runtime is disposed", async () => {
		const { root, runtime } = createMarkdownRuntime();
		const stagedCleanup = vi.fn();
		const preparation = requirePrepared(await runtime.prepareMarkdown(
			"body",
			"pending",
			({ container, resources }) => {
				container.textContent = "Pending";
				resources.register(stagedCleanup);
			},
		));

		runtime.dispose();
		expect(stagedCleanup).toHaveBeenCalledTimes(1);
		expect(preparation.commit()).toEqual({ status: "disposed" });
		expect(root.textContent).toBe("");
	});

	it("prepares content in the retained slot ownerDocument before explicit commit", async () => {
		const ownerDocument = createOwnerDocument();
		const { root, runtime, slot } = createContentRuntime(ownerDocument);
		const preparation = requirePrepared(await runtime.prepareContent(
			"body",
			"content-revision",
			({ container, ownerDocument: contextDocument }) => {
				expect(contextDocument).toBe(ownerDocument);
				expect(container.ownerDocument).toBe(ownerDocument);
				expect(container.isConnected).toBe(false);
				container.textContent = "Prepared content";
			},
		));

		expect(slot.textContent).toBe("");
		expect(preparation.commit()).toEqual({ status: "patched" });
		expect(root.textContent).toBe("Prepared content");
	});

	it("cleans a failed live commit, preserves committed resources, and allows retry", async () => {
		const { root, runtime, slot } = createMarkdownRuntime();
		const stableCleanup = vi.fn();
		await runtime.patchMarkdown("body", "stable", ({ container, resources }) => {
			container.textContent = "Stable";
			resources.register(stableCleanup);
		});
		const failedCleanup = vi.fn();
		const first = requirePrepared(await runtime.prepareMarkdown(
			"body",
			"next",
			({ container, resources }) => {
				container.textContent = "Next";
				resources.register(failedCleanup);
			},
		));
		const originalReplaceChildren = slot.replaceChildren.bind(slot);
		slot.replaceChildren = () => {
			throw new Error("Synthetic live commit failure");
		};

		const failedCommit = first.commit();
		expect(failedCommit.status).toBe("failed");
		expect(root.textContent).toBe("Stable");
		expect(failedCleanup).toHaveBeenCalledTimes(1);
		expect(stableCleanup).not.toHaveBeenCalled();

		slot.replaceChildren = originalReplaceChildren;
		const retry = requirePrepared(await runtime.prepareMarkdown("body", "next", ({ container }) => {
			container.textContent = "Recovered";
		}));
		expect(retry.commit()).toEqual({ status: "patched" });
		expect(root.textContent).toBe("Recovered");
		expect(stableCleanup).toHaveBeenCalledTimes(1);
	});
});
