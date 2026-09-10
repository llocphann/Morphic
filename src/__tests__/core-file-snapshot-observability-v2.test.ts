import { TFile, type App } from "obsidian";
import { describe, expect, it } from "vitest";
import { dependencyKey, RevisionStore } from "../core/dependencies";
import { FileSnapshotStore } from "../core/file-snapshot";

describe("Morphic FileSnapshotStore observability v2", () => {
	it("preserves the exact legacy stats shape when counters are disabled", async () => {
		const file = createFile("Notes/A.md");
		const app = createImmediateApp(new Map([[file.path, "A body"]]));
		const store = new FileSnapshotStore(app, new RevisionStore());

		store.metadata(file);
		expect(await store.body(file)).toBe("A body");
		expect(store.stats()).toEqual({
			metadataEntries: 1,
			bodyEntries: 1,
			bodyInFlight: 0,
			metadataCacheLimit: 512,
			bodyCacheLimit: 128,
		});
	});

	it("counts metadata cache hits, misses, and only capacity evictions", () => {
		const fileA = createFile("Notes/A.md");
		const fileB = createFile("Notes/B.md");
		const app = createImmediateApp(new Map([
			[fileA.path, "A body"],
			[fileB.path, "B body"],
		]));
		const store = new FileSnapshotStore(app, new RevisionStore(), {
			metadataCacheLimit: 1,
			bodyCacheLimit: 1,
			collectStats: true,
		});

		store.metadata(fileA);
		store.metadata(fileA);
		store.metadata(fileB);
		expect(store.stats()).toMatchObject({
			observabilityEnabled: true,
			metadataEntries: 1,
			metadataCacheHits: 1,
			metadataCacheMisses: 2,
			metadataEvictions: 1,
			bodyReads: 0,
			bodyValidationReads: 0,
		});

		store.clear(fileB.path);
		expect(store.stats()).toMatchObject({ metadataEntries: 0, metadataEvictions: 1 });
	});

	it("distinguishes body cache hits from cross-owner in-flight dedup", async () => {
		const file = createFile("Notes/A.md");
		const gate = deferred<string>();
		let reads = 0;
		const app = createApp(async () => {
			reads++;
			return gate.promise;
		});
		const store = new FileSnapshotStore(app, new RevisionStore(), { collectStats: true });

		const first = store.body(file);
		const second = store.body(file);
		expect(store.stats()).toMatchObject({
			bodyCacheHits: 0,
			bodyCacheMisses: 2,
			bodyInFlightDedupHits: 1,
			bodyReads: 1,
			bodyValidationReads: 0,
			bodyInFlight: 1,
		});
		expect(reads).toBe(1);

		gate.resolve("A body");
		expect(await Promise.all([first, second])).toEqual(["A body", "A body"]);
		expect(await store.body(file)).toBe("A body");
		expect(store.stats()).toMatchObject({
			bodyCacheHits: 1,
			bodyCacheMisses: 2,
			bodyInFlightDedupHits: 1,
			bodyReads: 1,
			bodyValidationReads: 0,
			bodyEntries: 1,
		});
	});

	it("counts freshness-fence reads as a separate subset of physical body reads", async () => {
		const file = createFile("Notes/A.md");
		let reads = 0;
		const app = createApp(async () => {
			reads++;
			return "A body";
		});
		const store = new FileSnapshotStore(app, new RevisionStore(), { collectStats: true });
		const session = store.beginRender();
		const tracked = session.file(file);

		expect(await tracked.body()).toBe("A body");
		session.requestSynchronousValidation();
		expect(await session.settleSynchronousValidation()).toBe(true);
		expect(reads).toBe(2);
		expect(store.stats()).toMatchObject({
			bodyReads: 2,
			bodyValidationReads: 1,
			bodyCacheMisses: 1,
			bodyCacheHits: 0,
		});
	});

	it("reports stale body completion suppression without warming stale data", async () => {
		const file = createFile("Notes/A.md");
		const firstGate = deferred<string>();
		const secondGate = deferred<string>();
		const gates = [firstGate, secondGate];
		let reads = 0;
		const app = createApp(async () => {
			const gate = gates[reads++];
			if (!gate) throw new Error("Unexpected body read");
			return gate.promise;
		});
		const revisions = new RevisionStore();
		const store = new FileSnapshotStore(app, revisions, { collectStats: true });

		const staleRead = store.body(file);
		revisions.bump(dependencyKey.file(file.path, "content"));
		firstGate.resolve("stale body");
		expect(await staleRead).toBe("stale body");
		expect(store.stats()).toMatchObject({
			bodyEntries: 0,
			bodyReads: 1,
			staleBodyCompletionsSuppressed: 1,
		});

		const freshRead = store.body(file);
		secondGate.resolve("fresh body");
		expect(await freshRead).toBe("fresh body");
		expect(store.stats()).toMatchObject({
			bodyEntries: 1,
			bodyReads: 2,
			staleBodyCompletionsSuppressed: 1,
		});
	});

	it("resetStats clears counters only and preserves a live in-flight read", async () => {
		const file = createFile("Notes/A.md");
		const gate = deferred<string>();
		let reads = 0;
		const app = createApp(async () => {
			reads++;
			return gate.promise;
		});
		const store = new FileSnapshotStore(app, new RevisionStore(), { collectStats: true });

		const first = store.body(file);
		expect(store.stats()).toMatchObject({ bodyReads: 1, bodyCacheMisses: 1, bodyInFlight: 1 });
		store.resetStats();
		expect(store.stats()).toMatchObject({ bodyReads: 0, bodyCacheMisses: 0, bodyInFlight: 1 });

		const second = store.body(file);
		expect(reads).toBe(1);
		expect(store.stats()).toMatchObject({ bodyCacheMisses: 1, bodyInFlightDedupHits: 1, bodyReads: 0 });
		gate.resolve("A body");
		expect(await Promise.all([first, second])).toEqual(["A body", "A body"]);
	});
});

function createImmediateApp(contents: Map<string, string>): App {
	return createApp(async file => contents.get(file.path) ?? "");
}

function createApp(read: (file: TFile) => Promise<string>): App {
	return {
		metadataCache: {
			getFileCache() {
				return { frontmatter: {}, tags: [], links: [] };
			},
		},
		vault: {
			cachedRead: read,
		},
	} as unknown as App;
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(next => {
		resolve = next;
	});
	return { promise, resolve };
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
