import type { App } from "obsidian";
import { TFile } from "obsidian";
import { describe, expect, it } from "vitest";
import {
	allPropertyDataDependencyKey,
	collectPropertyDataChanges,
	collectPropertyDataInvalidationKeys,
	propertyDataDependencyKey,
} from "../core/property-data-dependencies";
import type { FileMetadataSnapshot } from "../core/file-snapshot";
import { InvalidationEngine } from "../core/invalidation-engine";
import { ReactiveDataCore } from "../core/reactive-data-core";

describe("coarse property data dependency", () => {
	it("preserves the exact-only change helper while adding a separate coarse invalidation key", () => {
		const before = metadata({ rating: 9, author: "Ada" });
		const after = metadata({ rating: 10, author: "Ada" });

		expect(collectPropertyDataChanges(before, after)).toEqual([
			propertyDataDependencyKey("rating"),
		]);
		expect(collectPropertyDataInvalidationKeys(before, after)).toEqual([
			propertyDataDependencyKey("rating"),
			allPropertyDataDependencyKey(),
		]);
	});

	it("routes any property row change to dynamic property consumers once", () => {
		const fixture = createFixture();
		const invalidated: string[] = [];
		const invalidation = new InvalidationEngine<string>(owner => invalidated.push(owner));
		const core = new ReactiveDataCore(fixture.app, invalidation);
		core.bootstrap([fixture.file]);
		invalidation.commitDependencies("dynamic-owner", [allPropertyDataDependencyKey()]);
		invalidation.commitDependencies("rating-owner", [propertyDataDependencyKey("rating")]);

		fixture.setFrontmatter({ rating: 10, author: "Ada" });
		expect(new Set(core.fileMetadataRefreshed(fixture.file))).toEqual(new Set([
			"dynamic-owner",
			"rating-owner",
		]));
		expect(invalidated.filter(owner => owner === "dynamic-owner")).toHaveLength(1);
	});

	it("does not route file-field-only metadata changes to dynamic property consumers", () => {
		const fixture = createFixture();
		const invalidation = new InvalidationEngine<string>(() => undefined);
		const core = new ReactiveDataCore(fixture.app, invalidation);
		core.bootstrap([fixture.file]);
		invalidation.commitDependencies("dynamic-owner", [allPropertyDataDependencyKey()]);

		fixture.file.stat = { ...fixture.file.stat, mtime: 3 };
		expect(core.fileMetadataRefreshed(fixture.file)).not.toContain("dynamic-owner");
	});
});

function metadata(frontmatter: Record<string, unknown>): FileMetadataSnapshot {
	return Object.freeze({
		path: "A.md",
		name: "A.md",
		basename: "A",
		extension: "md",
		folder: "",
		size: 10,
		ctime: 1,
		mtime: 2,
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
		setFrontmatter(value) { frontmatter = value; },
	};
}
