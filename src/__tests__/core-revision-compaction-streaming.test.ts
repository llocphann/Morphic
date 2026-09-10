import { describe, expect, it } from "vitest";
import { RevisionStore, dependencyKey } from "../core/dependencies";

describe("RevisionStore streaming compaction", () => {
	it("reclaims a large sparse history while preserving exact active revisions and fingerprints", () => {
		const revisions = new RevisionStore();
		const history = Array.from({ length: 20_000 }, (_, index) =>
			dependencyKey.file(`Archive/Note-${index}.md`, "frontmatter", `field-${index % 17}`));
		for (const key of history) revisions.bump(key);

		const preserved = [history[3], history[999], history[9_999], history[19_999]];
		const implicit = dependencyKey.index("future-query", "not-yet-bumped");
		const active = [...preserved, implicit];
		const before = new Map(active.map(key => [key, revisions.current(key)]));
		const fingerprintBefore = revisions.fingerprint(active);

		const result = revisions.compact(active);

		expect(result.removed).toBe(history.length - preserved.length);
		expect(result.retained).toBe(active.length);
		expect(revisions.stats().trackedKeys).toBe(active.length);
		expect(revisions.fingerprint(active)).toBe(fingerprintBefore);
		for (const [key, revision] of before) expect(revisions.current(key)).toBe(revision);
	});

	it("keeps the advanced floor semantics after direct map deletion", () => {
		const revisions = new RevisionStore();
		const old = dependencyKey.file("Old.md", "content");
		const active = dependencyKey.file("Active.md", "content");
		revisions.bump(old);
		revisions.bump(old);
		revisions.bump(active);
		const activeRevision = revisions.current(active);

		const result = revisions.compact([active]);
		const unseen = dependencyKey.file("Unseen.md", "content");

		expect(revisions.current(active)).toBe(activeRevision);
		expect(result.floorRevision).toBeGreaterThan(2);
		expect(revisions.current(old)).toBe(result.floorRevision);
		expect(revisions.current(unseen)).toBe(result.floorRevision);
	});
});
