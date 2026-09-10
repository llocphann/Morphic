import { TFile, TFolder, type App } from "obsidian";
import { describe, expect, it } from "vitest";
import { dependencyKey } from "../core/dependencies";
import { InvalidationEngine } from "../core/invalidation-engine";
import { ReactiveDataCore } from "../core/reactive-data-core";
import { tagFamilyDependencyKey } from "../core/tag-family-dependencies";

function file(path: string): TFile {
	const value = new TFile();
	value.path = path;
	value.name = path.split("/").pop() ?? path;
	value.basename = value.name.replace(/\.md$/, "");
	value.extension = "md";
	value.stat = { ctime: 1, mtime: 1, size: 1 };
	const folderPath = path.split("/").slice(0, -1).join("/");
	const parent = new TFolder();
	parent.path = folderPath;
	parent.name = folderPath.split("/").pop() ?? folderPath;
	parent.parent = null;
	parent.children = [value];
	value.parent = parent;
	return value;
}

function fixture(): { app: App; reads(): number } {
	let reads = 0;
	return {
		app: {
			metadataCache: {
				getFileCache: () => ({ frontmatter: { rating: 1 }, tags: [], links: [] }),
			},
			vault: {
				cachedRead: async () => {
					reads++;
					return "body";
				},
			},
		} as unknown as App,
		reads: () => reads,
	};
}

describe("ReactiveDataCore folder tree deletion", () => {
	it("removes indexed descendants atomically and keeps unrelated data quiet", () => {
		const source = fixture();
		const invalidated: string[] = [];
		const invalidation = new InvalidationEngine<string>(owner => invalidated.push(owner));
		const core = new ReactiveDataCore(source.app, invalidation);
		const rootFile = file("Root/A.md");
		const nestedFile = file("Root/Sub/B.md");
		const outsideFile = file("Else/C.md");
		core.bootstrap(
			[rootFile, nestedFile, outsideFile],
			["Root", "Root/Sub", "Else"],
		);

		invalidation.commitDependencies("files-owner", [dependencyKey.index("files")]);
		invalidation.commitDependencies("folders-owner", [dependencyKey.index("folders")]);
		invalidation.commitDependencies("root-folder-owner", [dependencyKey.index("folder-exists", "Root")]);
		invalidation.commitDependencies("sub-folder-owner", [dependencyKey.index("folder-exists", "Root/Sub")]);
		invalidation.commitDependencies("root-file-owner", [dependencyKey.file(rootFile.path, "exists")]);
		invalidation.commitDependencies("nested-property-owner", [
			dependencyKey.file(nestedFile.path, "frontmatter", "rating"),
		]);
		invalidation.commitDependencies("outside-owner", [dependencyKey.file(outsideFile.path, "exists")]);

		const owners = core.folderTreeDeleted("Root");
		expect(new Set(owners)).toEqual(new Set([
			"files-owner",
			"folders-owner",
			"root-folder-owner",
			"sub-folder-owner",
			"root-file-owner",
			"nested-property-owner",
		]));
		expect(invalidated).toHaveLength(new Set(invalidated).size);
		expect(invalidated).not.toContain("outside-owner");
		expect(core.index.allPaths()).toEqual(["Else/C.md"]);
		expect(core.index.folderPaths()).toEqual(["Else"]);
		expect(core.propertyCatalog.definitions()).toEqual([{ name: "rating", type: "number" }]);
		expect(source.reads()).toBe(0);

		invalidated.length = 0;
		expect(core.fileDeleted(nestedFile.path)).toEqual([]);
		expect(core.folderTreeDeleted("Root")).toEqual([]);
		expect(invalidated).toEqual([]);
		expect(source.reads()).toBe(0);
	});

	it("preserves tag-family deletion semantics from the current canonical", () => {
		const source = fixture();
		const invalidated: string[] = [];
		const invalidation = new InvalidationEngine<string>(owner => invalidated.push(owner));
		const core = new ReactiveDataCore(source.app, invalidation);
		const rootFile = file("Root/A.md");
		const outsideFile = file("Else/B.md");
		core.bootstrap([rootFile, outsideFile], ["Root", "Else"]);

		const rootSnapshot = core.index.get(rootFile.path);
		const outsideSnapshot = core.index.get(outsideFile.path);
		expect(rootSnapshot).toBeDefined();
		expect(outsideSnapshot).toBeDefined();
		if (!rootSnapshot || !outsideSnapshot) throw new Error("bootstrap snapshot missing");

		core.index.upsert(Object.freeze({
			...rootSnapshot,
			tags: Object.freeze(["#topic/sub"]),
		}));
		core.index.upsert(Object.freeze({
			...outsideSnapshot,
			tags: Object.freeze(["#outside"]),
		}));

		const topicFamily = tagFamilyDependencyKey("#topic");
		const outsideFamily = tagFamilyDependencyKey("#outside");
		invalidation.commitDependencies("topic-owner", [topicFamily]);
		invalidation.commitDependencies("outside-tag-owner", [outsideFamily]);
		const topicBefore = invalidation.revisions.current(topicFamily);
		const outsideBefore = invalidation.revisions.current(outsideFamily);

		expect(core.index.filesWithTag("#topic/sub")).toEqual(["Root/A.md"]);
		expect(core.index.filesWithTag("#outside")).toEqual(["Else/B.md"]);
		expect(core.folderTreeDeleted("Root")).toEqual(["topic-owner"]);
		expect(invalidated).toEqual(["topic-owner"]);
		expect(invalidation.revisions.current(topicFamily)).toBe(topicBefore + 1);
		expect(invalidation.revisions.current(outsideFamily)).toBe(outsideBefore);
		expect(core.index.filesWithTag("#topic/sub")).toEqual([]);
		expect(core.index.filesWithTag("#outside")).toEqual(["Else/B.md"]);
		expect(source.reads()).toBe(0);
	});
});
