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

describe("FileSnapshotStore in-flight path identity", () => {
	it("never warms a renamed path from a body read that started under the old path", async () => {
		const target = file("Old.md");
		const oldRead = deferred<string>();
		const newRead = deferred<string>();
		let reads = 0;
		const app = {
			metadataCache: {
				getFileCache: () => ({ frontmatter: undefined }),
			},
			vault: {
				cachedRead: async () => {
					reads++;
					if (reads === 1) return oldRead.promise;
					if (reads === 2) return newRead.promise;
					throw new Error(`unexpected physical body read ${reads}`);
				},
			},
		} as unknown as App;
		const store = new FileSnapshotStore(app, new RevisionStore());

		const stale = store.body(target);
		expect(reads).toBe(1);

		// Obsidian mutates the same TFile object during rename. Model the event-lag
		// window where path identity changed before the rename event/revision arrives.
		target.path = "New.md";
		target.name = "New.md";
		target.basename = "New";

		oldRead.resolve("alpha");
		expect(await stale).toBe("alpha");

		const fresh = store.body(target);
		expect(reads).toBe(2);
		newRead.resolve("bravo");
		expect(await fresh).toBe("bravo");
		expect(await store.body(target)).toBe("bravo");
		expect(reads).toBe(2);
	});
});
