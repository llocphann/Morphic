import { TFile, type App } from "obsidian";
import { describe, expect, it } from "vitest";
import { dependencyKey } from "../core/dependencies";
import { fileDataDependencyKey } from "../core/file-data-dependencies";
import { InvalidationEngine } from "../core/invalidation-engine";
import { ReactiveDataCore } from "../core/reactive-data-core";

describe("embed-only metadata invalidation", () => {
	it("invalidates broad metadata without materializing note bodies", () => {
		const file = markdownFile("Notes/A.md");
		let embeds = [{ link: "Before.md" }];
		let bodyReads = 0;
		const app = {
			metadataCache: {
				getFileCache: () => ({
					frontmatter: { rating: 9 },
					tags: [],
					links: [],
					embeds,
				}),
			},
			vault: {
				cachedRead: async () => {
					bodyReads++;
					return "body";
				},
			},
		} as unknown as App;

		const invalidated: string[] = [];
		const invalidation = new InvalidationEngine<string>(owner => invalidated.push(owner));
		const core = new ReactiveDataCore(app, invalidation);
		core.bootstrap([file]);

		const metadataKey = dependencyKey.file(file.path, "metadata");
		const embedsKey = dependencyKey.file(file.path, "embeds");
		const ratingKey = dependencyKey.file(file.path, "frontmatter", "rating");
		const coarseEmbedsKey = fileDataDependencyKey("embeds");
		const backlinksKey = fileDataDependencyKey("backlinks");
		invalidation.commitDependencies("metadata-owner", [metadataKey]);
		invalidation.commitDependencies("embeds-owner", [embedsKey]);
		invalidation.commitDependencies("rating-owner", [ratingKey]);
		invalidation.commitDependencies("coarse-embeds-owner", [coarseEmbedsKey]);
		invalidation.commitDependencies("backlinks-owner", [backlinksKey]);

		expect(core.beginRender().file(file).metadata().embeds).toEqual(["Before.md"]);
		expect(bodyReads).toBe(0);

		embeds = [{ link: "After.md" }];
		expect(new Set(core.fileMetadataRefreshed(file))).toEqual(new Set([
			"metadata-owner",
			"embeds-owner",
			"coarse-embeds-owner",
			"backlinks-owner",
		]));
		expect(invalidated).not.toContain("rating-owner");
		expect(invalidation.revisions.current(metadataKey)).toBe(1);
		expect(invalidation.revisions.current(embedsKey)).toBe(1);
		expect(invalidation.revisions.current(coarseEmbedsKey)).toBe(1);
		expect(invalidation.revisions.current(backlinksKey)).toBe(1);
		expect(invalidation.revisions.current(ratingKey)).toBe(0);
		expect(core.beginRender().file(file).metadata().embeds).toEqual(["After.md"]);
		expect(bodyReads).toBe(0);

		invalidated.length = 0;
		expect(core.fileMetadataRefreshed(file)).toEqual([]);
		expect(invalidated).toEqual([]);
		expect(bodyReads).toBe(0);
	});
});

function markdownFile(path: string): TFile {
	const file = new TFile();
	file.path = path;
	file.name = path.split("/").pop() ?? path;
	file.basename = file.name.replace(/\.md$/, "");
	file.extension = "md";
	file.parent = null;
	file.stat = { ctime: 1, mtime: 2, size: 4 };
	return file;
}
