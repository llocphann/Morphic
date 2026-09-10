import { describe, expect, it, vi } from "vitest";
import { dependencyKey, RevisionStore } from "../core/dependencies";
import { RevisionedAsyncDataCache } from "../core/revisioned-async-cache";

describe("RevisionedAsyncDataCache in-flight revision bound", () => {
	it("keeps only the newest revision joinable for one cache identity and dependency set", async () => {
		const revisions = new RevisionStore();
		const dependency = dependencyKey.file("Data.md", "content");
		const cache = new RevisionedAsyncDataCache<string>(revisions);
		const old = deferred<string>();
		const latest = deferred<string>();
		const oldLoader = vi.fn(() => old.promise);
		const latestLoader = vi.fn(() => latest.promise);

		const oldCaller = cache.get("query", [dependency], oldLoader);
		expect(cache.stats().inFlight).toBe(1);
		revisions.bump(dependency);

		const latestCaller = cache.get("query", [dependency], latestLoader);
		expect(cache.stats().inFlight).toBe(1);
		const joinedLatest = cache.get("query", [dependency], () => Promise.resolve("unexpected"));
		expect(cache.stats().inFlight).toBe(1);
		expect(cache.stats().inFlightHits).toBe(1);
		expect(oldLoader).toHaveBeenCalledTimes(1);
		expect(latestLoader).toHaveBeenCalledTimes(1);

		old.resolve("old");
		expect(await oldCaller).toBe("old");
		// Settling superseded work cannot remove or warm over the newest loader.
		expect(cache.stats().inFlight).toBe(1);
		expect(cache.stats().entries).toBe(0);

		latest.resolve("latest");
		expect(await latestCaller).toBe("latest");
		expect(await joinedLatest).toBe("latest");
		expect(cache.stats().inFlight).toBe(0);
		expect(cache.stats().entries).toBe(1);

		const fallbackLoader = vi.fn(() => Promise.resolve("fallback"));
		expect(await cache.get("query", [dependency], fallbackLoader)).toBe("latest");
		expect(fallbackLoader).not.toHaveBeenCalled();
	});

	it("preserves concurrent exact-fingerprint dedup for different dependency sets sharing one cache key", async () => {
		const revisions = new RevisionStore();
		const firstDependency = dependencyKey.file("A.md", "content");
		const secondDependency = dependencyKey.file("B.md", "content");
		const cache = new RevisionedAsyncDataCache<string>(revisions);
		const first = deferred<string>();
		const second = deferred<string>();
		const firstLoader = vi.fn(() => first.promise);
		const secondLoader = vi.fn(() => second.promise);

		const firstCaller = cache.get("shared-identity", [firstDependency], firstLoader);
		const secondCaller = cache.get("shared-identity", [secondDependency], secondLoader);
		expect(cache.stats().inFlight).toBe(2);

		const firstJoined = cache.get(
			"shared-identity",
			[firstDependency],
			() => Promise.resolve("unexpected-first"),
		);
		const secondJoined = cache.get(
			"shared-identity",
			[secondDependency],
			() => Promise.resolve("unexpected-second"),
		);
		expect(cache.stats().inFlight).toBe(2);
		expect(cache.stats().inFlightHits).toBe(2);
		expect(firstLoader).toHaveBeenCalledTimes(1);
		expect(secondLoader).toHaveBeenCalledTimes(1);

		first.resolve("first");
		second.resolve("second");
		expect(await firstCaller).toBe("first");
		expect(await firstJoined).toBe("first");
		expect(await secondCaller).toBe("second");
		expect(await secondJoined).toBe("second");
	});

	it("bounds 128 unresolved revisions of one dependency set to one joinable in-flight entry", async () => {
		const revisions = new RevisionStore();
		const dependency = dependencyKey.index("property-data", "status");
		const cache = new RevisionedAsyncDataCache<number>(revisions);
		const pending: Array<ReturnType<typeof deferred<number>>> = [];
		const callers: Array<Promise<number>> = [];

		for (let generation = 0; generation < 128; generation++) {
			if (generation > 0) revisions.bump(dependency);
			const load = deferred<number>();
			pending.push(load);
			callers.push(cache.get("same-query", [dependency], () => load.promise));
			expect(cache.stats().inFlight).toBe(1);
		}
		expect(cache.stats().loads).toBe(128);

		for (let generation = 0; generation < 127; generation++) {
			pending[generation].resolve(generation);
			expect(await callers[generation]).toBe(generation);
			expect(cache.stats().inFlight).toBe(1);
			expect(cache.stats().entries).toBe(0);
		}

		pending[127].resolve(127);
		expect(await callers[127]).toBe(127);
		expect(cache.stats().inFlight).toBe(0);
		expect(cache.stats().entries).toBe(1);
		expect(await cache.get("same-query", [dependency], () => -1)).toBe(127);
	});
});

function deferred<T>(): {
	promise: Promise<T>;
	resolve(value: T): void;
} {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(next => {
		resolve = next;
	});
	return { promise, resolve };
}
