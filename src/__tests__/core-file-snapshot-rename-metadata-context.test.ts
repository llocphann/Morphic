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
	value.stat = { ctime: 1, mtime: 1, size: 32 };
	return value;
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(next => {
		resolve = next;
	});
	return { promise, resolve };
}

describe("FileSnapshotStore rename metadata context", () => {
	it("freezes old-path frontmatter context before the TFile and cache mutate", async () => {
		const target = file("Old.md");
		const pending = deferred<string>();
		let reads = 0;
		const oldCache: {
			frontmatter?: Record<string, unknown>;
			frontmatterPosition?: {
				start: { line: number; col: number; offset: number };
				end: { line: number; col: number; offset: number };
			};
		} = {
			frontmatter: { status: "old" },
			frontmatterPosition: {
				start: { line: 0, col: 0, offset: 0 },
				end: { line: 2, col: 3, offset: 22 },
			},
		};
		const app = {
			vault: {
				cachedRead: async () => {
					reads++;
					return pending.promise;
				},
			},
			metadataCache: {
				getFileCache: (current: TFile) => current.path === "Old.md" ? oldCache : {},
			},
		} as unknown as App;
		const store = new FileSnapshotStore(app, new RevisionStore(), { collectStats: true });

		const oldCaller = store.body(target);
		expect(reads).toBe(1);

		target.path = "New.md";
		target.name = "New.md";
		target.basename = "New";
		delete oldCache.frontmatter;
		delete oldCache.frontmatterPosition;
		pending.resolve("---\nstatus: old\n---\nOld body");

		expect(await oldCaller).toBe("Old body");
		expect(store.stats().bodyEntries).toBe(0);
		expect(store.stats().staleBodyCompletionsSuppressed).toBe(1);
	});
});
