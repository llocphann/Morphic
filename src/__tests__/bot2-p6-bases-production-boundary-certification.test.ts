import {
	MarkdownView,
	TFile,
	type App,
} from "obsidian";
import { describe, expect, it, vi } from "vitest";
import type {
	BasesDataProvider,
	EmbeddedBasesRequest,
	TemplateBases,
} from "../bases/types";
import {
	InvalidationEngine,
	ReactiveDataCore,
	RenderScope,
	propertyDataDependencyKey,
	type DependencyKey,
	type RenderPreparationContext,
	type RenderTransaction,
} from "../core";
import CustomViewsPlugin from "../main";
import { DEFAULT_SETTINGS } from "../settings";
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
	mode: "preview" | "livepreview";
	stateKey: string;
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

interface ProductionPreparerInternals {
	settingsVersion: number;
	nextScopeId: number;
	scopeIds: WeakMap<HTMLElement, string>;
	editableStates: WeakMap<HTMLElement, unknown>;
	compartments: WeakMap<object, unknown>;
	canvasOwners: Map<unknown, unknown>;
	basesProvider: BasesDataProvider | undefined;
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
	commitRuntimeDependencies(owner: TestOwner, dependencies: Iterable<DependencyKey>): void;
}

function createFile(path: string): TFile {
	const file = new TFile();
	file.path = path;
	file.name = path.split("/").pop() ?? path;
	file.basename = file.name.replace(/\.md$/i, "");
	file.extension = "md";
	Object.defineProperty(file, "parent", {
		value: { path: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "" },
		configurable: true,
	});
	file.stat = { ctime: 1, mtime: 2, size: 3 };
	return file;
}

function createBases(): TemplateBases {
	return [{
		key: "RowsKey",
		name: "Rows",
		type: "table",
		index: 0,
		source: {
			kind: "code-block",
			index: 0,
			line: 1,
			name: "RowsSource",
		},
		columns: [],
		rows: [],
		rowCount: 7,
	}];
}

function createConfig(
	id: string,
	template = [
		"<article>",
		"{{bases.Rows.rowCount}}|",
		"{{baseViews.RowsKey.name}}|",
		"{{file.bases.RowsSource.rowCount}}|",
		"{{file.baseViews.Rows.name}}|",
		"{{file(\"Linked\").bases}}",
		"</article>",
	].join(""),
): ViewConfig {
	return {
		id,
		name: id,
		rules: { type: "group", operator: "AND", conditions: [] },
		template,
	};
}

function baseSource(label: string): string {
	return [
		`# ${label}`,
		"```base",
		"filters:",
		'  - status == "open"',
		"views:",
		"  - type: table",
		"    name: Rows",
		"```",
	].join("\n");
}

function createAppFixture(options: {
	file: TFile;
	persistedSource: string;
	frontmatter?: Record<string, unknown>;
	linkedFile?: TFile;
	linkedFrontmatter?: Record<string, unknown>;
}): App {
	const linkedFile = options.linkedFile ?? createFile("People/Linked.md");
	return {
		metadataCache: {
			getFileCache(target: TFile) {
				if (target === options.file) {
					return {
						frontmatter: options.frontmatter ?? {},
						tags: [],
						links: [],
						embeds: [],
					};
				}
				if (target === linkedFile) {
					return {
						frontmatter: options.linkedFrontmatter ?? {},
						tags: [],
						links: [],
						embeds: [],
					};
				}
				return null;
			},
			getFirstLinkpathDest(target: string) {
				return target === "Linked" ? linkedFile : null;
			},
		},
		vault: {
			cachedRead: vi.fn(async (target: TFile) =>
				target === options.file ? options.persistedSource : ""),
			getMarkdownFiles: () => [options.file, linkedFile],
		},
		workspace: {},
	} as unknown as App;
}

function createProvider(options: {
	bases?: TemplateBases;
	dependency?: DependencyKey;
} = {}): {
	provider: BasesDataProvider;
	getEmbeddedBases: ReturnType<typeof vi.fn>;
} {
	const bases = options.bases ?? createBases();
	const getEmbeddedBases = vi.fn(async (request: EmbeddedBasesRequest) => {
		if (options.dependency) request.dependencyCollector?.track(options.dependency);
		return bases;
	});
	return {
		provider: { getEmbeddedBases },
		getEmbeddedBases,
	};
}

function createPlugin(
	app: App,
	file: TFile,
	config: ViewConfig,
	basesProvider: BasesDataProvider,
): ProductionPreparerInternals {
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
	internals.basesProvider = basesProvider;
	internals.findMatchedConfig = () => config;
	const invalidation = new InvalidationEngine<TestOwner>(() => undefined);
	const core = new ReactiveDataCore<TestOwner>(app, invalidation);
	core.bootstrap([file]);
	internals.runtimeDataInvalidation = invalidation;
	internals.runtimeDataCore = core;
	return internals;
}

function createView(
	file: TFile,
	mode: "preview" | "livepreview" = "preview",
	liveSource = "",
	ownerDocument: Document = document,
): MutableMarkdownView {
	const view = Object.create(MarkdownView.prototype) as MutableMarkdownView;
	view.file = file;
	view.contentEl = ownerDocument.createElement("div");
	view.getState = () => mode === "livepreview"
		? { mode: "source", source: false }
		: { mode: "preview", source: false };
	view.getViewData = () => liveSource;
	return view;
}

function createCanvasNode(
	file: TFile,
	ownerDocument: Document = document,
): { node: CanvasNodeFixture; container: HTMLElement } {
	const nodeEl = ownerDocument.createElement("div");
	const container = ownerDocument.createElement("div");
	container.classList.add("markdown-preview-view");
	nodeEl.appendChild(container);
	return { node: { file, nodeEl }, container };
}

function markdownInput(
	file: TFile,
	view: MutableMarkdownView,
	config: ViewConfig,
	mode: "preview" | "livepreview" = "preview",
	sourceContent?: string,
): MarkdownInput {
	return {
		view,
		file,
		matchedConfig: config,
		mode,
		stateKey: `${file.path}::${config.id}::${mode}::0`,
		...(sourceContent === undefined ? {} : { sourceContent }),
	};
}

function prepareContext(generation: number): {
	scope: RenderScope;
	context: RenderPreparationContext;
} {
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

function commit(transaction: RenderTransaction): void {
	expect(transaction.isValid?.()).not.toBe(false);
	transaction.commit();
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
	if (!root) throw new Error("Expected production custom-view root");
	return root;
}

function expectProviderRequest(
	request: EmbeddedBasesRequest,
	file: TFile,
	sourceContent: string,
	ownerDocument: Document,
): void {
	expect(request.file).toBe(file);
	expect(request.sourceContent).toBe(sourceContent);
	expect(request.ownerDocument).toBe(ownerDocument);
	expect(request.dependencyCollector).toBeDefined();
}

describe("Bot 2 P6 Bases production-boundary certification preparation", () => {
	it("binds persisted Bases through the real Markdown owner path", async () => {
		const restoreDom = installObsidianDomHelpers();
		try {
			const file = createFile("Notes/P6-Bases-Markdown.md");
			const persistedSource = baseSource("persisted markdown");
			const linkedFile = createFile("People/Linked.md");
			const app = createAppFixture({
				file,
				persistedSource,
				linkedFile,
				linkedFrontmatter: { bases: "linked-bases" },
			});
			const config = createConfig("p6-bases-markdown");
			const providerFixture = createProvider();
			const internals = createPlugin(app, file, config, providerFixture.provider);
			const view = createView(file);
			const prepared = prepareContext(1);

			commit(await internals.prepareMarkdownRender(
				view,
				markdownInput(file, view, config),
				prepared.context,
			));

			expect(liveRoot(view.contentEl).textContent).toBe("7|Rows|7|Rows|linked-bases");
			expect(providerFixture.getEmbeddedBases).toHaveBeenCalledTimes(1);
			expectProviderRequest(
				providerFixture.getEmbeddedBases.mock.calls[0][0] as EmbeddedBasesRequest,
				file,
				persistedSource,
				view.contentEl.ownerDocument,
			);
			prepared.scope.dispose();
		} finally {
			restoreDom();
		}
	});

	it("uses unsaved Live Preview source as the Bases source authority", async () => {
		const restoreDom = installObsidianDomHelpers();
		try {
			const file = createFile("Notes/P6-Bases-Live.md");
			const persistedSource = "# Persisted source without Bases";
			const liveSource = baseSource("unsaved live source");
			const app = createAppFixture({ file, persistedSource });
			const config = createConfig(
				"p6-bases-live",
				"<article>{{bases.Rows.rowCount}}</article>",
			);
			const providerFixture = createProvider();
			const internals = createPlugin(app, file, config, providerFixture.provider);
			const view = createView(file, "livepreview", liveSource);
			const prepared = prepareContext(1);

			commit(await internals.prepareMarkdownRender(
				view,
				markdownInput(file, view, config, "livepreview", liveSource),
				prepared.context,
			));

			expect(liveRoot(view.contentEl).textContent).toBe("7");
			expect(providerFixture.getEmbeddedBases).toHaveBeenCalledTimes(1);
			expectProviderRequest(
				providerFixture.getEmbeddedBases.mock.calls[0][0] as EmbeddedBasesRequest,
				file,
				liveSource,
				view.contentEl.ownerDocument,
			);
			expect(app.vault.cachedRead).not.toHaveBeenCalled();
			prepared.scope.dispose();
		} finally {
			restoreDom();
		}
	});

	it("binds persisted Bases through the real Canvas owner path and adopts provider dependencies on commit", async () => {
		const restoreDom = installObsidianDomHelpers();
		try {
			const file = createFile("Notes/P6-Bases-Canvas.md");
			const persistedSource = baseSource("persisted canvas");
			const app = createAppFixture({ file, persistedSource });
			const config = createConfig(
				"p6-bases-canvas",
				"<article>{{file.bases.Rows.rowCount}}|{{baseViews.Rows.name}}</article>",
			);
			const dependency = propertyDataDependencyKey("status");
			const providerFixture = createProvider({ dependency });
			const internals = createPlugin(app, file, config, providerFixture.provider);
			const dependencyCommits = vi.fn();
			internals.commitRuntimeDependencies = dependencyCommits;
			const { node, container } = createCanvasNode(file);
			const input = internals.buildCanvasRenderInput(node);
			if (!input) throw new Error("Expected Canvas render input");
			const prepared = prepareContext(1);

			const transaction = await internals.prepareCanvasRender(node, input, prepared.context);
			expect(dependencyCommits).not.toHaveBeenCalled();
			commit(transaction);

			expect(liveRoot(container).textContent).toBe("7|Rows");
			expect(providerFixture.getEmbeddedBases).toHaveBeenCalledTimes(1);
			expectProviderRequest(
				providerFixture.getEmbeddedBases.mock.calls[0][0] as EmbeddedBasesRequest,
				file,
				persistedSource,
				container.ownerDocument,
			);
			expect(dependencyCommits).toHaveBeenCalledTimes(1);
			const committedDependencies = Array.from(
				dependencyCommits.mock.calls[0][1] as Iterable<DependencyKey>,
			);
			expect(committedDependencies).toContain(dependency);
			prepared.scope.dispose();
		} finally {
			restoreDom();
		}
	});

	it("materializes empty built-in Bases when production has no Base source", async () => {
		const restoreDom = installObsidianDomHelpers();
		try {
			const file = createFile("Notes/P6-Bases-No-Source.md");
			const persistedSource = "# Plain note";
			const app = createAppFixture({
				file,
				persistedSource,
				frontmatter: {
					bases: "frontmatter-bases",
					baseViews: "frontmatter-views",
				},
			});
			const config = createConfig(
				"p6-bases-no-source",
				"<article>{{bases}}|{{baseViews}}</article>",
			);
			const providerFixture = createProvider();
			const internals = createPlugin(app, file, config, providerFixture.provider);
			const view = createView(file);
			const prepared = prepareContext(1);

			commit(await internals.prepareMarkdownRender(
				view,
				markdownInput(file, view, config),
				prepared.context,
			));

			expect(liveRoot(view.contentEl).textContent).toBe("|");
			expect(providerFixture.getEmbeddedBases).not.toHaveBeenCalled();
			prepared.scope.dispose();
		} finally {
			restoreDom();
		}
	});
});
