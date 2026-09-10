import type { App } from "obsidian";
import { TFile, TFolder } from "obsidian";
import { describe, expect, it } from "vitest";
import { dependencyKey } from "../core/dependencies";
import { InvalidationEngine } from "../core/invalidation-engine";
import { ReactiveDataCore } from "../core/reactive-data-core";

describe("ReactiveDataCore folder subtree rename", () => {
	it("moves descendant file/index memberships and invalidates each owner once", () => {
		const fixture = createFixture();
		const invalidated: string[] = [];
		const invalidation = new InvalidationEngine<string>(owner => invalidated.push(owner));
		const core = new ReactiveDataCore(fixture.app, invalidation);
		core.bootstrap(
			[fixture.fileA, fixture.fileB, fixture.otherFile],
			["Old", "Old/Sub", "Other"],
		);

		invalidation.commitDependencies("files-owner", [dependencyKey.index("files")]);
		invalidation.commitDependencies("old-folder-owner", [dependencyKey.index("folder", "Old")]);
		invalidation.commitDependencies("rating-owner", [dependencyKey.index("property", "rating")]);
		invalidation.commitDependencies("multi-owner", [
			dependencyKey.index("files"),
			dependencyKey.index("property", "rating"),
		]);
		invalidation.commitDependencies("other-owner", [
			dependencyKey.file("Other/C.md", "frontmatter", "status"),
		]);

		fixture.renameFile(fixture.fileA, "Renamed/A.md", "Renamed");
		fixture.renameFile(fixture.fileB, "Renamed/Sub/B.md", "Renamed/Sub");

		const affected = core.folderTreeRenamed(
			"Old",
			"Renamed",
			[fixture.fileA, fixture.fileB],
			["Renamed/Sub"],
		);

		expect(new Set(affected)).toEqual(new Set([
			"files-owner",
			"old-folder-owner",
			"rating-owner",
			"multi-owner",
		]));
		expect(invalidated.filter(owner => owner === "multi-owner")).toHaveLength(1);
		expect(invalidated).not.toContain("other-owner");
		expect(core.index.allPaths()).toEqual([
			"Other/C.md",
			"Renamed/A.md",
			"Renamed/Sub/B.md",
		]);
		expect(core.index.folderPaths()).toEqual(["Other", "Renamed", "Renamed/Sub"]);
		expect(core.index.filesInFolder("Old")).toEqual([]);
		expect(core.index.filesInFolder("Renamed")).toEqual(["Renamed/A.md"]);
		expect(core.index.filesWithProperty("rating")).toEqual([
			"Renamed/A.md",
			"Renamed/Sub/B.md",
		]);
		expect(core.index.get("Old/A.md")).toBeUndefined();
		expect(core.index.get("Renamed/A.md")?.path).toBe("Renamed/A.md");
	});

	it("preserves empty descendant folders and tolerates duplicate rename delivery", () => {
		const fixture = createFixture();
		const invalidation = new InvalidationEngine<string>(() => undefined);
		const core = new ReactiveDataCore(fixture.app, invalidation);
		core.bootstrap([fixture.fileA], ["Old", "Old/Empty"]);

		fixture.renameFile(fixture.fileA, "New/A.md", "New");
		const first = core.folderTreeRenamed("Old", "New", [fixture.fileA], ["New/Empty"]);
		expect(first).toEqual([]);
		expect(core.index.folderPaths()).toEqual(["New", "New/Empty"]);
		expect(core.index.allPaths()).toEqual(["New/A.md"]);

		const revisionsBefore = invalidation.revisions.stats().trackedKeys;
		expect(core.folderTreeRenamed("Old", "New", [fixture.fileA], ["New/Empty"])).toEqual([]);
		expect(invalidation.revisions.stats().trackedKeys).toBe(revisionsBefore);
		expect(core.index.folderPaths()).toEqual(["New", "New/Empty"]);
	});

	it("moves property catalogue file ownership with subtree rename", () => {
		const fixture = createFixture();
		const invalidation = new InvalidationEngine<string>(() => undefined);
		const core = new ReactiveDataCore(fixture.app, invalidation);
		core.bootstrap([fixture.fileA, fixture.fileB], ["Old", "Old/Sub"]);
		expect(core.propertyCatalog.stats()).toEqual({ files: 2, properties: 1 });

		fixture.renameFile(fixture.fileA, "New/A.md", "New");
		core.folderTreeRenamed("Old", "New", [fixture.fileA], []);
		expect(core.propertyCatalog.stats()).toEqual({ files: 2, properties: 1 });

		core.fileDeleted("New/A.md");
		expect(core.propertyCatalog.stats()).toEqual({ files: 1, properties: 1 });
		expect(core.propertyCatalog.inferredType("rating")).toBe("number");
	});

	it("ignores descendants that are not under the renamed new root", () => {
		const fixture = createFixture();
		const invalidation = new InvalidationEngine<string>(() => undefined);
		const core = new ReactiveDataCore(fixture.app, invalidation);
		core.bootstrap([fixture.fileA, fixture.otherFile], ["Old", "Other"]);

		fixture.renameFile(fixture.fileA, "New/A.md", "New");
		core.folderTreeRenamed("Old", "New", [fixture.fileA, fixture.otherFile], []);
		expect(core.index.allPaths()).toEqual(["New/A.md", "Other/C.md"]);
	});
});

function createFixture(): {
	app: App;
	fileA: TFile;
	fileB: TFile;
	otherFile: TFile;
	renameFile(file: TFile, path: string, folder: string): void;
} {
	const frontmatterByPath = new Map<string, Record<string, unknown>>();
	const fileA = makeFile("Old/A.md", "Old");
	const fileB = makeFile("Old/Sub/B.md", "Old/Sub");
	const otherFile = makeFile("Other/C.md", "Other");
	frontmatterByPath.set(fileA.path, { rating: 9 });
	frontmatterByPath.set(fileB.path, { rating: 7 });
	frontmatterByPath.set(otherFile.path, { status: "active" });

	const app = {
		metadataCache: {
			getFileCache(file: TFile) {
				return {
					frontmatter: frontmatterByPath.get(file.path) ?? {},
					tags: [],
					links: [],
				};
			},
		},
		vault: {
			cachedRead: async () => "",
		},
	} as unknown as App;

	return {
		app,
		fileA,
		fileB,
		otherFile,
		renameFile(file, path, folder) {
			const previousFrontmatter = frontmatterByPath.get(file.path) ?? {};
			frontmatterByPath.delete(file.path);
			file.path = path;
			file.name = path.split("/").pop() ?? path;
			file.basename = file.name.replace(/\.md$/, "");
			file.parent = makeFolder(folder);
			frontmatterByPath.set(path, previousFrontmatter);
		},
	};
}

function makeFile(path: string, folder: string): TFile {
	const file = new TFile();
	file.path = path;
	file.name = path.split("/").pop() ?? path;
	file.basename = file.name.replace(/\.md$/, "");
	file.extension = "md";
	file.parent = makeFolder(folder);
	file.stat = { ctime: 1, mtime: 2, size: 10 };
	return file;
}

function makeFolder(path: string): TFolder {
	const folder = new TFolder();
	folder.path = path;
	return folder;
}
