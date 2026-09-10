import { MarkdownView, TFile, type App } from "obsidian";
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

interface ProductionPreparerInternals {
	settingsVersion: number;
	nextScopeId: number;
	scopeIds: WeakMap<HTMLElement, string>;
	editableStates: WeakMap<HTMLElement, unknown>;
	compartments: WeakMap<object, unknown>;
	canvasOwners: Map<unknown, unknown>;
	runtimeDataInvalidation: InvalidationEngine<TestOwner> | null;
	runtimeDataCore: ReactiveDataCore<TestOwner> | null;
	findMatchedConfig(file: TFile): ViewConfig | null;
	prepareMarkdownRender(owner: MarkdownView, input: MarkdownInput, context: RenderPreparationContext): Promise<RenderTransaction>;
	buildCanvasRenderInput(node: CanvasNodeFixture): CanvasInput | null;
	prepareCanvasRender(owner: CanvasNodeFixture, input: CanvasInput, context: RenderPreparationContext): Promise<RenderTransaction>;
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

function createIfConfig(): ViewConfig {
	return {
		id: "structural-if-release-view",
		name: "Structural if release view",
		rules: { type: "group", operator: "AND", conditions: [] },
		template: "<article>{% if true %}<span>Stable</span>{% else %}<span>Other</span>{% endif %}<b>Tail</b></article>",
	};
}

function createForConfig(): ViewConfig {
	return {
		id: "structural-for-release-view",
		name: "Structural for release view",
		rules: { type: "group", operator: "AND", conditions: [] },
		template: "<article>{% for item in items %}<span>{{ item }}</span>{% endfor %}<b>Tail</b></article>",
	};
}

function createApp(file: TFile, frontmatter: Record<string, unknown> = {}): App {
	return {
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
		workspace: { openLinkText: vi.fn(async () => undefined) },
	} as unknown as App;
}

function createPlugin(app: App, file: TFile, config: ViewConfig): ProductionPreparerInternals {
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
	const internals = plugin as unknown as ProductionPreparerInternals;
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

function createView(file: TFile): MutableMarkdownView {
	const view = Object.create(MarkdownView.prototype) as MutableMarkdownView;
	view.file = file;
	view.contentEl = document.createElement("div");
	view.getState = () => ({ mode: "preview", source: false });
	return view;
}

function createCanvasNode(file: TFile): { node: CanvasNodeFixture; container: HTMLElement } {
	const nodeEl = document.createElement("div");
	const container = document.createElement("div");
	container.classList.add("markdown-preview-view");
	nodeEl.appendChild(container);
	return { node: { file, nodeEl }, container };
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

function installObsidianDomHelpers(): () => void {
	const prototype = HTMLElement.prototype;
	const originalAddClass = prototype.addClass;
	const originalRemoveClass = prototype.removeClass;
	const originalToggleClass = prototype.toggleClass;
	prototype.addClass = function (...classes: string[]): void { this.classList.add(...classes); };
	prototype.removeClass = function (...classes: string[]): void { this.classList.remove(...classes); };
	prototype.toggleClass = function (className: string, value?: boolean): void { this.classList.toggle(className, value); };
	return () => {
		prototype.addClass = originalAddClass;
		prototype.removeClass = originalRemoveClass;
		prototype.toggleClass = originalToggleClass;
	};
}

function expectNodeListIdentity(current: Element[], previous: Element[]): void {
	expect(current).toHaveLength(previous.length);
	for (let index = 0; index < previous.length; index++) {
		expect(current[index]).toBe(previous[index]);
	}
}

async function assertMarkdownIdentity(config: ViewConfig, frontmatter: Record<string, unknown>, expectedSpans: string[]): Promise<void> {
	const file = createFile(`Notes/${config.id}.md`);
	const internals = createPlugin(createApp(file, frontmatter), file, config);
	const view = createView(file);
	const stateKey = `${file.path}::${config.id}::preview::0`;
	const input: MarkdownInput = { view, file, matchedConfig: config, mode: "preview", stateKey };

	const first = prepareContext(1);
	commit(await internals.prepareMarkdownRender(view, input, first.context));
	const firstRoot = view.contentEl.querySelector(".obsidian-custom-view-render");
	const firstArticle = firstRoot?.querySelector("article");
	const firstSpans = Array.from(firstRoot?.querySelectorAll("span") ?? []);
	const firstTail = firstRoot?.querySelector("b");
	expect(firstSpans.map(span => span.textContent)).toEqual(expectedSpans);

	const second = prepareContext(2);
	commit(await internals.prepareMarkdownRender(view, input, second.context));
	expect(view.contentEl.querySelector(".obsidian-custom-view-render")).toBe(firstRoot);
	expect(view.contentEl.querySelector("article")).toBe(firstArticle);
	expectNodeListIdentity(Array.from(view.contentEl.querySelectorAll("span")), firstSpans);
	expect(view.contentEl.querySelector("b")).toBe(firstTail);
	first.scope.dispose();
	second.scope.dispose();
}

async function assertCanvasIdentity(config: ViewConfig, frontmatter: Record<string, unknown>, expectedSpans: string[]): Promise<void> {
	const file = createFile(`Notes/Canvas-${config.id}.md`);
	const internals = createPlugin(createApp(file, frontmatter), file, config);
	const { node, container } = createCanvasNode(file);
	const input = internals.buildCanvasRenderInput(node);
	expect(input).not.toBeNull();
	if (!input) throw new Error("Expected Canvas render input");

	const first = prepareContext(1);
	commit(await internals.prepareCanvasRender(node, input, first.context));
	const firstRoot = container.querySelector(".obsidian-custom-view-render");
	const firstArticle = firstRoot?.querySelector("article");
	const firstSpans = Array.from(firstRoot?.querySelectorAll("span") ?? []);
	const firstTail = firstRoot?.querySelector("b");
	expect(firstSpans.map(span => span.textContent)).toEqual(expectedSpans);

	const secondInput = internals.buildCanvasRenderInput(node);
	expect(secondInput).not.toBeNull();
	if (!secondInput) throw new Error("Expected second Canvas render input");
	const second = prepareContext(2);
	commit(await internals.prepareCanvasRender(node, secondInput, second.context));
	expect(container.querySelector(".obsidian-custom-view-render")).toBe(firstRoot);
	expect(container.querySelector("article")).toBe(firstArticle);
	expectNodeListIdentity(Array.from(container.querySelectorAll("span")), firstSpans);
	expect(container.querySelector("b")).toBe(firstTail);
	first.scope.dispose();
	second.scope.dispose();
}

describe("Bot 5 P5 production structural owner authority", () => {
	it("retains Reading View DOM identity for a stable dependency-free if branch", async () => {
		const restoreDom = installObsidianDomHelpers();
		try {
			await assertMarkdownIdentity(createIfConfig(), {}, ["Stable"]);
		} finally {
			restoreDom();
		}
	});

	it("retains Reading View DOM identity for a stable structural for loop", async () => {
		const restoreDom = installObsidianDomHelpers();
		try {
			await assertMarkdownIdentity(createForConfig(), { items: ["One", "Two"] }, ["One", "Two"]);
		} finally {
			restoreDom();
		}
	});

	it("retains Canvas DOM identity for a stable dependency-free if branch", async () => {
		const restoreDom = installObsidianDomHelpers();
		try {
			await assertCanvasIdentity(createIfConfig(), {}, ["Stable"]);
		} finally {
			restoreDom();
		}
	});

	it("retains Canvas DOM identity for a stable structural for loop", async () => {
		const restoreDom = installObsidianDomHelpers();
		try {
			await assertCanvasIdentity(createForConfig(), { items: ["One", "Two"] }, ["One", "Two"]);
		} finally {
			restoreDom();
		}
	});
});
