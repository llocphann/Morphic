import { describe, expect, it, vi } from "vitest";
import { RevisionTrackingDependencyCollector } from "../core/dependency-read-set";
import { dependencyKey } from "../core/dependencies";
import { InvalidationEngine } from "../core/invalidation-engine";

describe("Morphic zero-copy read-set commits", () => {
	it("commits a read set without calling the allocating dependencies() helper", () => {
		const invalidation = new InvalidationEngine<string>(() => undefined);
		const collector = new RevisionTrackingDependencyCollector(invalidation.revisions);
		const first = dependencyKey.file("Notes/A.md", "frontmatter", "rating");
		const second = dependencyKey.index("files");
		collector.trackMany([first, second, first]);
		const readSet = collector.readSet();
		const allocatingHelper = vi.spyOn(readSet, "dependencies").mockImplementation(() => {
			throw new Error("commitReadSet must not allocate through dependencies()");
		});

		invalidation.commitReadSet("owner", readSet);

		expect(allocatingHelper).not.toHaveBeenCalled();
		expect(invalidation.index.dependenciesOf("owner")).toEqual(new Set([first, second]));
	});

	it("keeps the frozen read-set iterator isolated from later collector changes", () => {
		const invalidation = new InvalidationEngine<string>(() => undefined);
		const collector = new RevisionTrackingDependencyCollector(invalidation.revisions);
		const first = dependencyKey.settings();
		const later = dependencyKey.file("Later.md", "content");
		collector.track(first);
		const readSet = collector.readSet();

		collector.track(later);

		expect(Array.from(readSet.dependencyIterator())).toEqual([first]);
		invalidation.commitReadSet("owner", readSet);
		expect(invalidation.index.dependenciesOf("owner")).toEqual(new Set([first]));
	});

	it("preserves atomic owner replacement and invalidation routing", () => {
		const invalidated: string[] = [];
		const invalidation = new InvalidationEngine<string>(owner => invalidated.push(owner));
		const firstCollector = new RevisionTrackingDependencyCollector(invalidation.revisions);
		const secondCollector = new RevisionTrackingDependencyCollector(invalidation.revisions);
		const oldKey = dependencyKey.file("Notes/A.md", "frontmatter", "rating");
		const nextKey = dependencyKey.file("Notes/A.md", "frontmatter", "author");
		firstCollector.track(oldKey);
		secondCollector.track(nextKey);

		invalidation.commitReadSet("owner", firstCollector.readSet());
		invalidation.commitReadSet("owner", secondCollector.readSet());
		expect(invalidation.index.dependenciesOf("owner")).toEqual(new Set([nextKey]));

		expect(invalidation.invalidate(oldKey)).toEqual([]);
		expect(invalidation.invalidate(nextKey)).toEqual(["owner"]);
		expect(invalidated).toEqual(["owner"]);
	});

	it("keeps active read-set revisions stable when commit triggers compaction", () => {
		const invalidation = new InvalidationEngine<string>(() => undefined, {
			revisionCompactionSlack: 0,
		});
		const collector = new RevisionTrackingDependencyCollector(invalidation.revisions);
		const active = dependencyKey.file("Notes/A.md", "content");
		const transient = dependencyKey.file("Deleted.md", "content");
		collector.track(active);
		const readSet = collector.readSet();
		const before = invalidation.revisions.current(active);
		invalidation.revisions.bump(transient);

		invalidation.commitReadSet("owner", readSet);

		expect(invalidation.revisions.current(active)).toBe(before);
		expect(readSet.isCurrent()).toBe(true);
		expect(invalidation.index.dependenciesOf("owner")).toEqual(new Set([active]));
		expect(invalidation.revisions.trackedKeyCount()).toBe(1);
	});
});
