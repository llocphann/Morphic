import type { App, TFile } from "obsidian";
import { ReactiveDataEventMap } from "./data-events";
import {
	DependencyCollector,
	type DependencyIndexStats,
	type DependencyKey,
	type RevisionStoreStats,
} from "./dependencies";
import {
	collectExactFileDataChanges,
	collectFileDataChanges,
	collectFileStatDataChanges,
} from "./file-data-dependencies";
import {
	FileSnapshotSession,
	FileSnapshotStore,
	captureFileMetadata,
	type FileMetadataSnapshot,
	type FileSnapshotStoreOptions,
	type FileSnapshotStoreStats,
} from "./file-snapshot";
import { InvalidationEngine } from "./invalidation-engine";
import {
	IncrementalPropertyCatalog,
	type PropertyCatalogStats,
} from "./property-catalog";
import { collectPropertyDataInvalidationKeys } from "./property-data-dependencies";
import {
	ObsidianRuntimeFileResolver,
	RuntimeDataSession,
} from "./runtime-data";
import { VaultSettingsDataSource } from "./settings-data-source";
import { collectTagFamilyChanges } from "./tag-family-dependencies";
import {
	TimeDependencyPolicy,
	type TimeDependencyPolicyOptions,
} from "./time-dependencies";
import { VaultIndex } from "./vault-index";
import {
	RevisionedVaultQueryCache,
	type RevisionedVaultQueryCacheOptions,
} from "./vault-query-cache";

export interface ReactiveDataCoreOptions {
	snapshots?: FileSnapshotStoreOptions;
	time?: TimeDependencyPolicyOptions;
	queries?: RevisionedVaultQueryCacheOptions;
}

export interface ReactiveDataCoreStats {
	readonly snapshots: FileSnapshotStoreStats;
	readonly propertyCatalog: PropertyCatalogStats;
	readonly dependencies: DependencyIndexStats;
	readonly revisions: RevisionStoreStats;
	readonly indexedFiles: number;
	readonly indexedFolders: number;
	readonly indexedTags: number;
	readonly indexedProperties: number;
}

/**
 * Bot 3 data-side composition root.
 *
 * This class deliberately owns no Obsidian event subscriptions and no render
 * scheduling policy. Bot 1 can register lifecycle events and forward them here;
 * the returned owners have already been routed through InvalidationEngine.
 *
 * Keeping FileSnapshotStore and revisioned query caching on the exact
 * RevisionStore owned by the invalidation engine guarantees that file/index
 * events and data-cache validity advance together.
 */
export class ReactiveDataCore<Owner> {
	readonly index = new VaultIndex();
	readonly propertyCatalog = new IncrementalPropertyCatalog();
	readonly snapshots: FileSnapshotStore;
	readonly queries: RevisionedVaultQueryCache;
	readonly settingsData: VaultSettingsDataSource;
	readonly time: TimeDependencyPolicy;
	private readonly events: ReactiveDataEventMap;
	private readonly runtimeResolver: ObsidianRuntimeFileResolver;

	constructor(
		private readonly app: App,
		private readonly invalidation: InvalidationEngine<Owner>,
		options: ReactiveDataCoreOptions = {},
	) {
		this.snapshots = new FileSnapshotStore(app, invalidation.revisions, options.snapshots);
		this.queries = new RevisionedVaultQueryCache(this.index, invalidation.revisions, options.queries);
		this.settingsData = new VaultSettingsDataSource(this.queries, this.propertyCatalog);
		this.time = new TimeDependencyPolicy(options.time);
		this.events = new ReactiveDataEventMap(this.index);
		this.runtimeResolver = new ObsidianRuntimeFileResolver(app);
	}

	/** Start a render-scoped direct file snapshot session. */
	beginRender(collector: DependencyCollector = new DependencyCollector()): FileSnapshotSession {
		return this.snapshots.beginRender(collector);
	}

	/** Start a render-scoped runtime data session for dynamic linked-file access. */
	beginRuntimeRender(collector: DependencyCollector = new DependencyCollector()): RuntimeDataSession {
		return new RuntimeDataSession(this.snapshots.beginRender(collector), this.runtimeResolver);
	}

	/**
	 * One-time/bootstrap rebuild. No invalidation is emitted because callers use
	 * this before controllers have committed dependency ownership.
	 */
	bootstrap(files: Iterable<TFile>, folderPaths?: Iterable<string>): void {
		this.propertyCatalog.clear();
		this.snapshots.clear();
		this.queries.clear();
		this.settingsData.clear();

		const app = this.app;
		const propertyCatalog = this.propertyCatalog;
		function* bootstrapSnapshots(): IterableIterator<FileMetadataSnapshot> {
			for (const file of files) {
				const snapshot = captureFileMetadata(app, file);
				propertyCatalog.seedBootstrapSnapshot(snapshot);
				yield snapshot;
			}
		}

		this.index.bootstrap(bootstrapSnapshots(), folderPaths);
		this.time.seed();
	}

	fileCreated(file: TFile): readonly Owner[] {
		this.snapshots.clear(file.path);
		const snapshot = captureFileMetadata(this.app, file);
		return this.apply([
			...this.events.fileCreated(snapshot),
			...collectPropertyDataInvalidationKeys(undefined, snapshot),
			...collectFileDataChanges(undefined, snapshot),
			...collectExactFileDataChanges(undefined, snapshot),
			...collectTagFamilyChanges([], snapshot.tags),
			...this.propertyCatalog.upsert(snapshot),
		]);
	}

	fileContentModified(file: TFile | string): readonly Owner[] {
		const path = typeof file === "string" ? file : file.path;
		const previous = this.index.get(path);
		this.snapshots.clear(path);
		if (typeof file === "string") return this.apply(this.events.fileContentModified(path));

		const coarseStatChanges = collectFileStatDataChanges(previous, file.stat);
		const preciseStatChanges = previous && coarseStatChanges.length > 0
			? this.index.upsert(withFileStat(previous, file.stat))
			: [];
		return this.apply([
			...this.events.fileContentModified(path),
			...coarseStatChanges,
			...preciseStatChanges,
		]);
	}

	fileMetadataRefreshed(file: TFile): readonly Owner[] {
		const previous = this.index.get(file.path);
		const snapshot = captureFileMetadata(this.app, file);
		// Metadata revisions invalidate FileSnapshotStore.metadata() lazily. Do not
		// evict the independently revisioned body cache for a metadata-only event.
		return this.apply([
			...this.events.fileMetadataRefreshed(snapshot),
			...collectPropertyDataInvalidationKeys(previous, snapshot),
			...collectFileDataChanges(previous, snapshot),
			...collectExactFileDataChanges(previous, snapshot),
			...collectTagFamilyChanges(previous?.tags ?? [], snapshot.tags),
			...this.propertyCatalog.upsert(snapshot),
		]);
	}

	fileDeleted(path: string): readonly Owner[] {
		const changed = new Set<DependencyKey>();
		this.collectFileDeletedChanges(path, changed);
		return this.apply(changed);
	}

	fileRenamed(oldPath: string, file: TFile): readonly Owner[] {
		const previous = this.index.get(oldPath);
		this.snapshots.clear(oldPath);
		this.snapshots.clear(file.path);
		const snapshot = captureFileMetadata(this.app, file);
		return this.apply([
			...this.events.fileRenamed(oldPath, snapshot),
			...collectPropertyDataInvalidationKeys(previous, snapshot, { identityChanged: true }),
			...collectFileDataChanges(previous, snapshot),
			...collectExactFileDataChanges(previous, snapshot),
			...collectTagFamilyChanges(previous?.tags ?? [], snapshot.tags),
			...this.propertyCatalog.rename(oldPath, snapshot),
		]);
	}

	folderCreated(path: string): readonly Owner[] {
		return this.apply(this.index.addFolder(path));
	}

	folderDeleted(path: string): readonly Owner[] {
		return this.apply(this.index.removeFolder(path));
	}

	/**
	 * Coalesced subtree delete for a single folder lifecycle event.
	 * Descendant paths are snapshotted before mutation so callers do not need
	 * Obsidian to deliver child delete events in any particular order.
	 */
	folderTreeDeleted(path: string): readonly Owner[] {
		if (!path) return [];
		const prefix = `${path}/`;
		const filePaths = this.index.allPaths().filter(filePath => filePath.startsWith(prefix));
		const folderPaths = this.index.folderPaths().filter(
			folderPath => folderPath === path || folderPath.startsWith(prefix),
		);
		const changed = new Set<DependencyKey>();

		for (const filePath of filePaths) this.collectFileDeletedChanges(filePath, changed);
		for (const folderPath of folderPaths) {
			for (const key of this.index.removeFolder(folderPath)) changed.add(key);
		}
		return this.apply(changed);
	}

	folderRenamed(oldPath: string, newPath: string): readonly Owner[] {
		return this.apply(this.index.renameFolder(oldPath, newPath));
	}

	/**
	 * Coalesced subtree rename for Obsidian folder-rename integrations.
	 *
	 * Callers provide the current descendant files and current folder paths under
	 * the renamed root. Old paths are derived from the prefix mapping, so the
	 * index can atomically remove stale old memberships and add new ones without
	 * rescanning unrelated vault entries. Duplicate delivery compares against the
	 * already-indexed new path instead of manufacturing create-style revisions.
	 */
	folderTreeRenamed(
		oldPath: string,
		newPath: string,
		files: Iterable<TFile>,
		folderPaths: Iterable<string> = [],
	): readonly Owner[] {
		if (oldPath === newPath) return [];
		const changed = new Set<DependencyKey>();
		const currentFolders = new Set<string>([newPath, ...folderPaths]);

		for (const currentPath of currentFolders) {
			const previousPath = previousPathForRenamedTree(currentPath, oldPath, newPath);
			if (previousPath === null) continue;
			for (const key of this.index.renameFolder(previousPath, currentPath)) changed.add(key);
		}

		for (const file of files) {
			const previousPath = previousPathForRenamedTree(file.path, oldPath, newPath);
			if (previousPath === null) continue;
			const previous = this.index.get(previousPath);
			const alreadyRenamed = previous === undefined ? this.index.get(file.path) : undefined;
			const comparisonSnapshot = previous ?? alreadyRenamed;
			this.snapshots.clear(previousPath);
			this.snapshots.clear(file.path);
			const snapshot = captureFileMetadata(this.app, file);
			for (const key of this.events.fileRenamed(previousPath, snapshot)) changed.add(key);
			for (const key of collectPropertyDataInvalidationKeys(
				comparisonSnapshot,
				snapshot,
				{ identityChanged: previous !== undefined },
			)) {
				changed.add(key);
			}
			for (const key of collectFileDataChanges(comparisonSnapshot, snapshot)) changed.add(key);
			for (const key of collectExactFileDataChanges(comparisonSnapshot, snapshot)) changed.add(key);
			for (const key of collectTagFamilyChanges(comparisonSnapshot?.tags ?? [], snapshot.tags)) changed.add(key);
			for (const key of this.propertyCatalog.rename(previousPath, snapshot)) changed.add(key);
		}

		return this.apply(changed);
	}

	settingsChanged(viewId?: string): readonly Owner[] {
		return this.apply(this.events.settingsChanged(viewId));
	}

	baseChanged(baseId: string): readonly Owner[] {
		return this.apply(this.events.baseChanged(baseId));
	}

	timeChanged(kind: "now" | "today" | "random"): readonly Owner[] {
		return this.apply(this.events.timeChanged(kind));
	}

	advanceTime(nowMs: number = Date.now()): readonly Owner[] {
		return this.apply(this.time.advance(nowMs));
	}

	randomCycle(): readonly Owner[] {
		return this.apply(this.time.randomCycle());
	}

	stats(): ReactiveDataCoreStats {
		return Object.freeze({
			snapshots: this.snapshots.stats(),
			propertyCatalog: this.propertyCatalog.stats(),
			dependencies: this.invalidation.index.stats(),
			revisions: this.invalidation.revisions.stats(),
			indexedFiles: this.index.allPaths().length,
			indexedFolders: this.index.folderPaths().length,
			indexedTags: this.index.allTags().length,
			indexedProperties: this.index.propertyNames().length,
		});
	}

	private collectFileDeletedChanges(path: string, changed: Set<DependencyKey>): void {
		const previous = this.index.get(path);
		this.snapshots.clear(path);
		for (const key of this.events.fileDeleted(path)) changed.add(key);
		for (const key of collectPropertyDataInvalidationKeys(previous, undefined)) changed.add(key);
		for (const key of collectFileDataChanges(previous, undefined)) changed.add(key);
		for (const key of collectExactFileDataChanges(previous, undefined)) changed.add(key);
		for (const key of collectTagFamilyChanges(previous?.tags ?? [], [])) changed.add(key);
		for (const key of this.propertyCatalog.remove(path)) changed.add(key);
	}

	private apply(keys: Iterable<DependencyKey>): readonly Owner[] {
		return this.invalidation.invalidateMany(keys);
	}
}

function withFileStat(
	snapshot: FileMetadataSnapshot,
	stat: Pick<FileMetadataSnapshot, "size" | "ctime" | "mtime">,
): FileMetadataSnapshot {
	return Object.freeze({
		...snapshot,
		size: stat.size,
		ctime: stat.ctime,
		mtime: stat.mtime,
	});
}

function previousPathForRenamedTree(
	currentPath: string,
	oldRoot: string,
	newRoot: string,
): string | null {
	if (currentPath === newRoot) return oldRoot;
	const prefix = `${newRoot}/`;
	if (!currentPath.startsWith(prefix)) return null;
	return `${oldRoot}/${currentPath.slice(prefix.length)}`;
}
