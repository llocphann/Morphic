import { dependencyKey, type DependencyCollector, type DependencyKey, type RevisionStore } from "./dependencies";
import { propertyDataDependencyKey } from "./property-data-dependencies";
import { propertyValueIndexKey, type VaultIndex } from "./vault-index";

interface RevisionedQueryEntry {
	readonly revision: number;
	readonly value: readonly string[];
}

export interface RevisionedVaultQueryCacheStats {
	readonly entries: number;
	readonly limit: number;
}

export interface RevisionedVaultQueryCacheOptions {
	limit?: number;
}

/**
 * Bounded revision-driven cache for sorted VaultIndex query results.
 *
 * VaultIndex owns membership correctness; RevisionStore owns freshness. Repeated
 * consumers therefore reuse the same immutable sorted result until the exact
 * query dependency revision changes, without broad cache flushes or rescans.
 */
export class RevisionedVaultQueryCache {
	private readonly entries = new Map<DependencyKey, RevisionedQueryEntry>();
	private readonly limit: number;

	constructor(
		private readonly index: VaultIndex,
		private readonly revisions: RevisionStore,
		options: RevisionedVaultQueryCacheOptions = {},
	) {
		this.limit = positiveLimit(options.limit, 256);
	}

	allPaths(collector?: DependencyCollector): readonly string[] {
		const key = dependencyKey.index("files");
		return this.read(key, () => this.index.allPaths(), collector);
	}

	folderPaths(collector?: DependencyCollector): readonly string[] {
		const key = dependencyKey.index("folders");
		return this.read(key, () => this.index.folderPaths(), collector);
	}

	filesInFolder(folder: string, collector?: DependencyCollector): readonly string[] {
		const key = dependencyKey.index("folder", folder);
		return this.read(key, () => this.index.filesInFolder(folder), collector);
	}

	allTags(collector?: DependencyCollector): readonly string[] {
		const key = dependencyKey.index("tags");
		return this.read(key, () => this.index.allTags(), collector);
	}

	filesWithTag(tag: string, collector?: DependencyCollector): readonly string[] {
		const normalized = tag.startsWith("#") ? tag : `#${tag}`;
		const key = dependencyKey.index("tag", normalized);
		return this.read(key, () => this.index.filesWithTag(normalized), collector);
	}

	propertyNames(collector?: DependencyCollector): readonly string[] {
		const key = dependencyKey.index("properties");
		return this.read(key, () => this.index.propertyNames(), collector);
	}

	filesWithProperty(name: string, collector?: DependencyCollector): readonly string[] {
		const key = dependencyKey.index("property", name);
		return this.read(key, () => this.index.filesWithProperty(name), collector);
	}

	propertySuggestionValues(name: string, collector?: DependencyCollector): readonly string[] {
		const key = dependencyKey.index("property-values", name);
		return this.read(key, () => this.index.propertySuggestionValues(name), collector);
	}

	/**
	 * Settings compatibility query for one property's autocomplete universe.
	 *
	 * Legacy FrontmatterValueSuggest stringifies every array element, including
	 * null/object/nested-array entries, while scalar null/object values are
	 * ignored. The compact VaultIndex suggestion membership intentionally keeps a
	 * narrower primitive-only universe, so Settings derives its compatibility
	 * view from already-indexed snapshots and keys it to exact property-data
	 * revisions. This is O(files-with-property) only when that property changes,
	 * never O(vault) per typed query.
	 */
	settingsPropertySuggestionValues(name: string, collector?: DependencyCollector): readonly string[] {
		// Keep the established autocomplete dependency visible to Settings owners;
		// property-data is the additional freshness key for legacy-only array values.
		collector?.track(dependencyKey.index("property-values", name));
		const key = propertyDataDependencyKey(name);
		return this.read(key, () => collectLegacyPropertySuggestionValues(this.index, name), collector);
	}

	filesWithPropertyValue(
		name: string,
		value: unknown,
		collector?: DependencyCollector,
	): readonly string[] {
		const key = propertyValueIndexKey(name, value);
		return this.read(key, () => this.index.filesWithPropertyValue(name, value), collector);
	}

	clear(): void {
		this.entries.clear();
	}

	stats(): RevisionedVaultQueryCacheStats {
		return Object.freeze({ entries: this.entries.size, limit: this.limit });
	}

	private read(
		key: DependencyKey,
		load: () => readonly string[],
		collector?: DependencyCollector,
	): readonly string[] {
		collector?.track(key);
		const revision = this.revisions.current(key);
		const cached = this.entries.get(key);
		if (cached && cached.revision === revision) {
			this.entries.delete(key);
			this.entries.set(key, cached);
			return cached.value;
		}

		const loaded = load();
		// VaultIndex query results are readonly by contract and never mutated after
		// return. Freeze that owned result in place instead of allocating a second
		// O(result-size) array solely for cache immutability.
		const value = Object.isFrozen(loaded) ? loaded : Object.freeze(loaded);
		// Replacing an existing Map value does not update insertion order. A stale
		// revision reload is still a real access, so move it to the MRU position just
		// like a cache hit before applying the bounded LRU policy.
		if (cached) this.entries.delete(key);
		this.entries.set(key, { revision, value });
		trimCache(this.entries, this.limit);
		return value;
	}
}

function collectLegacyPropertySuggestionValues(index: VaultIndex, name: string): readonly string[] {
	const result = new Set<string>();
	for (const path of index.filesWithProperty(name)) {
		const value: unknown = index.get(path)?.frontmatter[name];
		if (value === null || value === undefined) continue;

		if (Array.isArray(value)) {
			for (const item of value) {
				const text = String(item).trim();
				if (text.length > 0) result.add(text);
			}
			continue;
		}

		if (
			typeof value === "string" ||
			typeof value === "number" ||
			typeof value === "boolean" ||
			typeof value === "bigint"
		) {
			const text = String(value).trim();
			if (text.length > 0) result.add(text);
		}
	}
	return Array.from(result).sort();
}

function positiveLimit(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? Math.floor(value)
		: fallback;
}

function trimCache<K, V>(map: Map<K, V>, limit: number): void {
	while (map.size > limit) {
		const oldest = map.keys().next().value as K | undefined;
		if (oldest === undefined) break;
		map.delete(oldest);
	}
}
