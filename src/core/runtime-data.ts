import type { App, TFile } from "obsidian";
import { dependencyKey, type DependencyKey } from "./dependencies";
import {
	FileSnapshotSession,
	type TrackedFileSnapshot,
} from "./file-snapshot";

/**
 * Resolver boundary for runtime-linked files. The default implementation uses
 * Obsidian's own linkpath resolution semantics; tests may inject a deterministic
 * resolver without changing dependency tracking behavior.
 */
export interface RuntimeFileResolver {
	resolve(linkPath: string, sourcePath: string): TFile | null;
}

export class ObsidianRuntimeFileResolver implements RuntimeFileResolver {
	constructor(private readonly app: App) {}

	resolve(linkPath: string, sourcePath: string): TFile | null {
		return this.app.metadataCache.getFirstLinkpathDest(linkPath, sourcePath);
	}
}

/** Resolved runtime target without exposing or retaining the underlying TFile. */
export interface ResolvedRuntimeFile {
	readonly path: string;
	readonly snapshot: TrackedFileSnapshot;
}

/**
 * Per-render runtime data facade for dynamic file(...) / linked-file access.
 *
 * Link resolution itself depends on the vault file set because Obsidian may
 * resolve basename/relative candidates differently after create/delete/rename.
 * Until Morphic owns a dedicated link-resolution index, `index:files` is the
 * conservative correctness dependency for resolution. Once a concrete target
 * is selected, exact file-existence and field/content dependencies are tracked.
 *
 * Resolution results are cached only for this render session. If a file-set
 * event occurs concurrently, owner-generation invalidation prevents a stale
 * render from committing; a newer render gets a fresh resolution cache.
 */
interface RuntimeResolutionObservation {
	readonly linkPath: string;
	readonly sourcePath: string;
	readonly targetPath: string | null;
}

export class RuntimeDataSession {
	private readonly resolutionCache = new Map<string, TFile | null>();
	private readonly resolutionObservations = new Map<string, RuntimeResolutionObservation>();

	constructor(
		readonly snapshots: FileSnapshotSession,
		private readonly resolver: RuntimeFileResolver,
	) {}

	/** Direct current/known-file access without adding a link-resolution dependency. */
	file(file: TFile): TrackedFileSnapshot {
		return this.snapshots.file(file);
	}

	/** Resolve a runtime link/file target and keep its concrete path for chained resolution. */
	resolveFileTarget(linkPath: string, sourcePath: string): ResolvedRuntimeFile | null {
		this.snapshots.collector.track(dependencyKey.index("files"));

		const cacheKey = `${sourcePath}\u0000${linkPath}`;
		let target: TFile | null;
		if (this.resolutionCache.has(cacheKey)) {
			target = this.resolutionCache.get(cacheKey) ?? null;
		} else {
			target = this.resolver.resolve(linkPath, sourcePath);
			this.resolutionCache.set(cacheKey, target);
		}

		this.resolutionObservations.set(cacheKey, {
			linkPath,
			sourcePath,
			targetPath: target?.path ?? null,
		});

		if (!target) return null;
		this.snapshots.collector.track(dependencyKey.file(target.path, "exists"));
		return Object.freeze({
			path: target.path,
			snapshot: this.snapshots.file(target),
		});
	}

	/** Resolve a runtime link/file target and return its tracked snapshot. */
	resolveFile(linkPath: string, sourcePath: string): TrackedFileSnapshot | null {
		return this.resolveFileTarget(linkPath, sourcePath)?.snapshot ?? null;
	}

	/** Metadata-only linked property access. This never materializes note body text. */
	linkedProperty(
		linkPath: string,
		sourcePath: string,
		property: string,
	): unknown {
		return this.resolveFile(linkPath, sourcePath)?.property(property);
	}

	/** Explicit linked body access; body remains lazy and revision-safe. */
	async linkedBody(linkPath: string, sourcePath: string): Promise<string | null> {
		const target = this.resolveFile(linkPath, sourcePath);
		return target ? target.body() : null;
	}

	requestSynchronousValidation(): void {
		this.snapshots.requestSynchronousValidation();
	}

	async settleSynchronousValidation(): Promise<boolean> {
		return this.snapshots.settleSynchronousValidation();
	}

	isSynchronouslyCurrent(): boolean {
		if (!this.snapshots.isSynchronouslyCurrent()) return false;
		for (const observation of this.resolutionObservations.values()) {
			const current = this.resolver.resolve(observation.linkPath, observation.sourcePath);
			if ((current?.path ?? null) !== observation.targetPath) return false;
		}
		return true;
	}

	dependencies(): ReadonlySet<DependencyKey> {
		return this.snapshots.dependencies();
	}
}
