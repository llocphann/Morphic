import type { App } from "obsidian";
import { TFile } from "obsidian";
import { describe, expect, it } from "vitest";
import {
	collectPropertyDataChanges,
	propertyDataDependencyKey,
	trackPropertyData,
} from "../core/property-data-dependencies";
import { DependencyCollector } from "../core/dependencies";
import type { FileMetadataSnapshot } from "../core/file-snapshot";
import { InvalidationEngine } from "../core/invalidation-engine";
import { ReactiveDataCore } from "../core/reactive-data-core";

describe("property data dependencies", () => {
	it("invalidates property data when a value changes even if autocomplete universe can stay stable", () => {
		const before = metadata("A.md", { status: "todo", author: "Ada" });
		const after = metadata("A.md", { status: "done", author: "Ada" });
		expect(collectPropertyDataChanges(before, after)).toEqual([
			propertyDataDependencyKey("status"),
		]);
	});

	it("does not invalidate an unrelated property", () => {
		const before = metadata("A.md", { rating: 9, author: "Ada" });
		const after = metadata("A.md", { rating: 9, author: "Grace" });
		const changed = collectPropertyDataChanges(before, after);
		expect(changed).toContain(propertyDataDependencyKey("author"));
		expect(changed).not.toContain(propertyDataDependencyKey("rating"));
	});

	it("invalidates property data on membership and file identity changes", () => {
		const created = metadata("A.md", { rating: 9 });
		expect(collectPropertyDataChanges(undefined, created)).toEqual([
			propertyDataDependencyKey("rating"),
		]);
		expect(collectPropertyDataChanges(created, undefined)).toEqual([
			propertyDataDependencyKey("rating"),
		]);
		expect(collectPropertyDataChanges(
			created,
			metadata("Renamed.md", { rating: 9 }),
			{ identityChanged: true },
		)).toEqual([propertyDataDependencyKey("rating")]);
	});

	it("treats shared references and expanded structural values as equal", () => {
		const child = { label: "x,b:string:y", nested: [1, 2] };
		const shared = { left: child, right: child };
		const expanded = {
			left: { label: "x,b:string:y", nested: [1, 2] },
			right: { label: "x,b:string:y", nested: [1, 2] },
		};
		expect(collectPropertyDataChanges(
			metadata("A.md", { payload: shared }),
			metadata("A.md", { payload: expanded }),
		)).toEqual([]);
	});

	it("exposes a canonical collector helper for query/runtime consumers", () => {
		const collector = new DependencyCollector();
		trackPropertyData(collector, "rating");
		expect(collector.has(propertyDataDependencyKey("rating"))).toBe(true);
	});

	it("routes metadata changes to owners of the exact property data dependency", () => {
		const fixture = createFixture();
		const invalidated: string[] = [];
		const invalidation = new InvalidationEngine<string>(owner => invalidated.push(owner));
		const core = new ReactiveDataCore(fixture.app, invalidation);
		core.bootstrap([fixture.file]);
		invalidation.commitDependencies("rating-query", [propertyDataDependencyKey("rating")]);
		invalidation.commitDependencies("author-query", [propertyDataDependencyKey("author")]);

		fixture.setFrontmatter({ rating: 10, author: "Ada" });
		expect(core.fileMetadataRefreshed(fixture.file)).toContain("rating-query");
		expect(invalidated).not.toContain("author-query");
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
		frontmatter: Object.freeze(frontmatter),
	});
}

function createFixture(): {
	app: App;
	file: TFile;
	setFrontmatter(value: Record<string, unknown>): void;
} {
	const file = new TFile();
	file.path = "A.md";
	file.name = "A.md";
	file.basename = "A";
	file.extension = "md";
	file.parent = null;
	file.stat = { ctime: 1, mtime: 2, size: 10 };
	let frontmatter: Record<string, unknown> = { rating: 9, author: "Ada" };
	const app = {
		metadataCache: {
			getFileCache() {
				return { frontmatter, tags: [], links: [] };
			},
		},
		vault: { cachedRead: async () => "" },
	} as unknown as App;
	return {
		app,
		file,
		setFrontmatter(value) {
			frontmatter = value;
		},
	};
}
