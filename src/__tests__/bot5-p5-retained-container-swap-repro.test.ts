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

interface MarkdownInput {
	view: MarkdownView;
	file: TFile;
	matchedConfig: ViewConfig;
	mode: "preview";
	stateKey: string;
}

interface ProductionPreparerInternals {
	settingsVersion: number;
	nextScopeId: number;
	scopeIds: WeakMap<HTMLElement, string>;
	editableStates: WeakMap<HTMLElement, unknown>;
	compartments: WeakMap<object, unknown>;
	canvasOwners: Map<unknown, unknown>;
	runtimeDataInvalidation: InvalidationEngine<MarkdownView> | null;
	runtimeDataCore: ReactiveDataCore<MarkdownView> | null;
	findMatchedConfig(file: TFile): ViewConfig | null;
	prepareMarkdownRender(
		owner: MarkdownView,
		input: MarkdownInput,
		context: RenderPreparationContext,
	): Promise<RenderTransaction>;
}

function createFile(path: string): TFile {
	const file = new TFile();
	file.path = path;
	file.name = path.split("/").pop() ?? path;
	file.basename = file.name.replace(/\.md$/, "");
	file.extension = "md";
	Object.defineProperty(file, "parent", { value: { path: "Notes" }, configurable: true });
	file.stat = { ctime: 1, mtime: 2, size: 3 };
	return file;
}

function createConfig(): ViewConfig {
	return {
		id: "release-view",
		name: "Release view",
		rules: { type: "group", operator: "AND", conditions: [] },
		template: "<article><span>Stable</span></article>",
	};
}

function createApp(file: TFile): App {
	return {
		metadataCache: {
			getFileCache(target: TFile) {
				return target === file ? { frontmatter: {}, tags: [], links: [], embeds: [] } : null;
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
	const invalidation = new InvalidationEngine<MarkdownView>(() => undefined);
	const core = new ReactiveDataCore<MarkdownView>(app, invalidation);
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

function context(generation: number): { scope: RenderScope; value: RenderPreparationContext } {
	const scope = new RenderScope();
	Object.defineProperty(scope, "registerDomEvent", {
		value: (target: EventTarget, type: string, listener: EventListenerOrEventListenerObject): void => {
			target.addEventListener(type, listener);
			scope.registerDisposer(() => target.removeEventListener(type, listener));
		},
		configurable: true,
	});
	scope.load();
	return { scope, value: { generation, scope, signal: scope.signal } };
}

function installDomHelpers(): () => void {
	const prototype = HTMLElement.prototype;
	const add = prototype.addClass;
	const remove = prototype.removeClass;
	const toggle = prototype.toggleClass;
	prototype.addClass = function (...classes: string[]): void { this.classList.add(...classes); };
	prototype.removeClass = function (...classes: string[]): void { this.classList.remove(...classes); };
	prototype.toggleClass = function (className: string, value?: boolean): void { this.classList.toggle(className, value); };
	return () => {
		prototype.addClass = add;
		prototype.removeClass = remove;
		prototype.toggleClass = toggle;
	};
}

describe("Bot 5 P5 retained owner container swap safety", () => {
	it("does not remove the last-known-good retained surface during an uncommitted container replacement prepare", async () => {
		const restoreDom = installDomHelpers();
		try {
			const file = createFile("Notes/Test.md");
			const config = createConfig();
			const internals = createPlugin(createApp(file), file, config);
			const view = createView(file);
			const stateKey = `${file.path}::${config.id}::preview::0`;
			const input: MarkdownInput = { view, file, matchedConfig: config, mode: "preview", stateKey };

			const first = context(1);
			const committed = await internals.prepareMarkdownRender(view, input, first.value);
			expect(committed.isValid?.()).not.toBe(false);
			committed.commit();
			const previousContainer = view.contentEl;
			const previousRoot = previousContainer.querySelector(".obsidian-custom-view-render");
			expect(previousRoot).not.toBeNull();

			view.contentEl = document.createElement("div");
			const second = context(2);
			const pending = await internals.prepareMarkdownRender(view, { ...input, view }, second.value);

			// Preparation alone must not tear down the last committed owner surface.
			expect(previousContainer.querySelector(".obsidian-custom-view-render")).toBe(previousRoot);
			expect(previousRoot?.isConnected || previousRoot?.parentElement === previousContainer).toBe(true);

			pending.dispose?.();
			first.scope.dispose();
			second.scope.dispose();
		} finally {
			restoreDom();
		}
	});
});
