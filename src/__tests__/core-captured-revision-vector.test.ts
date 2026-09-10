import { describe, expect, it, vi } from "vitest";
import { RevisionStore } from "../core/dependencies";
import { RevisionedAsyncDataCache } from "../core/revisioned-async-cache";

describe("captured revision vectors", () => {
	it("preserves collision-safe fingerprint semantics while validating exact revisions", () => {
		const revisions = new RevisionStore();
		revisions.bump("a@0\nb");
		revisions.bump("plain");

		const vector = revisions.capture(["plain", "a@0\nb", "plain"]);
		expect(vector.fingerprint).toBe(revisions.fingerprint(["a@0\nb", "plain"]));
		expect(vector.isCurrent()).toBe(true);

		revisions.bump("unrelated");
		expect(vector.isCurrent()).toBe(true);
		revisions.bump("plain");
		expect(vector.isCurrent()).toBe(false);
	});

	it("preserves active implicit revisions through compaction and stales unowned vectors", () => {
		const revisions = new RevisionStore();
		const active = revisions.capture(["active"]);
		const orphan = revisions.capture(["orphan"]);

		revisions.bump("history");
		revisions.compact(["active"]);

		expect(active.isCurrent()).toBe(true);
		expect(active.fingerprint).toBe(revisions.fingerprint(["active"]));
		expect(orphan.isCurrent()).toBe(false);
	});

	it("lets async cache reject stale completion without rebuilding the fingerprint vector", async () => {
		const revisions = new RevisionStore();
		const cache = new RevisionedAsyncDataCache<string>(revisions);
		const fingerprintSpy = vi.spyOn(revisions, "fingerprint");
		const pending = deferred<string>();

		const first = cache.get("query", ["a", "b", "a"], () => pending.promise);
		revisions.bump("a");
		pending.resolve("stale");
		expect(await first).toBe("stale");
		expect(cache.stats().entries).toBe(0);

		expect(await cache.get("query", ["b", "a"], () => "fresh")).toBe("fresh");
		expect(cache.stats().loads).toBe(2);
		expect(fingerprintSpy).not.toHaveBeenCalled();
	});
});

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(next => {
		resolve = next;
	});
	return { promise, resolve };
}
