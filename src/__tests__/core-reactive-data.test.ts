import type { App, TFile } from "obsidian";
import { describe, expect, it } from "vitest";
import { ReactiveDataEventMap } from "../core/data-events";
import { DependencyCollector, RevisionStore, dependencyKey } from "../core/dependencies";
import {
	FileSnapshotStore,
	type FileMetadataSnapshot,
} from "../core/file-snapshot";
import { VaultIndex, propertyValueIndexKey } from "../core/vault-index";

describe("Morphic reactive file snapshots", () => {
	it("keeps metadata-only reads body-free and records the exact property dependency", () => {
		const fixture = createFixture();
		const revisions = new RevisionStore();
		const store = new FileSnapshotStore(fixture.app, revisions);
		const session = store.beginRender();

		expect(session.file(fixture.fileA).property("rating")).toBe(9);
		expect(fixture.readCount()).toBe(0);
		expect(Array.from(session.dependencies())).toEqual([
			dependencyKey.file("Notes/A.md", "frontmatter", "rating"),
		]);
	});

	it("deduplicates body reads across owners and refreshes only after content revision changes", async () => {
		const fixture = createFixture();
		const revisions = new RevisionStore();
		const store = new FileSnapshotStore(fixture.app, revisions);

		const first = store.beginRender().file(fixture.fileA).body();
		const second = store.beginRender().file(fixture.fileA).body();
		expect(await Promise.all([first, second])).toEqual(["Alpha body", "Alpha body"]);
		expect(fixture.readCount()).toBe(1);

		expect(await store.beginRender().file(fixture.fileA).body()).toBe("Alpha body");
		expect(fixture.readCount()).toBe(1);

		fixture.setContent("Notes/A.md", "---\nrating: 10\n---\nUpdated body");
		revisions.bump(dependencyKey.file("Notes/A.md", "content"));
		expect(await store.beginRender().file(fixture.fileA).body()).toBe("Updated body");
		expect(fixture.readCount()).toBe(2);
	});

	it("does not let an old in-flight body read poison a newer revision cache", async () => {
		const target = file("Notes/Race.md", 10);
		const resolvers: Array<(value: string) => void> = [];
		let reads = 0;
		const app = {
			metadataCache: { getFileCache: () => null },
			vault: {
				cachedRead: () => {
					reads++;
					return new Promise<string>(resolve => resolvers.push(resolve));
				},
			},
		} as unknown as App;
		const revisions = new RevisionStore();
		const store = new FileSnapshotStore(app, revisions);

		const oldRead = store.beginRender().file(target).body();
		revisions.bump(dependencyKey.file(target.path, "content"));
		const newRead = store.beginRender().file(target).body();
		expect(reads).toBe(2);

		resolvers[1]("new revision");
		expect(await newRead).toBe("new revision");
		resolvers[0]("old revision");
		expect(await oldRead).toBe("old revision");

		expect(await store.beginRender().file(target).body()).toBe("new revision");
		expect(reads).toBe(2);
	});

	it("tracks the actual linked file selected at runtime without materializing its body", () => {
		const fixture = createFixture();
		const store = new FileSnapshotStore(fixture.app, new RevisionStore());
		const session = store.beginRender();

		expect(session.file(fixture.fileB).property("author")).toBe("Ada");
		expect(fixture.readCount()).toBe(0);
		expect(session.dependencies().has(
			dependencyKey.file("People/B.md", "frontmatter", "author"),
		)).toBe(true);
	});
});

describe("Morphic incremental VaultIndex", () => {
	it("indexes folders, tags, properties and property values with tracked query dependencies", () => {
		const index = new VaultIndex();
		const collector = new DependencyCollector();
		index.upsert(metadata({
			path: "Notes/A.md",
			folder: "Notes",
			tags: ["#project", "#alpha"],
			frontmatter: { rating: 9, status: "active" },
		}));

		expect(index.filesInFolder("Notes", collector)).toEqual(["Notes/A.md"]);
		expect(index.filesWithTag("project", collector)).toEqual(["Notes/A.md"]);
		expect(index.filesWithProperty("rating", collector)).toEqual(["Notes/A.md"]);
		expect(index.filesWithPropertyValue("rating", 9, collector)).toEqual(["Notes/A.md"]);
		expect(collector.has(dependencyKey.index("folder", "Notes"))).toBe(true);
		expect(collector.has(dependencyKey.index("tag", "#project"))).toBe(true);
		expect(collector.has(dependencyKey.index("property", "rating"))).toBe(true);
		expect(collector.has(propertyValueIndexKey("rating", 9))).toBe(true);
	});

	it("keeps empty folders and exposes autocomplete lists without rescanning vault files", () => {
		const index = new VaultIndex();
		const collector = new DependencyCollector();
		index.replaceFolders(["Empty", "Notes"]);
		index.upsert(metadata({
			path: "Notes/A.md",
			folder: "Notes",
			tags: ["#project"],
			frontmatter: { status: ["active", "queued"], rating: 9 },
		}));

		expect(index.folderPaths(collector)).toEqual(["Empty", "Notes"]);
		expect(index.allTags(collector)).toEqual(["#project"]);
		expect(index.propertyNames(collector)).toEqual(["rating", "status"]);
		expect(index.propertySuggestionValues("status", collector)).toEqual(["active", "queued"]);
		expect(collector.has(dependencyKey.index("folders"))).toBe(true);
		expect(collector.has(dependencyKey.index("tags"))).toBe(true);
		expect(collector.has(dependencyKey.index("properties"))).toBe(true);
		expect(collector.has(dependencyKey.index("property-values", "status"))).toBe(true);

		index.remove("Notes/A.md");
		expect(index.folderPaths()).toEqual(["Empty", "Notes"]);
	});

	it("does not invalidate coarse autocomplete data when the unique values stay unchanged", () => {
		const index = new VaultIndex();
		index.upsert(metadata({
			path: "Notes/A.md",
			tags: ["#shared"],
			frontmatter: { status: ["active", "queued"] },
		}));
		index.upsert(metadata({
			path: "Notes/B.md",
			tags: ["#shared"],
			frontmatter: { status: "active" },
		}));

		const changed = new Set(index.upsert(metadata({
			path: "Notes/A.md",
			tags: ["#shared"],
			frontmatter: { status: "queued" },
		})));
		expect(index.allTags()).toEqual(["#shared"]);
		expect(index.propertySuggestionValues("status")).toEqual(["active", "queued"]);
		expect(changed.has(dependencyKey.index("tags"))).toBe(false);
		expect(changed.has(dependencyKey.index("properties"))).toBe(false);
		expect(changed.has(dependencyKey.index("property-values", "status"))).toBe(false);
	});

	it("does not invalidate an unrelated property dependency when another field changes", () => {
		const index = new VaultIndex();
		index.upsert(metadata({
			path: "Notes/A.md",
			frontmatter: { rating: 9, author: "Ada" },
		}));

		const changed = new Set(index.upsert(metadata({
			path: "Notes/A.md",
			frontmatter: { rating: 9, author: "Grace" },
		})));

		expect(changed.has(dependencyKey.file("Notes/A.md", "frontmatter", "author"))).toBe(true);
		expect(changed.has(dependencyKey.file("Notes/A.md", "frontmatter", "rating"))).toBe(false);
		expect(changed.has(propertyValueIndexKey("author", "Ada"))).toBe(true);
		expect(changed.has(propertyValueIndexKey("author", "Grace"))).toBe(true);
		expect(changed.has(dependencyKey.index("property", "author"))).toBe(false);
	});

	it("updates memberships correctly across rename and delete", () => {
		const index = new VaultIndex();
		index.upsert(metadata({
			path: "Old/A.md",
			folder: "Old",
			tags: ["#project"],
			frontmatter: { status: "active" },
		}));

		const renameKeys = new Set(index.rename("Old/A.md", metadata({
			path: "New/A.md",
			folder: "New",
			tags: ["#project"],
			frontmatter: { status: "active" },
		})));
		expect(index.filesInFolder("Old")).toEqual([]);
		expect(index.filesInFolder("New")).toEqual(["New/A.md"]);
		expect(index.filesWithTag("#project")).toEqual(["New/A.md"]);
		expect(renameKeys.has(dependencyKey.file("Old/A.md", "exists"))).toBe(true);
		expect(renameKeys.has(dependencyKey.file("New/A.md", "exists"))).toBe(true);

		const deleteKeys = new Set(index.remove("New/A.md"));
		expect(index.allPaths()).toEqual([]);
		expect(index.filesWithProperty("status")).toEqual([]);
		expect(deleteKeys.has(dependencyKey.file("New/A.md", "content"))).toBe(true);
	});
});

describe("Morphic reactive data event mapping", () => {
	it("keeps byte modifications separate from metadata-cache field invalidation", () => {
		const index = new VaultIndex();
		const events = new ReactiveDataEventMap(index);
		events.fileCreated(metadata({
			path: "Notes/A.md",
			frontmatter: { rating: 9 },
		}));

		expect(events.fileContentModified("Notes/A.md")).toEqual([
			dependencyKey.file("Notes/A.md", "content"),
		]);

		const metadataKeys = new Set(events.fileMetadataRefreshed(metadata({
			path: "Notes/A.md",
			frontmatter: { rating: 10 },
		})));
		expect(metadataKeys.has(dependencyKey.file("Notes/A.md", "frontmatter", "rating"))).toBe(true);
		expect(metadataKeys.has(dependencyKey.file("Notes/A.md", "content"))).toBe(false);
	});

	it("maps folder lifecycle without dropping empty folders", () => {
		const index = new VaultIndex();
		const events = new ReactiveDataEventMap(index);
		events.foldersBootstrapped(["Empty", "Notes"]);
		expect(index.folderPaths()).toEqual(["Empty", "Notes"]);
		expect(events.folderRenamed("Empty", "Archive")).toContain(dependencyKey.index("folders"));
		expect(index.folderPaths()).toEqual(["Archive", "Notes"]);
		expect(events.folderDeleted("Archive")).toContain(dependencyKey.index("folder-exists", "Archive"));
		expect(index.folderPaths()).toEqual(["Notes"]);
	});

	it("maps settings, Bases and time revisions into the shared dependency vocabulary", () => {
		const events = new ReactiveDataEventMap(new VaultIndex());
		expect(events.settingsChanged("movies")).toEqual([dependencyKey.settings("movies")]);
		expect(events.baseChanged("watchlist")).toEqual([dependencyKey.base("watchlist")]);
		expect(events.timeChanged("today")).toEqual([dependencyKey.time("today")]);
	});
});

function createFixture(): {
	app: App;
	fileA: TFile;
	fileB: TFile;
	readCount(): number;
	setContent(path: string, value: string): void;
} {
	const fileA = file("Notes/A.md", 100);
	const fileB = file("People/B.md", 80);
	const contents = new Map<string, string>([
		["Notes/A.md", "---\nrating: 9\n---\nAlpha body"],
		["People/B.md", "---\nauthor: Ada\n---\nBeta body"],
	]);
	const caches = new Map<string, unknown>([
		["Notes/A.md", {
			frontmatter: { rating: 9, tags: ["project"] },
			tags: [{ tag: "#inline" }],
			links: [{ link: "People/B" }],
		}],
		["People/B.md", {
			frontmatter: { author: "Ada" },
			tags: [],
			links: [],
		}],
	]);
	let reads = 0;
	const app = {
		metadataCache: {
			getFileCache(target: TFile) {
				return caches.get(target.path) ?? null;
			},
		},
		vault: {
			async cachedRead(target: TFile) {
				reads++;
				return contents.get(target.path) ?? "";
			},
		},
	} as unknown as App;

	return {
		app,
		fileA,
		fileB,
		readCount: () => reads,
		setContent: (path: string, value: string) => contents.set(path, value),
	};
}

function file(path: string, size: number): TFile {
	const slash = path.lastIndexOf("/");
	const name = slash >= 0 ? path.slice(slash + 1) : path;
	const dot = name.lastIndexOf(".");
	const fixture = {
		path,
		name,
		basename: dot >= 0 ? name.slice(0, dot) : name,
		extension: dot >= 0 ? name.slice(dot + 1) : "",
		parent: { path: slash >= 0 ? path.slice(0, slash) : "" },
		stat: { ctime: 1, mtime: 2, size },
	};
	// Test-only structural fixture; constructing a real Obsidian TFile requires a live Vault.
	// eslint-disable-next-line obsidianmd/no-tfile-tfolder-cast
	return fixture as TFile;
}

function metadata(overrides: Partial<FileMetadataSnapshot> = {}): FileMetadataSnapshot {
	const path = overrides.path ?? "Notes/A.md";
	const slash = path.lastIndexOf("/");
	const name = slash >= 0 ? path.slice(slash + 1) : path;
	const dot = name.lastIndexOf(".");
	return {
		path,
		name: overrides.name ?? name,
		basename: overrides.basename ?? (dot >= 0 ? name.slice(0, dot) : name),
		extension: overrides.extension ?? (dot >= 0 ? name.slice(dot + 1) : ""),
		folder: overrides.folder ?? (slash >= 0 ? path.slice(0, slash) : ""),
		size: overrides.size ?? 1,
		ctime: overrides.ctime ?? 1,
		mtime: overrides.mtime ?? 1,
		tags: overrides.tags ?? [],
		links: overrides.links ?? [],
		frontmatter: overrides.frontmatter ?? {},
	};
}
