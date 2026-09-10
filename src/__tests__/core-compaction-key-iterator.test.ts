import { describe, expect, it, vi } from "vitest";
import { dependencyKey } from "../core/dependencies";
import { InvalidationEngine } from "../core/invalidation-engine";

describe("revision compaction dependency-key iterator", () => {
	it("compacts from the live key iterator without allocating the defensive key snapshot", () => {
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
		const defensiveKeys = vi.spyOn(invalidation.index, "dependencyKeys").mockImplementation(() => {
			throw new Error("compaction hot path must not allocate the defensive key snapshot");
		});

		expect(() => invalidation.invalidateMany([orphanA, orphanB, orphanC])).not.toThrow();
		expect(defensiveKeys).not.toHaveBeenCalled();
		expect(invalidation.fingerprint("owner")).toBe(fingerprintBefore);
		expect(invalidation.revisions.current(activeA)).toBe(0);
		expect(invalidation.revisions.current(activeB)).toBe(0);
		expect(invalidation.revisions.trackedKeyCount()).toBe(2);

		defensiveKeys.mockRestore();
		expect(invalidation.index.dependencyKeys()).toEqual(new Set([activeA, activeB]));
	});
});
