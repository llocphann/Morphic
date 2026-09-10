import {
	TFile,
	parseYaml,
	stringifyYaml,
	type Plugin,
} from "obsidian";
import {
	collectBaseQueryDependencies,
	dependencyKey,
	RevisionedAsyncDataCache,
	RevisionStore,
	type DependencyKey,
} from "../core";
import {
	createCollectorBaseDocuments,
	extractEmbeddedBaseBlocks,
	extractEmbeddedBaseFileLinks,
} from "./code-blocks";
import {
	BaseEmbedCollectionSession,
	resolveBaseEmbedFactory,
	type BaseEmbedFactory,
} from "./embed-transport";
import {
	createBaseErrorView,
	normalizeBasesView,
	type NormalizeBaseMetadata,
} from "./normalize";
import { abortError, CollectorLifetime, CollectorLimiter } from "./reliability";
import { extractTemplateBaseBlocks } from "./template-syntax";
import type {
	BasesDataProvider,
	EmbeddedBasesRequest,
	TemplateBaseView,
	TemplateBases,
} from "./types";

const COLLECTION_TIMEOUT_MS = 5000;
const MAX_CONCURRENT_COLLECTORS = 4;
const CACHE_LIMIT = 64;

type BaseSource =
	| {
		kind: "template";
		name?: string;
		content: string;
		start: number;
		line: number;
	}
	| {
		kind: "code-block";
		content: string;
		start: number;
		line: number;
	}
	| {
		kind: "file-embed";
		target: string;
		viewName?: string;
		start: number;
		line: number;
	};

interface RenderJobSource {
	sourceKind: NormalizeBaseMetadata["sourceKind"];
	sourceIndex: number;
	sourceLine: number;
	sourcePath?: string;
	sourceName?: string;
	viewName?: string;
}

interface ActiveCollector {
	readonly lifetime: CollectorLifetime;
	readonly promise: Promise<TemplateBaseView>;
}

export class EmbeddedBasesProvider implements BasesDataProvider {
	private enabled = false;
	private disposed = false;
	private baseEmbedFactory: BaseEmbedFactory | null = null;
	private readonly cache: RevisionedAsyncDataCache<TemplateBaseView>;
	private readonly activeCollectors = new Map<string, ActiveCollector>();
	private readonly collectorLimiter = new CollectorLimiter(MAX_CONCURRENT_COLLECTORS);

	constructor(
		private readonly plugin: Plugin,
		private readonly revisions: RevisionStore = new RevisionStore(),
	) {
		this.cache = new RevisionedAsyncDataCache<TemplateBaseView>(revisions, { limit: CACHE_LIMIT });
	}

	register(): boolean {
		if (this.disposed) return false;
		this.baseEmbedFactory = resolveBaseEmbedFactory(this.plugin.app);
		this.enabled = this.baseEmbedFactory !== null;
		return this.enabled;
	}

	invalidateAll(): void {
		this.cache.clear();
		const reason = new Error("Bases collection was invalidated.");
		for (const operation of this.activeCollectors.values()) operation.lifetime.abort(reason);
		this.activeCollectors.clear();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.enabled = false;
		this.baseEmbedFactory = null;
		this.invalidateAll();
	}

	async getEmbeddedBases(request: EmbeddedBasesRequest): Promise<TemplateBases> {
		if (!this.enabled) return [];
		const sources = collectSources(request);
		if (sources.length === 0) return [];

		const jobs: Promise<TemplateBaseView>[] = [];
		for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex++) {
			const source = sources[sourceIndex];
			if (source.kind === "template") {
				jobs.push(...this.jobsForTemplate(request, source, sourceIndex));
			} else if (source.kind === "code-block") {
				jobs.push(...this.createRenderJobsForConfig(request, source.content, {
					sourceKind: "code-block",
					sourceIndex,
					sourceLine: source.line,
				}));
			} else {
				jobs.push(...await this.jobsForEmbeddedFile(request, source, sourceIndex));
			}
		}
		return Promise.all(jobs);
	}

	private jobsForTemplate(
		request: EmbeddedBasesRequest,
		source: Extract<BaseSource, { kind: "template" }>,
		sourceIndex: number,
	): Promise<TemplateBaseView>[] {
		if (source.content.trim().length === 0) {
			return [Promise.resolve(createBaseErrorView({
				sourceKind: "template",
				sourceIndex,
				sourceLine: source.line,
				sourceName: source.name,
				viewIndex: 0,
				viewName: "",
				originalType: "",
			}, "Template base block is empty."))];
		}
		return this.createRenderJobsForConfig(request, source.content, {
			sourceKind: "template",
			sourceIndex,
			sourceLine: source.line,
			sourceName: source.name,
		});
	}

	private async jobsForEmbeddedFile(
		request: EmbeddedBasesRequest,
		source: Extract<BaseSource, { kind: "file-embed" }>,
		sourceIndex: number,
	): Promise<Promise<TemplateBaseView>[]> {
		request.dependencyCollector?.track(dependencyKey.index("files"));
		const baseFile = resolveEmbeddedBaseFile(request, source.target);
		if (!baseFile) {
			return [Promise.resolve(createBaseErrorView({
				sourceKind: "file-embed",
				sourceIndex,
				sourceLine: source.line,
				sourcePath: source.target,
				viewIndex: 0,
				viewName: source.viewName ?? "",
				originalType: "",
			}, `Could not resolve embedded base file: ${source.target}`))];
		}

		request.dependencyCollector?.track(dependencyKey.file(baseFile.path, "content"));
		let content: string;
		try {
			content = await request.app.vault.cachedRead(baseFile);
		} catch (error) {
			return [Promise.resolve(createBaseErrorView({
				sourceKind: "file-embed",
				sourceIndex,
				sourceLine: source.line,
				sourcePath: baseFile.path,
				viewIndex: 0,
				viewName: source.viewName ?? "",
				originalType: "",
			}, errorMessage(error)))];
		}

		return this.createRenderJobsForConfig(request, content, {
			sourceKind: "file-embed",
			sourceIndex,
			sourceLine: source.line,
			sourcePath: baseFile.path,
			viewName: source.viewName,
		});
	}

	private createRenderJobsForConfig(
		request: EmbeddedBasesRequest,
		sourceContent: string,
		source: RenderJobSource,
	): Promise<TemplateBaseView>[] {
		let config: unknown;
		try {
			config = parseYaml(sourceContent);
		} catch (error) {
			return [Promise.resolve(createBaseErrorView(metadataForError(source), errorMessage(error)))];
		}

		const documents = createCollectorBaseDocuments(config, source.sourceIndex, source.viewName);
		if (documents.length === 0) {
			const message = source.viewName
				? `Could not find Bases view: ${source.viewName}`
				: "Could not find a Bases view to collect.";
			return [Promise.resolve(createBaseErrorView(metadataForError(source), message))];
		}

		return documents.map(document => {
			const dependencies = collectBaseQueryDependencies(document.config, {
				currentFilePath: request.file.path,
				sourceKind: source.sourceKind,
				sourcePath: source.sourcePath,
				settingsViewId: request.settingsViewId,
			});
			request.dependencyCollector?.trackMany(dependencies);
			const metadata: NormalizeBaseMetadata = {
				sourceKind: source.sourceKind,
				sourceIndex: document.sourceIndex,
				sourceLine: source.sourceLine,
				sourcePath: source.sourcePath,
				sourceName: source.sourceName,
				viewIndex: document.viewIndex,
				viewName: document.viewName,
				originalType: document.originalType,
			};
			return this.getCollectorBase(
				request,
				stringifyYaml(document.config).trimEnd(),
				metadata,
				dependencies,
			);
		});
	}

	private getCollectorBase(
		request: EmbeddedBasesRequest,
		baseContent: string,
		metadata: NormalizeBaseMetadata,
		dependencies: readonly DependencyKey[] = [],
	): Promise<TemplateBaseView> {
		const cacheKey = collectorCacheKey(request, baseContent, metadata);
		const activeKey = activeCollectorKey(cacheKey, this.revisions.fingerprint(dependencies));
		const active = this.activeCollectors.get(activeKey);

		if (active && !active.lifetime.signal.aborted) {
			active.lifetime.retain(request.component);
			return active.promise.catch(error => createBaseErrorView(metadata, errorMessage(error)));
		}

		if (active?.lifetime.signal.aborted) {
			return this.startUncachedReplacement(activeKey, request, baseContent, metadata);
		}

		const started: { lifetime?: CollectorLifetime } = {};
		const promise = this.cache.get(cacheKey, dependencies, () => {
			const lifetime = new CollectorLifetime();
			started.lifetime = lifetime;
			return this.runCollectorBase(request, baseContent, metadata, lifetime);
		});
		if (started.lifetime) {
			this.trackActive(activeKey, started.lifetime, promise, request);
		}
		return promise.catch(error => createBaseErrorView(metadata, errorMessage(error)));
	}

	private startUncachedReplacement(
		activeKey: string,
		request: EmbeddedBasesRequest,
		baseContent: string,
		metadata: NormalizeBaseMetadata,
	): Promise<TemplateBaseView> {
		const lifetime = new CollectorLifetime();
		const promise = this.runCollectorBase(request, baseContent, metadata, lifetime);
		this.trackActive(activeKey, lifetime, promise, request);
		return promise.catch(error => createBaseErrorView(metadata, errorMessage(error)));
	}

	private trackActive(
		key: string,
		lifetime: CollectorLifetime,
		promise: Promise<TemplateBaseView>,
		request: EmbeddedBasesRequest,
	): void {
		const operation: ActiveCollector = { lifetime, promise };
		this.activeCollectors.set(key, operation);
		lifetime.retain(request.component);
		const release = () => {
			if (this.activeCollectors.get(key) === operation) this.activeCollectors.delete(key);
		};
		void promise.then(release, release);
	}

	private runCollectorBase(
		request: EmbeddedBasesRequest,
		baseContent: string,
		metadata: NormalizeBaseMetadata,
		lifetime: CollectorLifetime,
	): Promise<TemplateBaseView> {
		const timers = request.ownerDocument.defaultView ?? window;
		const timeout = timers.setTimeout(() => {
			lifetime.abort(new Error("Timed out while collecting Bases data."));
		}, COLLECTION_TIMEOUT_MS);
		const finish = () => {
			timers.clearTimeout(timeout);
			lifetime.finish();
		};

		const immediate = this.collectorLimiter.tryAcquire();
		const task = immediate
			? this.collectWithPermit(request, baseContent, metadata, lifetime, immediate)
			: this.collectorLimiter.acquire(lifetime.signal).then(release =>
				this.collectWithPermit(request, baseContent, metadata, lifetime, release));
		return task.finally(finish);
	}

	private async collectWithPermit(
		request: EmbeddedBasesRequest,
		baseContent: string,
		metadata: NormalizeBaseMetadata,
		lifetime: CollectorLifetime,
		releasePermit: () => void,
	): Promise<TemplateBaseView> {
		if (lifetime.signal.aborted) {
			releasePermit();
			throw abortError(lifetime.signal);
		}

		const factory = request.app === this.plugin.app
			? this.baseEmbedFactory
			: resolveBaseEmbedFactory(request.app);
		if (!factory) {
			releasePermit();
			throw new Error("Obsidian Bases embed API is unavailable.");
		}

		const session = new BaseEmbedCollectionSession(
			request.app,
			request.ownerDocument,
			request.file,
			baseContent,
			metadata.viewName,
			factory,
		);
		lifetime.setCleanup(() => {
			try {
				session.dispose();
			} finally {
				releasePermit();
			}
		});

		const view = await session.collect(lifetime.signal);
		return normalizeBasesView(view, metadata);
	}
}

function metadataForError(source: RenderJobSource): NormalizeBaseMetadata {
	return {
		sourceKind: source.sourceKind,
		sourceIndex: source.sourceIndex,
		sourceLine: source.sourceLine,
		sourcePath: source.sourcePath,
		sourceName: source.sourceName,
		viewIndex: 0,
		viewName: source.viewName ?? "",
		originalType: "",
	};
}

function collectSources(request: EmbeddedBasesRequest): BaseSource[] {
	const templateSources: BaseSource[] = extractTemplateBaseBlocks(request.templateContent).map(block => ({
		kind: "template",
		name: block.name,
		content: block.content,
		start: block.start,
		line: block.line,
	}));
	const codeBlocks: BaseSource[] = extractEmbeddedBaseBlocks(request.sourceContent).map(block => ({
		kind: "code-block",
		content: block.content,
		start: block.start,
		line: block.line,
	}));
	const fileEmbeds: BaseSource[] = extractEmbeddedBaseFileLinks(request.sourceContent).map(link => ({
		kind: "file-embed",
		target: link.target,
		viewName: link.viewName,
		start: link.start,
		line: link.line,
	}));
	const noteSources = [...codeBlocks, ...fileEmbeds].sort((left, right) => left.start - right.start);
	return [...templateSources, ...noteSources];
}

function resolveEmbeddedBaseFile(request: EmbeddedBasesRequest, target: string): TFile | null {
	const linked = request.app.metadataCache.getFirstLinkpathDest(target, request.file.path);
	if (isBaseFile(linked)) return linked;

	const direct = request.app.vault.getFileByPath(target);
	if (isBaseFile(direct)) return direct;

	if (!target.includes("/")) {
		const parent = request.file.parent?.path ?? "";
		const relative = request.app.vault.getFileByPath(parent ? `${parent}/${target}` : target);
		if (isBaseFile(relative)) return relative;
	}
	return null;
}

function isBaseFile(value: unknown): value is TFile {
	return value instanceof TFile && value.extension === "base";
}

function activeCollectorKey(cacheKey: string, fingerprint: string): string {
	return `${cacheKey.length}:${cacheKey}${fingerprint}`;
}

function collectorCacheKey(
	request: EmbeddedBasesRequest,
	baseContent: string,
	metadata: NormalizeBaseMetadata,
): string {
	return JSON.stringify([
		request.file.path,
		metadata.sourceKind,
		metadata.sourceIndex,
		metadata.sourceLine,
		metadata.sourcePath ?? null,
		metadata.sourceName ?? null,
		metadata.viewIndex,
		metadata.viewName,
		metadata.originalType,
		baseContent,
	]);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
