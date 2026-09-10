import { MarkdownView, TFile, TFolder, type App } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import CustomViewsPlugin from "../main";
import { DEFAULT_SETTINGS } from "../settings";
import {
	InvalidationEngine,
	ReactiveDataCore,
	RenderControllerRegistry,
	type RenderPreparationContext,
	type RenderTransaction,
} from "../core";
import type { ViewConfig } from "../types";

interface MutableMarkdownView extends MarkdownView {
	file: TFile | null;
	contentEl: HTMLElement;
	getState(): { mode: string; source: boolean };
	getViewData(): string;
}

interface MarkdownInput {
	view: MarkdownView;
	file: TFile;
	matchedConfig: ViewConfig | null;
	mode: "livepreview";
	stateKey: string;
	requestKey?: string;
	sourceContent?: string;
}

interface PendingMarkdownRequest {
	file: TFile;
	timer: number;
}

interface SourceRevisionState {
	stateKey: string;
	sourceContent: string;
	revision: number;
}

interface ProductionInternals {
	settingsVersion: number;
	nextScopeId: number;
	scopeIds: WeakMap<HTMLElement, string>;
	editableStates: WeakMap<HTMLElement, unknown>;
	compartments: WeakMap<object, unknown>;
	canvasOwners: Map<unknown, unknown>;
	pendingMarkdownRequests: Map<MarkdownView, PendingMarkdownRequest>;
	markdownSourceRevisions: WeakMap<MarkdownView, SourceRevisionState>;
	markdownControllers: RenderControllerRegistry<MarkdownView, MarkdownInput> | null;
	runtimeDataInvalidation: InvalidationEngine<MarkdownView> | null;
	runtimeDataCore: ReactiveDataCore<MarkdownView> | null;
	findMatchedConfig(file: TFile): ViewConfig | null;
	prepareMarkdownRender(
		owner: MarkdownView,
		input: MarkdownInput,
		context: RenderPreparationContext,
	): Promise<RenderTransaction>;
	renderMarkdownView(view: MarkdownView, file: TFile, forceSemanticRefresh?: boolean): Promise<void>;
	queueMarkdownView(view: MarkdownView, file: TFile): void;
	commitRuntimeDependencies(owner: MarkdownView, dependencies: Iterable<unknown>): void;
	onload(): Promise<void>;
	loadSettings(): Promise<void>;
	addSettingTab(tab: unknown): void;
	addCommand(command: unknown): unknown;
	registerEvent(event: unknown): void;
}

interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function createFile(path: string): TFile {
	const file = new TFile();
	file.path = path;
	file.name = path.split("/").pop() ?? path;
	file.basename = file.name.replace(/\.md$/, "");
	file.extension = "md";
	Object.defineProperty(file, "parent", {
		value: { path: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "" },
		configurable: true,
	});
	file.stat = { ctime: 1, mtime: 2, size: 3 };
	return file;
}

function createConfig(): ViewConfig {
	return {
		id: "bot4-live-source-currentness",
		name: "Bot 4 live source currentness",
		rules: { type: "group", operator: "AND", conditions: [] },
		template: "<article>{% if show %}<i>Live</i>{{ content }}{% else %}<span>Off</span>{% endif %}<b>Tail</b></article>",
	};
}

function createRootFolder(): TFolder {
	const root = new TFolder();
	root.path = "";
	root.name = "";
	root.children = [];
	root.isRoot = () => true;
	return root;
}

function createApp(file: TFile): App {
	const root = createRootFolder();
	return {
		metadataCache: {
			getFileCache(target: TFile) {
				if (target !== file) return null;
				return { frontmatter: { show: true }, tags: [], links: [], embeds: [] };
			},
			getFirstLinkpathDest() {
				return null;
			},
		},
		vault: {
			cachedRead: vi.fn(async () => "Persisted body"),
			getMarkdownFiles: () => [file],
			getRoot: () => root,
		},
		workspace: { openLinkText: vi.fn(async () => undefined) },
	} as unknown as App;
}

function createView(file: TFile, readSource: () => string): MutableMarkdownView {
	const view = Object.create(MarkdownView.prototype) as MutableMarkdownView;
	view.file = file;
	view.contentEl = document.createElement("div");
	view.getState = () => ({ mode: "source", source: false });
	view.getViewData = readSource;
	return view;
}

function createPlugin(app: App, file: TFile, config: ViewConfig): ProductionInternals {
	const plugin = Object.create(CustomViewsPlugin.prototype) as CustomViewsPlugin;
	plugin.settings = {
		...DEFAULT_SETTINGS,
		enabled: true,
		editableContent: false,
		allowJavaScript: false,
		workInLivePreview: true,
		workInCanvas: true,
		views: [config],
	};
	Object.defineProperty(plugin, "app", { value: app, configurable: true });
	const internals = plugin as unknown as ProductionInternals;
	internals.settingsVersion = 0;
	internals.nextScopeId = 0;
	internals.scopeIds = new WeakMap();
	internals.editableStates = new WeakMap();
	internals.compartments = new WeakMap();
	internals.canvasOwners = new Map();
	internals.pendingMarkdownRequests = new Map();
	internals.markdownSourceRevisions = new WeakMap();
	internals.findMatchedConfig = () => config;
	const invalidation = new InvalidationEngine<MarkdownView>(() => undefined);
	const core = new ReactiveDataCore<MarkdownView>(app, invalidation);
	core.bootstrap([file]);
	internals.runtimeDataInvalidation = invalidation;
	internals.runtimeDataCore = core;
	internals.markdownControllers = new RenderControllerRegistry((owner) => {
		return (input, context) => internals.prepareMarkdownRender(owner, input, context);
	});
	return internals;
}

function installObsidianDomHelpers(): () => void {
	const prototype = HTMLElement.prototype;
	const originalAddClass = prototype.addClass;
	const originalRemoveClass = prototype.removeClass;
	const originalToggleClass = prototype.toggleClass;
	prototype.addClass = function (...classes: string[]): void {
		this.classList.add(...classes);
	};
	prototype.removeClass = function (...classes: string[]): void {
		this.classList.remove(...classes);
	};
	prototype.toggleClass = function (className: string, value?: boolean): void {
		this.classList.toggle(className, value);
	};
	return () => {
		prototype.addClass = originalAddClass;
		prototype.removeClass = originalRemoveClass;
		prototype.toggleClass = originalToggleClass;
	};
}

function liveRoot(container: HTMLElement): HTMLElement {
	const root = container.querySelector<HTMLElement>(".obsidian-custom-view-render");
	if (!root) throw new Error("Expected production live root");
	return root;
}

describe("Bot 4 Live Preview source currentness", () => {
	it("promotes same-state unsaved A→B while identical source remains zero-work and DOM state stays stable", async () => {
		const restoreDom = installObsidianDomHelpers();
		try {
			const file = createFile("Notes/Bot4-Live-A-B.md");
			const config = createConfig();
			const app = createApp(file);
			let source = "---\nshow: true\n---\nUnsaved A";
			const view = createView(file, () => source);
			const internals = createPlugin(app, file, config);
			const dependencyAuthorities: string[] = [];
			internals.commitRuntimeDependencies = vi.fn(() => {
				dependencyAuthorities.push(liveRoot(view.contentEl).textContent ?? "");
			});

			await internals.renderMarkdownView(view, file, true);
			const controller = internals.markdownControllers?.get(view);
			if (!controller) throw new Error("Expected Markdown controller");
			const generationA = controller.currentGeneration;
			const stableStateKey = `${file.path}::${config.id}::livepreview::0`;
			expect(view.contentEl.getAttribute("data-cv-state")).toBe(stableStateKey);
			expect(liveRoot(view.contentEl).textContent).toContain("Unsaved A");

			await internals.renderMarkdownView(view, file, false);
			expect(controller.currentGeneration).toBe(generationA);
			expect(dependencyAuthorities).toHaveLength(1);

			source = "---\nshow: true\n---\nUnsaved B";
			await internals.renderMarkdownView(view, file, false);

			expect(controller.currentGeneration).toBeGreaterThan(generationA);
			expect(view.contentEl.getAttribute("data-cv-state")).toBe(stableStateKey);
			expect(liveRoot(view.contentEl).textContent).toContain("Unsaved B");
			expect(liveRoot(view.contentEl).textContent).not.toContain("Unsaved A");
			expect(liveRoot(view.contentEl).textContent).not.toContain("Persisted body");
			expect(dependencyAuthorities).toHaveLength(2);
			expect(dependencyAuthorities[1]).toContain("Unsaved B");
			internals.markdownControllers?.dispose();
		} finally {
			restoreDom();
		}
	});

	it("lets B supersede a pending A through the real queue coalescer without stale publication/adoption", async () => {
		const restoreDom = installObsidianDomHelpers();
		try {
			const file = createFile("Notes/Bot4-Live-Pending.md");
			const config = createConfig();
			const app = createApp(file);
			let source = "---\nshow: true\n---\nPending A";
			const view = createView(file, () => source);
			const internals = createPlugin(app, file, config);
			const originalPrepare = internals.prepareMarkdownRender.bind(internals);
			const startedA = deferred<void>();
			const releaseA = deferred<void>();
			const committedB = deferred<void>();
			const dependencyAuthorities: string[] = [];

			internals.markdownControllers = new RenderControllerRegistry((owner) => {
				return async (input, context) => {
					if (input.sourceContent?.includes("Pending A")) {
						startedA.resolve();
						await releaseA.promise;
					}
					return originalPrepare(owner, input, context);
				};
			});
			internals.commitRuntimeDependencies = vi.fn(() => {
				const authority = liveRoot(view.contentEl).textContent ?? "";
				dependencyAuthorities.push(authority);
				if (authority.includes("Pending B")) committedB.resolve();
			});

			const renderA = internals.renderMarkdownView(view, file, true);
			await startedA.promise;
			const controller = internals.markdownControllers?.get(view);
			if (!controller) throw new Error("Expected pending Markdown controller");
			const generationA = controller.currentGeneration;
			const pendingAKey = controller.currentPendingKey;
			expect(pendingAKey).toContain("::source:1");

			source = "---\nshow: true\n---\nPending B";
			internals.queueMarkdownView(view, file);
			await committedB.promise;

			expect(controller.currentGeneration).toBeGreaterThan(generationA);
			expect(controller.currentPendingKey).toBeNull();
			expect(liveRoot(view.contentEl).textContent).toContain("Pending B");
			expect(liveRoot(view.contentEl).textContent).not.toContain("Pending A");
			expect(dependencyAuthorities).toHaveLength(1);
			expect(dependencyAuthorities[0]).toContain("Pending B");

			releaseA.resolve();
			await renderA;
			expect(liveRoot(view.contentEl).textContent).toContain("Pending B");
			expect(dependencyAuthorities).toHaveLength(1);
			internals.markdownControllers?.dispose();
		} finally {
			restoreDom();
		}
	});

	it("registers the real editor-change event and routes a MarkdownView owner into its queue", async () => {
		const file = createFile("Notes/Bot4-Live-Event.md");
		const config = createConfig();
		const app = createApp(file);
		const handlers: { editorChange?: (editor: unknown, info: unknown) => void } = {};
		const workspace = app.workspace as unknown as {
			on: (event: string, callback: (...args: unknown[]) => void) => unknown;
			onLayoutReady: (callback: () => void) => void;
			iterateAllLeaves: (callback: (leaf: unknown) => void) => void;
		};
		workspace.on = vi.fn((event: string, callback: (...args: unknown[]) => void) => {
			if (event === "editor-change") {
				handlers.editorChange = (editor, info) => callback(editor, info);
			}
			return {};
		});
		workspace.onLayoutReady = vi.fn();
		workspace.iterateAllLeaves = vi.fn();
		const vault = app.vault as unknown as {
			on: (event: string, callback: (...args: unknown[]) => void) => unknown;
		};
		vault.on = vi.fn(() => ({}));
		const metadataCache = app.metadataCache as unknown as {
			on: (event: string, callback: (...args: unknown[]) => void) => unknown;
		};
		metadataCache.on = vi.fn(() => ({}));

		const internals = createPlugin(app, file, config);
		internals.loadSettings = vi.fn(async () => undefined);
		internals.addSettingTab = vi.fn();
		internals.addCommand = vi.fn();
		internals.registerEvent = vi.fn();
		const queue = vi.fn();
		internals.queueMarkdownView = queue;

		await internals.onload();
		const installedEditorChange = handlers.editorChange;
		if (!installedEditorChange) throw new Error("Expected editor-change handler");
		const view = createView(file, () => "Unsaved event source");
		installedEditorChange({}, view);
		expect(queue).toHaveBeenCalledTimes(1);
		expect(queue).toHaveBeenCalledWith(view, file);
		internals.markdownControllers?.dispose();
	});
});
