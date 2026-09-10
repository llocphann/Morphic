import { afterEach, describe, expect, it, vi } from "vitest";
import { App, Component, MarkdownRenderer } from "obsidian";
import { RetainedDomRuntime } from "../render/retained-slot-runtime";
import { createObsidianContentIslandPatch } from "../render/obsidian-content-island";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function createContentRuntime(ownerDocument: Document = window.document) {
	const root = ownerDocument.createElement("div");
	const runtime = new RetainedDomRuntime(root);
	runtime.mountStructure("template", ({ fragment, ownerDocument: doc, contentSlot }) => {
		const slot = doc.createElement("div");
		slot.classList.add("markdown-rendered-content", "markdown-preview-view", "markdown-rendered");
		contentSlot("content", slot);
		fragment.appendChild(slot);
	});
	const slot = root.firstElementChild as HTMLElement;
	return { root, runtime, slot };
}

function createPatch(app: App, markdown: string, sourcePath: string, revisionKey: string) {
	return createObsidianContentIslandPatch({ app, markdown, sourcePath, revisionKey });
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("Obsidian content island adapter", () => {
	it("builds collision-safe keys from source context, revision, and body markdown", () => {
		const app = new App();
		const base = createPatch(app, "Same body", "Folder/A.md", "rev-1");

		expect(createPatch(app, "Same body", "Folder/B.md", "rev-1").renderKey)
			.not.toBe(base.renderKey);
		expect(createPatch(app, "Same body", "Folder/A.md", "rev-2").renderKey)
			.not.toBe(base.renderKey);
		expect(createPatch(app, "Different body", "Folder/A.md", "rev-1").renderKey)
			.not.toBe(base.renderKey);

		const delimiterHeavyA = createPatch(app, "c", "a\",\"b", "d");
		const delimiterHeavyB = createPatch(app, "b\",\"c", "a", "d");
		expect(delimiterHeavyA.renderKey).not.toBe(delimiterHeavyB.renderKey);
	});

	it("commits the native preview sizer and retains the Markdown component until disposal", async () => {
		const app = new App();
		const { runtime, slot } = createContentRuntime();
		const unload = vi.spyOn(Component.prototype, "unload");
		vi.spyOn(MarkdownRenderer, "render").mockImplementation(async (_app, markdown, el, sourcePath) => {
			expect(sourcePath).toBe("Folder/A.md");
			el.textContent = markdown;
		});

		const patch = createPatch(app, "Rendered body", "Folder/A.md", "rev-1");
		const result = await runtime.patchContent("content", patch.renderKey, patch.renderer);

		expect(result.status).toBe("patched");
		const sizer = slot.firstElementChild as HTMLElement;
		expect(sizer.classList.contains("markdown-preview-sizer")).toBe(true);
		expect(sizer.classList.contains("markdown-preview-section")).toBe(true);
		expect(sizer.textContent).toBe("Rendered body");
		expect(unload).not.toHaveBeenCalled();

		runtime.dispose();
		expect(unload).toHaveBeenCalledTimes(1);
	});

	it("deduplicates an unchanged committed content key", async () => {
		const app = new App();
		const { runtime } = createContentRuntime();
		const render = vi.spyOn(MarkdownRenderer, "render").mockImplementation(async (_app, markdown, el) => {
			el.textContent = markdown;
		});
		const patch = createPatch(app, "Stable body", "A.md", "rev-1");

		expect((await runtime.patchContent("content", patch.renderKey, patch.renderer)).status)
			.toBe("patched");
		expect((await runtime.patchContent("content", patch.renderKey, patch.renderer)).status)
			.toBe("unchanged");
		expect(render).toHaveBeenCalledTimes(1);
		runtime.dispose();
	});

	it("rerenders identical body markdown when source context changes", async () => {
		const app = new App();
		const { runtime, slot } = createContentRuntime();
		const sources: string[] = [];
		const unload = vi.spyOn(Component.prototype, "unload");
		vi.spyOn(MarkdownRenderer, "render").mockImplementation(async (_app, _markdown, el, sourcePath) => {
			sources.push(sourcePath);
			el.textContent = sourcePath;
		});

		const first = createPatch(app, "[[Relative]]", "Folder/A.md", "rev-1");
		const second = createPatch(app, "[[Relative]]", "Other/B.md", "rev-1");
		expect((await runtime.patchContent("content", first.renderKey, first.renderer)).status)
			.toBe("patched");
		expect((await runtime.patchContent("content", second.renderKey, second.renderer)).status)
			.toBe("patched");

		expect(sources).toEqual(["Folder/A.md", "Other/B.md"]);
		expect(slot.textContent).toBe("Other/B.md");
		expect(unload).toHaveBeenCalledTimes(1);
		runtime.dispose();
		expect(unload).toHaveBeenCalledTimes(2);
	});

	it("preserves last-known-good content and disposes failed staging resources", async () => {
		const app = new App();
		const { runtime, slot } = createContentRuntime();
		const unload = vi.spyOn(Component.prototype, "unload");
		vi.spyOn(MarkdownRenderer, "render").mockImplementation(async (_app, markdown, el) => {
			el.textContent = markdown;
			if (markdown === "Broken body") throw new Error("Content render failed");
		});

		const stable = createPatch(app, "Stable body", "A.md", "rev-1");
		const broken = createPatch(app, "Broken body", "A.md", "rev-2");
		expect((await runtime.patchContent("content", stable.renderKey, stable.renderer)).status)
			.toBe("patched");
		const failed = await runtime.patchContent("content", broken.renderKey, broken.renderer);

		expect(failed.status).toBe("failed");
		expect(slot.textContent).toBe("Stable body");
		expect(unload).toHaveBeenCalledTimes(1);
		runtime.dispose();
		expect(unload).toHaveBeenCalledTimes(2);
	});

	it("disposes stale content work and prevents its late commit", async () => {
		const app = new App();
		const { runtime, slot } = createContentRuntime();
		const oldGate = deferred();
		const unload = vi.spyOn(Component.prototype, "unload");
		vi.spyOn(MarkdownRenderer, "render").mockImplementation(async (_app, markdown, el) => {
			if (markdown === "Old body") await oldGate.promise;
			el.textContent = markdown;
		});

		const oldPatch = createPatch(app, "Old body", "A.md", "rev-1");
		const newPatch = createPatch(app, "New body", "A.md", "rev-2");
		const oldResult = runtime.patchContent("content", oldPatch.renderKey, oldPatch.renderer);
		const newResult = await runtime.patchContent("content", newPatch.renderKey, newPatch.renderer);

		expect(newResult.status).toBe("patched");
		expect(slot.textContent).toBe("New body");
		expect(unload).toHaveBeenCalledTimes(1);

		oldGate.resolve();
		expect((await oldResult).status).toBe("stale");
		expect(slot.textContent).toBe("New body");
		runtime.dispose();
		expect(unload).toHaveBeenCalledTimes(2);
	});

	it("uses the content ownerDocument and cleans pending resources on runtime disposal", async () => {
		const app = new App();
		const ownerDocument = new DOMParser().parseFromString(
			"<!doctype html><html><body></body></html>",
			"text/html",
		);
		const { runtime } = createContentRuntime(ownerDocument);
		const gate = deferred();
		const unload = vi.spyOn(Component.prototype, "unload");
		vi.spyOn(MarkdownRenderer, "render").mockImplementation(async (_app, _markdown, el) => {
			expect(el.ownerDocument).toBe(ownerDocument);
			expect(el.classList.contains("markdown-preview-sizer")).toBe(true);
			await gate.promise;
			el.textContent = "Late body";
		});

		const patch = createPatch(app, "Pending body", "Popup/A.md", "rev-1");
		const pending = runtime.patchContent("content", patch.renderKey, patch.renderer);
		runtime.dispose();
		expect(unload).toHaveBeenCalledTimes(1);

		gate.resolve();
		expect((await pending).status).toBe("disposed");
		expect(unload).toHaveBeenCalledTimes(1);
	});
});
