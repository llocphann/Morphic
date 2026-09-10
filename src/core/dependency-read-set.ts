import {
	DependencyCollector,
	RevisionStore,
	type DependencyKey,
} from "./dependencies";

/**
 * Immutable dependency/revision snapshot captured from one render preparation.
 *
 * The set records the first revision observed for every dependency read. A later
 * invalidation (or revision-floor advance during compaction) therefore makes the
 * snapshot stale even if the owner had not committed that dependency into the
 * reverse index yet.
 */
export class DependencyRevisionReadSet {
	private readonly observed: ReadonlyMap<DependencyKey, number>;

	constructor(
		private readonly revisions: RevisionStore,
		observed: ReadonlyMap<DependencyKey, number>,
	) {
		this.observed = new Map(observed);
	}

	/** Exact dependencies that must be committed if this render is accepted. */
	dependencies(): ReadonlySet<DependencyKey> {
		return new Set(this.observed.keys());
	}

	/**
	 * Ephemeral zero-copy iterator for synchronous reverse-index commit paths.
	 * The read set owns an immutable private snapshot, so callers may consume this
	 * iterator without receiving a mutable Set copy or access to collector state.
	 */
	dependencyIterator(): IterableIterator<DependencyKey> {
		return this.observed.keys();
	}

	/** True only while every dependency remains at the revision first read. */
	isCurrent(): boolean {
		for (const [key, revision] of this.observed) {
			if (this.revisions.current(key) !== revision) return false;
		}
		return true;
	}

	/** Test/diagnostic helper; allocates only when explicitly requested. */
	staleDependencies(): readonly DependencyKey[] {
		const stale: DependencyKey[] = [];
		for (const [key, revision] of this.observed) {
			if (this.revisions.current(key) !== revision) stale.push(key);
		}
		return Object.freeze(stale);
	}
}

/**
 * Dependency collector that also captures the first revision seen for each key.
 *
 * Keeping the first observation is intentional. If a dependency changes midway
 * through an async render and is read again afterward, the render is a mixed-
 * revision preparation and must still be rejected rather than silently adopting
 * the later revision.
 *
 * The observed revision map is also the collector's authoritative key store.
 * Avoiding the inherited per-key Set mirror removes duplicate insertion/storage
 * from every revision-tracked runtime read while preserving the base API.
 */
export class RevisionTrackingDependencyCollector extends DependencyCollector {
	private readonly observed = new Map<DependencyKey, number>();

	constructor(private readonly revisions: RevisionStore) {
		super();
	}

	override track(key: DependencyKey): void {
		if (!this.observed.has(key)) this.observed.set(key, this.revisions.current(key));
	}

	override trackMany(keys: Iterable<DependencyKey>): void {
		for (const key of keys) this.track(key);
	}

	override has(key: DependencyKey): boolean {
		return this.observed.has(key);
	}

	override snapshot(): ReadonlySet<DependencyKey> {
		return new Set(this.observed.keys());
	}

	override clear(): void {
		this.observed.clear();
	}

	/** Freeze the current read contract for a transaction's pre-commit check. */
	readSet(): DependencyRevisionReadSet {
		return new DependencyRevisionReadSet(this.revisions, this.observed);
	}
}
