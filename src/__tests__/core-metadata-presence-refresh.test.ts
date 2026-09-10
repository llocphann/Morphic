import { TFile, type App } from "obsidian";
import { describe, expect, it } from "vitest";
import { dependencyKey } from "../core/dependencies";
import { InvalidationEngine } from "../core/invalidation-engine";
import { ReactiveDataCore } from "../core/reactive-data-core";

describe("metadata property-presence refresh", () => {
	it("refreshes broad metadata for absent-to-own-undefined without invalidating body content", async () => {
		const file = createFile();
		let frontmatter: Record<string, unknown> = {};
		let reads = 0;
		const app = {
			metadataCache: {
				getFileCache: () => ({ frontmatter, tags: [], links: [], embeds: [] }),
			},
			vault: {
				cachedRead: async () => {
					reads++;
					return "---\n---\nStable body";
			},
			},
		} as unknown as App;
		const invalidated: string[] = [];
		const invalidation = new InvalidationEngine<string>(owner => invalidated.push(owner));
		const core = new ReactiveDataCore(app, invalidation);
		core.bootstrap([file]);

		const metadataKey = dependencyKey.file(file.path, "metadata");
		const contentKey = dependencyKey.file(file.path, "content");
		invalidation.commitDependencies("metadata-owner", [metadataKey]);
		invalidation.commitDependencies("body-owner", [contentKey]);

		const initial = core.beginRender().file(file).metadata();
		expect(Object.prototype.hasOwnProperty.call(initial.frontmatter, "optional")).toBe(false);
		expect(await core.beginRender().file(file).body()).toBe("Stable body");
		const contentRevision = invalidation.revisions.current(contentKey);

		frontmatter = { optional: undefined };
		expect(core.fileMetadataRefreshed(file)).toEqual(["metadata-owner"]);
		expect(invalidated).toEqual(["metadata-owner"]);
		expect(invalidation.revisions.current(contentKey)).toBe(contentRevision);

		const refreshed = core.beginRender().file(file).metadata();
		expect(Object.prototype.hasOwnProperty.call(refreshed.frontmatter, "optional")).toBe(true);
		expect(refreshed.frontmatter.optional).toBeUndefined();
		expect(await core.beginRender().file(file).body()).toBe("Stable body");
		expect(reads).toBe(1);
	});
});

function createFile(): TFile {
	const file = new TFile();
	file.path = "Notes/Presence.md";
	file.name = "Presence.md";
	file.basename = "Presence";
	file.extension = "md";
	file.parent = null;
	file.stat = { ctime: 1, mtime: 1, size: 21 };
	return file;
}
