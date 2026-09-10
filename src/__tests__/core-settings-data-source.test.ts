import { describe, expect, it } from "vitest";
import { DependencyCollector, RevisionStore, dependencyKey } from "../core/dependencies";
import type { FileMetadataSnapshot } from "../core/file-snapshot";
import { IncrementalPropertyCatalog } from "../core/property-catalog";
import { VaultSettingsDataSource } from "../core/settings-data-source";
import { VaultIndex } from "../core/vault-index";
import { RevisionedVaultQueryCache } from "../core/vault-query-cache";

describe("VaultSettingsDataSource", () => {
	it("preserves existing Settings suggestion value semantics without App/Vault access", () => {
		const { index, source } = createSource();
		index.replaceFolders(["Archive", "Notes"]);
		index.upsert(metadata({
			path: "Notes/B.md",
			tags: ["#project", "#alpha"],
			frontmatter: { status: ["queued", "active"], rating: 9 },
		}));
		index.upsert(metadata({
			path: "Notes/A.md",
			tags: ["#project"],
			frontmatter: { status: "active", author: "Ada" },
		}));

		expect(source.files()).toEqual(["Notes/A", "Notes/B"]);
		expect(source.folders()).toEqual(["/", "Archive", "Notes"]);
		expect(source.tags()).toEqual(["alpha", "project"]);
		expect(source.properties()).toEqual(["author", "rating", "status"]);
		expect(source.propertyValues("status")).toEqual(["active", "queued"]);
	});

	it("exposes incremental property definitions with assigned-type precedence", () => {
		const { catalog, source } = createSource();
		catalog.upsert(metadata({
			path: "Notes/A.md",
			frontmatter: { rating: 9, due: "2026-08-31", status: "active" },
		}));
		catalog.upsert(metadata({
			path: "Notes/B.md",
			frontmatter: { rating: "fallback", tags2: ["a"] },
		}));
		const collector = new DependencyCollector();

		expect(source.propertyDefinitions(undefined, collector)).toEqual([
			{ name: "due", type: "date" },
			{ name: "rating", type: "number" },
			{ name: "status", type: "text" },
			{ name: "tags2", type: "list" },
		]);
		expect(collector.has(dependencyKey.index("property-types"))).toBe(true);
		expect(source.propertyDefinitions(name => name === "rating" ? "text" : undefined)).toEqual([
			{ name: "due", type: "date" },
			{ name: "rating", type: "text" },
			{ name: "status", type: "text" },
			{ name: "tags2", type: "list" },
		]);
	});

	it("exposes a fresh indexed template-variable type view while preserving the generic reserved contract", () => {
		const { catalog, source } = createSource();
		const fileA = {
			position: "frontmatter-internal",
			tags: ["alpha"],
			aliases: ["Alias A"],
			created: "2026-09-03T10:30:00",
			due: "2026-09-03",
			mixed: null,
			unknownOnly: null,
		};
		catalog.upsert(metadata({ path: "Notes/A.md", frontmatter: fileA }));
		catalog.upsert(metadata({
			path: "Notes/B.md",
			frontmatter: { mixed: 42, plain: "hello" },
		}));
		const collector = new DependencyCollector();

		const generic = source.propertyDefinitions();
		expect(generic).toEqual([
			{ name: "created", type: "datetime" },
			{ name: "due", type: "date" },
			{ name: "mixed", type: "number" },
			{ name: "plain", type: "text" },
			{ name: "unknownOnly", type: "unknown" },
		]);
		const template = source.templatePropertyDefinitions(undefined, collector);
		expect(template).toEqual([
			{ name: "aliases", type: "list" },
			{ name: "created", type: "datetime" },
			{ name: "due", type: "date" },
			{ name: "mixed", type: "number" },
			{ name: "plain", type: "text" },
			{ name: "tags", type: "list" },
			{ name: "unknownOnly", type: "unknown" },
		]);
		expect(collector.has(dependencyKey.index("template-property-types"))).toBe(true);
		expect(source.templatePropertyDefinitions(name => name === "aliases" ? "text" : undefined)[0]).toEqual({
			name: "aliases",
			type: "text",
		});
		expect(source.templatePropertyDefinitions()).toBe(template);

		expect(catalog.upsert(metadata({
			path: "Notes/A.md",
			frontmatter: { ...fileA, tags: ["beta"], aliases: ["Alias B"] },
		}))).toEqual([]);
		expect(source.templatePropertyDefinitions()).toBe(template);
		expect(source.propertyDefinitions()).toBe(generic);

		const tagsChanged = catalog.upsert(metadata({
			path: "Notes/A.md",
			frontmatter: { ...fileA, tags: "single", aliases: ["Alias B"] },
		}));
		expect(tagsChanged).toContain(dependencyKey.index("template-property-types"));
		expect(tagsChanged).not.toContain(dependencyKey.index("property-types"));
		expect(source.templatePropertyDefinitions().find(definition => definition.name === "tags")?.type).toBe("text");
		expect(source.propertyDefinitions()).toBe(generic);

		const aliasesRemoved = catalog.upsert(metadata({
			path: "Notes/A.md",
			frontmatter: {
				position: fileA.position,
				tags: "single",
				created: fileA.created,
				due: fileA.due,
				mixed: fileA.mixed,
				unknownOnly: fileA.unknownOnly,
			},
		}));
		expect(aliasesRemoved).toContain(dependencyKey.index("template-property-types"));
		expect(source.templatePropertyDefinitions().some(definition => definition.name === "aliases")).toBe(false);
		expect(source.propertyDefinitions()).toBe(generic);
	});

	it("recomputes the template first-concrete type when the winning member updates or is removed", () => {
		const { catalog, source } = createSource();
		catalog.upsert(metadata({ path: "Notes/A.md", frontmatter: { tags: null } }));
		catalog.upsert(metadata({ path: "Notes/B.md", frontmatter: { tags: "winner" } }));
		catalog.upsert(metadata({ path: "Notes/C.md", frontmatter: { tags: ["fallback"] } }));

		expect(source.templatePropertyDefinitions().find(definition => definition.name === "tags")?.type).toBe("text");

		const winnerUpdated = catalog.upsert(metadata({ path: "Notes/B.md", frontmatter: { tags: null } }));
		expect(winnerUpdated).toContain(dependencyKey.index("template-property-types"));
		expect(winnerUpdated).not.toContain(dependencyKey.index("property-types"));
		expect(source.templatePropertyDefinitions().find(definition => definition.name === "tags")?.type).toBe("list");

		const fallbackRemoved = catalog.remove("Notes/C.md");
		expect(fallbackRemoved).toContain(dependencyKey.index("template-property-types"));
		expect(fallbackRemoved).not.toContain(dependencyKey.index("property-types"));
		expect(source.templatePropertyDefinitions().find(definition => definition.name === "tags")?.type).toBe("unknown");
	});

	it("preserves template first-concrete inference order across rename", () => {
		const { catalog, source } = createSource();
		catalog.upsert(metadata({ path: "Notes/A.md", frontmatter: { tags: null } }));
		catalog.upsert(metadata({ path: "Notes/B.md", frontmatter: { tags: "winner" } }));
		catalog.upsert(metadata({ path: "Notes/C.md", frontmatter: { tags: ["fallback"] } }));
		const before = source.templatePropertyDefinitions();

		expect(before.find(definition => definition.name === "tags")?.type).toBe("text");
		expect(catalog.rename("Notes/B.md", metadata({
			path: "Archive/B.md",
			frontmatter: { tags: "winner" },
		}))).toEqual([]);
		expect(source.templatePropertyDefinitions()).toBe(before);
		expect(source.templatePropertyDefinitions().find(definition => definition.name === "tags")?.type).toBe("text");
	});

	it("reuses transformed lists while their exact query revision is unchanged", () => {
		const { index, revisions, source } = createSource();
		index.upsert(metadata({ path: "Notes/A.md", tags: ["#project"] }));

		const files = source.files();
		const tags = source.tags();
		expect(source.files()).toBe(files);
		expect(source.tags()).toBe(tags);

		revisions.bump(dependencyKey.file("Notes/A.md", "frontmatter", "rating"));
		expect(source.files()).toBe(files);
		expect(source.tags()).toBe(tags);
	});

	it("refreshes only the transformed universe whose canonical revision changes", () => {
		const { index, revisions, source } = createSource();
		index.upsert(metadata({ path: "Notes/A.md", tags: ["#alpha"] }));
		const filesBefore = source.files();
		const tagsBefore = source.tags();

		index.upsert(metadata({ path: "Notes/A.md", tags: ["#beta"] }));
		revisions.bump(dependencyKey.index("tags"));
		const tagsAfter = source.tags();

		expect(tagsAfter).not.toBe(tagsBefore);
		expect(tagsAfter).toEqual(["beta"]);
		expect(source.files()).toBe(filesBefore);
	});

	it("records canonical dependencies through the shared query cache", () => {
		const { index, source } = createSource();
		index.replaceFolders(["Notes"]);
		index.upsert(metadata({
			path: "Notes/A.md",
			tags: ["#project"],
			frontmatter: { status: "active" },
		}));
		const collector = new DependencyCollector();

		source.files(collector);
		source.folders(collector);
		source.tags(collector);
		source.properties(collector);
		source.propertyValues("status", collector);

		expect(collector.has(dependencyKey.index("files"))).toBe(true);
		expect(collector.has(dependencyKey.index("folders"))).toBe(true);
		expect(collector.has(dependencyKey.index("tags"))).toBe(true);
		expect(collector.has(dependencyKey.index("properties"))).toBe(true);
		expect(collector.has(dependencyKey.index("property-values", "status"))).toBe(true);
	});

	it("clear releases derived arrays without changing the underlying query cache contract", () => {
		const { index, source } = createSource();
		index.upsert(metadata({ path: "Notes/A.md", tags: ["#project"] }));
		const filesBefore = source.files();
		const tagsBefore = source.tags();

		source.clear();
		expect(source.files()).not.toBe(filesBefore);
		expect(source.files()).toEqual(filesBefore);
		expect(source.tags()).not.toBe(tagsBefore);
		expect(source.tags()).toEqual(tagsBefore);
	});
});

function createSource(): {
	index: VaultIndex;
	catalog: IncrementalPropertyCatalog;
	revisions: RevisionStore;
	source: VaultSettingsDataSource;
} {
	const index = new VaultIndex();
	const catalog = new IncrementalPropertyCatalog();
	const revisions = new RevisionStore();
	const queries = new RevisionedVaultQueryCache(index, revisions);
	return {
		index,
		catalog,
		revisions,
		source: new VaultSettingsDataSource(queries, catalog),
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
