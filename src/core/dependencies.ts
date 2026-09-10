export type DependencyKey = string;

/** Canonical dependency keys used by the Morphic core. */
export const dependencyKey = {
	file(path: string, aspect: string = "metadata", field?: string): DependencyKey {
		const encodedPath = encodeDependencyComponent(path);
		const encodedAspect = encodeDependencyComponent(aspect);
		return field !== undefined
			? `file:${encodedPath}:${encodedAspect}:${encodeDependencyComponent(field)}`
			: `file:${encodedPath}:${encodedAspect}`;
	},
	settings(viewId?: string): DependencyKey {
		return viewId !== undefined
			? `settings:view:${encodeDependencyComponent(viewId)}`
			: "settings:global";
	},
	base(id: string): DependencyKey {
		return `base:${encodeDependencyComponent(id)}`;
	},
	index(kind: string, value?: string): DependencyKey {
		const encodedKind = encodeDependencyComponent(kind);
		return value === undefined
			? `index:${encodedKind}`
			: `index:${encodedKind}:${encodeDependencyComponent(value)}`;
	},
	time(kind: "now" | "today" | "random"): DependencyKey {
		return `time:${kind}`;
	},
};

/**
 * Keep ordinary dependency diagnostics byte-identical while making delimiter-bearing
 * user components injective. `~` is reserved as the escape marker; values that
 * contain `:` or start with `~` use a length-prefixed form so an encoded component
 * can never equal a different raw/segmented component sequence.
 */
function encodeDependencyComponent(value: string): string {
	if (!value.includes(":") && !value.startsWith("~")) return value;
	return `~${value.length}:${value}`;
}

/** Collects the dependencies actually read during one render. */
export class DependencyCollector {
	private readonly keys = new Set<DependencyKey>();

	track(key: DependencyKey): void {
		this.keys.add(key);
	}

	trackMany(keys: Iterable<DependencyKey>): void {
		for (const key of keys) this.keys.add(key);
	}

	has(key: DependencyKey): boolean {
		return this.keys.has(key);
	}

	snapshot(): ReadonlySet<DependencyKey> {
		return new Set(this.keys);
	}

	clear(): void {
		this.keys.clear();
	}
}

export interface DependencyIndexStats {
	readonly owners: number;
	readonly dependencyKeys: number;
	readonly edges: number;
}

/**
 * Reverse dependency index. Owners are normally RenderController instances.
 * Replacing an owner's dependencies is atomic from the index's perspective.
 */
export class DependencyIndex<Owner> {
	private readonly byDependency = new Map<DependencyKey, Set<Owner>>();
	private readonly byOwner = new Map<Owner, Set<DependencyKey>>();

	replace(owner: Owner, dependencies: Iterable<DependencyKey>): void {
		const next = new Set(dependencies);
		const previous = this.byOwner.get(owner);
		if (next.size > 0 && previous && sameDependencySet(previous, next)) return;

		this.remove(owner);
		// An owner with no dependencies cannot be reached through the reverse index.
		// Do not retain it solely to represent an empty set.
		if (next.size === 0) return;
		this.byOwner.set(owner, next);

		for (const key of next) {
			let owners = this.byDependency.get(key);
			if (!owners) {
				owners = new Set<Owner>();
				this.byDependency.set(key, owners);
			}
			owners.add(owner);
		}
	}

	remove(owner: Owner): void {
		const previous = this.byOwner.get(owner);
		if (!previous) return;

		for (const key of previous) {
			const owners = this.byDependency.get(key);
			if (!owners) continue;
			owners.delete(owner);
			if (owners.size === 0) this.byDependency.delete(key);
		}

		this.byOwner.delete(owner);
	}

	affected(key: DependencyKey): readonly Owner[] {
		return Array.from(this.byDependency.get(key) ?? []);
	}

	affectedMany(keys: Iterable<DependencyKey>): readonly Owner[] {
		const result = new Set<Owner>();
		for (const key of keys) {
			for (const owner of this.byDependency.get(key) ?? []) result.add(owner);
		}
		return Array.from(result);
	}

	dependenciesOf(owner: Owner): ReadonlySet<DependencyKey> {
		return new Set(this.byOwner.get(owner) ?? []);
	}

	dependencyKeys(): ReadonlySet<DependencyKey> {
		return new Set(this.byDependency.keys());
	}

	/** Ephemeral zero-copy key iterator for synchronous internal compaction paths. */
	dependencyKeyIterator(): IterableIterator<DependencyKey> {
		return this.byDependency.keys();
	}

	/** O(1) live membership probe paired with dependencyKeyIterator() during compaction. */
	hasDependencyKey(key: DependencyKey): boolean {
		return this.byDependency.has(key);
	}

	/** O(1) active-key count for hot-path revision-compaction threshold checks. */
	dependencyKeyCount(): number {
		return this.byDependency.size;
	}

	stats(): DependencyIndexStats {
		let edges = 0;
		for (const dependencies of this.byOwner.values()) edges += dependencies.size;
		return Object.freeze({
			owners: this.byOwner.size,
			dependencyKeys: this.byDependency.size,
			edges,
		});
	}
}

function sameDependencySet(left: ReadonlySet<DependencyKey>, right: ReadonlySet<DependencyKey>): boolean {
	if (left.size !== right.size) return false;
	for (const key of left) if (!right.has(key)) return false;
	return true;
}

export interface RevisionStoreStats {
	readonly trackedKeys: number;
}

export interface RevisionCompactionResult {
	readonly removed: number;
	readonly retained: number;
	readonly floorRevision: number;
}

/**
 * Immutable dependency-revision vector captured at one synchronous point.
 * Consumers can reuse the collision-safe fingerprint for cache identity and
 * later validate freshness without re-normalizing/sorting the dependency set.
 */
export interface CapturedRevisionVector {
	readonly fingerprint: string;
	isCurrent(): boolean;
}

/**
 * Sparse monotonic revisions for dependency invalidation and render fingerprints.
 *
 * The implicit floor allows old unowned keys to be pruned without making an old
 * cache token valid again: compaction advances the floor beyond every revision
 * token that existed before the prune.
 */
export class RevisionStore {
	private readonly revisions = new Map<DependencyKey, number>();
	private floorRevision = 0;
	private maxRevision = 0;

	current(key: DependencyKey): number {
		return this.revisions.get(key) ?? this.floorRevision;
	}

	bump(key: DependencyKey): number {
		const next = this.current(key) + 1;
		this.revisions.set(key, next);
		if (next > this.maxRevision) this.maxRevision = next;
		return next;
	}

	fingerprint(keys: Iterable<DependencyKey>): string {
		const entries = Array.from(new Set(keys)).sort();
		let fingerprint = "";
		for (const key of entries) {
			// Length-prefixing the raw key makes separators inside user-derived keys
			// unambiguous. Revisions are decimal digits terminated by `;`, so the
			// resulting vector is injective without escaping or parsing dependency keys.
			fingerprint += `${key.length}:${key}@${this.current(key)};`;
		}
		return fingerprint;
	}

	/**
	 * Capture a normalized revision vector once for async work that needs both a
	 * deterministic cache token and a later currentness check.
	 */
	capture(keys: Iterable<DependencyKey>): CapturedRevisionVector {
		const entries = Array.from(new Set(keys)).sort();
		const observedRevisions = new Array<number>(entries.length);
		let fingerprint = "";
		for (let index = 0; index < entries.length; index++) {
			const key = entries[index];
			const revision = this.current(key);
			observedRevisions[index] = revision;
			fingerprint += `${key.length}:${key}@${revision};`;
		}
		return Object.freeze(new CapturedRevisionVectorSnapshot(
			this,
			entries,
			observedRevisions,
			fingerprint,
		));
	}

	/**
	 * Prune unowned history while preserving active dependency fingerprints.
	 * Preserved implicit keys are materialized at the old floor before the floor
	 * advances, so compaction itself never changes an active owner's fingerprint.
	 * This public path snapshots caller input before mutation, preserving its
	 * original defensive semantics.
	 */
	compact(preserveKeys: Iterable<DependencyKey>): RevisionCompactionResult {
		const preserve = new Set(preserveKeys);
		return this.compactKnownMembership(preserve, key => preserve.has(key));
	}

	/**
	 * Internal zero-copy compaction path for a synchronous, authoritative key
	 * membership source. The caller must keep the iterable and membership probe
	 * consistent for the duration of this call; neither is retained afterward.
	 */
	compactKnownMembership(
		preserveKeys: Iterable<DependencyKey>,
		isPreserved: (key: DependencyKey) => boolean,
	): RevisionCompactionResult {
		const previousFloor = this.floorRevision;
		for (const key of preserveKeys) {
			if (!this.revisions.has(key)) this.revisions.set(key, previousFloor);
		}

		let removed = 0;
		// Map iterators remain valid when the current entry is deleted. Iterate the
		// sparse revision table directly so compaction does not allocate a second
		// O(history) key array while it is trying to reclaim that history.
		for (const key of this.revisions.keys()) {
			if (isPreserved(key)) continue;
			this.revisions.delete(key);
			removed++;
		}

		this.floorRevision = this.maxRevision + 1;
		this.maxRevision = this.floorRevision;
		return Object.freeze({
			removed,
			retained: this.revisions.size,
			floorRevision: this.floorRevision,
		});
	}

	/** O(1) scalar count for compaction-threshold checks without diagnostic allocation. */
	trackedKeyCount(): number {
		return this.revisions.size;
	}

	stats(): RevisionStoreStats {
		return Object.freeze({ trackedKeys: this.revisions.size });
	}

	/** Hard reset for coordinated bootstrap/test teardown; callers must clear dependent caches too. */
	clear(): void {
		this.revisions.clear();
		this.floorRevision = 0;
		this.maxRevision = 0;
	}
}

class CapturedRevisionVectorSnapshot implements CapturedRevisionVector {
	constructor(
		private readonly revisions: RevisionStore,
		private readonly keys: readonly DependencyKey[],
		private readonly observedRevisions: readonly number[],
		readonly fingerprint: string,
	) {}

	isCurrent(): boolean {
		for (let index = 0; index < this.keys.length; index++) {
			if (this.revisions.current(this.keys[index]) !== this.observedRevisions[index]) return false;
		}
		return true;
	}
}
