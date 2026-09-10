import { TFile, type App } from "obsidian";
import { describe, expect, it } from "vitest";
import { dependencyKey } from "../core/dependencies";
import { InvalidationEngine } from "../core/invalidation-engine";
import { ReactiveDataCore } from "../core/reactive-data-core";

describe("ReactiveDataCore metadata refresh body-cache ownership", () => {
	it("refreshes metadata without evicting independently revisioned body data", async () => {
		const fixture = createFixture();
		const invalidated: string[] = [];
		const invalidation = new InvalidationEngine<string>(owner => invalidated.push(owner));
		const core = new ReactiveDataCore(fixture.app, invalidation, {
			snapshots: { collectStats: true },
		});
		core.bootstrap([fixture.file]);

		const contentKey = dependencyKey.file(fixture.file.path, "content");
		const ratingKey = dependencyKey.file(fixture.file.path, "frontmatter", "rating");
		invalidation.commitDependencies("body-owner", [contentKey]);
		invalidation.commitDependencies("rating-owner", [ratingKey]);

		expect(await core.beginRender().file(fixture.file).body()).toBe("Body one");
		expect(core.beginRender().file(fixture.file).property("rating")).toBe(1);
		expect(fixture.readCount()).toBe(1);
		const contentRevision = invalidation.revisions.current(contentKey);

		fixture.setFrontmatter({ rating: 2 });
		expect(core.fileMetadataRefreshed(fixture.file)).toEqual(["rating-owner"]);
		expect(invalidated).toEqual(["rating-owner"]);
		expect(invalidation.revisions.current(contentKey)).toBe(contentRevision);
		expect(core.beginRender().file(fixture.file).property("rating")).toBe(2);
		expect(await core.beginRender().file(fixture.file).body()).toBe("Body one");
		expect(fixture.readCount()).toBe(1);

		const stats = core.snapshots.stats();
		expect(stats.observabilityEnabled).toBe(true);
		expect(stats.bodyReads).toBe(1);
		expect(stats.bodyCacheHits).toBe(1);
		expect(stats.metadataCacheMisses).toBe(2);
	});

	it("refreshes broad metadata for embed-only changes while preserving body data", async () => {
		const fixture = createFixture();
		const invalidation = new InvalidationEngine<string>(() => undefined);
		const core = new ReactiveDataCore(fixture.app, invalidation, {
			snapshots: { collectStats: true },
		});
		core.bootstrap([fixture.file]);

		const metadataKey = dependencyKey.file(fixture.file.path, "metadata");
		const contentKey = dependencyKey.file(fixture.file.path, "content");
		expect(core.beginRender().file(fixture.file).metadata().embeds).toEqual([]);
		expect(await core.beginRender().file(fixture.file).body()).toBe("Body one");
		const metadataRevision = invalidation.revisions.current(metadataKey);
		const contentRevision = invalidation.revisions.current(contentKey);

		fixture.setEmbeds(["Asset.png"]);
		core.fileMetadataRefreshed(fixture.file);
		expect(invalidation.revisions.current(metadataKey)).toBeGreaterThan(metadataRevision);
		expect(invalidation.revisions.current(contentKey)).toBe(contentRevision);
		expect(core.beginRender().file(fixture.file).metadata().embeds).toEqual(["Asset.png"]);
		expect(await core.beginRender().file(fixture.file).body()).toBe("Body one");
		expect(fixture.readCount()).toBe(1);
	});

	it("still invalidates and reloads body data after a real content modification", async () => {
		const fixture = createFixture();
		const invalidated: string[] = [];
		const invalidation = new InvalidationEngine<string>(owner => invalidated.push(owner));
		const core = new ReactiveDataCore(fixture.app, invalidation, {
			snapshots: { collectStats: true },
		});
		core.bootstrap([fixture.file]);

		const contentKey = dependencyKey.file(fixture.file.path, "content");
		invalidation.commitDependencies("body-owner", [contentKey]);
		expect(await core.beginRender().file(fixture.file).body()).toBe("Body one");

		fixture.setFrontmatter({ rating: 2 });
		core.fileMetadataRefreshed(fixture.file);
		expect(await core.beginRender().file(fixture.file).body()).toBe("Body one");
		expect(fixture.readCount()).toBe(1);

		fixture.setContent("---\nrating: 2\n---\nBody two");
		fixture.file.stat = { ...fixture.file.stat, mtime: 2, size: 32 };
		expect(core.fileContentModified(fixture.file)).toEqual(["body-owner"]);
		expect(invalidated).toContain("body-owner");
		expect(await core.beginRender().file(fixture.file).body()).toBe("Body two");
		expect(fixture.readCount()).toBe(2);
	});
});

function createFixture(): {
	app: App;
	file: TFile;
	readCount(): number;
	setContent(value: string): void;
	setFrontmatter(value: Record<string, unknown>): void;
	setEmbeds(value: readonly string[]): void;
} {
	const file = new TFile();
	file.path = "Notes/A.md";
	file.name = "A.md";
	file.basename = "A";
	file.extension = "md";
	file.parent = null;
	file.stat = { ctime: 1, mtime: 1, size: 32 };

	let raw = "---\nrating: 1\n---\nBody one";
	let frontmatter: Record<string, unknown> = { rating: 1 };
	let embeds: readonly string[] = [];
	let reads = 0;
	const app = {
		metadataCache: {
			getFileCache: () => ({
				frontmatter,
				tags: [],
				links: [],
				embeds: embeds.map(link => ({ link })),
			}),
		},
		vault: {
			cachedRead: async () => {
				reads++;
				return raw;
			},
		},
	} as unknown as App;

	return {
		app,
		file,
		readCount: () => reads,
		setContent: value => { raw = value; },
		setFrontmatter: value => { frontmatter = value; },
		setEmbeds: value => { embeds = value; },
	};
}
