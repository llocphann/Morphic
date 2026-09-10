import { Component, TFile } from "obsidian";
import type { App, BasesView, Plugin } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { EmbeddedBasesProvider } from "../bases/provider";
import type { EmbeddedBasesRequest } from "../bases/types";

interface Deferred {
	promise: Promise<void>;
	resolve(): void;
}

function deferred(): Deferred {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
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

function baseSources(count: number, prefix = "Rows"): string {
	return Array.from({ length: count }, (_, index) => [
		"```base",
		JSON.stringify({
			views: [{ type: "table", name: `${prefix}${index}` }],
		}),
		"```",
	].join("\n")).join("\n\n");
}

type HarnessMode = "immediate" | "gated" | "never-ready" | "hung-load";

function makeHarness(mode: HarnessMode) {
	const gate = deferred();
	let activeLoads = 0;
	let maxActiveLoads = 0;
	let app!: App;
	const unload = vi.fn();

	const factory = vi.fn((_: unknown, _file: TFile, viewSubpath?: string) => {
		const selectedName = viewSubpath?.startsWith("#") ? viewSubpath.slice(1) : "Rows";
		const controller = {
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
				activeLoads++;
				maxActiveLoads = Math.max(maxActiveLoads, activeLoads);
				try {
					if (mode === "gated" || mode === "hung-load") {
						await gate.promise;
					}
					controller.queue.queue.runnable.running = false;
					if (mode !== "never-ready") {
						controller.view = makeView(app, selectedName);
					}
				} finally {
					activeLoads--;
				}
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

	return {
		app,
		factory,
		gate,
		unload,
		get activeLoads() {
			return activeLoads;
		},
		get maxActiveLoads() {
			return maxActiveLoads;
		},
	};
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

function makeProvider(app: App): EmbeddedBasesProvider {
	const plugin = { app } as unknown as Plugin;
	const provider = new EmbeddedBasesProvider(plugin);
	expect(provider.register()).toBe(true);
	return provider;
}

function makeRequest(
	app: App,
	sourceContent: string,
	component = new Component(),
): EmbeddedBasesRequest {
	return {
		app,
		file: makeFile(),
		templateContent: "{{bases[0].rowCount}}",
		sourceContent,
		ownerDocument: window.document,
		component,
	};
}

describe("Bot 5 Bases reliability contracts", () => {
	it("deduplicates identical concurrent native Bases collection", async () => {
		const harness = makeHarness("gated");
		const provider = makeProvider(harness.app);
		const request = makeRequest(harness.app, baseSources(1));
		const first = provider.getEmbeddedBases(request);
		const second = provider.getEmbeddedBases(request);

		try {
			await Promise.resolve();
			expect(harness.factory).toHaveBeenCalledTimes(1);
		} finally {
			harness.gate.resolve();
			await Promise.allSettled([first, second]);
		}
	});

	it("reuses a warm result but invalidates it when Base source content changes", async () => {
		const harness = makeHarness("immediate");
		const provider = makeProvider(harness.app);
		const component = new Component();
		const original = makeRequest(harness.app, baseSources(1, "Original"), component);

		await provider.getEmbeddedBases(original);
		await provider.getEmbeddedBases(original);
		await provider.getEmbeddedBases({
			...original,
			sourceContent: baseSources(1, "Changed"),
		});

		expect(harness.factory).toHaveBeenCalledTimes(2);
	});

	it("releases pending native collector resources when the owning component unloads", async () => {
		vi.useFakeTimers();
		const harness = makeHarness("never-ready");
		const provider = makeProvider(harness.app);
		const component = new Component();
		const request = makeRequest(harness.app, baseSources(1), component);
		const query = provider.getEmbeddedBases(request);

		try {
			await Promise.resolve();
			await Promise.resolve();
			expect(window.document.body.querySelectorAll(".cv-bases-collector-host")).toHaveLength(1);

			component.unload();

			expect(harness.unload).toHaveBeenCalledTimes(1);
			expect(window.document.body.querySelectorAll(".cv-bases-collector-host")).toHaveLength(0);
		} finally {
			await vi.advanceTimersByTimeAsync(5000);
			await Promise.allSettled([query]);
			vi.useRealTimers();
		}
	});

	it("does not fan out every native collector concurrently for a multi-source request", async () => {
		const sourceCount = 24;
		const harness = makeHarness("gated");
		const provider = makeProvider(harness.app);
		const query = provider.getEmbeddedBases(makeRequest(harness.app, baseSources(sourceCount)));

		try {
			await Promise.resolve();
			expect(harness.maxActiveLoads).toBeGreaterThan(0);
			expect(harness.maxActiveLoads).toBeLessThan(sourceCount);
		} finally {
			harness.gate.resolve();
			await Promise.allSettled([query]);
		}
	});

	it("applies the collection timeout to a native embed whose loadFile never settles", async () => {
		vi.useFakeTimers();
		const harness = makeHarness("hung-load");
		const provider = makeProvider(harness.app);
		const query = provider.getEmbeddedBases(makeRequest(harness.app, baseSources(1)));
		let settled = false;
		void query.finally(() => {
			settled = true;
		});

		try {
			await Promise.resolve();
			await vi.advanceTimersByTimeAsync(5000);
			expect(settled).toBe(true);
		} finally {
			harness.gate.resolve();
			await Promise.allSettled([query]);
			vi.useRealTimers();
		}
	});
});
