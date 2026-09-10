import type { App } from "obsidian";
import { TFile } from "obsidian";
import { describe, expect, it } from "vitest";
import { dependencyKey } from "../core/dependencies";
import {
	collectFileDataChanges,
	fileDataDependencyKey,
} from "../core/file-data-dependencies";
import {
	captureFileMetadata,
	type FileMetadataSnapshot,
} from "../core/file-snapshot";
import { InvalidationEngine } from "../core/invalidation-engine";
import { ReactiveDataCore } from "../core/reactive-data-core";

describe("file data query dependencies", () => {
	it("invalidates only candidate file fields whose observable values changed", () => {
		const previous = metadata({
			path: "Books/A.md",
			folder: "Books",
			tags: ["#book"],
			frontmatter: { rating: 9 },
		});
		const next = metadata({
			path: "Books/A.md",
			folder: "Books",
			tags: ["#book", "#favorite"],
			frontmatter: { rating: 10 },
		});

		expect(collectFileDataChanges(previous, next)).toEqual([
			fileDataDependencyKey("tags"),
		]);
	});

	it("treats create/delete as changes to every cross-file field", () => {
		const keys = new Set(collectFileDataChanges(undefined, metadata({ path: "A.md" })));
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
			expect(keys.has(fileDataDependencyKey(field)), field).toBe(true);
		}
	});

	it("treats source link/embed changes as backlink changes", () => {
		const previous = metadata({ links: ["A"], embeds: ["Image.png"] });
		const linkChange = new Set(collectFileDataChanges(previous, metadata({
			links: ["B"],
			embeds: ["Image.png"],
		})));
		expect(linkChange).toEqual(new Set([
			fileDataDependencyKey("links"),
			fileDataDependencyKey("backlinks"),
		]));

		const embedChange = new Set(collectFileDataChanges(previous, metadata({
			links: ["A"],
			embeds: ["Other.png"],
		})));
		expect(embedChange).toEqual(new Set([
			fileDataDependencyKey("embeds"),
			fileDataDependencyKey("backlinks"),
		]));
	});

	it("routes exact and candidate stat changes immediately from a TFile modify event", () => {
		const fixture = createFixture();
		const invalidated: string[] = [];
		const invalidation = new InvalidationEngine<string>(owner => invalidated.push(owner));
		const core = new ReactiveDataCore(fixture.app, invalidation);
		core.bootstrap([fixture.file]);
		invalidation.commitDependencies("mtime-owner", [fileDataDependencyKey("mtime")]);
		invalidation.commitDependencies("size-owner", [fileDataDependencyKey("size")]);
		invalidation.commitDependencies("exact-mtime-owner", [
			dependencyKey.file(fixture.file.path, "stat", "mtime"),
		]);
		invalidation.commitDependencies("exact-size-owner", [
			dependencyKey.file(fixture.file.path, "stat", "size"),
		]);
		invalidation.commitDependencies("metadata-owner", [
			dependencyKey.file(fixture.file.path, "metadata"),
		]);
		invalidation.commitDependencies("links-owner", [fileDataDependencyKey("links")]);
		invalidation.commitDependencies("content-owner", [dependencyKey.file(fixture.file.path, "content")]);

		fixture.file.stat = { ...fixture.file.stat, mtime: 3, size: 99 };
		const affected = new Set(core.fileContentModified(fixture.file));
		expect(affected).toEqual(new Set([
			"mtime-owner",
			"size-owner",
			"exact-mtime-owner",
			"exact-size-owner",
			"metadata-owner",
			"content-owner",
		]));
		expect(invalidated).not.toContain("links-owner");
		expect(core.index.get(fixture.file.path)).toMatchObject({ mtime: 3, size: 99 });

		invalidated.length = 0;
		expect(core.fileContentModified(fixture.file)).toEqual(["content-owner"]);
		expect(invalidated).toEqual(["content-owner"]);

		invalidated.length = 0;
		expect(core.fileMetadataRefreshed(fixture.file)).toEqual([]);
		expect(invalidated).toEqual([]);
	});

	it("routes metadata-backed link changes to links and backlinks owners", () => {
		const fixture = createFixture();
		const invalidation = new InvalidationEngine<string>(() => undefined);
		const core = new ReactiveDataCore(fixture.app, invalidation);
		core.bootstrap([fixture.file]);
		invalidation.commitDependencies("links-owner", [fileDataDependencyKey("links")]);
		invalidation.commitDependencies("backlinks-owner", [fileDataDependencyKey("backlinks")]);
		invalidation.commitDependencies("name-owner", [fileDataDependencyKey("name")]);

		fixture.setLinks(["Target", "Second"]);
		expect(new Set(core.fileMetadataRefreshed(fixture.file))).toEqual(new Set([
			"links-owner",
			"backlinks-owner",
		]));
	});

	it("routes embeds precisely for current file and coarsely for candidate/backlink queries", () => {
		const fixture = createFixture();
		const invalidation = new InvalidationEngine<string>(() => undefined);
		const core = new ReactiveDataCore(fixture.app, invalidation);
		core.bootstrap([fixture.file]);
		invalidation.commitDependencies("embed-owner", [fileDataDependencyKey("embeds")]);
		invalidation.commitDependencies("backlinks-owner", [fileDataDependencyKey("backlinks")]);
		invalidation.commitDependencies("current-embed-owner", [
			dependencyKey.file(fixture.file.path, "embeds"),
		]);

		fixture.setEmbeds(["Cover.png", "Trailer.mp4"]);
		expect(new Set(core.fileMetadataRefreshed(fixture.file))).toEqual(new Set([
			"embed-owner",
			"backlinks-owner",
			"current-embed-owner",
		]));
	});

	it("captures file.links from body and frontmatter without a body read", () => {
		const fixture = createFixture();
		fixture.setFrontmatterLinks(["Author"]);
		const snapshot = captureFileMetadata(fixture.app, fixture.file);
		expect(snapshot.links).toEqual(["Target", "Author"]);
		expect(snapshot.embeds).toEqual(["Cover.png"]);
	});
});

function metadata(overrides: Partial<FileMetadataSnapshot>): FileMetadataSnapshot {
	const path = overrides.path ?? "Books/A.md";
	const name = path.split("/").pop() ?? path;
	return Object.freeze({
		path,
		name,
		basename: name.replace(/\.md$/, ""),
		extension: "md",
		folder: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "",
		size: 10,
		ctime: 1,
		mtime: 2,
		tags: Object.freeze([]),
		links: Object.freeze([]),
		embeds: Object.freeze([]),
		frontmatter: Object.freeze({}),
		...overrides,
	});
}

function createFixture(): {
	app: App;
	file: TFile;
	setLinks(links: string[]): void;
	setFrontmatterLinks(links: string[]): void;
	setEmbeds(embeds: string[]): void;
} {
	const file = new TFile();
	file.path = "Books/A.md";
	file.name = "A.md";
	file.basename = "A";
	file.extension = "md";
	file.parent = null;
	file.stat = { ctime: 1, mtime: 2, size: 10 };
	let links = ["Target"];
	let frontmatterLinks: string[] = [];
	let embeds = ["Cover.png"];
	const app = {
		metadataCache: {
			getFileCache() {
				return {
					frontmatter: { rating: 9 },
					tags: [],
					links: links.map(link => ({ link })),
					frontmatterLinks: frontmatterLinks.map(link => ({ link })),
					embeds: embeds.map(link => ({ link })),
				};
			},
		},
		vault: {
			cachedRead: async () => "Body",
		},
	} as unknown as App;
	return {
		app,
		file,
		setLinks(next) { links = next; },
		setFrontmatterLinks(next) { frontmatterLinks = next; },
		setEmbeds(next) { embeds = next; },
	};
}
