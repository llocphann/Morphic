import { afterEach, describe, expect, it, vi } from "vitest";
import { App, Component, MarkdownRenderer } from "obsidian";
import { RetainedDomRuntime } from "../render/retained-slot-runtime";
import { createObsidianMarkdownIslandPatch } from "../render/obsidian-markdown-island";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function createMarkdownRuntime(ownerDocument: Document = document) {
	const root = ownerDocument.createElement("div");
	const runtime = new RetainedDomRuntime(root);
	runtime.mountStructure("template", ({ fragment, ownerDocument: doc, markdownSlot }) => {
		const slot = doc.createElement("span");
		markdownSlot("markdown", slot);
		fragment.appendChild(slot);
	});
	const slot = root.firstElementChild as HTMLElement;
	return { root, runtime, slot };
}

function createPatch(
	app: App,
	markdown: string,
	sourcePath: string,
	revisionKey: string,
	mode: "inline" | "block" = "block",
) {
	return createObsidianMarkdownIslandPatch({
		app,
		markdown,
		sourcePath,
		revisionKey,
		mode,
	});
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("Obsidian Markdown island adapter", () => {
	it("builds collision-safe keys from mode, source context, revision, and markdown", () => {
		const app = new App();
		const base = createPatch(app, "Same markdown", "Folder/A.md", "rev-1", "inline");

		expect(createPatch(app, "Same markdown", "Folder/B.md", "rev-1", "inline").renderKey)
			.not.toBe(base.renderKey);
		expect(createPatch(app, "Same markdown", "Folder/A.md", "rev-2", "inline").renderKey)
			.not.toBe(base.renderKey);
		expect(createPatch(app, "Same markdown", "Folder/A.md", "rev-1", "block").renderKey)
			.not.toBe(base.renderKey);
		expect(createPatch(app, "Different markdown", "Folder/A.md", "rev-1", "inline").renderKey)
			.not.toBe(base.renderKey);

		const delimiterHeavyA = createPatch(app, "c", "a\",\"b", "d", "block");
		const delimiterHeavyB = createPatch(app, "b\",\"c", "a", "d", "block");
		expect(delimiterHeavyA.renderKey).not.toBe(delimiterHeavyB.renderKey);
	});

	it("keeps the Markdown component alive through commit and unloads it on island disposal", async () => {
		const app = new App();
		const { runtime, slot } = createMarkdownRuntime();
		const events: string[] = [];
		vi.spyOn(Component.prototype, "load").mockImplementation(function () {
			events.push("load");
		});
		const unload = vi.spyOn(Component.prototype, "unload").mockImplementation(function () {
			events.push("unload");
		});
		vi.spyOn(MarkdownRenderer, "render").mockImplementation(async (_app, markdown, el, sourcePath) => {
			events.push(`render:${sourcePath}`);
			const paragraph = el.ownerDocument.createElement("p");
			paragraph.textContent = markdown;
			el.appendChild(paragraph);
		});

		const patch = createPatch(app, "Rendered value", "Folder/A.md", "rev-1", "inline");
		const result = await runtime.patchMarkdown("markdown", patch.renderKey, patch.renderer);

		expect(result.status).toBe("patched");
		expect(slot.textContent).toBe("Rendered value");
		expect(slot.querySelector("p")).toBeNull();
		expect(events).toEqual(["load", "render:Folder/A.md"]);
		expect(unload).not.toHaveBeenCalled();

		runtime.dispose();
		expect(unload).toHaveBeenCalledTimes(1);
		expect(events).toEqual(["load", "render:Folder/A.md", "unload"]);
	});

	it("deduplicates an unchanged committed Markdown render key", async () => {
		const app = new App();
		const { runtime } = createMarkdownRuntime();
		const render = vi.spyOn(MarkdownRenderer, "render").mockImplementation(async (_app, markdown, el) => {
			el.textContent = markdown;
		});
		const patch = createPatch(app, "Stable value", "A.md", "rev-1");

		expect((await runtime.patchMarkdown("markdown", patch.renderKey, patch.renderer)).status)
			.toBe("patched");
		expect((await runtime.patchMarkdown("markdown", patch.renderKey, patch.renderer)).status)
			.toBe("unchanged");
		expect(render).toHaveBeenCalledTimes(1);
		runtime.dispose();
	});

	it("rerenders identical markdown when the committed source path changes", async () => {
		const app = new App();
		const { runtime, slot } = createMarkdownRuntime();
		const unload = vi.spyOn(Component.prototype, "unload");
		const sources: string[] = [];
		vi.spyOn(MarkdownRenderer, "render").mockImplementation(async (_app, _markdown, el, sourcePath) => {
			sources.push(sourcePath);
			el.textContent = sourcePath;
		});

		const first = createPatch(app, "[[Relative]]", "Folder/A.md", "rev-1");
		const second = createPatch(app, "[[Relative]]", "Other/B.md", "rev-1");
		expect((await runtime.patchMarkdown("markdown", first.renderKey, first.renderer)).status)
			.toBe("patched");
		expect((await runtime.patchMarkdown("markdown", second.renderKey, second.renderer)).status)
			.toBe("patched");

		expect(sources).toEqual(["Folder/A.md", "Other/B.md"]);
		expect(slot.textContent).toBe("Other/B.md");
		expect(unload).toHaveBeenCalledTimes(1);
		runtime.dispose();
		expect(unload).toHaveBeenCalledTimes(2);
	});

	it("preserves last-known-good Markdown and disposes failed staging resources", async () => {
		const app = new App();
		const { runtime, slot } = createMarkdownRuntime();
		const unload = vi.spyOn(Component.prototype, "unload");
		vi.spyOn(MarkdownRenderer, "render").mockImplementation(async (_app, markdown, el) => {
			el.textContent = markdown;
			if (markdown === "Broken value") throw new Error("Markdown render failed");
		});

		const stable = createPatch(app, "Stable value", "A.md", "rev-1");
		const broken = createPatch(app, "Broken value", "A.md", "rev-2");
		expect((await runtime.patchMarkdown("markdown", stable.renderKey, stable.renderer)).status)
			.toBe("patched");
		const failed = await runtime.patchMarkdown("markdown", broken.renderKey, broken.renderer);

		expect(failed.status).toBe("failed");
		expect(slot.textContent).toBe("Stable value");
		expect(unload).toHaveBeenCalledTimes(1);
		runtime.dispose();
		expect(unload).toHaveBeenCalledTimes(2);
	});

	it("unloads stale Markdown work immediately and prevents its late commit", async () => {
		const app = new App();
		const { runtime, slot } = createMarkdownRuntime();
		const oldGate = deferred();
		const unload = vi.spyOn(Component.prototype, "unload");
		vi.spyOn(MarkdownRenderer, "render").mockImplementation(async (_app, markdown, el) => {
			if (markdown === "Old value") await oldGate.promise;
			el.textContent = markdown;
		});

		const oldPatch = createPatch(app, "Old value", "A.md", "rev-1");
		const newPatch = createPatch(app, "New value", "A.md", "rev-2");
		const oldResult = runtime.patchMarkdown("markdown", oldPatch.renderKey, oldPatch.renderer);
		const newResult = await runtime.patchMarkdown("markdown", newPatch.renderKey, newPatch.renderer);

		expect(newResult.status).toBe("patched");
		expect(slot.textContent).toBe("New value");
		expect(unload).toHaveBeenCalledTimes(1);

		oldGate.resolve();
		expect((await oldResult).status).toBe("stale");
		expect(slot.textContent).toBe("New value");
		runtime.dispose();
		expect(unload).toHaveBeenCalledTimes(2);
	});

	it("uses the island ownerDocument and disposes pending Markdown work with the runtime", async () => {
		const app = new App();
		const ownerDocument = new DOMParser().parseFromString(
			"<!doctype html><html><body></body></html>",
			"text/html",
		);
		const { runtime } = createMarkdownRuntime(ownerDocument);
		const gate = deferred();
		const unload = vi.spyOn(Component.prototype, "unload");
		vi.spyOn(MarkdownRenderer, "render").mockImplementation(async (_app, _markdown, el) => {
			expect(el.ownerDocument).toBe(ownerDocument);
			await gate.promise;
			el.textContent = "Late value";
		});

		const patch = createPatch(app, "Pending value", "Popup/A.md", "rev-1");
		const pending = runtime.patchMarkdown("markdown", patch.renderKey, patch.renderer);
		runtime.dispose();
		expect(unload).toHaveBeenCalledTimes(1);

		gate.resolve();
		expect((await pending).status).toBe("disposed");
		expect(unload).toHaveBeenCalledTimes(1);
	});
});
