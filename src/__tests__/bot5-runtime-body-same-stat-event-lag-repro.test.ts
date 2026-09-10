import { TFile, type App } from "obsidian";
import { describe, expect, it } from "vitest";
import { InvalidationEngine } from "../core/invalidation-engine";
import { ReactiveDataCore } from "../core/reactive-data-core";
import { beginRevisionTrackedRuntimeRender } from "../core/tracked-runtime-render";

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

describe("Bot 5 runtime body same-stat event-lag race", () => {
	it("rejects an old in-flight body when backing content changes with identical stat before revision delivery", async () => {
		const target = file("Target.md");
		const firstRead = deferred<string>();
		let physicalReads = 0;
		const app = {
			metadataCache: {
				getFileCache: () => ({ frontmatter: {}, tags: [], links: [] }),
			},
			vault: {
				cachedRead: async () => {
					physicalReads++;
					if (physicalReads === 1) return firstRead.promise;
					return "bravo";
				},
			},
		} as unknown as App;
		const invalidation = new InvalidationEngine<string>(() => undefined);
		const core = new ReactiveDataCore(app, invalidation);
		const render = beginRevisionTrackedRuntimeRender(core);

		const pendingBody = render.runtime.file(target).body();
		const readSet = render.freezeReadSet();
		expect(readSet.isCurrent()).toBe(true);
		expect(render.isSynchronouslyCurrent()).toBe(true);

		// External/backing content becomes a same-length replacement before the
		// corresponding runtime-data event/revision has been delivered. TFile.stat
		// intentionally remains identical, matching the already-proven #143
		// same-stat freshness class.
		firstRead.resolve("alpha");
		expect(await pendingBody).toBe("alpha");
		expect(target.stat).toEqual({ ctime: 1, mtime: 1, size: 5 });
		expect(readSet.isCurrent()).toBe(true);

		// A transaction that prepared "alpha" must not be allowed to commit after
		// the backing source has become "bravo", even though size/mtime alone cannot
		// distinguish the two values and the event revision has not arrived yet.
		expect(render.isSynchronouslyCurrent()).toBe(false);
	});
});

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(next => {
		resolve = next;
	});
	return { promise, resolve };
}
