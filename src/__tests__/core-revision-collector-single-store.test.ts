import { afterEach, describe, expect, it, vi } from "vitest";
import { DependencyCollector, RevisionStore, dependencyKey } from "../core/dependencies";
import { RevisionTrackingDependencyCollector } from "../core/dependency-read-set";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("RevisionTrackingDependencyCollector single-store semantics", () => {
	it("does not mirror tracked keys through the base collector Set", () => {
		const revisions = new RevisionStore();
		const collector = new RevisionTrackingDependencyCollector(revisions);
		const first = dependencyKey.index("files");
		const second = dependencyKey.settings();
		vi.spyOn(DependencyCollector.prototype, "track").mockImplementation(() => {
			throw new Error("base Set mirror must not be used");
		});

		collector.track(first);
		collector.trackMany([second, first]);
		expect(collector.has(first)).toBe(true);
		expect(collector.has(second)).toBe(true);
		expect(collector.snapshot()).toEqual(new Set([first, second]));
	});

	it("preserves the first observed revision when a dependency is read again", () => {
		const revisions = new RevisionStore();
		const collector = new RevisionTrackingDependencyCollector(revisions);
		const key = dependencyKey.file("A.md", "metadata");

		collector.track(key);
		const readSet = collector.readSet();
		revisions.bump(key);
		collector.track(key);

		expect(readSet.isCurrent()).toBe(false);
		expect(collector.readSet().isCurrent()).toBe(false);
		expect(collector.snapshot()).toEqual(new Set([key]));
	});

	it("clear resets both membership and first-read revision state", () => {
		const revisions = new RevisionStore();
		const collector = new RevisionTrackingDependencyCollector(revisions);
		const key = dependencyKey.base("Example");
		collector.track(key);
		revisions.bump(key);
		expect(collector.readSet().isCurrent()).toBe(false);

		collector.clear();
		expect(collector.has(key)).toBe(false);
		expect(collector.snapshot()).toEqual(new Set());
		collector.track(key);
		expect(collector.readSet().isCurrent()).toBe(true);
	});
});
