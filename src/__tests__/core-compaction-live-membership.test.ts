import { describe, expect, it, vi } from "vitest";
import { DependencyIndex, dependencyKey } from "../core/dependencies";
import { InvalidationEngine } from "../core/invalidation-engine";

describe("revision compaction live dependency membership", () => {
	it("compacts without entering the defensive public preserve-set path", () => {
		const invalidation = new InvalidationEngine<string>(() => undefined, {
			revisionCompactionSlack: 0,
		});
		const activeA = dependencyKey.file("Active-A.md", "content");
		const activeB = dependencyKey.file("Active-B.md", "frontmatter", "status");
		const orphanA = dependencyKey.file("Orphan-A.md", "content");
		const orphanB = dependencyKey.file("Orphan-B.md", "content");
		const orphanC = dependencyKey.file("Orphan-C.md", "content");

		invalidation.commitDependencies("owner", [activeA, activeB]);
		const fingerprintBefore = invalidation.fingerprint("owner");
		const defensiveCompact = vi.spyOn(invalidation.revisions, "compact").mockImplementation(() => {
			throw new Error("invalidation compaction must not allocate the defensive preserve Set");
		});
		const membership = vi.spyOn(invalidation.index, "hasDependencyKey");

		// Active keys are still implicit at revision floor 0, so three orphan
		// revisions are required to exceed the two-key active threshold at slack 0.
		expect(() => invalidation.invalidateMany([orphanA, orphanB, orphanC])).not.toThrow();
		expect(defensiveCompact).not.toHaveBeenCalled();
		expect(membership).toHaveBeenCalledWith(activeA);
		expect(membership).toHaveBeenCalledWith(activeB);
		expect(membership).toHaveBeenCalledWith(orphanA);
		expect(membership).toHaveBeenCalledWith(orphanB);
		expect(membership).toHaveBeenCalledWith(orphanC);
		expect(invalidation.fingerprint("owner")).toBe(fingerprintBefore);
		expect(invalidation.revisions.current(activeA)).toBe(0);
		expect(invalidation.revisions.current(activeB)).toBe(0);
		expect(invalidation.revisions.trackedKeyCount()).toBe(2);
	});

	it("keeps live dependency membership exact across owner replace and removal", () => {
		const index = new DependencyIndex<string>();
		const first = dependencyKey.index("tag", "first");
		const shared = dependencyKey.index("tag", "shared");
		const next = dependencyKey.index("tag", "next");

		index.replace("owner-a", [first, shared]);
		index.replace("owner-b", [shared]);
		expect(index.hasDependencyKey(first)).toBe(true);
		expect(index.hasDependencyKey(shared)).toBe(true);
		expect(index.hasDependencyKey(next)).toBe(false);

		index.replace("owner-a", [next]);
		expect(index.hasDependencyKey(first)).toBe(false);
		expect(index.hasDependencyKey(shared)).toBe(true);
		expect(index.hasDependencyKey(next)).toBe(true);

		index.remove("owner-b");
		expect(index.hasDependencyKey(shared)).toBe(false);
		expect(Array.from(index.dependencyKeyIterator())).toEqual([next]);
	});
});
