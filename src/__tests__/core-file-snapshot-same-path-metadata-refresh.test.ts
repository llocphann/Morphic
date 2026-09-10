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

describe("FileSnapshotStore same-path metadata refresh", () => {
	it("uses metadata that becomes available while the same-path body read is pending", async () => {
		const target = file("Note.md");
		const pending = deferred<string>();
		let reads = 0;
		let metadataReady = false;
		const app = {
			vault: {
				cachedRead: async () => {
					reads++;
					return pending.promise;
				},
			},
			metadataCache: {
				getFileCache: () => metadataReady
					? { frontmatter: { status: "ready" } }
					: {},
			},
		} as unknown as App;
		const store = new FileSnapshotStore(app, new RevisionStore());

		const body = store.body(target);
		expect(reads).toBe(1);

		// Same TFile identity/path; only MetadataCache catches up while the physical
		// read is pending. Canonical pre-#801 behavior consulted this fresh metadata
		// after the await and therefore stripped the YAML frontmatter.
		metadataReady = true;
		pending.resolve("---\nstatus: ready\n---\nBody");

		expect(await body).toBe("Body");
		expect(reads).toBe(1);
	});
});
