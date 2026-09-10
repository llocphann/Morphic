import { describe, expect, it } from "vitest";
import { RevisionStore, dependencyKey } from "../core/dependencies";
import { RevisionedAsyncDataCache } from "../core/revisioned-async-cache";

describe("RevisionedAsyncDataCache", () => {
	it("deduplicates identical concurrent loads and reuses the warm value", async () => {
		const revisions = new RevisionStore();
		const cache = new RevisionedAsyncDataCache<string>(revisions);
		const deferred = createDeferred("result");
		let loads = 0;
		const key = dependencyKey.base("dashboard");
		const load = () => {
			loads++;
			return deferred.promise;
		};

		const first = cache.get("query", [key], load);
		const second = cache.get("query", [key], load);
		expect(first).toBe(second);
		expect(loads).toBe(1);
		expect(cache.stats().inFlightHits).toBe(1);

		deferred.resolve();
		expect(await first).toBe("result");
		expect(await cache.get("query", [key], load)).toBe("result");
		expect(loads).toBe(1);
		expect(cache.stats().warmHits).toBe(1);
	});

	it("keeps delimiter-bearing cache identities and revision vectors in separate in-flight loads", async () => {
		const revisions = new RevisionStore();
		const cache = new RevisionedAsyncDataCache<string>(revisions);
		const firstLoad = createDeferred("first");
		const secondLoad = createDeferred("second");
		let firstLoads = 0;
		let secondLoads = 0;

		// Under the old `${cacheKey}\0${fingerprint}` encoding these two pairs
		// serialize identically with RevisionStore's real zero-revision format:
		// a + \0 + 5:P\01:x@0; === a\05:P + \0 + 1:x@0;
		const first = cache.get("a", ["P\u00001:x"], () => {
			firstLoads++;
			return firstLoad.promise;
		});
		const second = cache.get("a\u00005:P", ["x"], () => {
			secondLoads++;
			return secondLoad.promise;
		});

		expect(first).not.toBe(second);
		expect(firstLoads).toBe(1);
		expect(secondLoads).toBe(1);
		expect(cache.stats()).toMatchObject({ inFlight: 2, inFlightHits: 0, loads: 2 });

		secondLoad.resolve();
		firstLoad.resolve();
		expect(await first).toBe("first");
		expect(await second).toBe("second");
		expect(cache.stats().inFlight).toBe(0);
	});

	it("ignores unrelated revisions but reloads after an exact dependency changes", async () => {
		const revisions = new RevisionStore();
		const cache = new RevisionedAsyncDataCache<number>(revisions);
		const baseKey = dependencyKey.base("dashboard");
		let loads = 0;
		const load = () => ++loads;

		expect(await cache.get("query", [baseKey], load)).toBe(1);
		revisions.bump(dependencyKey.settings());
		expect(await cache.get("query", [baseKey], load)).toBe(1);
		expect(loads).toBe(1);

		revisions.bump(baseKey);
		expect(await cache.get("query", [baseKey], load)).toBe(2);
		expect(loads).toBe(2);
	});

	it("does not let an old revision poison a newer warm entry", async () => {
		const revisions = new RevisionStore();
		const cache = new RevisionedAsyncDataCache<string>(revisions);
		const baseKey = dependencyKey.base("dashboard");
		const oldLoad = createDeferred("old");
		const newLoad = createDeferred("new");

		const oldPromise = cache.get("query", [baseKey], () => oldLoad.promise);
		revisions.bump(baseKey);
		const newPromise = cache.get("query", [baseKey], () => newLoad.promise);

		newLoad.resolve();
		expect(await newPromise).toBe("new");
		oldLoad.resolve();
		expect(await oldPromise).toBe("old");
		expect(await cache.get("query", [baseKey], () => "unexpected")).toBe("new");
	});

	it("clear prevents already-running work from repopulating warm cache", async () => {
		const revisions = new RevisionStore();
		const cache = new RevisionedAsyncDataCache<string>(revisions);
		const key = dependencyKey.base("dashboard");
		const oldLoad = createDeferred("old");
		let reloads = 0;

		const oldPromise = cache.get("query", [key], () => oldLoad.promise);
		cache.clear("query");
		oldLoad.resolve();
		expect(await oldPromise).toBe("old");
		expect(await cache.get("query", [key], () => {
			reloads++;
			return "fresh";
		})).toBe("fresh");
		expect(reloads).toBe(1);
	});

	it("bounds warm retention with LRU eviction", async () => {
		const revisions = new RevisionStore();
		const cache = new RevisionedAsyncDataCache<string>(revisions, { limit: 2 });
		const key = dependencyKey.base("dashboard");

		await cache.get("a", [key], () => "A");
		await cache.get("b", [key], () => "B");
		expect(await cache.get("a", [key], () => "unexpected")).toBe("A");
		await cache.get("c", [key], () => "C");

		let bLoads = 0;
		expect(await cache.get("b", [key], () => {
			bLoads++;
			return "B2";
		})).toBe("B2");
		expect(bLoads).toBe(1);
		expect(cache.stats().entries).toBe(2);
	});

	it("tracks a full revision vector rather than only one coarse key", async () => {
		const revisions = new RevisionStore();
		const cache = new RevisionedAsyncDataCache<number>(revisions);
		const baseKey = dependencyKey.base("dashboard");
		const sourceKey = dependencyKey.file("Dashboard.md", "content");
		let loads = 0;

		expect(await cache.get("query", [baseKey, sourceKey], () => ++loads)).toBe(1);
		revisions.bump(sourceKey);
		expect(await cache.get("query", [baseKey, sourceKey], () => ++loads)).toBe(2);
		expect(loads).toBe(2);
	});
});

function createDeferred<T>(value: T): {
	promise: Promise<T>;
	resolve(): void;
} {
	let resolvePromise: ((value: T) => void) | undefined;
	const promise = new Promise<T>(resolve => {
		resolvePromise = resolve;
	});
	return {
		promise,
		resolve() {
			resolvePromise?.(value);
		},
	};
}
