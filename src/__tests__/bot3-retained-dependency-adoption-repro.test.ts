import { MarkdownView, TFile, type App } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import CustomViewsPlugin from "../main";
import { DEFAULT_SETTINGS } from "../settings";
import {
	InvalidationEngine,
	ReactiveDataCore,
	RenderScope,
	dependencyKey,
	type RenderPreparationContext,
	type RenderTransaction,
} from "../core";
import { RetainedStaticOwnerSurfaceRegistry } from "../render/retained-static-owner-surface";
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

type TestOwner = MarkdownView | CanvasNodeFixture;

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

interface ProductionInternals {
	settingsVersion: number;
	nextScopeId: number;
	scopeIds: WeakMap<HTMLElement, string>;
	editableStates: WeakMap<HTMLElement, unknown>;
	compartments: WeakMap<object, unknown>;
	canvasOwners: Map<unknown, unknown>;
	runtimeDataInvalidation: InvalidationEngine<TestOwner> | null;
	runtimeDataCore: ReactiveDataCore<TestOwner> | null;
	retainedOwnerSurfaces: unknown;
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
		id: "retained-dependency-adoption",
		name: "Retained dependency adoption",
		rules: { type: "group", operator: "AND", conditions: [] },
		template: "<article><span>Stable</span></article>",
	};
}

function createApp(file: TFile): App {
	return {
		metadataCache: {
			getFileCache(target: TFile) {
				if (target !== file) return null;
				return { frontmatter: {}, tags: [], links: [], embeds: [] };
			},
			getFirstLinkpathDest() {
				return null;
			},
		},
		vault: {
			cachedRead: vi.fn(async () => "Body source"),
			getMarkdownFiles: () => [file],
		},
		workspace: {
			openLinkText: vi.fn(async () => undefined),
		},
	} as unknown as App;
}

function createView(file: TFile): MutableMarkdownView {
	const view = Object.create(MarkdownView.prototype) as MutableMarkdownView;
	view.file = file;
	view.contentEl = document.createElement("div");
	view.getState = () => ({ mode: "preview", source: false });
	return view;
}

function createPlugin(app: App, file: TFile, config: ViewConfig): {
	plugin: CustomViewsPlugin;
	internals: ProductionInternals;
	invalidation: InvalidationEngine<TestOwner>;
} {
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
	return { plugin, internals, invalidation };
}

function prepareContext(generation: number): { scope: RenderScope; context: RenderPreparationContext } {
	const scope = new RenderScope();
	Object.defineProperty(scope, "registerDomEvent", {
		value: (
			target: EventTarget,
			type: string,
			listener: EventListenerOrEventListenerObject,
		): void => {
			target.addEventListener(type, listener);
			scope.registerDisposer(() => target.removeEventListener(type, listener));
		},
		configurable: true,
	});
	scope.load();
	return { scope, context: { generation, scope, signal: scope.signal } };
}

function installRejectingSurfaceRegistry(
	internals: ProductionInternals,
): RetainedStaticOwnerSurfaceRegistry<TestOwner> {
	const backingRegistry = new RetainedStaticOwnerSurfaceRegistry<TestOwner>(
		"obsidian-custom-view-render",
	);
	internals.retainedOwnerSurfaces = {
		prepare(owner: TestOwner, container: HTMLElement) {
			const prepared = backingRegistry.prepare(owner, container);
			return {
				surface: prepared.surface,
				isCurrent: () => prepared.isCurrent(),
				commit: () => false,
				dispose: () => prepared.dispose(),
			};
		},
		release: (owner: TestOwner) => backingRegistry.release(owner),
		dispose: () => backingRegistry.dispose(),
	};
	return backingRegistry;
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

describe("Bot 3 retained dependency adoption transaction", () => {
	it("keeps Markdown last-known-good reverse edges when owner-surface adoption fails", async () => {
		const restoreDom = installObsidianDomHelpers();
		try {
			const file = createFile("Notes/Test.md");
			const config = createConfig();
			const { internals, invalidation } = createPlugin(createApp(file), file, config);
			const view = createView(file);
			const oldDependency = dependencyKey.file(file.path, "frontmatter", "last-good");
			invalidation.commitDependencies(view, [oldDependency]);
			expect(invalidation.index.dependenciesOf(view)).toEqual(new Set([oldDependency]));
			installRejectingSurfaceRegistry(internals);

			const stateKey = `${file.path}::${config.id}::preview::0`;
			const input: MarkdownInput = { view, file, matchedConfig: config, mode: "preview", stateKey };
			const preparedContext = prepareContext(2);
			const transaction = await internals.prepareMarkdownRender(view, input, preparedContext.context);
			expect(transaction.isValid?.()).not.toBe(false);

			expect(() => transaction.commit()).toThrow(
				"Retained Markdown owner surface authority changed before adoption",
			);
			transaction.dispose?.();

			// Failed surface adoption must preserve dependency ownership from the
			// last successful generation. A later successful commit may replace it.
			expect(invalidation.index.dependenciesOf(view)).toEqual(new Set([oldDependency]));
			preparedContext.scope.dispose();
		} finally {
			restoreDom();
		}
	});

	it("keeps Canvas last-known-good reverse edges when owner-surface adoption fails", async () => {
		const restoreDom = installObsidianDomHelpers();
		try {
			const file = createFile("Notes/Canvas.md");
			const config = createConfig();
			const { internals, invalidation } = createPlugin(createApp(file), file, config);
			const nodeEl = document.createElement("div");
			const container = document.createElement("div");
			container.classList.add("markdown-preview-view");
			nodeEl.appendChild(container);
			const node: CanvasNodeFixture = { file, nodeEl };
			const oldDependency = dependencyKey.file(file.path, "frontmatter", "last-good");
			invalidation.commitDependencies(node, [oldDependency]);
			expect(invalidation.index.dependenciesOf(node)).toEqual(new Set([oldDependency]));
			installRejectingSurfaceRegistry(internals);

			const input = internals.buildCanvasRenderInput(node);
			expect(input).not.toBeNull();
			if (!input) throw new Error("Expected Canvas render input");
			const preparedContext = prepareContext(2);
			const transaction = await internals.prepareCanvasRender(node, input, preparedContext.context);
			expect(transaction.isValid?.()).not.toBe(false);

			expect(() => transaction.commit()).toThrow(
				"Retained Canvas owner surface authority changed before adoption",
			);
			transaction.dispose?.();

			expect(invalidation.index.dependenciesOf(node)).toEqual(new Set([oldDependency]));
			preparedContext.scope.dispose();
		} finally {
			restoreDom();
		}
	});
});
