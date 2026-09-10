import { TFile, type App } from "obsidian";
import { describe, expect, it } from "vitest";
import {
	RevisionTrackingDependencyCollector,
} from "../core/dependency-read-set";
import { dependencyKey, RevisionStore } from "../core/dependencies";
import { InvalidationEngine } from "../core/invalidation-engine";
import { ReactiveDataCore } from "../core/reactive-data-core";

describe("Morphic dependency revision read sets", () => {
	it("keeps the first observed revision even when the same dependency is read again", () => {
		const revisions = new RevisionStore();
		const collector = new RevisionTrackingDependencyCollector(revisions);
		const key = dependencyKey.file("Notes/A.md", "frontmatter", "rating");

		collector.track(key);
		const beforeChange = collector.readSet();
		expect(beforeChange.isCurrent()).toBe(true);

		revisions.bump(key);
		collector.track(key);
		const mixedRevision = collector.readSet();

		expect(mixedRevision.isCurrent()).toBe(false);
		expect(mixedRevision.staleDependencies()).toEqual([key]);
		expect(mixedRevision.dependencies()).toEqual(new Set([key]));
	});

	it("clear starts a fresh read contract", () => {
		const revisions = new RevisionStore();
		const collector = new RevisionTrackingDependencyCollector(revisions);
		const oldKey = dependencyKey.file("Notes/A.md", "content");
		const nextKey = dependencyKey.settings();

		collector.trackMany([oldKey]);
		collector.clear();
		revisions.bump(oldKey);
		collector.trackMany([nextKey]);

		const readSet = collector.readSet();
		expect(readSet.dependencies()).toEqual(new Set([nextKey]));
		expect(readSet.isCurrent()).toBe(true);
	});

	it("treats revision-floor compaction during preparation as stale", () => {
		const revisions = new RevisionStore();
		const collector = new RevisionTrackingDependencyCollector(revisions);
		const readKey = dependencyKey.file("Notes/A.md", "content");
		const transient = dependencyKey.file("Deleted.md", "content");

		collector.track(readKey);
		const readSet = collector.readSet();
		revisions.bump(transient);
		revisions.compact([]);

		expect(readSet.isCurrent()).toBe(false);
		expect(readSet.staleDependencies()).toEqual([readKey]);
	});

	it("rejects an async body preparation changed before its dependency was ever committed", async () => {
		const file = createFile("Notes/A.md");
		const gate = deferred<string>();
		const app = createApp({
			files: [file],
			read: async () => gate.promise,
		});
		const invalidation = new InvalidationEngine<string>(() => undefined);
		const core = new ReactiveDataCore(app, invalidation);
		core.bootstrap([file]);
		const collector = new RevisionTrackingDependencyCollector(invalidation.revisions);
		const session = core.beginRuntimeRender(collector);

		const body = session.file(file).body();
		const readSet = collector.readSet();
		expect(invalidation.index.dependenciesOf("owner").size).toBe(0);
		expect(readSet.isCurrent()).toBe(true);

		core.fileContentModified(file);
		expect(readSet.isCurrent()).toBe(false);
		expect(readSet.staleDependencies()).toContain(
			dependencyKey.file(file.path, "content"),
		);

		gate.resolve("old body");
		expect(await body).toBe("old body");
		expect(readSet.isCurrent()).toBe(false);
	});

	it("rejects an unresolved runtime target when the file universe changes before commit", () => {
		const root = createFile("Notes/A.md");
		const target = createFile("People/B.md");
		let resolved: TFile | null = null;
		const app = createApp({
			files: [root, target],
			resolve: () => resolved,
		});
		const invalidation = new InvalidationEngine<string>(() => undefined);
		const core = new ReactiveDataCore(app, invalidation);
		core.bootstrap([root]);
		const collector = new RevisionTrackingDependencyCollector(invalidation.revisions);
		const session = core.beginRuntimeRender(collector);

		expect(session.resolveFile("person", root.path)).toBeNull();
		const readSet = collector.readSet();
		expect(readSet.dependencies()).toEqual(new Set([dependencyKey.index("files")]));
		expect(readSet.isCurrent()).toBe(true);

		resolved = target;
		core.fileCreated(target);
		expect(readSet.isCurrent()).toBe(false);
		expect(readSet.staleDependencies()).toEqual([dependencyKey.index("files")]);
	});

	it("rejects a newly resolved linked property changed before reverse-index commit", () => {
		const root = createFile("Notes/A.md");
		const target = createFile("People/B.md");
		const frontmatter = new Map<string, Record<string, unknown>>([
			[root.path, { person: "[[People/B]]" }],
			[target.path, { author: "Ada" }],
		]);
		const app = createApp({
			files: [root, target],
			frontmatter,
			resolve: () => target,
		});
		const invalidation = new InvalidationEngine<string>(() => undefined);
		const core = new ReactiveDataCore(app, invalidation);
		core.bootstrap([root, target]);
		const collector = new RevisionTrackingDependencyCollector(invalidation.revisions);
		const session = core.beginRuntimeRender(collector);

		expect(session.linkedProperty("People/B", root.path, "author")).toBe("Ada");
		const readSet = collector.readSet();
		expect(invalidation.index.dependenciesOf("owner").size).toBe(0);
		expect(readSet.isCurrent()).toBe(true);

		frontmatter.set(target.path, { author: "Grace" });
		core.fileMetadataRefreshed(target);

		expect(readSet.isCurrent()).toBe(false);
		expect(readSet.staleDependencies()).toContain(
			dependencyKey.file(target.path, "frontmatter", "author"),
		);
	});
});

function createApp(options: {
	files: readonly TFile[];
	frontmatter?: Map<string, Record<string, unknown>>;
	read?: (file: TFile) => Promise<string>;
	resolve?: (linkPath: string, sourcePath: string) => TFile | null;
}): App {
	const frontmatter = options.frontmatter ?? new Map<string, Record<string, unknown>>();
	return {
		metadataCache: {
			getFileCache(file: TFile) {
				return {
					frontmatter: frontmatter.get(file.path) ?? {},
					tags: [],
					links: [],
				};
			},
			getFirstLinkpathDest(linkPath: string, sourcePath: string) {
				return options.resolve?.(linkPath, sourcePath) ?? null;
			},
		},
		vault: {
			async cachedRead(file: TFile) {
				return options.read ? options.read(file) : `${file.basename} body`;
			},
		},
	} as unknown as App;
}

function createFile(path: string): TFile {
	const file = new TFile();
	file.path = path;
	file.name = path.split("/").pop() ?? path;
	file.basename = file.name.replace(/\.md$/, "");
	file.extension = "md";
	file.parent = null;
	file.stat = { ctime: 1, mtime: 1, size: 32 };
	return file;
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(next => {
		resolve = next;
	});
	return { promise, resolve };
}
