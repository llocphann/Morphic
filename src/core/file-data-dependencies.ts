import {
	dependencyKey,
	type DependencyCollector,
	type DependencyKey,
} from "./dependencies";
import type { FileMetadataSnapshot } from "./file-snapshot";

export type FileDataField =
	| "name"
	| "basename"
	| "path"
	| "folder"
	| "extension"
	| "size"
	| "ctime"
	| "mtime"
	| "tags"
	| "links"
	| "embeds"
	| "backlinks";

const STORED_FILE_DATA_FIELDS: readonly Exclude<FileDataField, "backlinks">[] = [
	"name",
	"basename",
	"path",
	"folder",
	"extension",
	"size",
	"ctime",
	"mtime",
	"tags",
	"links",
	"embeds",
];

const FILE_DATA_FIELDS: readonly FileDataField[] = [
	...STORED_FILE_DATA_FIELDS,
	"backlinks",
];

/**
 * Coarse-per-field dependency for vault queries that observe a file field across
 * the candidate file universe. This differs from `file:<path>:...`, which owns
 * one concrete file, and from `index:files`, which owns only file membership.
 */
export function fileDataDependencyKey(field: FileDataField): DependencyKey {
	return dependencyKey.index("file-data", field);
}

const ALL_FILE_DATA_DEPENDENCY_KEYS: readonly DependencyKey[] = Object.freeze(
	FILE_DATA_FIELDS.map(fileDataDependencyKey),
);

export function trackFileData(
	collector: DependencyCollector,
	field: FileDataField,
): void {
	collector.track(fileDataDependencyKey(field));
}

/** Return only cross-file field dependencies whose observable values changed. */
export function collectFileDataChanges(
	previous: FileMetadataSnapshot | undefined,
	next: FileMetadataSnapshot | undefined,
): readonly DependencyKey[] {
	if (!previous && !next) return [];
	// Preserve the historical fresh-array return contract while avoiding repeated
	// dependency-key construction for the fixed create/delete vocabulary.
	if (!previous || !next) return ALL_FILE_DATA_DEPENDENCY_KEYS.slice();

	const changed: DependencyKey[] = [];
	for (const field of STORED_FILE_DATA_FIELDS) {
		if (!sameField(fieldValue(previous, field), fieldValue(next, field))) {
			changed.push(fileDataDependencyKey(field));
		}
	}

	// Backlinks are a reverse projection of link/embed resolution. Any source
	// link/embed change, or path identity change, can change another file's
	// backlinks even though the target file's own metadata snapshot is unchanged.
	if (
		previous.path !== next.path
		|| !sameField(previous.links, next.links)
		|| !sameField(previous.embeds ?? [], next.embeds ?? [])
	) {
		changed.push(fileDataDependencyKey("backlinks"));
	}

	return changed;
}

/**
 * Exact per-file metadata dependencies that are not part of the original
 * VaultIndex field vocabulary. This keeps `this.file.embeds` precise while
 * candidate `file.embeds` remains the coarse cross-file dependency above.
 *
 * A broad `file:<path>:metadata` read exposes embeds and frontmatter property
 * presence through FileMetadataSnapshot. Embed-only refreshes and own-property
 * presence changes must therefore advance that broad dependency even when the
 * direct `.property(name)` value remains observationally equal (for example,
 * absent -> own `undefined`).
 */
export function collectExactFileDataChanges(
	previous: FileMetadataSnapshot | undefined,
	next: FileMetadataSnapshot | undefined,
): readonly DependencyKey[] {
	if (!previous && !next) return [];
	const changed: DependencyKey[] = [];
	if (!previous || !next || previous.path !== next.path) {
		if (previous) changed.push(dependencyKey.file(previous.path, "embeds"));
		if (next) changed.push(dependencyKey.file(next.path, "embeds"));
		return changed;
	}

	let metadataChanged = false;
	if (!sameField(previous.embeds ?? [], next.embeds ?? [])) {
		changed.push(dependencyKey.file(next.path, "embeds"));
		metadataChanged = true;
	}
	if (frontmatterPropertyPresenceChanged(previous.frontmatter, next.frontmatter)) {
		metadataChanged = true;
	}
	if (metadataChanged) changed.push(dependencyKey.file(next.path, "metadata"));
	return changed;
}

/**
 * Content writes can update stat fields before MetadataCache refreshes. This
 * helper lets the vault modify adapter advance those query revisions without
 * pretending frontmatter/tags/links/embeds are already fresh.
 */
export function collectFileStatDataChanges(
	previous: FileMetadataSnapshot | undefined,
	file: Pick<FileMetadataSnapshot, "size" | "ctime" | "mtime">,
): readonly DependencyKey[] {
	if (!previous) return [];
	const changed: DependencyKey[] = [];
	for (const field of ["size", "ctime", "mtime"] as const) {
		if (previous[field] !== file[field]) changed.push(fileDataDependencyKey(field));
	}
	return changed;
}

function fieldValue(
	snapshot: FileMetadataSnapshot,
	field: Exclude<FileDataField, "backlinks">,
): unknown {
	return field === "embeds" ? snapshot.embeds ?? [] : snapshot[field];
}

function sameField(left: unknown, right: unknown): boolean {
	if (Array.isArray(left) && Array.isArray(right)) {
		if (left.length !== right.length) return false;
		return left.every((value, index) => value === right[index]);
	}
	return left === right;
}

function frontmatterPropertyPresenceChanged(
	left: Readonly<Record<string, unknown>>,
	right: Readonly<Record<string, unknown>>,
): boolean {
	let leftCount = 0;
	for (const key in left) {
		if (!hasOwn(left, key)) continue;
		leftCount++;
		if (!hasOwn(right, key)) return true;
	}

	let rightCount = 0;
	for (const key in right) {
		if (hasOwn(right, key)) rightCount++;
	}
	return leftCount !== rightCount;
}

function hasOwn(value: Readonly<Record<string, unknown>>, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(value, key) === true;
}
