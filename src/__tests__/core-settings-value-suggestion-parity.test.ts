import { describe, expect, it } from "vitest";
import { DependencyCollector, RevisionStore, dependencyKey } from "../core/dependencies";
import type { FileMetadataSnapshot } from "../core/file-snapshot";
import { IncrementalPropertyCatalog } from "../core/property-catalog";
import { propertyDataDependencyKey } from "../core/property-data-dependencies";
import { VaultSettingsDataSource } from "../core/settings-data-source";
import { VaultIndex } from "../core/vault-index";
import { RevisionedVaultQueryCache } from "../core/vault-query-cache";

describe("Settings property-value suggestion parity", () => {
	it("matches legacy array coercion while keeping scalar object/null values excluded", () => {
		const { index, source } = createSource();
		index.upsert(metadata({
			path: "Notes/A.md",
			frontmatter: {
				status: [null, undefined, { kind: "queued" }, ["nested", "pair"], " active ", 9, false, ""],
			},
		}));
		index.upsert(metadata({
			path: "Notes/B.md",
			frontmatter: { status: { ignored: true } },
		}));
		index.upsert(metadata({
			path: "Notes/C.md",
			frontmatter: { status: null },
		}));

		expect(source.propertyValues("status")).toEqual([
			"9",
			"[object Object]",
			"active",
			"false",
			"nested,pair",
			"null",
			"undefined",
		]);
	});

	it("tracks legacy autocomplete plus exact property-data freshness", () => {
		const { index, source } = createSource();
		index.upsert(metadata({ path: "Notes/A.md", frontmatter: { status: [null] } }));
		const collector = new DependencyCollector();

		source.propertyValues("status", collector);

		expect(collector.has(dependencyKey.index("property-values", "status"))).toBe(true);
		expect(collector.has(propertyDataDependencyKey("status"))).toBe(true);
	});

	it("reuses the cached universe across unrelated property changes and refreshes exotic array changes", () => {
		const { index, revisions, source } = createSource();
		index.upsert(metadata({
			path: "Notes/A.md",
			frontmatter: { status: [null], rating: 9 },
		}));
		const before = source.propertyValues("status");
		expect(before).toEqual(["null"]);

		revisions.bump(propertyDataDependencyKey("rating"));
		expect(source.propertyValues("status")).toBe(before);

		index.upsert(metadata({
			path: "Notes/A.md",
			frontmatter: { status: [{ state: "active" }], rating: 10 },
		}));
		revisions.bump(propertyDataDependencyKey("status"));
		const after = source.propertyValues("status");
		expect(after).not.toBe(before);
		expect(after).toEqual(["[object Object]"]);
	});
});

function createSource(): {
	index: VaultIndex;
	revisions: RevisionStore;
	source: VaultSettingsDataSource;
} {
	const index = new VaultIndex();
	const revisions = new RevisionStore();
	const queries = new RevisionedVaultQueryCache(index, revisions);
	return {
		index,
		revisions,
		source: new VaultSettingsDataSource(queries, new IncrementalPropertyCatalog()),
	};
}

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