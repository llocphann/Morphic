import { describe, expect, it } from "vitest";
import { collectBaseQueryDependencies } from "../core/base-query-dependencies";
import { dependencyKey } from "../core/dependencies";
import { fileDataDependencyKey } from "../core/file-data-dependencies";
import { propertyDataDependencyKey } from "../core/property-data-dependencies";
import { tagFamilyDependencyKey } from "../core/tag-family-dependencies";

describe("Bases dependency string-literal boundaries", () => {
	it("ignores this and file vocabulary that appears only inside string literals", () => {
		const path = "Dashboards/Current.md";
		const dependencies = new Set(collectBaseQueryDependencies({
			filters: [
				'"this" == "this"',
				'"this.file.embeds" == "file.backlinks"',
				'"file.hasTag(\\"fake\\")" != "note.rating"',
			],
			views: [{ type: "table", name: "Rows" }],
		}, { currentFilePath: path }));

		expect(dependencies).toEqual(new Set([dependencyKey.index("files")]));
	});

	it("keeps real syntax precise while ignoring lookalike vocabulary in sibling literals", () => {
		const path = "Dashboards/Current.md";
		const dependencies = new Set(collectBaseQueryDependencies({
			filters: [
				'rating > 0 && note.category == "this.file.embeds"',
				'file.hasTag("music") && "file.hasTag(\\"fake\\")" != "file.backlinks"',
			],
			views: [{ type: "table", name: "Rows" }],
		}, { currentFilePath: path }));

		expect(dependencies.has(propertyDataDependencyKey("rating"))).toBe(true);
		expect(dependencies.has(propertyDataDependencyKey("category"))).toBe(true);
		expect(dependencies.has(tagFamilyDependencyKey("music"))).toBe(true);
		expect(dependencies.has(tagFamilyDependencyKey("fake"))).toBe(false);
		expect(dependencies.has(dependencyKey.file(path, "file", "path"))).toBe(false);
		expect(dependencies.has(dependencyKey.file(path, "embeds"))).toBe(false);
		expect(dependencies.has(fileDataDependencyKey("embeds"))).toBe(false);
		expect(dependencies.has(fileDataDependencyKey("backlinks"))).toBe(false);
	});
});
