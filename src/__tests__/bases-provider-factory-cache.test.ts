import { Component, TFile } from "obsidian";
import type { App, BasesView, Plugin } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { EmbeddedBasesProvider } from "../bases/provider";

function makeFile(): TFile {
	const file = new TFile();
	Object.assign(file, {
		name: "Bases.md",
		basename: "Bases",
		path: "Vault/Bases.md",
		extension: "md",
		parent: { path: "Vault" },
		stat: { size: 0, ctime: 1, mtime: 1 },
	});
	return file;
}

describe("EmbeddedBasesProvider factory lifecycle", () => {
	it("reuses the Base embed factory resolved during register", async () => {
		const sourceContent = [
			"```base",
			JSON.stringify({ views: [{ type: "table", name: "Songs" }] }),
			"```",
		].join("\n");
		const sourceFile = makeFile();
		const baseView = {
			config: {
				getDisplayName: (propertyId: string) => propertyId,
				get: () => null,
			},
			data: {
				properties: [],
				data: [],
			},
			type: "table",
			name: "Songs",
		} as unknown as BasesView;
		const factory = vi.fn(() => ({
			controller: {
				currentFile: sourceFile,
				view: baseView,
			},
			loadFile: vi.fn(async () => undefined),
			unload: vi.fn(),
		}));
		let factoryReads = 0;
		const embedByExtension: Record<string, unknown> = {};
		Object.defineProperty(embedByExtension, "base", {
			configurable: true,
			get() {
				factoryReads++;
				return factory;
			},
		});

		const vault = {
			read: vi.fn(async () => ""),
			cachedRead: vi.fn(async () => sourceContent),
			modify: vi.fn(async () => undefined),
			create: vi.fn(async () => sourceFile),
			getFileByPath: vi.fn(() => null),
		};
		const app = {
			embedRegistry: { embedByExtension },
			metadataCache: {
				getFirstLinkpathDest: vi.fn(() => null),
				getFileCache: vi.fn(() => ({ frontmatter: {} })),
			},
			vault,
		} as unknown as App;
		const plugin = { app } as Plugin;
		const provider = new EmbeddedBasesProvider(plugin);

		expect(provider.register()).toBe(true);
		expect(factoryReads).toBe(1);

		await provider.getEmbeddedBases({
			app,
			file: sourceFile,
			templateContent: "",
			sourceContent,
			ownerDocument: document,
			component: new Component(),
		});

		expect(factory).toHaveBeenCalledTimes(1);
		expect(factoryReads).toBe(1);
		provider.dispose();
	});
});
