import { Component, TFile } from "obsidian";
import type { App, BasesView, Plugin } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { EmbeddedBasesProvider } from "../bases/provider";
import type { EmbeddedBasesRequest } from "../bases/types";
import {
	DependencyCollector,
	RevisionStore,
	dependencyKey,
} from "../core/dependencies";
import { propertyDataDependencyKey } from "../core/property-data-dependencies";

function makeFile(path: string, extension = "md"): TFile {
	const file = new TFile();
	const name = path.slice(path.lastIndexOf("/") + 1);
	Object.assign(file, {
		name,
		basename: name.replace(new RegExp(`\\.${extension}$`, "i"), ""),
		path,
		extension,
		parent: { path: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "" },
		stat: { size: 1, ctime: 1, mtime: 1 },
	});
	return file;
}

function makeBaseContent(): string {
	return JSON.stringify({
		filters: 'status == "open"',
		views: [
			{ type: "table", name: "Rows", order: ["note.status"] },
			{ type: "table", name: "Archive", order: ["note.status"] },
		],
	});
}

function makeView(app: App, name: string): BasesView {
	return {
		app,
		config: {
			getDisplayName: (propertyId: string) => propertyId,
		},
		data: {
			properties: [],
			data: [],
		},
		type: "table",
		name,
	} as unknown as BasesView;
}

function makeHarness(baseFile: TFile, baseContent: string) {
	let app!: App;
	const unload = vi.fn();
	const cachedRead = vi.fn(async (file: TFile) => file.path === baseFile.path ? baseContent : "");
	const getFirstLinkpathDest = vi.fn((target: string) => target === baseFile.path ? baseFile : null);
	const getFileByPath = vi.fn((path: string) => path === baseFile.path ? baseFile : null);
	const factory = vi.fn((_: unknown, _file: TFile, viewSubpath?: string) => {
		const selectedName = viewSubpath?.startsWith("#") ? viewSubpath.slice(1) : "Rows";
		const controller = {
			currentFile: undefined as TFile | undefined,
			view: null as BasesView | null,
			queue: {
				queue: {
					runnable: {
						running: true,
					},
				},
			},
		};
		return {
			controller,
			containingFile: undefined as TFile | undefined,
			loadFile: vi.fn(async () => {
				controller.queue.queue.runnable.running = false;
				controller.view = makeView(app, selectedName);
			}),
			unload,
		};
	});

	app = {
		metadataCache: {
			getFileCache: vi.fn(() => ({ frontmatter: {} })),
			getFirstLinkpathDest,
		},
		vault: {
			read: vi.fn(async () => ""),
			cachedRead,
			modify: vi.fn(async () => undefined),
			create: vi.fn(async (path: string) => makeFile(path, "base")),
			getFileByPath,
		},
		embedRegistry: {
			embedByExtension: {
				base: factory,
			},
		},
	} as unknown as App;

	return { app, factory, unload, cachedRead, getFirstLinkpathDest, getFileByPath };
}

function makeProvider(app: App, revisions: RevisionStore): EmbeddedBasesProvider {
	const provider = new EmbeddedBasesProvider({ app } as unknown as Plugin, revisions);
	expect(provider.register()).toBe(true);
	return provider;
}

function makeRequest(
	app: App,
	file: TFile,
	viewName: string,
	collector = new DependencyCollector(),
): EmbeddedBasesRequest {
	return {
		app,
		file,
		templateContent: "{{bases.Rows.rowCount}}",
		sourceContent: `![[Queries/Tasks.base#${viewName}]]`,
		ownerDocument: window.document,
		component: new Component(),
		dependencyCollector: collector,
	};
}

describe("Bot 2 P6 external Base embed cache certification preparation", () => {
	it("tracks resolution/content dependencies and invalidates only when their revisions advance", async () => {
		const baseFile = makeFile("Queries/Tasks.base", "base");
		const harness = makeHarness(baseFile, makeBaseContent());
		const revisions = new RevisionStore();
		const provider = makeProvider(harness.app, revisions);
		const note = makeFile("Dashboards/Dashboard.md");
		const collector = new DependencyCollector();
		const indexKey = dependencyKey.index("files");
		const contentKey = dependencyKey.file(baseFile.path, "content");
		const statusKey = propertyDataDependencyKey("status");

		await provider.getEmbeddedBases(makeRequest(harness.app, note, "Rows", collector));
		await provider.getEmbeddedBases(makeRequest(harness.app, note, "Rows"));

		expect(collector.has(indexKey)).toBe(true);
		expect(collector.has(contentKey)).toBe(true);
		expect(collector.has(statusKey)).toBe(true);
		expect(harness.factory).toHaveBeenCalledTimes(1);
		expect(harness.getFirstLinkpathDest).toHaveBeenCalledWith(baseFile.path, note.path);

		revisions.bump(propertyDataDependencyKey("unrelated"));
		await provider.getEmbeddedBases(makeRequest(harness.app, note, "Rows"));
		expect(harness.factory).toHaveBeenCalledTimes(1);

		revisions.bump(contentKey);
		await provider.getEmbeddedBases(makeRequest(harness.app, note, "Rows"));
		expect(harness.factory).toHaveBeenCalledTimes(2);

		revisions.bump(indexKey);
		await provider.getEmbeddedBases(makeRequest(harness.app, note, "Rows"));
		expect(harness.factory).toHaveBeenCalledTimes(3);
		expect(window.document.body.querySelector(".cv-bases-collector-host")).toBeNull();
	});

	it("partitions external Base cache identity by selected view", async () => {
		const baseFile = makeFile("Queries/Tasks.base", "base");
		const harness = makeHarness(baseFile, makeBaseContent());
		const revisions = new RevisionStore();
		const provider = makeProvider(harness.app, revisions);
		const note = makeFile("Dashboards/Dashboard.md");

		await provider.getEmbeddedBases(makeRequest(harness.app, note, "Rows"));
		await provider.getEmbeddedBases(makeRequest(harness.app, note, "Archive"));
		await provider.getEmbeddedBases(makeRequest(harness.app, note, "Rows"));

		expect(harness.factory).toHaveBeenCalledTimes(2);
		expect(harness.factory.mock.calls.map(call => call[2])).toEqual(["#Rows", "#Archive"]);
		expect(harness.unload).toHaveBeenCalledTimes(2);
	});
});
