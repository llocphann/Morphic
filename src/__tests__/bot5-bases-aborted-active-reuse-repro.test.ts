import { Component, TFile } from "obsidian";
import type { App, BasesView, Plugin } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { EmbeddedBasesProvider } from "../bases/provider";
import type { EmbeddedBasesRequest, TemplateBaseView } from "../bases/types";
import type { NormalizeBaseMetadata } from "../bases/normalize";

interface ProviderInternals {
	getCollectorBase(
		request: EmbeddedBasesRequest,
		baseContent: string,
		metadata: NormalizeBaseMetadata,
	): Promise<TemplateBaseView>;
}

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

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
	const gate = deferred();
	let app!: App;
	const unload = vi.fn();
	const factory = vi.fn((_: unknown, _file: TFile, viewSubpath?: string) => {
		const selectedName = viewSubpath?.startsWith("#") ? viewSubpath.slice(1) : "Rows";
		const controller = {
			view: null as BasesView | null,
			queue: { queue: { runnable: { running: true } } },
		};
		return {
			controller,
			containingFile: undefined as TFile | undefined,
			loadFile: vi.fn(async () => {
				await gate.promise;
				controller.queue.queue.runnable.running = false;
				controller.view = makeView(app, selectedName);
			}),
			unload,
		};
	});

	app = {
		metadataCache: {
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

	const provider = new EmbeddedBasesProvider({ app } as unknown as Plugin);
	expect(provider.register()).toBe(true);
	return { app, provider, factory, gate, unload };
}

function request(app: App, component: Component): EmbeddedBasesRequest {
	return {
		app,
		file: makeFile(),
		templateContent: "{{bases[0].rowCount}}",
		sourceContent: "",
		ownerDocument: window.document,
		component,
	};
}

const metadata: NormalizeBaseMetadata = {
	sourceKind: "code-block",
	sourceIndex: 0,
	sourceLine: 1,
	viewIndex: 0,
	viewName: "Rows",
	originalType: "table",
};

const baseContent = "views:\n  - type: table\n    name: Rows";

describe("Bot 5 Bases aborted active-collector reuse race", () => {
	it("starts a fresh collector when a new live owner arrives immediately after the previous owner aborts", async () => {
		const harness = makeHarness();
		const internals = harness.provider as unknown as ProviderInternals;
		const firstOwner = new Component();
		const secondOwner = new Component();
		const first = internals.getCollectorBase(request(harness.app, firstOwner), baseContent, metadata);

		try {
			expect(harness.factory).toHaveBeenCalledTimes(1);
			firstOwner.unload();
			expect(harness.unload).toHaveBeenCalledTimes(1);

			const second = internals.getCollectorBase(request(harness.app, secondOwner), baseContent, metadata);

			// The aborted first operation must not remain leaseable until its promise
			// cleanup microtask removes the active map entry. A new live owner needs a
			// fresh native collector immediately, otherwise it receives the old abort
			// normalized as a successful error view.
			expect(harness.factory).toHaveBeenCalledTimes(2);

			harness.gate.resolve();
			const secondResult = await second;
			expect(secondResult.error).toBeUndefined();
		} finally {
			harness.gate.resolve();
			await Promise.allSettled([first]);
			secondOwner.unload();
			harness.provider.dispose();
		}
	});
});