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

function baseSource(filter = 'status == "open"'): string {
	return [
		"```base",
		JSON.stringify({
			filters: filter,
			views: [{ type: "table", name: "Rows", order: ["note.status"] }],
		}),
		"```",
	].join("\n");
}

function templateBaseSource(): string {
	return [
		'{% base "Rows" %}',
		JSON.stringify({
			filters: 'status == "open"',
			views: [{ type: "table", name: "Rows", order: ["note.status"] }],
		}),
		"{% endbase %}",
		"{{bases.Rows.rowCount}}",
	].join("\n");
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

function makeHarness() {
	let app!: App;
	const unload = vi.fn();
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
		embedRegistry: {
			embedByExtension: {
				base: factory,
			},
		},
	} as unknown as App;

	return { app, factory, unload };
}

function makeProvider(app: App, revisions: RevisionStore): EmbeddedBasesProvider {
	const plugin = { app } as unknown as Plugin;
	const provider = new EmbeddedBasesProvider(plugin, revisions);
	expect(provider.register()).toBe(true);
	return provider;
}

function makeRequest(
	app: App,
	file: TFile,
	sourceContent: string,
	dependencyCollector = new DependencyCollector(),
	options: {
		templateContent?: string;
		settingsViewId?: string;
	} = {},
): EmbeddedBasesRequest {
	return {
		app,
		file,
		templateContent: options.templateContent ?? "{{bases.Rows.rowCount}}",
		sourceContent,
		ownerDocument: window.document,
		component: new Component(),
		dependencyCollector,
		...(options.settingsViewId ? { settingsViewId: options.settingsViewId } : {}),
	};
}

describe("Bot 2 P6 Bases provider/cache certification preparation", () => {
	it("reuses a warm query while surfacing its dependency read-set to every request", async () => {
		const harness = makeHarness();
		const revisions = new RevisionStore();
		const provider = makeProvider(harness.app, revisions);
		const file = makeFile();
		const sourceContent = baseSource();
		const firstCollector = new DependencyCollector();
		const secondCollector = new DependencyCollector();
		const statusKey = propertyDataDependencyKey("status");

		await provider.getEmbeddedBases(makeRequest(harness.app, file, sourceContent, firstCollector));
		await provider.getEmbeddedBases(makeRequest(harness.app, file, sourceContent, secondCollector));

		expect(harness.factory).toHaveBeenCalledTimes(1);
		expect(firstCollector.has(statusKey)).toBe(true);
		expect(secondCollector.has(statusKey)).toBe(true);
		expect(window.document.body.querySelector(".cv-bases-collector-host")).toBeNull();
	});

	it("invalidates a warm query when an exact query dependency revision changes", async () => {
		const harness = makeHarness();
		const revisions = new RevisionStore();
		const provider = makeProvider(harness.app, revisions);
		const file = makeFile();
		const sourceContent = baseSource();
		const statusKey = propertyDataDependencyKey("status");

		await provider.getEmbeddedBases(makeRequest(harness.app, file, sourceContent));
		await provider.getEmbeddedBases(makeRequest(harness.app, file, sourceContent));
		expect(harness.factory).toHaveBeenCalledTimes(1);

		revisions.bump(statusKey);
		await provider.getEmbeddedBases(makeRequest(harness.app, file, sourceContent));

		expect(harness.factory).toHaveBeenCalledTimes(2);
	});

	it("invalidates warm time-dependent queries only after their exact time revision advances", async () => {
		for (const [kind, filter] of [
			["now", "now() != null"],
			["today", "today() != null"],
			["random", "random() >= 0"],
		] as const) {
			const harness = makeHarness();
			const revisions = new RevisionStore();
			const provider = makeProvider(harness.app, revisions);
			const file = makeFile();
			const sourceContent = baseSource(filter);
			const collector = new DependencyCollector();
			const timeKey = dependencyKey.time(kind);

			await provider.getEmbeddedBases(makeRequest(harness.app, file, sourceContent, collector));
			await provider.getEmbeddedBases(makeRequest(harness.app, file, sourceContent));
			expect(collector.has(timeKey), kind).toBe(true);
			expect(harness.factory, kind).toHaveBeenCalledTimes(1);

			revisions.bump(timeKey);
			await provider.getEmbeddedBases(makeRequest(harness.app, file, sourceContent));

			expect(harness.factory, kind).toHaveBeenCalledTimes(2);
		}
	});

	it("does not invalidate a warm query for an unrelated revision bump", async () => {
		const harness = makeHarness();
		const revisions = new RevisionStore();
		const provider = makeProvider(harness.app, revisions);
		const file = makeFile();
		const sourceContent = baseSource();

		await provider.getEmbeddedBases(makeRequest(harness.app, file, sourceContent));
		revisions.bump(propertyDataDependencyKey("unrelated"));
		await provider.getEmbeddedBases(makeRequest(harness.app, file, sourceContent));

		expect(harness.factory).toHaveBeenCalledTimes(1);
	});

	it("partitions warm query results by current-file identity", async () => {
		const harness = makeHarness();
		const revisions = new RevisionStore();
		const provider = makeProvider(harness.app, revisions);
		const sourceContent = baseSource('this.file.folder == "Dashboards"');

		await provider.getEmbeddedBases(makeRequest(
			harness.app,
			makeFile("Dashboards/First.md"),
			sourceContent,
		));
		await provider.getEmbeddedBases(makeRequest(
			harness.app,
			makeFile("Archive/Second.md"),
			sourceContent,
		));

		expect(harness.factory).toHaveBeenCalledTimes(2);
	});

	it("keeps template-defined Base cache identity scoped to the owning settings view", async () => {
		const harness = makeHarness();
		const revisions = new RevisionStore();
		const provider = makeProvider(harness.app, revisions);
		const file = makeFile();
		const templateContent = templateBaseSource();
		const firstCollector = new DependencyCollector();
		const secondCollector = new DependencyCollector();

		await provider.getEmbeddedBases(makeRequest(
			harness.app,
			file,
			"",
			firstCollector,
			{ templateContent, settingsViewId: "view-a" },
		));
		await provider.getEmbeddedBases(makeRequest(
			harness.app,
			file,
			"",
			secondCollector,
			{ templateContent, settingsViewId: "view-b" },
		));

		expect(firstCollector.has(dependencyKey.settings("view-a"))).toBe(true);
		expect(secondCollector.has(dependencyKey.settings("view-b"))).toBe(true);
		expect(firstCollector.has(dependencyKey.settings("view-b"))).toBe(false);
		expect(secondCollector.has(dependencyKey.settings("view-a"))).toBe(false);
		expect(harness.factory).toHaveBeenCalledTimes(2);
	});

	it("releases native collector resources after successful normalization", async () => {
		const harness = makeHarness();
		const revisions = new RevisionStore();
		const provider = makeProvider(harness.app, revisions);

		await provider.getEmbeddedBases(makeRequest(
			harness.app,
			makeFile(),
			baseSource(),
		));

		expect(harness.unload).toHaveBeenCalledTimes(1);
		expect(window.document.body.querySelector(".cv-bases-collector-host")).toBeNull();
	});
});
