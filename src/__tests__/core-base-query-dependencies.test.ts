import { describe, expect, it } from "vitest";
import {
	collectBaseQueryDependencies,
	trackBaseQueryDependencies,
} from "../core/base-query-dependencies";
import { DependencyCollector, dependencyKey } from "../core/dependencies";
import { fileDataDependencyKey } from "../core/file-data-dependencies";
import {
	allPropertyDataDependencyKey,
	propertyDataDependencyKey,
} from "../core/property-data-dependencies";
import { tagFamilyDependencyKey } from "../core/tag-family-dependencies";

describe("Bases query dependency extraction", () => {
	it("derives native filters, formula inputs, view properties, time, and source dependencies", () => {
		const dependencies = new Set(collectBaseQueryDependencies({
			filters: {
				or: [
					'file.hasTag("music", "book")',
					'file.hasLink("Textbook")',
					'file.inFolder("Required Reading")',
					'status != "done"',
					'note["review score"] > 2',
					'file.hasProperty("director")',
					'this.file.folder == file.folder',
					'file.embeds.length > 0',
					'file.backlinks.length > 0',
					'author == this',
					'now() < today()',
				],
			},
			formulas: {
				Score: "(rating * 10).round()",
				Label: "formula.Score + note.category",
			},
			properties: {
				status: { displayName: "Status" },
				"formula.Score": { displayName: "Score" },
			},
			views: [{
				type: "table",
				name: "Songs",
				order: ["file.name", "note.categories", "formula.Score"],
				sort: [{ property: "formula.Label", direction: "DESC" }],
				groupBy: { property: "note.age", direction: "DESC" },
				map: { property: "note.location" },
			}],
		}, {
			currentFilePath: "Books/Book.md",
			sourceKind: "template",
			settingsViewId: "view-1",
		}));

		for (const key of [
			dependencyKey.index("files"),
			dependencyKey.settings("view-1"),
			tagFamilyDependencyKey("music"),
			tagFamilyDependencyKey("book"),
			dependencyKey.index("folder", "Required Reading"),
			dependencyKey.index("property", "director"),
			fileDataDependencyKey("links"),
			fileDataDependencyKey("folder"),
			fileDataDependencyKey("name"),
			fileDataDependencyKey("embeds"),
			fileDataDependencyKey("backlinks"),
			dependencyKey.file("Books/Book.md", "file", "folder"),
			dependencyKey.file("Books/Book.md", "file", "path"),
			propertyDataDependencyKey("status"),
			propertyDataDependencyKey("review score"),
			propertyDataDependencyKey("rating"),
			propertyDataDependencyKey("category"),
			propertyDataDependencyKey("categories"),
			propertyDataDependencyKey("age"),
			propertyDataDependencyKey("location"),
			propertyDataDependencyKey("author"),
			dependencyKey.time("now"),
			dependencyKey.time("today"),
		]) {
			expect(dependencies.has(key), key).toBe(true);
		}

		expect(dependencies.has(dependencyKey.index("tag", "#music"))).toBe(false);
		expect(dependencies.has(dependencyKey.index("tag", "#book"))).toBe(false);
		expect(dependencies.has(propertyDataDependencyKey("Songs"))).toBe(false);
		expect(dependencies.has(propertyDataDependencyKey("Status"))).toBe(false);
	});

	it("keeps this.file fields exact while direct this tracks current file identity", () => {
		const dependencies = new Set(collectBaseQueryDependencies({
			filters: [
				'this.file.folder == "Books" && this.file.hasTag("project")',
				"this.file.embeds.length > 0",
				"this.file.backlinks.length > 0",
				"authors.contains(this)",
			],
			views: [{ type: "table", name: "Rows" }],
		}, { currentFilePath: "Books/Book.md" }));

		expect(dependencies.has(dependencyKey.file("Books/Book.md", "file", "folder"))).toBe(true);
		expect(dependencies.has(dependencyKey.file("Books/Book.md", "file", "path"))).toBe(true);
		expect(dependencies.has(dependencyKey.file("Books/Book.md", "tags"))).toBe(true);
		expect(dependencies.has(dependencyKey.file("Books/Book.md", "embeds"))).toBe(true);
		expect(dependencies.has(fileDataDependencyKey("backlinks"))).toBe(true);
		expect(dependencies.has(propertyDataDependencyKey("authors"))).toBe(true);
		expect(dependencies.has(fileDataDependencyKey("folder"))).toBe(false);
		expect(dependencies.has(fileDataDependencyKey("tags"))).toBe(false);
		expect(dependencies.has(fileDataDependencyKey("embeds"))).toBe(false);
	});

	it("tracks embedded source content and literal property membership precisely", () => {
		const dependencies = new Set(collectBaseQueryDependencies({
			filters: 'file.hasProperty("status")',
			views: [{ type: "table", name: "Rows" }],
		}, {
			sourceKind: "file-embed",
			sourcePath: "Dashboards/Library.base",
		}));

		expect(dependencies.has(dependencyKey.file("Dashboards/Library.base", "content"))).toBe(true);
		expect(dependencies.has(dependencyKey.index("property", "status"))).toBe(true);
		expect(dependencies.has(propertyDataDependencyKey("status"))).toBe(false);
	});

	it("uses coarse data fallbacks only for dynamic or plugin-defined access", () => {
		const dependencies = new Set(collectBaseQueryDependencies({
			filters: [
				"note[propertyName] != null",
				"file.pluginPredicate()",
			],
			views: [{ type: "table", name: "Rows" }],
		}));

		expect(dependencies.has(allPropertyDataDependencyKey())).toBe(true);
		for (const field of [
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
			"backlinks",
		] as const) {
			expect(dependencies.has(fileDataDependencyKey(field)), field).toBe(true);
		}
	});

	it("terminates formula cycles and still records concrete inputs", () => {
		const dependencies = new Set(collectBaseQueryDependencies({
			formulas: {
				A: "formula.B + rating",
				B: "formula.A + note.status",
			},
			views: [{ type: "table", name: "Rows", order: ["formula.A"] }],
		}));

		expect(dependencies.has(propertyDataDependencyKey("rating"))).toBe(true);
		expect(dependencies.has(propertyDataDependencyKey("status"))).toBe(true);
	});

	it("forwards the derived set into the runtime collector", () => {
		const collector = new DependencyCollector();
		const dependencies = trackBaseQueryDependencies(collector, {
			filters: 'price > 2 && file.ext == "md"',
			views: [{ type: "table", name: "Rows" }],
		});

		expect(collector.snapshot()).toEqual(new Set(dependencies));
		expect(collector.has(propertyDataDependencyKey("price"))).toBe(true);
		expect(collector.has(fileDataDependencyKey("extension"))).toBe(true);
	});
});