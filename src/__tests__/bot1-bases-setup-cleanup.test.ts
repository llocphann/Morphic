import { Component, TFile } from "obsidian";
import type { App, BasesView, Plugin } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { EmbeddedBasesProvider } from "../bases/provider";
import type { EmbeddedBasesRequest } from "../bases/types";

function makeFile(path = "Dashboards/Dashboard.md"): TFile {
	const file = new TFile();
	const name = path.slice(path.lastIndexOf("/") + 1);
	Object.assign(file, {
		name,
		basename: name.replace(/\.md$/i, ""),
		path,
		extension: "md",
		parent: { path: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "" },
		stat: { size: 1, ctime: 1, mtime: 1 },
	});
	return file;
}

function baseSource(name: string): string {
	return [
		"```base",
		JSON.stringify({ views: [{ type: "table", name }] }),
		"```",
	].join("\n");
}

function makeView(app: App, name: string): BasesView {
	return {
		app,
		config: { getDisplayName: (propertyId: string) => propertyId },
		data: { properties: [], data: [] },
		type: "table",
		name,
	} as unknown as BasesView;
}

function makeHarness() {
	let app!: App;
	const factory = vi.fn((_: unknown, _file: TFile, viewSubpath?: string) => {
		const name = viewSubpath?.startsWith("#") ? viewSubpath.slice(1) : "Rows";
		const controller = { view: null as BasesView | null };
		return {
			controller,
			loadFile: vi.fn(async () => {
				controller.view = makeView(app, name);
			}),
			unload: vi.fn(),
		};
	});

	app = {
		metadataCache: {
			getFileCache: vi.fn(() => ({ frontmatter: {} })),
			getFirstLinkpathDest: vi.fn(() => null),
		},
		vault: {
			read: vi.fn(async () => ""),
			cachedRead: vi.fn(async () => ""),
			modify: vi.fn(async () => undefined),
			create: vi.fn(async (path: string) => {
				const file = makeFile(path);
				file.extension = "base";
				return file;
			}),
			getFileByPath: vi.fn(() => null),
		},
		embedRegistry: { embedByExtension: { base: factory } },
	} as unknown as App;

	return { app, factory };
}

function request(app: App, sourceContent: string): EmbeddedBasesRequest {
	return {
		app,
		file: makeFile(),
		templateContent: "{{bases[0].rowCount}}",
		sourceContent,
		ownerDocument: window.document,
		component: new Component(),
	};
}

describe("Bot 1 Bases collector setup cleanup", () => {
	it("does not leak limiter permits when host setup throws before native embed creation", async () => {
		const { app, factory } = makeHarness();
		const provider = new EmbeddedBasesProvider({ app } as unknown as Plugin);
		expect(provider.register()).toBe(true);

		const appendChild = vi.spyOn(window.document.body, "appendChild");
		for (let index = 0; index < 4; index++) {
			appendChild.mockImplementationOnce(() => {
				throw new Error(`collector host setup failed ${index}`);
			});
		}

		let healthyQuery: ReturnType<EmbeddedBasesProvider["getEmbeddedBases"]> | null = null;
		try {
			for (let index = 0; index < 4; index++) {
				const result = await provider.getEmbeddedBases(request(app, baseSource(`Fail${index}`)));
				expect(result[0]?.error).toContain("collector host setup failed");
			}

			healthyQuery = provider.getEmbeddedBases(request(app, baseSource("Healthy")));
			await Promise.resolve();
			await Promise.resolve();
			expect(factory).toHaveBeenCalledTimes(1);

			const result = await healthyQuery;
			expect(result[0]?.error).toBeUndefined();
		} finally {
			appendChild.mockRestore();
			provider.dispose();
			if (healthyQuery) await Promise.allSettled([healthyQuery]);
		}
	});
});
