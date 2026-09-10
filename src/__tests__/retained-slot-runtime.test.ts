import { describe, expect, it, vi } from "vitest";
import {
	RetainedDomRuntime,
	type RetainedIslandRenderer,
} from "../render/retained-slot-runtime";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("RetainedDomRuntime", () => {
	it("retains one static tree for the same structure key and patches text in place", () => {
		const root = document.createElement("div");
		const runtime = new RetainedDomRuntime(root);
		const build = vi.fn(({ ownerDocument, fragment, textSlot }) => {
			const article = ownerDocument.createElement("article");
			article.appendChild(textSlot("title", "First"));
			fragment.appendChild(article);
		});

		expect(runtime.mountStructure("template-a", build)).toBe("mounted");
		const article = root.firstElementChild;
		expect(article?.textContent).toBe("First");

		expect(runtime.patchText("title", "Second")).toBe("patched");
		expect(root.firstElementChild).toBe(article);
		expect(article?.textContent).toBe("Second");
		expect(runtime.patchText("title", "Second")).toBe("unchanged");

		expect(runtime.mountStructure("template-a", build)).toBe("reused");
		expect(build).toHaveBeenCalledTimes(1);
		expect(root.firstElementChild).toBe(article);
	});

	it("uses the root ownerDocument and rejects slot targets from another document", () => {
		const popupDocument = document.implementation.createHTMLDocument("Popup");
		const root = popupDocument.createElement("div");
		popupDocument.body.appendChild(root);
		const runtime = new RetainedDomRuntime(root);

		runtime.mountStructure("popup", ({ ownerDocument, fragment, textSlot }) => {
			expect(ownerDocument).toBe(popupDocument);
			const section = ownerDocument.createElement("section");
			section.appendChild(textSlot("label", "Popup safe"));
			fragment.appendChild(section);
		});

		expect(root.firstChild?.ownerDocument).toBe(popupDocument);
		const previous = root.firstChild;
		const foreign = document.createElement("button");
		expect(() => runtime.mountStructure("foreign", ({ attributeSlot }) => {
			attributeSlot("foreign-attr", foreign, "title");
		})).toThrow("different document");
		expect(root.firstChild).toBe(previous);
		expect(runtime.currentStructureKey).toBe("popup");
	});

	it("patches attributes without rebuilding and removes only nullish values", () => {
		const root = document.createElement("div");
		const runtime = new RetainedDomRuntime(root);

		runtime.mountStructure("attributes", ({ ownerDocument, fragment, attributeSlot }) => {
			const button = ownerDocument.createElement("button");
			attributeSlot("title", button, "title");
			fragment.appendChild(button);
		});
		const button = root.querySelector<HTMLButtonElement>("button");
		expect(button).not.toBeNull();

		expect(runtime.patchAttribute("title", 42)).toBe("patched");
		expect(button?.getAttribute("title")).toBe("42");
		expect(runtime.patchAttribute("title", 42)).toBe("unchanged");
		expect(runtime.patchAttribute("title", false)).toBe("patched");
		expect(button?.getAttribute("title")).toBe("false");
		expect(runtime.patchAttribute("title", null)).toBe("patched");
		expect(button?.hasAttribute("title")).toBe(false);
	});

	it("confines explicit raw HTML updates to the registered island", () => {
		const root = document.createElement("div");
		const runtime = new RetainedDomRuntime(root);

		runtime.mountStructure("raw", ({ ownerDocument, fragment, rawHtmlSlot }) => {
			const staticNode = ownerDocument.createElement("span");
			staticNode.textContent = "Static";
			const rawIsland = ownerDocument.createElement("div");
			rawIsland.className = "raw-island";
			rawHtmlSlot("raw-body", rawIsland);
			fragment.append(staticNode, rawIsland);
		});
		const retainedStaticNode = root.firstElementChild;
		const rawIsland = root.querySelector<HTMLElement>(".raw-island");
		expect(rawIsland).not.toBeNull();

		expect(runtime.patchRawHtml("raw-body", {
			explicitRawHtml: true,
			html: "<strong>Trusted</strong>",
		})).toBe("patched");
		expect(rawIsland?.innerHTML).toBe("<strong>Trusted</strong>");
		expect(root.firstElementChild).toBe(retainedStaticNode);
		expect(runtime.patchRawHtml("raw-body", {
			explicitRawHtml: true,
			html: "<strong>Trusted</strong>",
		})).toBe("unchanged");
	});

	it("deduplicates an unchanged committed Markdown island", async () => {
		const root = document.createElement("div");
		const runtime = new RetainedDomRuntime(root);
		runtime.mountStructure("markdown", ({ ownerDocument, fragment, markdownSlot }) => {
			const island = ownerDocument.createElement("div");
			markdownSlot("summary", island);
			fragment.appendChild(island);
		});

		const render = vi.fn<RetainedIslandRenderer>(({ container }) => {
			container.textContent = "Rendered";
		});
		expect((await runtime.patchMarkdown("summary", "revision-1", render)).status).toBe("patched");
		expect(root.textContent).toBe("Rendered");

		const redundant = vi.fn<RetainedIslandRenderer>();
		expect((await runtime.patchMarkdown("summary", "revision-1", redundant)).status).toBe("unchanged");
		expect(redundant).not.toHaveBeenCalled();
		expect(root.textContent).toBe("Rendered");
	});

	it("prevents an older Markdown island generation from committing after a newer update", async () => {
		const root = document.createElement("div");
		const runtime = new RetainedDomRuntime(root);
		runtime.mountStructure("markdown-race", ({ ownerDocument, fragment, markdownSlot }) => {
			const island = ownerDocument.createElement("div");
			markdownSlot("body", island);
			fragment.appendChild(island);
		});

		await runtime.patchMarkdown("body", "base", ({ container }) => {
			container.textContent = "Base";
		});

		const gate = deferred();
		const oldCleanup = vi.fn();
		const oldRender = runtime.patchMarkdown("body", "old", async ({ container, resources, isCurrent }) => {
			container.textContent = "Old";
			resources.register(oldCleanup);
			await gate.promise;
			expect(isCurrent()).toBe(false);
		});

		const newResult = await runtime.patchMarkdown("body", "new", ({ container }) => {
			container.textContent = "New";
		});
		expect(newResult.status).toBe("patched");
		expect(root.textContent).toBe("New");
		expect(oldCleanup).toHaveBeenCalledTimes(1);

		gate.resolve();
		expect((await oldRender).status).toBe("stale");
		expect(root.textContent).toBe("New");
	});

	it("keeps last-known-good island DOM and resources when an async render fails", async () => {
		const root = document.createElement("div");
		const runtime = new RetainedDomRuntime(root);
		runtime.mountStructure("markdown-failure", ({ ownerDocument, fragment, markdownSlot }) => {
			const island = ownerDocument.createElement("div");
			markdownSlot("body", island);
			fragment.appendChild(island);
		});

		const committedCleanup = vi.fn();
		await runtime.patchMarkdown("body", "stable", ({ container, resources }) => {
			container.textContent = "Stable";
			resources.register(committedCleanup);
		});

		const failedCleanup = vi.fn();
		const failure = new Error("Island render failed");
		const result = await runtime.patchMarkdown("body", "broken", ({ container, resources }) => {
			container.textContent = "Broken";
			resources.register(failedCleanup);
			throw failure;
		});

		expect(result.status).toBe("failed");
		expect(result.error).toBe(failure);
		expect(root.textContent).toBe("Stable");
		expect(failedCleanup).toHaveBeenCalledTimes(1);
		expect(committedCleanup).not.toHaveBeenCalled();
	});

	it("preserves the old retained tree when a replacement builder throws", async () => {
		const root = document.createElement("div");
		const runtime = new RetainedDomRuntime(root);
		const cleanup = vi.fn();
		runtime.mountStructure("good", ({ ownerDocument, fragment, markdownSlot }) => {
			const island = ownerDocument.createElement("div");
			markdownSlot("body", island);
			fragment.appendChild(island);
		});
		await runtime.patchMarkdown("body", "stable", ({ container, resources }) => {
			container.textContent = "Stable";
			resources.register(cleanup);
		});
		const previous = root.firstChild;

		expect(() => runtime.mountStructure("bad", () => {
			throw new Error("Static build failed");
		})).toThrow("Static build failed");
		expect(root.firstChild).toBe(previous);
		expect(root.textContent).toBe("Stable");
		expect(runtime.currentStructureKey).toBe("good");
		expect(cleanup).not.toHaveBeenCalled();
	});

	it("disposes committed resources after a successful structure replacement", async () => {
		const root = document.createElement("div");
		const runtime = new RetainedDomRuntime(root);
		const cleanup = vi.fn();
		runtime.mountStructure("first", ({ ownerDocument, fragment, contentSlot }) => {
			const island = ownerDocument.createElement("div");
			contentSlot("content", island);
			fragment.appendChild(island);
		});
		await runtime.patchContent("content", "content-1", ({ container, resources }) => {
			container.textContent = "Content";
			resources.register(cleanup);
		});

		expect(runtime.mountStructure("second", ({ ownerDocument, fragment, textSlot }) => {
			const paragraph = ownerDocument.createElement("p");
			paragraph.appendChild(textSlot("replacement", "Replacement"));
			fragment.appendChild(paragraph);
		})).toBe("mounted");
		expect(root.textContent).toBe("Replacement");
		expect(cleanup).toHaveBeenCalledTimes(1);
	});

	it("keeps cleanup reporter failures diagnostic after a committed structure replacement", async () => {
		const cleanupError = new Error("Cleanup failed");
		const reported: unknown[] = [];
		const root = document.createElement("div");
		const runtime = new RetainedDomRuntime(root, {
			onCleanupError(error) {
				reported.push(error);
				throw new Error("Reporter failed");
			},
		});
		runtime.mountStructure("markdown", ({ ownerDocument, fragment, markdownSlot }) => {
			const island = ownerDocument.createElement("div");
			markdownSlot("body", island);
			fragment.appendChild(island);
		});
		await runtime.patchMarkdown("body", "stable", ({ container, resources }) => {
			container.textContent = "Stable";
			resources.register(() => {
				throw cleanupError;
			});
		});

		let mountStatus: ReturnType<typeof runtime.mountStructure> | null = null;
		expect(() => {
			mountStatus = runtime.mountStructure("replacement", ({ ownerDocument, fragment, textSlot }) => {
				const paragraph = ownerDocument.createElement("p");
				paragraph.appendChild(textSlot("replacement", "Replacement"));
				fragment.appendChild(paragraph);
			});
		}).not.toThrow();
		expect(mountStatus).toBe("mounted");
		expect(root.textContent).toBe("Replacement");
		expect(runtime.currentStructureKey).toBe("replacement");
		expect(reported).toEqual([cleanupError]);
		expect(runtime.mountStructure("replacement", () => {
			throw new Error("Same structure must be retained");
		})).toBe("reused");
	});

	it("invalidates pending island work and cleans all resources on dispose", async () => {
		const cleanupError = new Error("Cleanup failed");
		const onCleanupError = vi.fn();
		const root = document.createElement("div");
		const runtime = new RetainedDomRuntime(root, { onCleanupError });
		runtime.mountStructure("dispose", ({ ownerDocument, fragment, markdownSlot }) => {
			const island = ownerDocument.createElement("div");
			markdownSlot("body", island);
			fragment.appendChild(island);
		});

		const committedCleanup = vi.fn();
		await runtime.patchMarkdown("body", "stable", ({ container, resources }) => {
			container.textContent = "Stable";
			resources.register(committedCleanup);
		});

		const gate = deferred();
		const pendingCleanup = vi.fn(() => {
			throw cleanupError;
		});
		const pending = runtime.patchMarkdown("body", "pending", async ({ resources, isCurrent }) => {
			resources.register(pendingCleanup);
			await gate.promise;
			expect(isCurrent()).toBe(false);
		});

		runtime.dispose();
		expect(pendingCleanup).toHaveBeenCalledTimes(1);
		expect(committedCleanup).toHaveBeenCalledTimes(1);
		expect(onCleanupError).toHaveBeenCalledWith(cleanupError);
		expect(runtime.patchText("missing", "Ignored")).toBe("disposed");

		gate.resolve();
		expect((await pending).status).toBe("disposed");
	});
});
