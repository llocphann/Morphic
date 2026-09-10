import { describe, expect, it, vi } from "vitest";
import { InvalidationEngine } from "../core/invalidation-engine";

describe("revision compaction active-key count", () => {
	it("checks compaction thresholds without traversing diagnostic dependency stats", () => {
		const engine = new InvalidationEngine<string>(() => undefined, {
			revisionCompactionSlack: 0,
		});
		const statsSpy = vi.spyOn(engine.index, "stats").mockImplementation(() => {
			throw new Error("diagnostic stats must not run on the invalidation hot path");
		});

		expect(() => engine.commitDependencies("owner", ["active"])).not.toThrow();
		expect(engine.index.dependencyKeyCount()).toBe(1);

		// First unowned revision reaches the active-key threshold without compacting.
		expect(() => engine.invalidate("stale-a")).not.toThrow();
		expect(engine.revisions.stats().trackedKeys).toBe(1);

		// Crossing the threshold compacts through the O(1) active-key count while
		// preserving the active dependency at its pre-compaction revision.
		expect(() => engine.invalidate("stale-b")).not.toThrow();
		expect(engine.revisions.stats().trackedKeys).toBe(1);
		expect(engine.revisions.current("active")).toBe(0);
		expect(engine.revisions.current("stale-a")).toBeGreaterThan(0);

		statsSpy.mockRestore();
		expect(engine.index.stats()).toEqual({ owners: 1, dependencyKeys: 1, edges: 1 });
	});

	it("keeps the active-key count exact across replace and remove transitions", () => {
		const engine = new InvalidationEngine<string>(() => undefined);

		engine.commitDependencies("first", ["a", "b"]);
		engine.commitDependencies("second", ["b", "c"]);
		expect(engine.index.dependencyKeyCount()).toBe(3);

		engine.commitDependencies("first", ["b", "c"]);
		expect(engine.index.dependencyKeyCount()).toBe(2);

		engine.remove("second");
		expect(engine.index.dependencyKeyCount()).toBe(2);

		engine.remove("first");
		expect(engine.index.dependencyKeyCount()).toBe(0);
	});
});
