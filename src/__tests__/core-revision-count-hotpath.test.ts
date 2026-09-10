import { describe, expect, it, vi } from "vitest";
import { RevisionStore, dependencyKey } from "../core/dependencies";
import { InvalidationEngine } from "../core/invalidation-engine";

describe("RevisionStore hot-path tracked count", () => {
	it("matches diagnostic tracked-key accounting across bump, compaction, and clear", () => {
		const revisions = new RevisionStore();
		const first = dependencyKey.file("A.md", "content");
		const second = dependencyKey.file("B.md", "content");

		expect(revisions.trackedKeyCount()).toBe(0);
		revisions.bump(first);
		revisions.bump(first);
		revisions.bump(second);
		expect(revisions.trackedKeyCount()).toBe(2);
		expect(revisions.trackedKeyCount()).toBe(revisions.stats().trackedKeys);

		revisions.compact([first]);
		expect(revisions.trackedKeyCount()).toBe(1);
		expect(revisions.trackedKeyCount()).toBe(revisions.stats().trackedKeys);

		revisions.clear();
		expect(revisions.trackedKeyCount()).toBe(0);
		expect(revisions.trackedKeyCount()).toBe(revisions.stats().trackedKeys);
	});

	it("never consults diagnostic RevisionStore.stats during invalidation hot paths", () => {
		const invalidation = new InvalidationEngine<string>(() => undefined, {
			revisionCompactionSlack: 0,
		});
		const active = dependencyKey.file("Active.md", "content");
		const orphanA = dependencyKey.file("Orphan-A.md", "content");
		const orphanB = dependencyKey.file("Orphan-B.md", "content");
		const stats = vi.spyOn(invalidation.revisions, "stats").mockImplementation(() => {
			throw new Error("diagnostic stats must not run on invalidation hot paths");
		});

		invalidation.commitDependencies("owner", [active]);
		invalidation.invalidate(orphanA);
		invalidation.invalidateMany([orphanA, orphanB]);
		invalidation.remove("owner");

		expect(stats).not.toHaveBeenCalled();
		stats.mockRestore();
		expect(invalidation.revisions.trackedKeyCount()).toBe(invalidation.revisions.stats().trackedKeys);
	});
});
