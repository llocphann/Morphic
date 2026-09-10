import { getAllTags, type App, type TFile } from "obsidian";
import {
	captureFrontmatterStripContext,
	stripFrontmatterWithContext,
} from "../frontmatter";
import {
	DependencyCollector,
	RevisionStore,
	dependencyKey,
	type DependencyKey,
} from "./dependencies";

export interface FileMetadataSnapshot {
	readonly path: string;
	readonly name: string;
	readonly basename: string;
	readonly extension: string;
	readonly folder: string;
	readonly size: number;
	readonly ctime: number;
	readonly mtime: number;
	readonly tags: readonly string[];
	readonly links: readonly string[];
	/** Embedded links are metadata-only and never require body materialization. */
	readonly embeds?: readonly string[];
	readonly frontmatter: Readonly<Record<string, unknown>>;
}

interface RevisionedMetadataEntry {
	revision: number;
	value: FileMetadataSnapshot;
}

interface RevisionedBodyEntry {
	revision: number;
	value: string;
}

interface BodyInFlightEntry {
	readonly path: string;
	readonly promise: Promise<string>;
	invalidated: boolean;
}

export interface FileSnapshotStoreOptions {
	metadataCacheLimit?: number;
	bodyCacheLimit?: number;
	/** Enable cumulative QA/benchmark counters. Disabled on the production hot path by default. */
	collectStats?: boolean;
}

/** Test/benchmark-visible gauges and optional counters; retains no file/owner/DOM objects. */
export interface FileSnapshotStoreStats {
	readonly metadataEntries: number;
	readonly bodyEntries: number;
	readonly bodyInFlight: number;
	readonly metadataCacheLimit: number;
	readonly bodyCacheLimit: number;
	readonly observabilityEnabled?: true;
	readonly metadataCacheHits?: number;
	readonly metadataCacheMisses?: number;
	readonly bodyCacheHits?: number;
	readonly bodyCacheMisses?: number;
	readonly bodyInFlightDedupHits?: number;
	/** All body source-read attempts, whether served through Vault.cachedRead() or Vault.read(). */
	readonly bodyReads?: number;
	/** Subset of bodyReads issued only by the pre-commit fresh-source fence. */
	readonly bodyValidationReads?: number;
	readonly staleBodyCompletionsSuppressed?: number;
	readonly metadataEvictions?: number;
	readonly bodyEvictions?: number;
}

interface MutableFileSnapshotStoreCounters {
	metadataCacheHits: number;
	metadataCacheMisses: number;
	bodyCacheHits: number;
	bodyCacheMisses: number;
	bodyInFlightDedupHits: number;
	bodyReads: number;
	bodyValidationReads: number;
	staleBodyCompletionsSuppressed: number;
	metadataEvictions: number;
	bodyEvictions: number;
}

/**
 * Shared data-side cache for render sessions.
 *
 * Metadata snapshots never materialize note bodies. Body text is loaded lazily,
 * keyed by the file content dependency revision, and identical in-flight reads
 * are shared across owners.
 */
export class FileSnapshotStore {
	private readonly metadataCache = new Map<string, RevisionedMetadataEntry>();
	private readonly bodyCache = new Map<string, RevisionedBodyEntry>();
	private readonly bodyInFlight = new Map<string, BodyInFlightEntry>();
	private readonly metadataCacheLimit: number;
	private readonly bodyCacheLimit: number;
	private readonly counters: MutableFileSnapshotStoreCounters | null;

	constructor(
		private readonly app: App,
		readonly revisions: RevisionStore,
		options: FileSnapshotStoreOptions = {},
	) {
		this.metadataCacheLimit = positiveLimit(options.metadataCacheLimit, 512);
		this.bodyCacheLimit = positiveLimit(options.bodyCacheLimit, 128);
		this.counters = options.collectStats === true ? emptyCounters() : null;
	}

	beginRender(collector: DependencyCollector = new DependencyCollector()): FileSnapshotSession {
		return new FileSnapshotSession(this, collector);
	}

	metadata(file: TFile): FileMetadataSnapshot {
		const key = dependencyKey.file(file.path, "metadata");
		const revision = this.revisions.current(key);
		const cached = this.metadataCache.get(file.path);
		if (cached && cached.revision === revision) {
			if (this.counters) this.counters.metadataCacheHits++;
			touch(this.metadataCache, file.path, cached);
			return cached.value;
		}

		if (this.counters) this.counters.metadataCacheMisses++;
		const value = captureFileMetadata(this.app, file);
		this.metadataCache.set(file.path, { revision, value });
		const evictions = trimCache(this.metadataCache, this.metadataCacheLimit);
		if (this.counters) this.counters.metadataEvictions += evictions;
		return value;
	}

	async body(file: TFile): Promise<string> {
		const path = file.path;
		const key = dependencyKey.file(path, "content");
		const revision = this.revisions.current(key);
		const cached = this.bodyCache.get(path);
		if (cached && cached.revision === revision) {
			if (this.counters) this.counters.bodyCacheHits++;
			touch(this.bodyCache, path, cached);
			return cached.value;
		}

		if (this.counters) this.counters.bodyCacheMisses++;
		const inFlightKey = `${path}\u0000${revision}`;
		const existing = this.bodyInFlight.get(inFlightKey);
		if (existing) {
			if (this.counters) this.counters.bodyInFlightDedupHits++;
			return existing.promise;
		}

		let entry!: BodyInFlightEntry;
		// Once Core has observed a content revision, bypass Obsidian's display cache
		// for the first miss at that revision. A vault modify event may reach Morphic
		// before cachedRead() has rotated to the just-written bytes; Vault.read() is
		// the authoritative source at this known-change boundary. Revision-0 and
		// Morphic-cache hot paths retain cachedRead() behavior.
		const promise = this.loadBody(file, false, revision !== 0).then(
			value => {
				if (
					!entry.invalidated &&
					file.path === path &&
					this.revisions.current(key) === revision
				) {
					this.bodyCache.set(path, { revision, value });
					const evictions = trimCache(this.bodyCache, this.bodyCacheLimit);
					if (this.counters) this.counters.bodyEvictions += evictions;
				} else if (this.counters) {
					this.counters.staleBodyCompletionsSuppressed++;
				}
				if (this.bodyInFlight.get(inFlightKey) === entry) this.bodyInFlight.delete(inFlightKey);
				return value;
			},
			error => {
				if (this.bodyInFlight.get(inFlightKey) === entry) this.bodyInFlight.delete(inFlightKey);
				throw error;
			},
		);
		entry = { path, promise, invalidated: false };
		this.bodyInFlight.set(inFlightKey, entry);
		return promise;
	}

	clear(path?: string): void {
		if (path === undefined) {
			this.metadataCache.clear();
			this.bodyCache.clear();
			for (const entry of this.bodyInFlight.values()) entry.invalidated = true;
			this.bodyInFlight.clear();
			return;
		}
		this.metadataCache.delete(path);
		this.bodyCache.delete(path);
		for (const [key, entry] of this.bodyInFlight) {
			if (entry.path !== path) continue;
			entry.invalidated = true;
			this.bodyInFlight.delete(key);
		}
	}

	stats(): FileSnapshotStoreStats {
		const gauges = {
			metadataEntries: this.metadataCache.size,
			bodyEntries: this.bodyCache.size,
			bodyInFlight: this.bodyInFlight.size,
			metadataCacheLimit: this.metadataCacheLimit,
			bodyCacheLimit: this.bodyCacheLimit,
		};
		if (!this.counters) return Object.freeze(gauges);
		return Object.freeze({
			...gauges,
			observabilityEnabled: true as const,
			...this.counters,
		});
	}

	/** Reset cumulative counters without mutating cache contents or in-flight work. */
	resetStats(): void {
		if (this.counters) Object.assign(this.counters, emptyCounters());
	}

	/** Capture live Obsidian metadata without consulting snapshot caches. */
	liveMetadata(file: TFile): FileMetadataSnapshot {
		return captureFileMetadata(this.app, file);
	}

	/** Compare a broad observed snapshot with current Obsidian metadata. */
	isMetadataCurrent(file: TFile, expected: FileMetadataSnapshot): boolean {
		return metadataSnapshotsEqual(expected, this.liveMetadata(file));
	}

	/**
	 * Fresh body fence used only when a render seals its dependency contract.
	 * This bypasses both Morphic's revision/in-flight caches and, on supported
	 * Obsidian versions, the Vault.cachedRead() display cache. Same-stat backing
	 * changes can otherwise be invisible until the corresponding event/revision.
	 * Validation failure is fail-closed.
	 */
	async isBodyCurrent(file: TFile, expected: string): Promise<boolean> {
		try {
			return await this.loadBody(file, true, true) === expected;
		} catch {
			return false;
		}
	}

	private async loadBody(
		file: TFile,
		validationRead: boolean,
		authoritativeRead: boolean,
	): Promise<string> {
		if (this.counters) {
			this.counters.bodyReads++;
			if (validationRead) this.counters.bodyValidationReads++;
		}
		const path = file.path;
		const stripContext = captureFrontmatterStripContext(
			this.app.metadataCache.getFileCache(file),
		);
		// Vault.read() exists throughout Morphic's supported Obsidian range. The
		// function guard keeps lightweight App/Vault compatibility shims fail-soft;
		// real supported hosts always take the direct branch when requested.
		const raw = authoritativeRead && typeof this.app.vault.read === "function"
			? await this.app.vault.read(file)
			: await this.app.vault.cachedRead(file);
		const initial = stripFrontmatterWithContext(stripContext, raw);
		if (initial !== raw || file.path !== path || !startsWithYamlFrontmatter(raw)) {
			return initial;
		}

		// MetadataCache may become current while the physical read is pending. It is
		// safe to consult that fresher context only while the same TFile path/identity
		// still owns the read. If the TFile was renamed, the frozen pre-read context
		// remains authoritative for the old raw bytes (Bot 5 #801).
		const freshContext = captureFrontmatterStripContext(
			this.app.metadataCache.getFileCache(file),
		);
		return stripFrontmatterWithContext(freshContext, raw);
	}
}

/** Per-render wrapper that records the exact runtime dependencies read. */
export class FileSnapshotSession {
	private readonly snapshots = new Map<string, TrackedFileSnapshot>();

	constructor(
		private readonly store: FileSnapshotStore,
		readonly collector: DependencyCollector,
	) {}

	file(file: TFile): TrackedFileSnapshot {
		const existing = this.snapshots.get(file.path);
		if (existing) return existing;
		const snapshot = new TrackedFileSnapshot(this.store, this.collector, file);
		this.snapshots.set(file.path, snapshot);
		return snapshot;
	}

	dependencies(): ReadonlySet<DependencyKey> {
		return this.collector.snapshot();
	}

	/** Request freshness validation for observations that need async source confirmation. */
	requestSynchronousValidation(): void {
		for (const snapshot of this.snapshots.values()) snapshot.requestSynchronousValidation();
	}

	/** Wait until all requested async freshness fences have settled. */
	async settleSynchronousValidation(): Promise<boolean> {
		const results = await Promise.all(
			Array.from(this.snapshots.values(), snapshot => snapshot.settleSynchronousValidation()),
		);
		return results.every(Boolean);
	}

	/** Event-lag guard: only values actually observed by this render must remain current. */
	isSynchronouslyCurrent(): boolean {
		for (const snapshot of this.snapshots.values()) {
			if (!snapshot.isSynchronouslyCurrent()) return false;
		}
		return true;
	}
}

type FileStatField = "size" | "ctime" | "mtime";
type FileIdentityField = "name" | "basename" | "path" | "folder" | "extension";

interface ContentStatObservation {
	readonly size: number;
	readonly mtime: number;
}

export class TrackedFileSnapshot {
	private observedSourcePath: string | null = null;
	private observedMetadata: FileMetadataSnapshot | null = null;
	private readonly observedProperties = new Map<string, unknown>();
	private readonly observedStats = new Map<FileStatField, number>();
	private readonly observedFileFields = new Map<FileIdentityField, string>();
	private observedTags: readonly string[] | null = null;
	private observedLinks: readonly string[] | null = null;
	private observedEmbeds: readonly string[] | null = null;
	private observedContentStat: ContentStatObservation | null = null;
	private observedBody: string | null = null;
	private bodyValidationRequested = false;
	private bodyValidation: Promise<boolean> | null = null;
	private bodyValidationCurrent: boolean | null = null;

	constructor(
		private readonly store: FileSnapshotStore,
		private readonly collector: DependencyCollector,
		private readonly source: TFile,
	) {}

	metadata(): FileMetadataSnapshot {
		this.observeSourcePath();
		this.collector.track(dependencyKey.file(this.source.path, "metadata"));
		const metadata = this.currentMetadata();
		if (this.observedMetadata === null) this.observedMetadata = metadata;
		return metadata;
	}

	property(name: string): unknown {
		this.observeSourcePath();
		this.collector.track(dependencyKey.file(this.source.path, "frontmatter", name));
		const value = this.currentMetadata().frontmatter[name];
		if (!this.observedProperties.has(name)) this.observedProperties.set(name, value);
		return value;
	}

	stat(field: FileStatField): number {
		this.observeSourcePath();
		this.collector.track(dependencyKey.file(this.source.path, "stat", field));
		const value = this.currentMetadata()[field];
		if (!this.observedStats.has(field)) this.observedStats.set(field, value);
		return value;
	}

	fileField(field: FileIdentityField): string {
		this.observeSourcePath();
		this.collector.track(dependencyKey.file(this.source.path, "file", field));
		const value = this.currentMetadata()[field];
		if (!this.observedFileFields.has(field)) this.observedFileFields.set(field, value);
		return value;
	}

	tags(): readonly string[] {
		this.observeSourcePath();
		this.collector.track(dependencyKey.file(this.source.path, "tags"));
		const value = this.currentMetadata().tags;
		if (this.observedTags === null) this.observedTags = value;
		return value;
	}

	links(): readonly string[] {
		this.observeSourcePath();
		this.collector.track(dependencyKey.file(this.source.path, "links"));
		const value = this.currentMetadata().links;
		if (this.observedLinks === null) this.observedLinks = value;
		return value;
	}

	embeds(): readonly string[] {
		this.observeSourcePath();
		this.collector.track(dependencyKey.file(this.source.path, "embeds"));
		const value = this.currentMetadata().embeds ?? [];
		if (this.observedEmbeds === null) this.observedEmbeds = value;
		return value;
	}

	async body(): Promise<string> {
		this.observeSourcePath();
		this.collector.track(dependencyKey.file(this.source.path, "content"));
		if (this.observedContentStat === null) {
			this.observedContentStat = Object.freeze({
				size: this.source.stat.size,
				mtime: this.source.stat.mtime,
			});
		}

		const value = await this.store.body(this.source);
		if (this.observedBody === null) this.observedBody = value;
		// If the render sealed while this read was in flight, do not resolve the
		// semantic read to the caller until its fresh-source fence has settled.
		if (this.bodyValidationRequested) await this.ensureBodyValidation();
		return value;
	}

	requestSynchronousValidation(): void {
		this.bodyValidationRequested = true;
		if (this.observedBody !== null) void this.ensureBodyValidation();
	}

	async settleSynchronousValidation(): Promise<boolean> {
		this.requestSynchronousValidation();
		if (this.observedBody === null) return true;
		return this.ensureBodyValidation();
	}

	isSynchronouslyCurrent(): boolean {
		if (this.observedSourcePath !== null && this.source.path !== this.observedSourcePath) {
			return false;
		}

		const needsLiveMetadata = this.observedMetadata !== null ||
			this.observedProperties.size > 0 ||
			this.observedStats.size > 0 ||
			this.observedFileFields.size > 0 ||
			this.observedTags !== null ||
			this.observedLinks !== null ||
			this.observedEmbeds !== null;

		if (needsLiveMetadata) {
			const live = this.store.liveMetadata(this.source);
			if (this.observedMetadata !== null && !metadataSnapshotsEqual(this.observedMetadata, live)) {
				return false;
			}
			for (const [name, expected] of this.observedProperties) {
				if (!metadataValueEqual(expected, live.frontmatter[name])) return false;
			}
			for (const [field, expected] of this.observedStats) {
				if (live[field] !== expected) return false;
			}
			for (const [field, expected] of this.observedFileFields) {
				if (live[field] !== expected) return false;
			}
			if (this.observedTags !== null && !metadataValueEqual(this.observedTags, live.tags)) return false;
			if (this.observedLinks !== null && !metadataValueEqual(this.observedLinks, live.links)) return false;
			if (this.observedEmbeds !== null && !metadataValueEqual(this.observedEmbeds, live.embeds ?? [])) return false;
		}

		if (
			this.observedContentStat !== null &&
			(this.source.stat.size !== this.observedContentStat.size ||
				this.source.stat.mtime !== this.observedContentStat.mtime)
		) {
			return false;
		}
		if (
			this.bodyValidationRequested &&
			this.observedBody !== null &&
			this.bodyValidationCurrent !== true
		) {
			return false;
		}
		return true;
	}

	private ensureBodyValidation(): Promise<boolean> {
		if (this.bodyValidation) return this.bodyValidation;
		const expected = this.observedBody;
		if (expected === null) return Promise.resolve(true);
		this.bodyValidation = this.store.isBodyCurrent(this.source, expected).then(current => {
			this.bodyValidationCurrent = current;
			return current;
		});
		return this.bodyValidation;
	}

	private currentMetadata(): FileMetadataSnapshot {
		return this.store.metadata(this.source);
	}

	private observeSourcePath(): void {
		if (this.observedSourcePath === null) this.observedSourcePath = this.source.path;
	}
}

/**
 * Capture current Obsidian metadata without consulting snapshot caches.
 * Event adapters use this for old/new diffing before dependency revisions bump.
 */
export function captureFileMetadata(app: App, file: TFile): FileMetadataSnapshot {
	const cache = app.metadataCache.getFileCache(file);
	const cachedFrontmatter: unknown = cache?.frontmatter;
	const rawFrontmatter = isPlainRecord(cachedFrontmatter) ? cachedFrontmatter : {};
	const frontmatter = freezeRecord(rawFrontmatter);
	const tags = cache ? Array.from(new Set(getAllTags(cache) ?? [])) : [];
	const linkCache = cache as typeof cache & {
		frontmatterLinks?: readonly { link: string }[];
		embeds?: readonly { link: string }[];
	};
	const links = [
		...(linkCache?.links ?? []),
		...(linkCache?.frontmatterLinks ?? []),
	].map(link => link.link);
	const embeds = (linkCache?.embeds ?? []).map(embed => embed.link);

	return Object.freeze({
		path: file.path,
		name: file.name,
		basename: file.basename,
		extension: file.extension,
		folder: file.parent?.path ?? "",
		size: file.stat.size,
		ctime: file.stat.ctime,
		mtime: file.stat.mtime,
		tags: Object.freeze(tags),
		links: Object.freeze(links.slice()),
		embeds: Object.freeze(embeds.slice()),
		frontmatter,
	});
}

function freezeRecord(value: Record<string, unknown>): Readonly<Record<string, unknown>> {
	const result: Record<string, unknown> = {};
	for (const key of Object.keys(value)) {
		if (key === "position") continue;
		const cloned = cloneMetadataValue(value[key]);
		if (key === "__proto__") {
			Object.defineProperty(result, key, {
				value: cloned,
				enumerable: true,
				configurable: true,
				writable: true,
			});
		} else {
			result[key] = cloned;
		}
	}
	return Object.freeze(result);
}

function cloneMetadataValue(value: unknown): unknown {
	if (Array.isArray(value)) {
		return Object.freeze(value.map(item => cloneMetadataValue(item)));
	}
	if (isPlainRecord(value)) {
		return freezeRecord(value);
	}
	return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object") return false;
	const prototype: unknown = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function metadataSnapshotsEqual(left: FileMetadataSnapshot, right: FileMetadataSnapshot): boolean {
	return left.path === right.path &&
		left.name === right.name &&
		left.basename === right.basename &&
		left.extension === right.extension &&
		left.folder === right.folder &&
		left.size === right.size &&
		left.ctime === right.ctime &&
		left.mtime === right.mtime &&
		metadataValueEqual(left.tags, right.tags) &&
		metadataValueEqual(left.links, right.links) &&
		metadataValueEqual(left.embeds ?? [], right.embeds ?? []) &&
		metadataValueEqual(left.frontmatter, right.frontmatter);
}

function metadataValueEqual(left: unknown, right: unknown): boolean {
	if (Object.is(left, right)) return true;
	if (Array.isArray(left) || Array.isArray(right)) {
		if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
		for (let i = 0; i < left.length; i++) {
			if (!metadataValueEqual(left[i], right[i])) return false;
		}
		return true;
	}
	if (isPlainRecord(left) || isPlainRecord(right)) {
		if (!isPlainRecord(left) || !isPlainRecord(right)) return false;
		const leftKeys = Object.keys(left);
		const rightKeys = Object.keys(right);
		if (leftKeys.length !== rightKeys.length) return false;
		for (const key of leftKeys) {
			if (!Object.prototype.hasOwnProperty.call(right, key) || !metadataValueEqual(left[key], right[key])) return false;
		}
		return true;
	}
	return false;
}

function positiveLimit(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? Math.floor(value)
		: fallback;
}

function emptyCounters(): MutableFileSnapshotStoreCounters {
	return {
		metadataCacheHits: 0,
		metadataCacheMisses: 0,
		bodyCacheHits: 0,
		bodyCacheMisses: 0,
		bodyInFlightDedupHits: 0,
		bodyReads: 0,
		bodyValidationReads: 0,
		staleBodyCompletionsSuppressed: 0,
		metadataEvictions: 0,
		bodyEvictions: 0,
	};
}

function touch<T>(map: Map<string, T>, key: string, value: T): void {
	map.delete(key);
	map.set(key, value);
}

function trimCache<T>(map: Map<string, T>, limit: number): number {
	let removed = 0;
	while (map.size > limit) {
		const oldest = map.keys().next().value as string | undefined;
		if (oldest === undefined) break;
		map.delete(oldest);
		removed++;
	}
	return removed;
}

function startsWithYamlFrontmatter(raw: string): boolean {
	return raw.startsWith("---\n") || raw.startsWith("---\r\n");
}