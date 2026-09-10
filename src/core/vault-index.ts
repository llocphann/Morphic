import { dependencyKey, type DependencyCollector, type DependencyKey } from "./dependencies";
import type { FileMetadataSnapshot } from "./file-snapshot";

/**
 * Incremental vault metadata index used by settings/runtime lookups.
 * Updates return the exact dependency keys whose query results or file data
 * changed so Bot 1 can route them through InvalidationEngine.invalidateMany().
 */
export class VaultIndex {
	private readonly entries = new Map<string, FileMetadataSnapshot>();
	private readonly folders = new Set<string>();
	private readonly byFolder = new Map<string, Set<string>>();
	private readonly byTag = new Map<string, Set<string>>();
	private readonly byProperty = new Map<string, Set<string>>();
	private readonly byPropertyValue = new Map<string, Set<string>>();
	private readonly suggestionValuesByProperty = new Map<string, Map<string, Set<string>>>();

	private pathListCache: readonly string[] | undefined;
	private folderListCache: readonly string[] | undefined;
	private tagListCache: readonly string[] | undefined;
	private propertyListCache: readonly string[] | undefined;
	private readonly propertySuggestionListCache = new Map<string, readonly string[]>();

	/**
	 * Rebuild from bootstrap snapshots without materializing invalidation diffs.
	 * Bootstrap runs before dependency ownership exists, so new unique paths can
	 * populate the index directly. Duplicate paths fall back to ordinary upsert()
	 * so replacement semantics stay byte-for-byte equivalent to incremental use.
	 * An explicitly supplied folder registry remains authoritative and preserves
	 * empty folders; when omitted, file-derived ancestor folders are retained.
	 */
	bootstrap(
		snapshots: Iterable<FileMetadataSnapshot>,
		folderPaths?: Iterable<string>,
	): void {
		this.clear();
		for (const snapshot of snapshots) {
			if (this.entries.has(snapshot.path)) {
				this.upsert(snapshot);
				continue;
			}
			this.entries.set(snapshot.path, snapshot);
			this.addMemberships(snapshot);
			for (const folder of folderAncestors(snapshot.folder)) this.folders.add(folder);
		}

		if (folderPaths !== undefined) {
			this.folders.clear();
			for (const folder of ancestorClosedFolderSet(folderPaths)) this.folders.add(folder);
		}
	}

	upsert(next: FileMetadataSnapshot): readonly DependencyKey[] {
		const changed = new Set<DependencyKey>();
		const previous = this.entries.get(next.path);

		// Vault `modify` advances TFile.stat before MetadataCache refreshes. The
		// ReactiveDataCore intentionally derives `next` from the already-indexed
		// snapshot in that path, preserving every non-stat value/reference. Handle
		// that narrow shape without removing/re-adding tag/folder/property indexes.
		if (previous && sharesNonStatSnapshotData(previous, next)) {
			let metadataChanged = false;
			for (const field of ["size", "ctime", "mtime"] as const) {
				if (previous[field] === next[field]) continue;
				changed.add(dependencyKey.file(next.path, "stat", field));
				metadataChanged = true;
			}
			if (metadataChanged) changed.add(dependencyKey.file(next.path, "metadata"));
			this.entries.set(next.path, next);
			return Array.from(changed);
		}

		// MetadataCache refreshes allocate fresh arrays/frontmatter objects even when
		// every value owned by VaultIndex is unchanged. Preserve the newest snapshot
		// (notably embeds, which are routed by the outer exact-dependency layer) while
		// avoiding remove/re-add churn across every membership index.
		if (previous && sameIndexedSnapshotData(previous, next)) {
			this.entries.set(next.path, next);
			return [];
		}

		const coarseBefore = this.captureCoarseState(previous, next);

		if (!previous) {
			changed.add(dependencyKey.file(next.path, "exists"));
			changed.add(dependencyKey.file(next.path, "metadata"));
			changed.add(dependencyKey.index("files"));
			this.pathListCache = undefined;
			this.addAllFileDependencyKeys(changed, next);
			this.addAllIndexDependencyKeys(changed, next);
		} else {
			this.collectChangedFileKeys(changed, previous, next);
			this.collectChangedIndexKeys(changed, previous, next);
		}

		if (previous) this.removeMemberships(previous);
		this.entries.set(next.path, next);
		this.addMemberships(next);
		this.ensureFolder(next.folder, changed);
		this.collectCoarseIndexChanges(changed, coarseBefore);
		return Array.from(changed);
	}

	remove(path: string): readonly DependencyKey[] {
		const previous = this.entries.get(path);
		if (!previous) return [];
		const changed = new Set<DependencyKey>();
		const coarseBefore = this.captureCoarseState(previous, undefined);

		changed.add(dependencyKey.file(path, "exists"));
		changed.add(dependencyKey.file(path, "metadata"));
		changed.add(dependencyKey.file(path, "content"));
		changed.add(dependencyKey.index("files"));
		this.pathListCache = undefined;
		this.addAllFileDependencyKeys(changed, previous);
		this.addAllIndexDependencyKeys(changed, previous);

		this.removeMemberships(previous);
		this.entries.delete(path);
		this.collectCoarseIndexChanges(changed, coarseBefore);
		return Array.from(changed);
	}

	/** Rename is diffed atomically so unchanged tag/property universes stay valid. */
	rename(oldPath: string, next: FileMetadataSnapshot): readonly DependencyKey[] {
		const previous = this.entries.get(oldPath);
		if (!previous) return this.upsert(next);

		const changed = new Set<DependencyKey>();
		const coarseBefore = this.captureCoarseState(previous, next);
		changed.add(dependencyKey.index("files"));
		this.pathListCache = undefined;

		for (const path of [oldPath, next.path]) {
			changed.add(dependencyKey.file(path, "exists"));
			changed.add(dependencyKey.file(path, "metadata"));
			changed.add(dependencyKey.file(path, "content"));
		}
		this.addAllFileDependencyKeys(changed, previous);
		this.addAllIndexDependencyKeys(changed, previous);
		this.addAllFileDependencyKeys(changed, next);
		this.addAllIndexDependencyKeys(changed, next);

		this.removeMemberships(previous);
		this.entries.delete(oldPath);
		this.entries.set(next.path, next);
		this.addMemberships(next);
		this.ensureFolder(next.folder, changed);
		this.collectCoarseIndexChanges(changed, coarseBefore);
		return Array.from(changed);
	}

	/** Replace the known folder registry after a one-time vault-tree bootstrap. */
	replaceFolders(paths: Iterable<string>): readonly DependencyKey[] {
		const next = ancestorClosedFolderSet(paths);
		const changed = new Set<DependencyKey>();
		for (const path of symmetricDifference(this.folders, next)) {
			changed.add(dependencyKey.index("folder-exists", path));
		}
		if (!sameStringSet(this.folders, next)) {
			changed.add(dependencyKey.index("folders"));
			this.folderListCache = undefined;
		}
		this.folders.clear();
		for (const path of next) this.folders.add(path);
		return Array.from(changed);
	}

	addFolder(path: string): readonly DependencyKey[] {
		const added: string[] = [];
		for (const candidate of folderAncestors(path)) {
			if (this.folders.has(candidate)) continue;
			this.folders.add(candidate);
			added.push(candidate);
		}
		if (added.length === 0) return [];
		this.folderListCache = undefined;
		return [
			dependencyKey.index("folders"),
			...added.map(candidate => dependencyKey.index("folder-exists", candidate)),
		];
	}

	removeFolder(path: string): readonly DependencyKey[] {
		if (!this.folders.delete(path)) return [];
		this.folderListCache = undefined;
		return [dependencyKey.index("folders"), dependencyKey.index("folder-exists", path)];
	}

	renameFolder(oldPath: string, newPath: string): readonly DependencyKey[] {
		if (oldPath === newPath) return [];
		const changed = new Set<DependencyKey>(this.removeFolder(oldPath));
		for (const key of this.addFolder(newPath)) changed.add(key);
		return Array.from(changed);
	}

	get(path: string, collector?: DependencyCollector): FileMetadataSnapshot | undefined {
		collector?.track(dependencyKey.file(path, "exists"));
		return this.entries.get(path);
	}

	allPaths(collector?: DependencyCollector): readonly string[] {
		collector?.track(dependencyKey.index("files"));
		if (!this.pathListCache) this.pathListCache = sorted(this.entries.keys());
		return this.pathListCache;
	}

	folderPaths(collector?: DependencyCollector): readonly string[] {
		collector?.track(dependencyKey.index("folders"));
		if (!this.folderListCache) this.folderListCache = sorted(this.folders);
		return this.folderListCache;
	}

	filesInFolder(folder: string, collector?: DependencyCollector): readonly string[] {
		collector?.track(dependencyKey.index("folder", folder));
		return sorted(this.byFolder.get(folder) ?? []);
	}

	allTags(collector?: DependencyCollector): readonly string[] {
		collector?.track(dependencyKey.index("tags"));
		if (!this.tagListCache) this.tagListCache = sorted(this.byTag.keys());
		return this.tagListCache;
	}

	filesWithTag(tag: string, collector?: DependencyCollector): readonly string[] {
		const normalized = tag.startsWith("#") ? tag : `#${tag}`;
		collector?.track(dependencyKey.index("tag", normalized));
		return sorted(this.byTag.get(normalized) ?? []);
	}

	propertyNames(collector?: DependencyCollector): readonly string[] {
		collector?.track(dependencyKey.index("properties"));
		if (!this.propertyListCache) this.propertyListCache = sorted(this.byProperty.keys());
		return this.propertyListCache;
	}

	filesWithProperty(name: string, collector?: DependencyCollector): readonly string[] {
		collector?.track(dependencyKey.index("property", name));
		return sorted(this.byProperty.get(name) ?? []);
	}

	propertySuggestionValues(name: string, collector?: DependencyCollector): readonly string[] {
		collector?.track(dependencyKey.index("property-values", name));
		const cached = this.propertySuggestionListCache.get(name);
		if (cached) return cached;
		const values = sorted(this.suggestionValuesByProperty.get(name)?.keys() ?? []);
		this.propertySuggestionListCache.set(name, values);
		return values;
	}

	filesWithPropertyValue(name: string, value: unknown, collector?: DependencyCollector): readonly string[] {
		const key = propertyValueIndexKey(name, value);
		collector?.track(key);
		return sorted(this.byPropertyValue.get(key) ?? []);
	}

	clear(): void {
		this.entries.clear();
		this.folders.clear();
		this.byFolder.clear();
		this.byTag.clear();
		this.byProperty.clear();
		this.byPropertyValue.clear();
		this.suggestionValuesByProperty.clear();
		this.pathListCache = undefined;
		this.folderListCache = undefined;
		this.tagListCache = undefined;
		this.propertyListCache = undefined;
		this.propertySuggestionListCache.clear();
	}

	private collectChangedFileKeys(
		changed: Set<DependencyKey>,
		previous: FileMetadataSnapshot,
		next: FileMetadataSnapshot,
	): void {
		let metadataChanged = false;
		const fileFields: Array<"name" | "basename" | "path" | "folder" | "extension"> = [
			"name", "basename", "path", "folder", "extension",
		];
		for (const field of fileFields) {
			if (previous[field] !== next[field]) {
				changed.add(dependencyKey.file(next.path, "file", field));
				metadataChanged = true;
			}
		}

		const statFields: Array<"size" | "ctime" | "mtime"> = ["size", "ctime", "mtime"];
		for (const field of statFields) {
			if (previous[field] !== next[field]) {
				changed.add(dependencyKey.file(next.path, "stat", field));
				metadataChanged = true;
			}
		}

		if (!sameStringArray(previous.tags, next.tags)) {
			changed.add(dependencyKey.file(next.path, "tags"));
			metadataChanged = true;
		}
		if (!sameStringArray(previous.links, next.links)) {
			changed.add(dependencyKey.file(next.path, "links"));
			metadataChanged = true;
		}

		for (const property of propertiesFrom(previous, next)) {
			if (!sameValue(previous.frontmatter[property], next.frontmatter[property])) {
				changed.add(dependencyKey.file(next.path, "frontmatter", property));
				metadataChanged = true;
			}
		}

		if (metadataChanged) changed.add(dependencyKey.file(next.path, "metadata"));
	}

	private collectChangedIndexKeys(
		changed: Set<DependencyKey>,
		previous: FileMetadataSnapshot,
		next: FileMetadataSnapshot,
	): void {
		if (previous.folder !== next.folder) {
			changed.add(dependencyKey.index("folder", previous.folder));
			changed.add(dependencyKey.index("folder", next.folder));
		}

		for (const tag of symmetricDifference(previous.tags, next.tags)) {
			changed.add(dependencyKey.index("tag", tag));
		}

		for (const property of propertiesFrom(previous, next)) {
			const had = Object.prototype.hasOwnProperty.call(previous.frontmatter, property);
			const has = Object.prototype.hasOwnProperty.call(next.frontmatter, property);
			if (had !== has) changed.add(dependencyKey.index("property", property));

			const previousValue: unknown = previous.frontmatter[property];
			const nextValue: unknown = next.frontmatter[property];
			if (!sameValue(previousValue, nextValue)) {
				if (had) changed.add(propertyValueIndexKey(property, previousValue));
				if (has) changed.add(propertyValueIndexKey(property, nextValue));
			}
		}
	}

	private addAllFileDependencyKeys(changed: Set<DependencyKey>, snapshot: FileMetadataSnapshot): void {
		for (const field of ["name", "basename", "path", "folder", "extension"]) {
			changed.add(dependencyKey.file(snapshot.path, "file", field));
		}
		for (const field of ["size", "ctime", "mtime"]) {
			changed.add(dependencyKey.file(snapshot.path, "stat", field));
		}
		changed.add(dependencyKey.file(snapshot.path, "tags"));
		changed.add(dependencyKey.file(snapshot.path, "links"));
		for (const property of Object.keys(snapshot.frontmatter)) {
			changed.add(dependencyKey.file(snapshot.path, "frontmatter", property));
		}
	}

	private addAllIndexDependencyKeys(changed: Set<DependencyKey>, snapshot: FileMetadataSnapshot): void {
		changed.add(dependencyKey.index("folder", snapshot.folder));
		for (const tag of new Set(snapshot.tags)) changed.add(dependencyKey.index("tag", tag));
		for (const property of Object.keys(snapshot.frontmatter)) {
			changed.add(dependencyKey.index("property", property));
			changed.add(propertyValueIndexKey(property, snapshot.frontmatter[property]));
		}
	}

	private addMemberships(snapshot: FileMetadataSnapshot): void {
		addMembership(this.byFolder, snapshot.folder, snapshot.path);
		for (const tag of new Set(snapshot.tags)) addMembership(this.byTag, tag, snapshot.path);
		for (const property of Object.keys(snapshot.frontmatter)) {
			const value: unknown = snapshot.frontmatter[property];
			addMembership(this.byProperty, property, snapshot.path);
			addMembership(this.byPropertyValue, propertyValueIndexKey(property, value), snapshot.path);
			for (const suggestionValue of suggestionValues(value)) {
				addNestedMembership(this.suggestionValuesByProperty, property, suggestionValue, snapshot.path);
			}
		}
	}

	private removeMemberships(snapshot: FileMetadataSnapshot): void {
		removeMembership(this.byFolder, snapshot.folder, snapshot.path);
		for (const tag of new Set(snapshot.tags)) removeMembership(this.byTag, tag, snapshot.path);
		for (const property of Object.keys(snapshot.frontmatter)) {
			const value: unknown = snapshot.frontmatter[property];
			removeMembership(this.byProperty, property, snapshot.path);
			removeMembership(this.byPropertyValue, propertyValueIndexKey(property, value), snapshot.path);
			for (const suggestionValue of suggestionValues(value)) {
				removeNestedMembership(this.suggestionValuesByProperty, property, suggestionValue, snapshot.path);
			}
		}
	}

	private ensureFolder(path: string, changed: Set<DependencyKey>): void {
		for (const key of this.addFolder(path)) changed.add(key);
	}

	private captureCoarseState(
		previous: FileMetadataSnapshot | undefined,
		next: FileMetadataSnapshot | undefined,
	): CoarseIndexState {
		const tagExistence = new Map<string, boolean>();
		for (const tag of unionStrings(previous?.tags ?? [], next?.tags ?? [])) {
			tagExistence.set(tag, this.byTag.has(tag));
		}

		const propertyExistence = new Map<string, boolean>();
		const propertyValueExistence = new Map<string, Map<string, boolean>>();
		for (const property of propertiesFrom(previous, next)) {
			propertyExistence.set(property, this.byProperty.has(property));
			const values = unionStrings(
				suggestionValues(previous?.frontmatter[property]),
				suggestionValues(next?.frontmatter[property]),
			);
			const existingValues = this.suggestionValuesByProperty.get(property);
			const existence = new Map<string, boolean>();
			for (const value of values) existence.set(value, existingValues?.has(value) ?? false);
			propertyValueExistence.set(property, existence);
		}

		return { tagExistence, propertyExistence, propertyValueExistence };
	}

	private collectCoarseIndexChanges(changed: Set<DependencyKey>, before: CoarseIndexState): void {
		for (const [tag, existed] of before.tagExistence) {
			if (this.byTag.has(tag) !== existed) {
				changed.add(dependencyKey.index("tags"));
				this.tagListCache = undefined;
				break;
			}
		}

		for (const [property, existed] of before.propertyExistence) {
			if (this.byProperty.has(property) !== existed) {
				changed.add(dependencyKey.index("properties"));
				this.propertyListCache = undefined;
				break;
			}
		}

		for (const [property, values] of before.propertyValueExistence) {
			const nextValues = this.suggestionValuesByProperty.get(property);
			for (const [value, existed] of values) {
				if ((nextValues?.has(value) ?? false) !== existed) {
					changed.add(dependencyKey.index("property-values", property));
					this.propertySuggestionListCache.delete(property);
					break;
				}
			}
		}
	}
}

interface CoarseIndexState {
	readonly tagExistence: ReadonlyMap<string, boolean>;
	readonly propertyExistence: ReadonlyMap<string, boolean>;
	readonly propertyValueExistence: ReadonlyMap<string, ReadonlyMap<string, boolean>>;
}

export function propertyValueIndexKey(name: string, value: unknown): DependencyKey {
	return dependencyKey.index("property-value", `${name}=${stableValueKey(value)}`);
}

function propertiesFrom(
	left: FileMetadataSnapshot | undefined,
	right: FileMetadataSnapshot | undefined,
): readonly string[] {
	return sorted(new Set<string>([
		...Object.keys(left?.frontmatter ?? {}),
		...Object.keys(right?.frontmatter ?? {}),
	]));
}

function suggestionValues(value: unknown): readonly string[] {
	const values: readonly unknown[] = Array.isArray(value) ? value : [value];
	const result = new Set<string>();
	for (const item of values) {
		let text: string | null = null;
		if (typeof item === "string") text = item.trim();
		else if (typeof item === "number" || typeof item === "boolean" || typeof item === "bigint") {
			text = item.toString().trim();
		}
		if (text) result.add(text);
	}
	return Array.from(result);
}

function addMembership(index: Map<string, Set<string>>, key: string, path: string): void {
	let paths = index.get(key);
	if (!paths) {
		paths = new Set<string>();
		index.set(key, paths);
	}
	paths.add(path);
}

function removeMembership(index: Map<string, Set<string>>, key: string, path: string): void {
	const paths = index.get(key);
	if (!paths) return;
	paths.delete(path);
	if (paths.size === 0) index.delete(key);
}

function addNestedMembership(
	index: Map<string, Map<string, Set<string>>>,
	property: string,
	value: string,
	path: string,
): void {
	let values = index.get(property);
	if (!values) {
		values = new Map<string, Set<string>>();
		index.set(property, values);
	}
	addMembership(values, value, path);
}

function removeNestedMembership(
	index: Map<string, Map<string, Set<string>>>,
	property: string,
	value: string,
	path: string,
): void {
	const values = index.get(property);
	if (!values) return;
	removeMembership(values, value, path);
	if (values.size === 0) index.delete(property);
}

function folderAncestors(path: string): readonly string[] {
	if (!path) return [];
	const parts = path.split("/").filter(part => part.length > 0);
	const result: string[] = [];
	let current = "";
	for (const part of parts) {
		current = current ? `${current}/${part}` : part;
		result.push(current);
	}
	return result;
}

function ancestorClosedFolderSet(paths: Iterable<string>): Set<string> {
	const result = new Set<string>();
	for (const path of paths) {
		for (const ancestor of folderAncestors(path)) result.add(ancestor);
	}
	return result;
}

function sorted(values: Iterable<string>): readonly string[] {
	return Array.from(values).sort();
}

function unionStrings(left: Iterable<string>, right: Iterable<string>): readonly string[] {
	return Array.from(new Set<string>([...left, ...right]));
}

function symmetricDifference(left: Iterable<string>, right: Iterable<string>): readonly string[] {
	const leftSet = new Set(left);
	const rightSet = new Set(right);
	const changed = new Set<string>();
	for (const value of leftSet) if (!rightSet.has(value)) changed.add(value);
	for (const value of rightSet) if (!leftSet.has(value)) changed.add(value);
	return Array.from(changed);
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
	if (left.length !== right.length) return false;
	for (let i = 0; i < left.length; i++) {
		if (left[i] !== right[i]) return false;
	}
	return true;
}

function sameStringSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
	if (left.size !== right.size) return false;
	for (const value of left) if (!right.has(value)) return false;
	return true;
}

/** Narrow identity-based fast-path guard for ReactiveDataCore's stat-only clone. */
function sharesNonStatSnapshotData(left: FileMetadataSnapshot, right: FileMetadataSnapshot): boolean {
	return left.path === right.path
		&& left.name === right.name
		&& left.basename === right.basename
		&& left.extension === right.extension
		&& left.folder === right.folder
		&& left.tags === right.tags
		&& left.links === right.links
		&& left.embeds === right.embeds
		&& left.frontmatter === right.frontmatter;
}

/** Semantic equality for every observable value owned by VaultIndex itself. */
function sameIndexedSnapshotData(left: FileMetadataSnapshot, right: FileMetadataSnapshot): boolean {
	return left.path === right.path
		&& left.name === right.name
		&& left.basename === right.basename
		&& left.extension === right.extension
		&& left.folder === right.folder
		&& left.size === right.size
		&& left.ctime === right.ctime
		&& left.mtime === right.mtime
		&& sameStringArray(left.tags, right.tags)
		&& sameStringArray(left.links, right.links)
		&& sameFrontmatter(left.frontmatter, right.frontmatter);
}

function sameFrontmatter(
	left: Readonly<Record<string, unknown>>,
	right: Readonly<Record<string, unknown>>,
): boolean {
	const leftKeys = Object.keys(left);
	const rightKeys = Object.keys(right);
	if (leftKeys.length !== rightKeys.length) return false;
	for (const key of leftKeys) {
		if (!Object.prototype.hasOwnProperty.call(right, key)) return false;
		if (!sameValue(left[key], right[key])) return false;
	}
	return true;
}

function sameValue(left: unknown, right: unknown): boolean {
	return stableValueKey(left) === stableValueKey(right);
}

interface StableValueState {
	readonly activeIds: Map<object, number>;
	nextId: number;
}

/**
 * Collision-safe canonical value encoding.
 * Object identity matters only while the object is active on the recursion path,
 * so shared/YAML-alias references remain structurally equal to expanded values.
 */
function stableValueKey(
	value: unknown,
	state: StableValueState = { activeIds: new Map<object, number>(), nextId: 0 },
): string {
	if (value === null) return JSON.stringify(["null"]);
	if (value === undefined) return JSON.stringify(["undefined"]);

	switch (typeof value) {
		case "string":
			return JSON.stringify(["string", value]);
		case "number":
			return JSON.stringify(["number", numberValueKey(value)]);
		case "boolean":
			return JSON.stringify(["boolean", value]);
		case "bigint":
			return JSON.stringify(["bigint", value.toString()]);
		case "symbol":
			return JSON.stringify(["symbol", value.description ?? ""]);
		case "function":
			return JSON.stringify(["function", value.name]);
	}

	const activeId = state.activeIds.get(value);
	if (activeId !== undefined) return JSON.stringify(["ref", activeId]);
	const id = state.nextId++;
	state.activeIds.set(value, id);

	let encoded: string;
	if (Array.isArray(value)) {
		encoded = JSON.stringify(["array", id, value.map(item => stableValueKey(item, state))]);
	} else if (value instanceof Date) {
		encoded = JSON.stringify(["date", id, numberValueKey(value.getTime())]);
	} else if (value instanceof RegExp) {
		encoded = JSON.stringify(["regexp", id, value.source, value.flags]);
	} else if (value instanceof Map) {
		const entries = Array.from(value.entries()).map(([key, entryValue]) => [
			stableValueKey(key, state),
			stableValueKey(entryValue, state),
		] as const);
		encoded = JSON.stringify(["map", id, entries]);
	} else if (value instanceof Set) {
		const entries = Array.from(value.values()).map(item => stableValueKey(item, state));
		encoded = JSON.stringify(["set", id, entries]);
	} else {
		const record = value as Record<string, unknown>;
		const entries = Object.keys(record)
			.sort()
			.map(key => [key, stableValueKey(record[key], state)] as const);
		encoded = JSON.stringify(["object", id, entries]);
	}

	state.activeIds.delete(value);
	return encoded;
}

function numberValueKey(value: number): string {
	if (Number.isNaN(value)) return "NaN";
	if (Object.is(value, -0)) return "-0";
	if (value === Number.POSITIVE_INFINITY) return "Infinity";
	if (value === Number.NEGATIVE_INFINITY) return "-Infinity";
	return String(value);
}
