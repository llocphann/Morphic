import { describe, expect, it } from "vitest";
import { RevisionStore, dependencyKey } from "../core/dependencies";
import { RevisionedAsyncDataCache } from "../core/revisioned-async-cache";

describe("RevisionedAsyncDataCache targeted clear precision", () => {
	it("does not prevent an unrelated in-flight load from warming", async () => {
		const revisions = new RevisionStore();
		const cache = new RevisionedAsyncDataCache<string>(revisions);
		const dependency = dependencyKey.base("dashboard");
		const a = deferred("A");
		const b = deferred("B");

		const aPromise = cache.get("a", [dependency], () => a.promise);
		const bPromise = cache.get("b", [dependency], () => b.promise);
		cache.clear("a");

		b.resolve();
		expect(await bPromise).toBe("B");
		let bReloads = 0;
		expect(await cache.get("b", [dependency], () => {
			bReloads++;
			return "B2";
		})).toBe("B");
		expect(bReloads).toBe(0);

		a.resolve();
		expect(await aPromise).toBe("A");
		let aReloads = 0;
		expect(await cache.get("a", [dependency], () => {
			aReloads++;
			return "A2";
		})).toBe("A2");
		expect(aReloads).toBe(1);
	});

	it("does not let a cleared promise delete its newer same-key replacement", async () => {
		const revisions = new RevisionStore();
		const cache = new RevisionedAsyncDataCache<string>(revisions);
		const dependency = dependencyKey.base("dashboard");
		const oldLoad = deferred("old");
		const newLoad = deferred("new");

		const oldPromise = cache.get("query", [dependency], () => oldLoad.promise);
		cache.clear("query");
		const newPromise = cache.get("query", [dependency], () => newLoad.promise);

		oldLoad.resolve();
		expect(await oldPromise).toBe("old");
		let unexpectedLoads = 0;
		const joined = cache.get("query", [dependency], () => {
			unexpectedLoads++;
			return "unexpected";
		});
		expect(joined).toBe(newPromise);
		expect(unexpectedLoads).toBe(0);

		newLoad.resolve();
		expect(await joined).toBe("new");
	});

	it("keeps full clear global while protecting a post-clear replacement", async () => {
		const revisions = new RevisionStore();
		const cache = new RevisionedAsyncDataCache<string>(revisions);
		const dependency = dependencyKey.base("dashboard");
		const oldLoad = deferred("old");
		const newLoad = deferred("new");

		const oldPromise = cache.get("query", [dependency], () => oldLoad.promise);
		cache.clear();
		const newPromise = cache.get("query", [dependency], () => newLoad.promise);

		oldLoad.resolve();
		expect(await oldPromise).toBe("old");
		const joined = cache.get("query", [dependency], () => "unexpected");
		expect(joined).toBe(newPromise);

		newLoad.resolve();
		expect(await joined).toBe("new");
		expect(await cache.get("query", [dependency], () => "unexpected-2")).toBe("new");
	});
});

function deferred<T>(value: T): { promise: Promise<T>; resolve(): void } {
	let resolvePromise!: (value: T) => void;
	const promise = new Promise<T>(resolve => {
		resolvePromise = resolve;
	});
	return {
		promise,
		resolve() {
			resolvePromise(value);
		},
	};
}
