import { Component, TFile } from "obsidian";
import type { App } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { renderTemplate } from "../renderer";

function createFile(path: string, size: number): TFile {
	const file = new TFile();
	file.path = path;
	file.name = path.split("/").at(-1) ?? path;
	file.basename = file.name.replace(/\.md$/, "");
	file.extension = "md";
	file.parent = null;
	file.stat = { ctime: 1, mtime: 1000, size };
	return file;
}

function createContainer(): HTMLElement {
	const doc = new DOMParser().parseFromString("<main></main>", "text/html");
	return doc.createElement("div");
}

describe("source content freshness", () => {
	it("rereads source when a new render has identical path, mtime, and size", async () => {
		let body = "alpha";
		const cachedRead = vi.fn(async () => body);
		const app = {
			metadataCache: {
				getFileCache: vi.fn(() => ({ frontmatter: {} })),
			},
			vault: { cachedRead },
		} as unknown as App;
		const file = createFile("Notes/SameStat.md", 5);
		const component = new Component();
		const container = createContainer();

		await renderTemplate(
			app,
			"<p>{{content | upper}}</p>",
			file,
			container,
			component,
			false,
			undefined,
			undefined,
			false,
		);
		expect(container.textContent).toBe("ALPHA");
		expect(cachedRead).toHaveBeenCalledTimes(1);

		body = "bravo";
		await renderTemplate(
			app,
			"<p>{{content | upper}}</p>",
			file,
			container,
			component,
			false,
			undefined,
			undefined,
			false,
		);

		expect(cachedRead).toHaveBeenCalledTimes(2);
		expect(container.textContent).toBe("BRAVO");
	});

	it("does not reread when the caller supplies an explicit source snapshot", async () => {
		const cachedRead = vi.fn(async () => "vault-body");
		const app = {
			metadataCache: {
				getFileCache: vi.fn(() => ({ frontmatter: {} })),
			},
			vault: { cachedRead },
		} as unknown as App;
		const file = createFile("Notes/Explicit.md", 8);
		const container = createContainer();

		await renderTemplate(
			app,
			"<p>{{content | upper}}</p>",
			file,
			container,
			new Component(),
			false,
			undefined,
			undefined,
			false,
			"snapshot",
		);

		expect(cachedRead).not.toHaveBeenCalled();
		expect(container.textContent).toBe("SNAPSHOT");
	});

	it("deduplicates only concurrent source reads and rereads after the shared read settles", async () => {
		let resolveFirst!: (value: string) => void;
		const firstRead = new Promise<string>((resolve) => {
			resolveFirst = resolve;
		});
		const cachedRead = vi.fn(() => {
			return cachedRead.mock.calls.length === 1 ? firstRead : Promise.resolve("fresh");
		});
		const app = {
			metadataCache: {
				getFileCache: vi.fn(() => ({ frontmatter: {} })),
			},
			vault: { cachedRead },
		} as unknown as App;
		const file = createFile("Notes/Concurrent.md", 6);
		const firstContainer = createContainer();
		const secondContainer = createContainer();

		const firstRender = renderTemplate(
			app,
			"<p>{{content | upper}}</p>",
			file,
			firstContainer,
			new Component(),
			false,
			undefined,
			undefined,
			false,
		);
		const secondRender = renderTemplate(
			app,
			"<p>{{content | upper}}</p>",
			file,
			secondContainer,
			new Component(),
			false,
			undefined,
			undefined,
			false,
		);

		expect(cachedRead).toHaveBeenCalledTimes(1);
		resolveFirst("shared");
		await Promise.all([firstRender, secondRender]);
		expect(firstContainer.textContent).toBe("SHARED");
		expect(secondContainer.textContent).toBe("SHARED");

		const thirdContainer = createContainer();
		await renderTemplate(
			app,
			"<p>{{content | upper}}</p>",
			file,
			thirdContainer,
			new Component(),
			false,
			undefined,
			undefined,
			false,
		);

		expect(cachedRead).toHaveBeenCalledTimes(2);
		expect(thirdContainer.textContent).toBe("FRESH");
	});
});
