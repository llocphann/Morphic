import { TFile, type App } from "obsidian";
import { describe, expect, it } from "vitest";
import { RevisionStore } from "../core/dependencies";
import { FileSnapshotStore } from "../core/file-snapshot";

function file(path: string): TFile {
	const value = new TFile();
	value.path = path;
	value.name = path.split("/").pop() ?? path;
	value.basename = value.name.replace(/\.md$/, "");
	value.extension = "md";
	value.parent = null;
	value.stat = { ctime: 1, mtime: 1, size: 5 };
	return value;
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(next => {
		resolve = next;
	});
	return { promise, resolve };
}

describe("FileSnapshotStore clear in-flight ownership", () => {
	it("targeted clear revokes old in-flight reuse without letting the stale completion delete the replacement", async () => {
		const target = file("Target.md");
		const first = deferred<string>();
		const second = deferred<string>();
		let reads = 0;
		const app = {
			metadataCache: {
				getFileCache: () => ({ frontmatter: undefined }),
			},
			vault: {
				cachedRead: async () => {
					reads++;
					if (reads === 1) return first.promise;
					if (reads === 2) return second.promise;
					throw new Error(`unexpected physical body read ${reads}`);
				},
			},
		} as unknown as App;
		const store = new FileSnapshotStore(app, new RevisionStore());

		const stale = store.body(target);
		expect(reads).toBe(1);

		store.clear(target.path);
		const replacement = store.body(target);
		expect(reads).toBe(2);

		first.resolve("alpha");
		expect(await stale).toBe("alpha");

		const joinedReplacement = store.body(target);
		expect(reads).toBe(2);

		second.resolve("bravo");
		expect(await replacement).toBe("bravo");
		expect(await joinedReplacement).toBe("bravo");
		expect(await store.body(target)).toBe("bravo");
		expect(reads).toBe(2);
	});

	it("global clear revokes in-flight reuse independently for every active path", async () => {
		const firstFile = file("A.md");
		const secondFile = file("B.md");
		const pending = [
			deferred<string>(),
			deferred<string>(),
			deferred<string>(),
			deferred<string>(),
		];
		let reads = 0;
		const app = {
			metadataCache: {
				getFileCache: () => ({ frontmatter: undefined }),
			},
			vault: {
				cachedRead: async () => {
					const current = pending[reads];
					reads++;
					if (!current) throw new Error(`unexpected physical body read ${reads}`);
					return current.promise;
				},
			},
		} as unknown as App;
		const store = new FileSnapshotStore(app, new RevisionStore());

		const staleA = store.body(firstFile);
		const staleB = store.body(secondFile);
		expect(reads).toBe(2);

		store.clear();
		const freshA = store.body(firstFile);
		const freshB = store.body(secondFile);
		expect(reads).toBe(4);

		pending[0].resolve("old-a");
		pending[1].resolve("old-b");
		pending[2].resolve("new-a");
		pending[3].resolve("new-b");

		expect(await staleA).toBe("old-a");
		expect(await staleB).toBe("old-b");
		expect(await freshA).toBe("new-a");
		expect(await freshB).toBe("new-b");
		expect(await store.body(firstFile)).toBe("new-a");
		expect(await store.body(secondFile)).toBe("new-b");
		expect(reads).toBe(4);
	});

	it("targeted clear leaves unrelated in-flight dedup intact", async () => {
		const firstFile = file("A.md");
		const secondFile = file("B.md");
		const first = deferred<string>();
		const second = deferred<string>();
		let reads = 0;
		const app = {
			metadataCache: {
				getFileCache: () => ({ frontmatter: undefined }),
			},
			vault: {
				cachedRead: async (target: TFile) => {
					reads++;
					return target.path === firstFile.path ? first.promise : second.promise;
				},
			},
		} as unknown as App;
		const store = new FileSnapshotStore(app, new RevisionStore());

		const pendingA = store.body(firstFile);
		const pendingB = store.body(secondFile);
		expect(reads).toBe(2);
		store.clear(firstFile.path);

		const joinedB = store.body(secondFile);
		expect(reads).toBe(2);
		second.resolve("b");
		expect(await pendingB).toBe("b");
		expect(await joinedB).toBe("b");

		first.resolve("a");
		expect(await pendingA).toBe("a");
	});
});
