import { BasesEntry, TFile, type App } from "obsidian";

export type BasesFilter = string | { and: BasesFilter[] } | { or: BasesFilter[] } | { not: BasesFilter[] };

export interface ParsedFilter {
	serialize(): BasesFilter;
	hasError(): boolean;
	test(entry: BasesEntry): boolean;
}

interface NativeViewConfig { name: string }

export interface NativeQuery {
	filters?: ParsedFilter;
	views: NativeViewConfig[];
	saveFn?: () => void;
	getViewConfig(name: string): NativeViewConfig;
	setGlobalFilters(filters: BasesFilter | null): void;
}

export interface NativeBuilder {
	innerContainerEl: HTMLElement;
	root?: { children?: unknown[]; advancedInputEditor?: { destroy(): void } };
	updateQuery(save: (filters: BasesFilter | null) => void, view: NativeViewConfig, filters?: ParsedFilter): void;
}

export interface NativeController {
	query: NativeQuery;
	viewName: string;
	ctx: unknown;
	filterMenu: { globalFilterBuilder: NativeBuilder; toolbarItem?: { setOpen(open: boolean): void } };
	buildBasesContext(): unknown;
	unload(): void;
}

interface ParseReceiver {
	app: { vault: { read(): Promise<string> } };
	file: TFile;
	controller: NativeController;
	requestSave(): void;
}

interface NativeEmbed {
	controller: NativeController;
	loadQuery(this: ParseReceiver): Promise<NativeQuery>;
	unload(): void;
}

interface QueryConstructor { parse(data: unknown): NativeQuery }

type EmbedFactory = (
	context: { app: App; containerEl: HTMLElement; sourcePath: string; linktext: string },
	file: TFile,
	subpath: string,
) => NativeEmbed;

export interface NativeBasesApi {
	parse(filters: BasesFilter | null): NativeQuery;
	createEditor(host: HTMLElement, filters: BasesFilter | null, save: (filters: BasesFilter | null) => void): () => void;
	test(filter: ParsedFilter, file: TFile): boolean;
}

const apiByApp = new WeakMap<App, Promise<NativeBasesApi>>();

export function getNativeBasesApi(app: App): Promise<NativeBasesApi> {
	const existing = apiByApp.get(app);
	if (existing) return existing;

	const discovery = createBridge(app).catch(error => {
		apiByApp.delete(app);
		throw error;
	});
	apiByApp.set(app, discovery);
	return discovery;
}

async function createBridge(app: App): Promise<NativeBasesApi> {
	const factory = findEmbedFactory(app);
	if (!factory || typeof BasesEntry !== "function") {
		throw new Error("Enable Obsidian’s Bases core plugin to edit these filters.");
	}

	const probeFile = makeProbeFile();
	const Query = await discoverQueryConstructor(app, factory, probeFile);
	return new NativeBasesBridge(app, factory, probeFile, Query);
}

class NativeBasesBridge implements NativeBasesApi {
	constructor(
		private readonly app: App,
		private readonly factory: EmbedFactory,
		private readonly probeFile: TFile,
		private readonly Query: QueryConstructor,
	) {}

	parse(filters: BasesFilter | null): NativeQuery {
		return this.Query.parse({
			...(filters === null ? {} : { filters }),
			views: [{ type: "table", name: "Rules" }],
		});
	}

	test(filter: ParsedFilter, file: TFile): boolean {
		const Entry = BasesEntry as unknown as new (context: unknown, file: TFile) => BasesEntry;
		return filter.test(new Entry({ app: this.app, formulas: {}, local: null }, file));
	}

	createEditor(
		host: HTMLElement,
		filters: BasesFilter | null,
		save: (filters: BasesFilter | null) => void,
	): () => void {
		const session = new NativeFilterEditorSession(
			this.app,
			this.factory,
			this.probeFile,
			this.parse(filters),
			host,
			save,
		);
		session.mount();
		return () => session.dispose();
	}
}

class NativeFilterEditorSession {
	private embed: NativeEmbed | undefined;
	private builder: NativeBuilder | undefined;
	private internalHost: HTMLElement | undefined;
	private disposed = false;

	constructor(
		private readonly app: App,
		private readonly factory: EmbedFactory,
		private readonly file: TFile,
		private readonly query: NativeQuery,
		private readonly host: HTMLElement,
		private readonly save: (filters: BasesFilter | null) => void,
	) {}

	mount(): void {
		if (this.disposed || this.embed) return;
		const internalHost = this.host.ownerDocument.createElement("div");
		this.internalHost = internalHost;
		const embed = this.factory(
			{ app: this.app, containerEl: internalHost, sourcePath: "", linktext: "" },
			this.file,
			"",
		);
		this.embed = embed;

		try {
			const controller = embed.controller;
			const builder = controller?.filterMenu?.globalFilterBuilder;
			if (!builder) throw incompatibleEditorError();
			this.builder = builder;

			this.query.saveFn = () => {};
			controller.query = this.query;
			controller.viewName = "Rules";
			controller.ctx = controller.buildBasesContext();
			builder.updateQuery(filters => this.onChange(filters), this.query.getViewConfig("Rules"), this.query.filters);
			this.host.replaceChildren(builder.innerContainerEl);
		} catch (error) {
			this.dispose();
			throw error;
		}
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;

		const controller = this.embed?.controller;
		safely(() => controller?.filterMenu?.toolbarItem?.setOpen(false));
		destroyInputTree(this.builder?.root);
		safely(() => this.builder?.innerContainerEl.remove());
		safely(() => this.embed?.unload());
		this.internalHost?.remove();
		this.builder = undefined;
		this.embed = undefined;
		this.internalHost = undefined;
	}

	private onChange(filters: BasesFilter | null): void {
		if (this.disposed || !this.embed) return;
		this.query.setGlobalFilters(filters);
		this.embed.controller.ctx = this.embed.controller.buildBasesContext();
		this.save(filters);
	}
}

async function discoverQueryConstructor(
	app: App,
	factory: EmbedFactory,
	file: TFile,
): Promise<QueryConstructor> {
	const host = activeWindow.createDiv();
	const seed = factory({ app, containerEl: host, sourcePath: "", linktext: "" }, file, "");
	try {
		if (typeof seed.loadQuery !== "function" || !seed.controller?.filterMenu?.globalFilterBuilder) {
			throw incompatibleEditorError();
		}
		const receiver: ParseReceiver = {
			app: { vault: { read: () => Promise.resolve("") } },
			file,
			controller: seed.controller,
			requestSave() {},
		};
		const query = requireNativeQuery(await seed.loadQuery.call(receiver));
		query.saveFn = () => {};
		return queryConstructor(query);
	} finally {
		safely(() => seed.unload());
		host.remove();
	}
}

function findEmbedFactory(app: App): EmbedFactory | undefined {
	const registry = (app as App & {
		embedRegistry?: { embedByExtension?: Record<string, unknown> };
	}).embedRegistry;
	const candidate = registry?.embedByExtension?.base;
	return typeof candidate === "function" ? candidate as EmbedFactory : undefined;
}

function makeProbeFile(): TFile {
	const candidate: unknown = Object.create(TFile.prototype);
	if (!(candidate instanceof TFile)) throw new Error("Could not initialize native filters.");
	Object.assign(candidate, {
		path: "__morphic_rules__.base",
		name: "__morphic_rules__.base",
		basename: "__morphic_rules__",
		extension: "base",
	});
	return candidate;
}

function requireNativeQuery(value: unknown): NativeQuery {
	if (!isRecord(value)) throw new Error("The native Bases query object is unavailable.");
	if (!Array.isArray(value.views)
		|| typeof value.getViewConfig !== "function"
		|| typeof value.setGlobalFilters !== "function") {
		throw new Error("This Obsidian version returned an incompatible Bases query object.");
	}
	return value as unknown as NativeQuery;
}

function queryConstructor(query: NativeQuery): QueryConstructor {
	const prototype = Object.getPrototypeOf(query) as Record<string, unknown> | null;
	const Constructor = prototype?.constructor;
	if (typeof Constructor !== "function") {
		throw new Error("The native Bases query parser is unavailable.");
	}
	const parse = (Constructor as unknown as { parse?: unknown }).parse;
	if (typeof parse !== "function") {
		throw new Error("The native Bases query parser is unavailable.");
	}
	return Constructor as unknown as QueryConstructor;
}

function destroyInputTree(node: unknown): void {
	if (!isRecord(node)) return;
	const item = node as {
		children?: unknown[];
		advancedInputEditor?: { destroy(): void } | null;
		leftInputEl?: { close(): void };
		operatorComponent?: { close(): void };
	};
	safely(() => item.leftInputEl?.close());
	safely(() => item.operatorComponent?.close());
	safely(() => item.advancedInputEditor?.destroy());
	item.advancedInputEditor = null;
	for (const child of item.children ?? []) destroyInputTree(child);
}

function incompatibleEditorError(): Error {
	return new Error("This Obsidian version does not expose a compatible Bases filter editor.");
}

function safely(action: () => void): void {
	try {
		action();
	} catch (error) {
		console.error("[Morphic] native Bases cleanup failed:", error);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
