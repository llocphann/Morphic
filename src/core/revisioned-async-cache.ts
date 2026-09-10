import { RevisionStore, type DependencyKey } from "./dependencies";

export interface RevisionedAsyncCacheOptions {
	limit?: number;
}

export interface RevisionedAsyncCacheStats {
	readonly entries: number;
	readonly inFlight: number;
	readonly limit: number;
	readonly warmHits: number;
	readonly inFlightHits: number;
	readonly loads: number;
}

interface CacheEntry<Value> {
	readonly fingerprint: string;
	readonly value: Value;
}

interface InFlightToken {
	invalidated: boolean;
}

interface InFlightEntry<Value> {
	readonly cacheKey: string;
	readonly dependencyKeys: ReadonlySet<DependencyKey>;
	readonly promise: Promise<Value>;
	readonly token: InFlightToken;
}

/**
 * Bounded async data cache keyed by a caller-defined identity plus dependency
 * revisions.
 *
 * Intended consumers include normalized Bases/query data and other expensive
 * data-side operations whose result is safe to share across render owners.
 * The cache owns no lifecycle resources and never retains TFile/View/DOM refs
 * unless a caller puts them inside Value (callers must not do that).
 *
 * Correctness contract:
 * - identical key + revision vector shares one in-flight loader;
 * - warm data is reused only while the exact dependency fingerprint matches;
 * - an old revision may resolve to its original caller but cannot populate the
 *   warm cache after any dependency advances;
 * - clear() prevents already-running work from repopulating the cache;
 * - targeted clear invalidates only that cache identity, not unrelated work;
 * - stale/superseded promises cannot delete a newer in-flight entry;
 * - at most one revision fingerprint per cache identity + dependency set remains joinable in-flight;
 * - retained warm entries are bounded with LRU eviction.
 */
export class RevisionedAsyncDataCache<Value> {
	private readonly entries = new Map<string, CacheEntry<Value>>();
	private readonly inFlight = new Map<string, InFlightEntry<Value>>();
	private readonly limit: number;
	private generation = 0;
	private warmHits = 0;
	private inFlightHits = 0;
	private loads = 0;

	constructor(
		private readonly revisions: RevisionStore,
		options: RevisionedAsyncCacheOptions = {},
	) {
		this.limit = positiveLimit(options.limit, 64);
	}

	get(
		cacheKey: string,
		dependencies: Iterable<DependencyKey>,
		load: () => Promise<Value> | Value,
	): Promise<Value> {
		// Materialize once so one-shot iterables can both feed the revision vector
		// and identify the dependency-set shape for safe supersession below.
		const dependencyKeys = new Set(dependencies);
		const revisionVector = this.revisions.capture(dependencyKeys);
		const fingerprint = revisionVector.fingerprint;
		const cached = this.entries.get(cacheKey);
		if (cached && cached.fingerprint === fingerprint) {
			this.warmHits++;
			touch(this.entries, cacheKey, cached);
			return Promise.resolve(cached.value);
		}

		const inFlightKey = makeInFlightKey(cacheKey, fingerprint);
		const existing = this.inFlight.get(inFlightKey);
		if (existing) {
			this.inFlightHits++;
			return existing.promise;
		}

		// A newer revision of the same dependency set makes older revisions of that
		// shape permanently stale (RevisionStore revisions do not move backwards).
		// Different dependency sets for the same caller cacheKey may remain valid
		// concurrently and must keep exact key+fingerprint dedup semantics.
		this.supersedeInFlight(cacheKey, dependencyKeys);

		const generation = this.generation;
		const token: InFlightToken = { invalidated: false };
		this.loads++;
		let loaded: Promise<Value>;
		try {
			loaded = Promise.resolve(load());
		} catch (error) {
			loaded = Promise.reject(toError(error));
		}
		const promise = loaded.then(
			value => {
				this.deleteInFlightIfCurrent(inFlightKey, token);
				if (
					!token.invalidated
					&& this.generation === generation
					&& revisionVector.isCurrent()
				) {
					this.entries.set(cacheKey, { fingerprint, value });
					trimCache(this.entries, this.limit);
				}
				return value;
			},
			error => {
				this.deleteInFlightIfCurrent(inFlightKey, token);
				throw error;
			},
		);

		this.inFlight.set(inFlightKey, { cacheKey, dependencyKeys, promise, token });
		return promise;
	}

	clear(cacheKey?: string): void {
		if (cacheKey === undefined) {
			this.generation++;
			this.entries.clear();
			this.inFlight.clear();
			return;
		}

		this.entries.delete(cacheKey);
		for (const [key, entry] of this.inFlight) {
			if (entry.cacheKey !== cacheKey) continue;
			entry.token.invalidated = true;
			this.inFlight.delete(key);
		}
	}

	stats(): RevisionedAsyncCacheStats {
		return Object.freeze({
			entries: this.entries.size,
			inFlight: this.inFlight.size,
			limit: this.limit,
			warmHits: this.warmHits,
			inFlightHits: this.inFlightHits,
			loads: this.loads,
		});
	}

	private supersedeInFlight(cacheKey: string, dependencyKeys: ReadonlySet<DependencyKey>): void {
		for (const [key, entry] of this.inFlight) {
			if (entry.cacheKey !== cacheKey || !sameSet(entry.dependencyKeys, dependencyKeys)) continue;
			entry.token.invalidated = true;
			this.inFlight.delete(key);
		}
	}

	private deleteInFlightIfCurrent(inFlightKey: string, token: InFlightToken): void {
		if (this.inFlight.get(inFlightKey)?.token === token) this.inFlight.delete(inFlightKey);
	}
}

function makeInFlightKey(cacheKey: string, fingerprint: string): string {
	// Both values may contain arbitrary user-derived bytes, including NUL. Prefix
	// the caller key with its exact UTF-16 length so the boundary is unambiguous.
	return `${cacheKey.length}:${cacheKey}${fingerprint}`;
}

function sameSet<Value>(left: ReadonlySet<Value>, right: ReadonlySet<Value>): boolean {
	if (left.size !== right.size) return false;
	for (const value of left) if (!right.has(value)) return false;
	return true;
}

function positiveLimit(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

function touch<Key, Value>(map: Map<Key, Value>, key: Key, value: Value): void {
	map.delete(key);
	map.set(key, value);
}

function trimCache<Key, Value>(map: Map<Key, Value>, limit: number): void {
	while (map.size > limit) {
		const first = map.keys().next();
		if (first.done) return;
		map.delete(first.value);
	}
}
