import {
	dependencyKey,
	type DependencyCollector,
	type DependencyKey,
} from "./dependencies";
import type { FileMetadataSnapshot } from "./file-snapshot";
import { propertyValueIndexKey } from "./vault-index";

export interface PropertyDataChangeOptions {
	/**
	 * Set when the same logical file moved to a different path. Query result rows
	 * can expose file identity/path even when the property's value is unchanged.
	 */
	identityChanged?: boolean;
}

const NO_PROPERTY_DATA_CHANGES: readonly DependencyKey[] = Object.freeze([]);

/** Any note-property row/value change anywhere in the indexed vault. */
export function allPropertyDataDependencyKey(): DependencyKey {
	return dependencyKey.index("property-data");
}

/**
 * Dependency for query semantics that observe any file/value change for one
 * frontmatter property. This is deliberately distinct from:
 *
 * - `index:property:<name>`: property membership only;
 * - `index:property-values:<name>`: unique autocomplete value universe only;
 * - exact `propertyValueIndexKey()`: equality membership for one exact value.
 */
export function propertyDataDependencyKey(name: string): DependencyKey {
	return dependencyKey.index("property-data", name);
}

export function trackPropertyData(
	collector: DependencyCollector,
	name: string,
): void {
	collector.track(propertyDataDependencyKey(name));
}

/**
 * Return exact per-property keys whose observable query rows changed between two
 * metadata snapshots. Structural value equality delegates to the canonical
 * property-value encoder, so YAML alias/reference topology alone is not data.
 *
 * The common refresh path walks the two own-property sets directly instead of
 * materializing Object.keys arrays plus a union Set. Shared properties are
 * visited from `previous`; only next-only properties need the second pass.
 */
export function collectPropertyDataChanges(
	previous: FileMetadataSnapshot | undefined,
	next: FileMetadataSnapshot | undefined,
	options: PropertyDataChangeOptions = {},
): readonly DependencyKey[] {
	const previousFrontmatter = previous?.frontmatter;
	const nextFrontmatter = next?.frontmatter;
	let changed: DependencyKey[] | undefined;

	if (previousFrontmatter !== undefined) {
		for (const property in previousFrontmatter) {
			if (!hasOwn(previousFrontmatter, property)) continue;
			const hasNext = nextFrontmatter !== undefined && hasOwn(nextFrontmatter, property);

			if (options.identityChanged || !hasNext) {
				changed = appendPropertyDataChange(changed, property);
				continue;
			}

			const previousValue: unknown = previousFrontmatter[property];
			const nextValue: unknown = nextFrontmatter[property];
			// Ordinary metadata refreshes frequently reuse the same primitive or object
			// value. Exact identity proves structural equality, so canonicalizing both
			// sides cannot add information. Non-identical values still use the canonical
			// collision-safe encoder below, preserving alias/cycle/value semantics.
			if (Object.is(previousValue, nextValue)) continue;
			if (
				propertyValueIndexKey(property, previousValue)
				!== propertyValueIndexKey(property, nextValue)
			) {
				changed = appendPropertyDataChange(changed, property);
			}
		}
	}

	if (nextFrontmatter !== undefined) {
		for (const property in nextFrontmatter) {
			if (!hasOwn(nextFrontmatter, property)) continue;
			if (previousFrontmatter !== undefined && hasOwn(previousFrontmatter, property)) continue;
			changed = appendPropertyDataChange(changed, property);
		}
	}

	return changed ?? NO_PROPERTY_DATA_CHANGES;
}

/** Exact property keys plus one coarse key for dynamic `file.properties` access. */
export function collectPropertyDataInvalidationKeys(
	previous: FileMetadataSnapshot | undefined,
	next: FileMetadataSnapshot | undefined,
	options: PropertyDataChangeOptions = {},
): readonly DependencyKey[] {
	const exact = collectPropertyDataChanges(previous, next, options);
	return exact.length === 0
		? exact
		: [...exact, allPropertyDataDependencyKey()];
}

function appendPropertyDataChange(
	changed: DependencyKey[] | undefined,
	property: string,
): DependencyKey[] {
	const result = changed ?? [];
	result.push(propertyDataDependencyKey(property));
	return result;
}

function hasOwn(value: Readonly<Record<string, unknown>>, property: string): boolean {
	return Object.prototype.hasOwnProperty.call(value, property) === true;
}
