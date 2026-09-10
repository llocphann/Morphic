import { describe, expect, it } from "vitest";
import { DependencyCollector, RevisionStore, dependencyKey } from "../core/dependencies";
import type { FileMetadataSnapshot } from "../core/file-snapshot";
import { RevisionedVaultQueryCache } from "../core/vault-query-cache";
import { VaultIndex, propertyValueIndexKey } from "../core/vault-index";

describe("RevisionedVaultQueryCache", () => {
	it("reuses a sorted query result until its exact dependency revision changes", () => {
		const index = new VaultIndex();
		const revisions = new RevisionStore();
		const cache = new RevisionedVaultQueryCache(index, revisions);
		index.upsert(metadata({ path: "Notes/B.md", folder: "Notes" }));
		index.upsert(metadata({ path: "Notes/A.md", folder: "Notes" }));

		const first = cache.filesInFolder("Notes");
		const second = cache.filesInFolder("Notes");
		expect(first).toEqual(["Notes/A.md", "Notes/B.md"]);
		expect(second).toBe(first);
		expect(Object.isFrozen(first)).toBe(true);

		revisions.bump(dependencyKey.file("Notes/A.md", "frontmatter", "author"));
		expect(cache.filesInFolder("Notes")).toBe(first);

		index.upsert(metadata({ path: "Notes/C.md", folder: "Notes" }));
		revisions.bump(dependencyKey.index("folder", "Notes"));
		const changed = cache.filesInFolder("Notes");
		expect(changed).not.toBe(first);
		expect(changed).toEqual(["Notes/A.md", "Notes/B.md", "Notes/C.md"]);
	});

	it("invalidates a cached empty result when query membership appears", () => {
		const index = new VaultIndex();
		const revisions = new RevisionStore();
		const cache = new RevisionedVaultQueryCache(index, revisions);
		const empty = cache.filesWithTag("project");
		expect(empty).toEqual([]);

		index.upsert(metadata({ path: "Notes/A.md", tags: ["#project"] }));
		revisions.bump(dependencyKey.index("tag", "#project"));
		const populated = cache.filesWithTag("#project");
		expect(populated).not.toBe(empty);
		expect(populated).toEqual(["Notes/A.md"]);
	});

	it("tracks canonical query keys and preserves property-value precision", () => {
		const index = new VaultIndex();
		const revisions = new RevisionStore();
		const cache = new RevisionedVaultQueryCache(index, revisions);
		index.upsert(metadata({
			path: "Notes/A.md",
			frontmatter: { rating: 9, status: "active" },
		}));
		const collector = new DependencyCollector();

		expect(cache.filesWithPropertyValue("rating", 9, collector)).toEqual(["Notes/A.md"]);
		expect(collector.has(propertyValueIndexKey("rating", 9))).toBe(true);

		const first = cache.filesWithPropertyValue("rating", 9);
		revisions.bump(propertyValueIndexKey("status", "active"));
		expect(cache.filesWithPropertyValue("rating", 9)).toBe(first);
	});

	it("bounds cached query results with LRU eviction", () => {
		const index = new VaultIndex();
		const revisions = new RevisionStore();
		const cache = new RevisionedVaultQueryCache(index, revisions, { limit: 2 });
		index.upsert(metadata({
			path: "Notes/A.md",
			folder: "Notes",
			tags: ["#project"],
			frontmatter: { rating: 9 },
		}));

		cache.allPaths();
		cache.allTags();
		cache.propertyNames();
		expect(cache.stats()).toEqual({ entries: 2, limit: 2 });
	});

	it("treats a stale-revision reload as a fresh LRU access", () => {
		const index = new VaultIndex();
		const revisions = new RevisionStore();
		const cache = new RevisionedVaultQueryCache(index, revisions, { limit: 2 });
		index.upsert(metadata({ path: "A/One.md", folder: "A" }));
		index.upsert(metadata({ path: "B/One.md", folder: "B" }));
		index.upsert(metadata({ path: "C/One.md", folder: "C" }));

		const originalA = cache.filesInFolder("A");
		cache.filesInFolder("B");

		revisions.bump(dependencyKey.index("folder", "A"));
		const refreshedA = cache.filesInFolder("A");
		expect(refreshedA).not.toBe(originalA);
		expect(refreshedA).toEqual(["A/One.md"]);

		cache.filesInFolder("C");
		expect(cache.filesInFolder("A")).toBe(refreshedA);
	});

	it("clears cached results for bootstrap rebuilds that intentionally emit no revisions", () => {
		const index = new VaultIndex();
		const revisions = new RevisionStore();
		const cache = new RevisionedVaultQueryCache(index, revisions);
		index.upsert(metadata({ path: "Notes/A.md" }));
		const before = cache.allPaths();

		index.clear();
		index.upsert(metadata({ path: "Notes/B.md" }));
		cache.clear();
		const after = cache.allPaths();
		expect(after).not.toBe(before);
		expect(after).toEqual(["Notes/B.md"]);
	});
});

function metadata(overrides: Partial<FileMetadataSnapshot>): FileMetadataSnapshot {
	const path = overrides.path ?? "Notes/A.md";
	const name = path.split("/").pop() ?? path;
	const basename = name.replace(/\.md$/, "");
	const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
	return Object.freeze({
		path,
		name,
		basename,
		extension: "md",
		folder,
		size: 1,
		ctime: 1,
		mtime: 1,
		tags: Object.freeze([]),
		links: Object.freeze([]),
		frontmatter: Object.freeze({}),
		...overrides,
	});
}
