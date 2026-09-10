import type { App } from "obsidian";
import { TFile } from "obsidian";
import { describe, expect, it } from "vitest";
import { dependencyKey } from "../core/dependencies";
import { InvalidationEngine } from "../core/invalidation-engine";
import { ReactiveDataCore } from "../core/reactive-data-core";

describe("Morphic ReactiveDataCore", () => {
	it("shares invalidation revisions with the lazy body cache", async () => {
		const fixture = createFixture();
		const invalidated: string[] = [];
		const invalidation = new InvalidationEngine<string>(owner => invalidated.push(owner));
		const core = new ReactiveDataCore(fixture.app, invalidation);
		core.bootstrap([fixture.file]);

		const contentKey = dependencyKey.file(fixture.file.path, "content");
		invalidation.commitDependencies("body-owner", [contentKey]);
		invalidation.commitDependencies("rating-owner", [
			dependencyKey.file(fixture.file.path, "frontmatter", "rating"),
		]);

		expect(await core.beginRender().file(fixture.file).body()).toBe("Body one");
		expect(fixture.readCount()).toBe(1);

		fixture.setContent("---\nrating: 9\nauthor: Ada\n---\nBody two");
		expect(core.fileContentModified(fixture.file)).toEqual(["body-owner"]);
		expect(invalidated).toEqual(["body-owner"]);
		expect(invalidation.revisions.current(contentKey)).toBe(1);

		expect(await core.beginRender().file(fixture.file).body()).toBe("Body two");
		expect(fixture.readCount()).toBe(2);
	});

	it("routes metadata refresh only to owners of fields that actually changed", () => {
		const fixture = createFixture();
		const invalidated: string[] = [];
		const invalidation = new InvalidationEngine<string>(owner => invalidated.push(owner));
		const core = new ReactiveDataCore(fixture.app, invalidation);
		core.bootstrap([fixture.file]);

		const ratingKey = dependencyKey.file(fixture.file.path, "frontmatter", "rating");
		const authorKey = dependencyKey.file(fixture.file.path, "frontmatter", "author");
		invalidation.commitDependencies("rating-owner", [ratingKey]);
		invalidation.commitDependencies("author-owner", [authorKey]);

		fixture.setFrontmatter({ rating: 10, author: "Ada" });
		expect(core.fileMetadataRefreshed(fixture.file)).toEqual(["rating-owner"]);
		expect(invalidated).toEqual(["rating-owner"]);
		expect(invalidation.revisions.current(ratingKey)).toBe(1);
		expect(invalidation.revisions.current(authorKey)).toBe(0);
	});

	it("routes property type changes without invalidating stable property types", () => {
		const fixture = createFixture();
		const invalidated: string[] = [];
		const invalidation = new InvalidationEngine<string>(owner => invalidated.push(owner));
		const core = new ReactiveDataCore(fixture.app, invalidation);
		core.bootstrap([fixture.file]);

		const ratingType = dependencyKey.index("property-type", "rating");
		const authorType = dependencyKey.index("property-type", "author");
		const catalogKey = dependencyKey.index("property-types");
		invalidation.commitDependencies("rating-type-owner", [ratingType]);
		invalidation.commitDependencies("author-type-owner", [authorType]);
		invalidation.commitDependencies("catalog-owner", [catalogKey]);

		fixture.setFrontmatter({ rating: "nine", author: "Ada" });
		expect(new Set(core.fileMetadataRefreshed(fixture.file))).toEqual(new Set([
			"rating-type-owner",
			"catalog-owner",
		]));
		expect(invalidated).not.toContain("author-type-owner");
		expect(core.propertyCatalog.inferredType("rating")).toBe("text");
		expect(core.propertyCatalog.inferredType("author")).toBe("text");
	});

	it("routes folder registry changes through the same dependency graph", () => {
		const fixture = createFixture();
		const invalidation = new InvalidationEngine<string>(() => undefined);
		const core = new ReactiveDataCore(fixture.app, invalidation);
		core.bootstrap([fixture.file]);

		const foldersKey = dependencyKey.index("folders");
		const archiveKey = dependencyKey.index("folder-exists", "Archive");
		invalidation.commitDependencies("folder-list", [foldersKey]);
		invalidation.commitDependencies("archive-owner", [archiveKey]);

		expect(new Set(core.folderCreated("Archive"))).toEqual(new Set(["folder-list", "archive-owner"]));
		expect(invalidation.revisions.current(foldersKey)).toBe(1);
		expect(invalidation.revisions.current(archiveKey)).toBe(1);
		expect(core.folderCreated("Archive")).toEqual([]);
		expect(invalidation.revisions.current(foldersKey)).toBe(1);
	});

	it("routes only owners whose time boundary actually changed", () => {
		const fixture = createFixture();
		const invalidation = new InvalidationEngine<string>(() => undefined);
		const core = new ReactiveDataCore(fixture.app, invalidation, {
			time: { nowResolutionMs: 60_000 },
		});
		core.time.seed(120_000);
		invalidation.commitDependencies("now-owner", [dependencyKey.time("now")]);
		invalidation.commitDependencies("random-owner", [dependencyKey.time("random")]);

		expect(core.advanceTime(179_999)).toEqual([]);
		expect(core.advanceTime(180_000)).toEqual(["now-owner"]);
		expect(core.randomCycle()).toEqual(["random-owner"]);
	});

	it("exposes bounded cache/index counters without retaining owner objects", async () => {
		const fixture = createFixture();
		const invalidation = new InvalidationEngine<string>(() => undefined);
		const core = new ReactiveDataCore(fixture.app, invalidation, {
			snapshots: { metadataCacheLimit: 4, bodyCacheLimit: 2 },
		});
		core.bootstrap([fixture.file], ["Notes"]);

		const session = core.beginRender();
		expect(session.file(fixture.file).property("rating")).toBe(9);
		expect(await session.file(fixture.file).body()).toBe("Body one");
		expect(core.stats()).toEqual({
			snapshots: {
				metadataEntries: 1,
				bodyEntries: 1,
				bodyInFlight: 0,
				metadataCacheLimit: 4,
				bodyCacheLimit: 2,
			},
			propertyCatalog: { files: 1, properties: 2 },
			dependencies: { owners: 0, dependencyKeys: 0, edges: 0 },
			revisions: { trackedKeys: 0 },
			indexedFiles: 1,
			indexedFolders: 1,
			indexedTags: 0,
			indexedProperties: 2,
		});
	});

	it("bootstraps without emitting invalidation work", () => {
		const fixture = createFixture();
		const invalidated: string[] = [];
		const invalidation = new InvalidationEngine<string>(owner => invalidated.push(owner));
		invalidation.commitDependencies("files-owner", [dependencyKey.index("files")]);
		const core = new ReactiveDataCore(fixture.app, invalidation);

		core.bootstrap([fixture.file], ["Notes", "Archive"]);
		expect(invalidated).toEqual([]);
		expect(core.index.allPaths()).toEqual(["Notes/A.md"]);
		expect(core.index.folderPaths()).toEqual(["Archive", "Notes"]);
		expect(core.propertyCatalog.definitions()).toEqual([
			{ name: "author", type: "text" },
			{ name: "rating", type: "number" },
		]);
	});
});

function createFixture(): {
	app: App;
	file: TFile;
	readCount(): number;
	setContent(value: string): void;
	setFrontmatter(value: Record<string, unknown>): void;
} {
	const file = new TFile();
	file.path = "Notes/A.md";
	file.name = "A.md";
	file.basename = "A";
	file.extension = "md";
	file.parent = null;
	file.stat = { ctime: 1, mtime: 2, size: 40 };

	let content = "---\nrating: 9\nauthor: Ada\n---\nBody one";
	let frontmatter: Record<string, unknown> = { rating: 9, author: "Ada" };
	let reads = 0;
	const app = {
		metadataCache: {
			getFileCache() {
				return {
					frontmatter,
					tags: [],
					links: [],
				};
			},
		},
		vault: {
			async cachedRead() {
				reads++;
				return content;
			},
		},
	} as unknown as App;

	return {
		app,
		file,
		readCount: () => reads,
		setContent: value => { content = value; },
		setFrontmatter: value => { frontmatter = value; },
	};
}
