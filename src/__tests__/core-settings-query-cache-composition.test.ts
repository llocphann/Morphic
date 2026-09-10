import { describe, expect, it } from "vitest";
import { RevisionStore, dependencyKey } from "../core/dependencies";
import type { FileMetadataSnapshot } from "../core/file-snapshot";
import { propertyDataDependencyKey } from "../core/property-data-dependencies";
import { VaultIndex } from "../core/vault-index";
import { RevisionedVaultQueryCache } from "../core/vault-query-cache";

describe("Settings parity and no-copy Vault query cache composition", () => {
	it("adopts VaultIndex-owned results without copying while preserving revision freshness", () => {
		const index = new VaultIndex();
		const revisions = new RevisionStore();
		const cache = new RevisionedVaultQueryCache(index, revisions);
		index.upsert(metadata("Notes/A.md", { status: "active" }));

		const indexed = index.allPaths();
		const cached = cache.allPaths();
		expect(cached).toBe(indexed);
		expect(Object.isFrozen(cached)).toBe(true);
		expect(index.allPaths()).toBe(cached);

		index.upsert(metadata("Notes/B.md", { status: "queued" }));
		revisions.bump(dependencyKey.index("files"));
		const changed = cache.allPaths();
		expect(changed).not.toBe(cached);
		expect(changed).toEqual(["Notes/A.md", "Notes/B.md"]);
		expect(Object.isFrozen(changed)).toBe(true);
	});

	it("keeps legacy Settings coercion cached by exact property-data revision", () => {
		const index = new VaultIndex();
		const revisions = new RevisionStore();
		const cache = new RevisionedVaultQueryCache(index, revisions);
		index.upsert(metadata("Notes/A.md", {
			status: [null, undefined, { state: "queued" }, ["nested", "pair"], " active "],
			rating: 9,
		}));

		const before = cache.settingsPropertySuggestionValues("status");
		expect(before).toEqual(["[object Object]", "active", "nested,pair", "null", "undefined"]);
		expect(Object.isFrozen(before)).toBe(true);
		expect(cache.settingsPropertySuggestionValues("status")).toBe(before);

		revisions.bump(propertyDataDependencyKey("rating"));
		expect(cache.settingsPropertySuggestionValues("status")).toBe(before);

		index.upsert(metadata("Notes/A.md", { status: [{ state: "active" }], rating: 10 }));
		revisions.bump(propertyDataDependencyKey("status"));
		const after = cache.settingsPropertySuggestionValues("status");
		expect(after).not.toBe(before);
		expect(after).toEqual(["[object Object]"]);
		expect(Object.isFrozen(after)).toBe(true);
	});
});

function metadata(path: string, frontmatter: Record<string, unknown>): FileMetadataSnapshot {
	const name = path.split("/").pop() ?? path;
	return Object.freeze({
		path,
		name,
		basename: name.replace(/\.md$/, ""),
		extension: "md",
		folder: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "",
		size: 1,
		ctime: 1,
		mtime: 1,
		tags: Object.freeze([]),
		links: Object.freeze([]),
		embeds: Object.freeze([]),
		frontmatter: Object.freeze(frontmatter),
	});
}
