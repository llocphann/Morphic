import { TFile, type App } from "obsidian";
import { describe, expect, it } from "vitest";
import { RevisionStore } from "../core/dependencies";
import { FileSnapshotStore } from "../core/file-snapshot";
import { BOT3_P6_P7_CERT_WORKLOAD } from "./support/bot3-p6-p7-cert-workloads";

function file(path: string): TFile {
	const value = new TFile();
	value.path = path;
	value.name = path.split("/").pop() ?? path;
	value.basename = value.name.replace(/\.md$/, "");
	value.extension = "md";
	value.parent = null;
	value.stat = { ctime: 1, mtime: 1, size: 8 };
	return value;
}

interface Deferred<T> {
	readonly promise: Promise<T>;
	resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("Bot 3 P6/P7 FileSnapshot lifecycle certification harness", () => {
	it("suppresses stale completion cache warming across a deterministic multi-path targeted-clear trace", async () => {
		const files = Array.from(
			{ length: BOT3_P6_P7_CERT_WORKLOAD.snapshotPaths },
			(_, index) => file(`Certification/Snapshot-${index}.md`),
		);
		const oldReads = new Map<string, Deferred<string>>();
		const replacementReads = new Map<string, Deferred<string>>();
		const physicalReads = new Map<string, number>();

		for (let index = 0; index < files.length; index++) {
			const target = files[index];
			oldReads.set(target.path, deferred<string>());
			if (index % 4 === 0) replacementReads.set(target.path, deferred<string>());
		}

		const app = {
			metadataCache: {
				getFileCache: () => ({ frontmatter: undefined }),
			},
			vault: {
				cachedRead: async (target: TFile) => {
					const count = (physicalReads.get(target.path) ?? 0) + 1;
					physicalReads.set(target.path, count);
					if (count === 1) return oldReads.get(target.path)?.promise ?? "";
					if (count === 2) {
						const replacement = replacementReads.get(target.path);
						if (replacement) return replacement.promise;
					}
					throw new Error(`unexpected physical body read ${target.path} #${count}`);
				},
			},
		} as unknown as App;
		const store = new FileSnapshotStore(app, new RevisionStore(), { collectStats: true });

		const firstGeneration = new Map(files.map((target) => [target.path, store.body(target)]));
		expect(store.stats()).toMatchObject({
			bodyReads: BOT3_P6_P7_CERT_WORKLOAD.snapshotPaths,
			bodyInFlight: BOT3_P6_P7_CERT_WORKLOAD.snapshotPaths,
		});

		const replacements = new Map<string, Promise<string>>();
		const joinedUncleared = new Map<string, Promise<string>>();
		for (let index = 0; index < files.length; index++) {
			const target = files[index];
			if (index % 4 === 0) {
				store.clear(target.path);
				replacements.set(target.path, store.body(target));
			} else {
				// Unrelated paths retain in-flight dedup while targeted clears revoke only
				// the selected identities. Physical reads, not async Promise wrapper identity,
				// are the dedup authority.
				joinedUncleared.set(target.path, store.body(target));
			}
		}
		expect(store.stats()).toMatchObject({
			bodyReads:
				BOT3_P6_P7_CERT_WORKLOAD.snapshotPaths + BOT3_P6_P7_CERT_WORKLOAD.snapshotPaths / 4,
			bodyInFlight: BOT3_P6_P7_CERT_WORKLOAD.snapshotPaths,
			bodyInFlightDedupHits:
				BOT3_P6_P7_CERT_WORKLOAD.snapshotPaths - BOT3_P6_P7_CERT_WORKLOAD.snapshotPaths / 4,
		});

		for (const target of files) oldReads.get(target.path)?.resolve(`old:${target.path}`);
		for (let index = 0; index < files.length; index++) {
			const target = files[index];
			expect(await firstGeneration.get(target.path)).toBe(`old:${target.path}`);
			if (index % 4 !== 0) {
				expect(await joinedUncleared.get(target.path)).toBe(`old:${target.path}`);
			}
		}
		expect(store.stats()).toMatchObject({
			bodyEntries:
				BOT3_P6_P7_CERT_WORKLOAD.snapshotPaths - BOT3_P6_P7_CERT_WORKLOAD.snapshotPaths / 4,
			bodyInFlight: BOT3_P6_P7_CERT_WORKLOAD.snapshotPaths / 4,
			staleBodyCompletionsSuppressed: BOT3_P6_P7_CERT_WORKLOAD.snapshotPaths / 4,
		});

		for (const [path, pending] of replacementReads) pending.resolve(`fresh:${path}`);
		for (const [path, pending] of replacements) expect(await pending).toBe(`fresh:${path}`);

		for (let index = 0; index < files.length; index++) {
			const target = files[index];
			const expected = index % 4 === 0 ? `fresh:${target.path}` : `old:${target.path}`;
			expect(await store.body(target)).toBe(expected);
		}
		expect(store.stats()).toMatchObject({
			bodyEntries: BOT3_P6_P7_CERT_WORKLOAD.snapshotPaths,
			bodyInFlight: 0,
			bodyReads:
				BOT3_P6_P7_CERT_WORKLOAD.snapshotPaths + BOT3_P6_P7_CERT_WORKLOAD.snapshotPaths / 4,
			staleBodyCompletionsSuppressed: BOT3_P6_P7_CERT_WORKLOAD.snapshotPaths / 4,
		});
	});

	it("keeps metadata and body cache retention bounded under a full snapshot identity sweep", async () => {
		const files = Array.from(
			{ length: BOT3_P6_P7_CERT_WORKLOAD.snapshotPaths },
			(_, index) => file(`Certification/Pressure-${index}.md`),
		);
		let physicalReads = 0;
		const app = {
			metadataCache: {
				getFileCache: () => ({ frontmatter: {}, tags: [], links: [] }),
			},
			vault: {
				cachedRead: async (target: TFile) => {
					physicalReads += 1;
					return `body:${target.path}`;
				},
			},
		} as unknown as App;
		const store = new FileSnapshotStore(app, new RevisionStore(), {
			metadataCacheLimit: BOT3_P6_P7_CERT_WORKLOAD.snapshotMetadataCacheLimit,
			bodyCacheLimit: BOT3_P6_P7_CERT_WORKLOAD.snapshotBodyCacheLimit,
			collectStats: true,
		});

		for (const target of files) {
			store.metadata(target);
			expect(await store.body(target)).toBe(`body:${target.path}`);
		}
		expect(physicalReads).toBe(BOT3_P6_P7_CERT_WORKLOAD.snapshotPaths);
		expect(store.stats()).toMatchObject({
			metadataEntries: BOT3_P6_P7_CERT_WORKLOAD.snapshotMetadataCacheLimit,
			bodyEntries: BOT3_P6_P7_CERT_WORKLOAD.snapshotBodyCacheLimit,
			bodyInFlight: 0,
			metadataEvictions:
				BOT3_P6_P7_CERT_WORKLOAD.snapshotPaths - BOT3_P6_P7_CERT_WORKLOAD.snapshotMetadataCacheLimit,
			bodyEvictions:
				BOT3_P6_P7_CERT_WORKLOAD.snapshotPaths - BOT3_P6_P7_CERT_WORKLOAD.snapshotBodyCacheLimit,
		});

		for (const target of files.slice(-BOT3_P6_P7_CERT_WORKLOAD.snapshotBodyCacheLimit)) {
			expect(await store.body(target)).toBe(`body:${target.path}`);
		}
		expect(physicalReads).toBe(BOT3_P6_P7_CERT_WORKLOAD.snapshotPaths);
		expect(store.stats()).toMatchObject({
			bodyEntries: BOT3_P6_P7_CERT_WORKLOAD.snapshotBodyCacheLimit,
			bodyInFlight: 0,
			bodyCacheHits: BOT3_P6_P7_CERT_WORKLOAD.snapshotBodyCacheLimit,
		});

		store.clear();
		expect(store.stats()).toMatchObject({
			metadataEntries: 0,
			bodyEntries: 0,
			bodyInFlight: 0,
		});
	});
});
