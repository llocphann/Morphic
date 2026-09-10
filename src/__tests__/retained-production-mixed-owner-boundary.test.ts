import {
	Component,
	MarkdownRenderer,
	MarkdownView,
	TFile,
	type App,
} from "obsidian";
import { describe, expect, it, vi } from "vitest";
import CustomViewsPlugin from "../main";
import { DEFAULT_SETTINGS } from "../settings";
import {
	InvalidationEngine,
	ReactiveDataCore,
	RenderScope,
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

interface CanvasNodeFixture {
	file: TFile;
	nodeEl: HTMLElement;
}

interface MarkdownInput {
	view: MarkdownView;
	file: TFile;
	matchedConfig: ViewConfig;
	mode: "preview";
	stateKey: string;
	requestKey?: string;
	sourceContent?: string;
}

interface CanvasInput {
	node: CanvasNodeFixture;
	file: TFile;
	container: HTMLElement;
	matchedConfig: ViewConfig | null;
	isSchedulerCurrent: () => boolean;
	stateKey: string;
}

type TestOwner = MarkdownView | CanvasNodeFixture;

interface ProductionInternals {
	settingsVersion: number;
	nextScopeId: number;
	scopeIds: WeakMap<HTMLElement, string>;
	editableStates: WeakMap<HTMLElement, unknown>;
	compartments: WeakMap<object, unknown>;
	canvasOwners: Map<unknown, unknown>;
	runtimeDataInvalidation: InvalidationEngine<TestOwner> | null;
	runtimeDataCore: ReactiveDataCore<TestOwner> | null;
	findMatchedConfig(file: TFile): ViewConfig | null;
	prepareMarkdownRender(
		owner: MarkdownView,
		input: MarkdownInput,
		context: RenderPreparationContext,
	): Promise<RenderTransaction>;
	buildCanvasRenderInput(node: CanvasNodeFixture): CanvasInput | null;
	prepareCanvasRender(
		owner: CanvasNodeFixture,
		input: CanvasInput,
		context: RenderPreparationContext,
	): Promise<RenderTransaction>;
	commitRuntimeDependencies(owner: TestOwner, dependencies: Iterable<unknown>): void;
	restoreDefaultView(view: MarkdownView): void;
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

function createConfig(id: string = "bot4-mixed-owner"): ViewConfig {
	return {
		id,
		name: id,
		rules: { type: "group", operator: "AND", conditions: [] },
		template: "<article><h2>Shell</h2>{% if show %}<i>Before</i>{{ title | markdown }}{{ content }}<strong>After</strong>{% else %}<span>Off</span>{% endif %}<footer>Tail</footer></article>",
	};
}

function createApp(
	file: TFile,
	frontmatter: Record<string, unknown> = { show: true, title: "Alpha" },
): { app: App; openLinkText: ReturnType<typeof vi.fn> } {
	const openLinkText = vi.fn(async () => undefined);
	const app = {
		metadataCache: {
			getFileCache(target: TFile) {
				if (target !== file) return null;
				return { frontmatter, tags: [], links: [], embeds: [] };
			},
			getFirstLinkpathDest() {
				return null;
			},
		},
		vault: {
			cachedRead: vi.fn(async () => "Body source"),
			getMarkdownFiles: () => [file],
		},
		workspace: { openLinkText },
	} as unknown as App;
	return { app, openLinkText };
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
	internals.findMatchedConfig = () => config;
	const invalidation = new InvalidationEngine<TestOwner>(() => undefined);
	const core = new ReactiveDataCore<TestOwner>(app, invalidation);
	core.bootstrap([file]);
	internals.runtimeDataInvalidation = invalidation;
	internals.runtimeDataCore = core;
	return internals;
}

function createView(file: TFile, ownerDocument: Document = document): MutableMarkdownView {
	const view = Object.create(MarkdownView.prototype) as MutableMarkdownView;
	view.file = file;
	view.contentEl = ownerDocument.createElement("div");
	view.getState = () => ({ mode: "preview", source: false });
	view.getViewData = () => "";
	return view;
}

function createCanvasNode(file: TFile): { node: CanvasNodeFixture; container: HTMLElement } {
	const nodeEl = document.createElement("div");
	const container = document.createElement("div");
	container.classList.add("markdown-preview-view");
	nodeEl.appendChild(container);
	return { node: { file, nodeEl }, container };
}

function markdownInput(file: TFile, view: MarkdownView, config: ViewConfig): MarkdownInput {
	return {
		view,
		file,
		matchedConfig: config,
		mode: "preview",
		stateKey: `${file.path}::${config.id}::preview::0`,
	};
}

function prepareContext(generation: number): { scope: RenderScope; context: RenderPreparationContext } {
	const scope = new RenderScope();
	Object.defineProperty(scope, "registerDomEvent", {
		value: (target: EventTarget, type: string, listener: EventListenerOrEventListenerObject): void => {
			target.addEventListener(type, listener);
			scope.registerDisposer(() => target.removeEventListener(type, listener));
		},
		configurable: true,
	});
	scope.load();
	return { scope, context: { generation, scope, signal: scope.signal } };
}

function commit(transaction: RenderTransaction): void {
	expect(transaction.isValid?.()).not.toBe(false);
	transaction.commit();
}

function liveRoot(container: HTMLElement): HTMLElement {
	const root = container.querySelector<HTMLElement>(".obsidian-custom-view-render");
	if (!root) throw new Error("Expected production custom-view root");
	return root;
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

function installMarkdownRenderer() {
	return vi.spyOn(MarkdownRenderer, "render").mockImplementation(async (_app, markdown, element) => {
		element.textContent = markdown;
	});
}

describe("Bot 4 mixed conditional production owner boundary", () => {
	it("retains exact Markdown and Canvas owner/static identity across equivalent mixed refreshes", async () => {
		const restoreDom = installObsidianDomHelpers();
		const render = installMarkdownRenderer();
		try {
			const markdownFile = createFile("Notes/Bot4-Mixed-Markdown.md");
			const markdownConfig = createConfig("bot4-markdown-identity");
			const markdownFixture = createApp(markdownFile);
			const markdownInternals = createPlugin(markdownFixture.app, markdownFile, markdownConfig);
			const view = createView(markdownFile);
			const input = markdownInput(markdownFile, view, markdownConfig);

			const markdownFirst = prepareContext(1);
			commit(await markdownInternals.prepareMarkdownRender(view, input, markdownFirst.context));
			const firstMarkdownRoot = liveRoot(view.contentEl);
			const firstArticle = firstMarkdownRoot.querySelector("article");
			const firstBefore = firstMarkdownRoot.querySelector("i");
			const firstFooter = firstMarkdownRoot.querySelector("footer");

			const markdownSecond = prepareContext(2);
			commit(await markdownInternals.prepareMarkdownRender(view, input, markdownSecond.context));
			expect(liveRoot(view.contentEl)).toBe(firstMarkdownRoot);
			expect(firstMarkdownRoot.querySelector("article")).toBe(firstArticle);
			expect(firstMarkdownRoot.querySelector("i")).toBe(firstBefore);
			expect(firstMarkdownRoot.querySelector("footer")).toBe(firstFooter);

			const canvasFile = createFile("Notes/Bot4-Mixed-Canvas.md");
			const canvasConfig = createConfig("bot4-canvas-identity");
			const canvasFixture = createApp(canvasFile);
			const canvasInternals = createPlugin(canvasFixture.app, canvasFile, canvasConfig);
			const { node, container } = createCanvasNode(canvasFile);
			const canvasInput = canvasInternals.buildCanvasRenderInput(node);
			if (!canvasInput) throw new Error("Expected Canvas input");

			const canvasFirst = prepareContext(1);
			commit(await canvasInternals.prepareCanvasRender(node, canvasInput, canvasFirst.context));
			const firstCanvasRoot = liveRoot(container);
			const firstCanvasArticle = firstCanvasRoot.querySelector("article");
			const firstCanvasBefore = firstCanvasRoot.querySelector("i");
			const firstCanvasFooter = firstCanvasRoot.querySelector("footer");

			const nextCanvasInput = canvasInternals.buildCanvasRenderInput(node);
			if (!nextCanvasInput) throw new Error("Expected next Canvas input");
			const canvasSecond = prepareContext(2);
			commit(await canvasInternals.prepareCanvasRender(node, nextCanvasInput, canvasSecond.context));
			expect(liveRoot(container)).toBe(firstCanvasRoot);
			expect(firstCanvasRoot.querySelector("article")).toBe(firstCanvasArticle);
			expect(firstCanvasRoot.querySelector("i")).toBe(firstCanvasBefore);
			expect(firstCanvasRoot.querySelector("footer")).toBe(firstCanvasFooter);

			markdownFirst.scope.dispose();
			markdownSecond.scope.dispose();
			canvasFirst.scope.dispose();
			canvasSecond.scope.dispose();
		} finally {
			render.mockRestore();
			restoreDom();
		}
	});

	it("keeps LKG and dependency authority when later mixed island preparation fails", async () => {
		const restoreDom = installObsidianDomHelpers();
		const render = installMarkdownRenderer();
		try {
			const file = createFile("Notes/Bot4-Mixed-LKG.md");
			const config = createConfig("bot4-mixed-lkg");
			const fixture = createApp(file);
			const internals = createPlugin(fixture.app, file, config);
			const view = createView(file);
			const input = markdownInput(file, view, config);
			const dependencyCommits = vi.fn(() => {
				expect(liveRoot(view.contentEl).parentElement).toBe(view.contentEl);
				expect(view.contentEl.getAttribute("data-cv-state")).toBe(input.stateKey);
			});
			internals.commitRuntimeDependencies = dependencyCommits;

			const first = prepareContext(1);
			commit(await internals.prepareMarkdownRender(view, input, first.context));
			const firstRoot = liveRoot(view.contentEl);
			const firstHtml = firstRoot.innerHTML;
			expect(dependencyCommits).toHaveBeenCalledTimes(1);

			render.mockClear();
			render
				.mockImplementationOnce(async (_app, markdown, element) => {
					element.textContent = markdown;
				})
				.mockRejectedValueOnce(new Error("bot4 content staging failed"));

			const second = prepareContext(2);
			await expect(internals.prepareMarkdownRender(view, input, second.context))
				.rejects.toThrow("bot4 content staging failed");
			expect(liveRoot(view.contentEl)).toBe(firstRoot);
			expect(firstRoot.innerHTML).toBe(firstHtml);
			expect(dependencyCommits).toHaveBeenCalledTimes(1);
			first.scope.dispose();
			second.scope.dispose();
		} finally {
			render.mockRestore();
			restoreDom();
		}
	});

	it("binds mixed islands and owner links to the exact foreign owner document/source path", async () => {
		const restoreDom = installObsidianDomHelpers();
		const foreignDocument = document.implementation.createHTMLDocument("bot4-popout");
		const renderSources: string[] = [];
		const renderDocuments: Document[] = [];
		const render = vi.spyOn(MarkdownRenderer, "render").mockImplementation(async (_app, markdown, element, sourcePath) => {
			renderSources.push(sourcePath);
			renderDocuments.push(element.ownerDocument);
			const link = element.ownerDocument.createElement("a");
			link.classList.add("internal-link");
			link.setAttribute("data-href", "./Child");
			link.textContent = markdown;
			element.appendChild(link);
		});
		try {
			const file = createFile("Folder/Bot4-Popout.md");
			const config = createConfig("bot4-popout-affinity");
			const fixture = createApp(file);
			const internals = createPlugin(fixture.app, file, config);
			const view = createView(file, foreignDocument);
			const input = markdownInput(file, view, config);
			const first = prepareContext(1);
			commit(await internals.prepareMarkdownRender(view, input, first.context));

			const root = liveRoot(view.contentEl);
			expect(root.ownerDocument).toBe(foreignDocument);
			expect(renderSources).toEqual([file.path, file.path]);
			expect(renderDocuments).toEqual([foreignDocument, foreignDocument]);
			const link = root.querySelector<HTMLElement>(".internal-link");
			if (!link) throw new Error("Expected mixed rendered internal link");
			link.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			expect(fixture.openLinkText).toHaveBeenCalledWith("./Child", file.path, false);
			first.scope.dispose();
		} finally {
			render.mockRestore();
			restoreDom();
		}
	});

	it("owns committed mixed island components through owner teardown and disposes them once", async () => {
		const restoreDom = installObsidianDomHelpers();
		const render = installMarkdownRenderer();
		const originalUnload = Component.prototype.unload;
		const islandUnloads: Component[] = [];
		const unload = vi.spyOn(Component.prototype, "unload").mockImplementation(function (this: Component) {
			if (!(this instanceof RenderScope)) islandUnloads.push(this);
			return originalUnload.call(this);
		});
		try {
			const file = createFile("Notes/Bot4-Mixed-Resources.md");
			const config = createConfig("bot4-mixed-resources");
			const fixture = createApp(file);
			const internals = createPlugin(fixture.app, file, config);
			const view = createView(file);
			const input = markdownInput(file, view, config);
			const first = prepareContext(1);
			commit(await internals.prepareMarkdownRender(view, input, first.context));
			expect(islandUnloads).toHaveLength(0);

			internals.restoreDefaultView(view);
			expect(islandUnloads).toHaveLength(2);
			internals.restoreDefaultView(view);
			expect(islandUnloads).toHaveLength(2);
			first.scope.dispose();
		} finally {
			unload.mockRestore();
			render.mockRestore();
			restoreDom();
		}
	});
});
