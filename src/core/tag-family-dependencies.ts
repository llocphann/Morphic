import { dependencyKey, type DependencyKey } from "./dependencies";

/**
 * Dependency for native Bases `file.hasTag()` semantics. Obsidian treats a tag
 * as matching both the exact tag and any nested descendant, so `#topic/sub`
 * contributes membership to both `#topic` and `#topic/sub` families.
 */
export function tagFamilyDependencyKey(tag: string): DependencyKey {
	return dependencyKey.index("tag-family", normalizeTag(tag));
}

/**
 * Return only tag-family memberships whose truth changed for one file.
 *
 * Comparing the expanded family sets avoids invalidating `hasTag("topic")`
 * when one nested `#topic/*` tag is replaced by another while the file still
 * belongs to the `#topic` family.
 */
export function collectTagFamilyChanges(
	previousTags: readonly string[],
	nextTags: readonly string[],
): readonly DependencyKey[] {
	// MetadataCache refreshes commonly rebuild the tags array even when every tag
	// is byte-for-byte unchanged. Detect that no-op before allocating/expanding
	// the two nested-family sets. This is only a sufficient equality shortcut;
	// all non-identical sequences still use the canonical family-set comparison.
	if (sameTagSequence(previousTags, nextTags)) return [];

	const previous = expandTagFamilies(previousTags);
	const next = expandTagFamilies(nextTags);
	const changed = new Set<DependencyKey>();

	for (const tag of previous) {
		if (!next.has(tag)) changed.add(tagFamilyDependencyKey(tag));
	}
	for (const tag of next) {
		if (!previous.has(tag)) changed.add(tagFamilyDependencyKey(tag));
	}
	return Array.from(changed);
}

function sameTagSequence(left: readonly string[], right: readonly string[]): boolean {
	if (left.length !== right.length) return false;
	for (let index = 0; index < left.length; index++) {
		if (left[index] !== right[index]) return false;
	}
	return true;
}

function expandTagFamilies(tags: readonly string[]): ReadonlySet<string> {
	const result = new Set<string>();
	for (const tag of tags) {
		const normalized = normalizeTag(tag);
		for (let index = normalized.indexOf("/", 1); index >= 0; index = normalized.indexOf("/", index + 1)) {
			result.add(normalized.slice(0, index));
		}
		result.add(normalized);
	}
	return result;
}

function normalizeTag(tag: string): string {
	return tag.startsWith("#") ? tag : `#${tag}`;
}
