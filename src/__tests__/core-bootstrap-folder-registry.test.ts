import { TFile, TFolder, type App } from "obsidian";
import { describe, expect, it } from "vitest";
import { dependencyKey } from "../core/dependencies";
import { InvalidationEngine } from "../core/invalidation-engine";
import { ReactiveDataCore } from "../core/reactive-data-core";

function file(path: string): TFile {
	const value = new TFile();
	value.path = path;
	value.name = path.split("/").pop() ?? path;
	value.basename = value.name.replace(/\.md$/, "");
	value.extension = "md";
	const folderPath = path.split("/").slice(0, -1).join("/");
	const parent = new TFolder();
	parent.path = folderPath;
	parent.name = folderPath.split("/").pop() ?? folderPath;
	parent.parent = null;
	parent.children = [value];
	value.parent = parent;
	value.stat = { ctime: 1, mtime: 1, size: 1 };
	return value;
}

function app(): App {
	return {
		metadataCache: {
			getFileCache: () => ({ frontmatter: {}, tags: [], links: [] }),
		},
		vault: { cachedRead: async () => "" },
	} as unknown as App;
}

describe("ReactiveDataCore bootstrap folder registry", () => {
	it("preserves the full ancestor chain discovered from bootstrapped files", () => {
		const core = new ReactiveDataCore(app(), new InvalidationEngine<string>(() => undefined));

		core.bootstrap([file("Notes/Nested/A.md")]);

		expect(core.index.folderPaths()).toEqual(["Notes", "Notes/Nested"]);
		expect(core.stats().indexedFolders).toBe(2);
	});

	it("ancestor-closes an explicitly supplied authoritative folder registry", () => {
		const core = new ReactiveDataCore(app(), new InvalidationEngine<string>(() => undefined));

		core.bootstrap([], ["Archive/Deep"]);

		expect(core.index.folderPaths()).toEqual(["Archive", "Archive/Deep"]);
	});

	it("routes newly inferred parent and child folder existence exactly once", () => {
		const invalidation = new InvalidationEngine<string>(() => undefined);
		const core = new ReactiveDataCore(app(), invalidation);
		core.bootstrap([]);
		invalidation.commitDependencies("folders-owner", [dependencyKey.index("folders")]);
		invalidation.commitDependencies("parent-owner", [dependencyKey.index("folder-exists", "Archive")]);
		invalidation.commitDependencies("child-owner", [dependencyKey.index("folder-exists", "Archive/Deep")]);

		expect(new Set(core.folderCreated("Archive/Deep"))).toEqual(new Set([
			"folders-owner",
			"parent-owner",
			"child-owner",
		]));
		expect(core.index.folderPaths()).toEqual(["Archive", "Archive/Deep"]);
		expect(core.folderCreated("Archive/Deep")).toEqual([]);
	});
});
