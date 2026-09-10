import { describe, expect, it } from "vitest";
import {
	DependencyCollector,
	DependencyIndex,
	RevisionStore,
	dependencyKey,
} from "../core/dependencies";

describe("Morphic core dependencies", () => {
	it("deduplicates dependencies read during a render", () => {
		const collector = new DependencyCollector();
		const key = dependencyKey.file("Notes/A.md", "frontmatter", "rating");
		collector.track(key);
		collector.track(key);
		expect(Array.from(collector.snapshot())).toEqual([key]);
	});

	it("keeps ordinary dependency key diagnostics byte-identical", () => {
		expect(dependencyKey.file("Notes/A.md", "frontmatter", "rating")).toBe(
			"file:Notes/A.md:frontmatter:rating",
		);
		expect(dependencyKey.settings("view-1")).toBe("settings:view:view-1");
		expect(dependencyKey.base("Base-A")).toBe("base:Base-A");
		expect(dependencyKey.index("tag", "#music")).toBe("index:tag:#music");
	});

	it("separates file path and field components that collided under raw colon joining", () => {
		const fieldInjection = dependencyKey.file(
			"A",
			"frontmatter",
			"B:frontmatter:C",
		);
		const pathInjection = dependencyKey.file(
			"A:frontmatter:B",
			"frontmatter",
			"C",
		);

		// Legacy raw joining produced the same string for both tuples:
		// file:A:frontmatter:B:frontmatter:C
		expect(fieldInjection).not.toBe(pathInjection);
		expect(fieldInjection).toBe("file:A:frontmatter:~15:B:frontmatter:C");
		expect(pathInjection).toBe("file:~15:A:frontmatter:B:frontmatter:C");
	});

	it("reserves the escape prefix so raw values cannot impersonate encoded components", () => {
		expect(dependencyKey.base("~3:a:b")).not.toBe(dependencyKey.base("a:b"));
		expect(dependencyKey.index("tag:files", "x")).not.toBe(
			dependencyKey.index("tag", "files:x"),
		);
		expect(dependencyKey.file("A.md", "frontmatter", "")).toBe(
			"file:A.md:frontmatter:",
		);
	});

	it("replaces reverse-index ownership without leaving stale edges", () => {
		const index = new DependencyIndex<object>();
		const owner = {};
		index.replace(owner, ["a", "b"]);
		expect(index.affected("a")).toContain(owner);

		index.replace(owner, ["c"]);
		expect(index.affected("a")).not.toContain(owner);
		expect(index.affected("c")).toContain(owner);
		expect(index.dependencyKeys()).toEqual(new Set(["c"]));
		expect(index.stats()).toEqual({ owners: 1, dependencyKeys: 1, edges: 1 });

		index.remove(owner);
		expect(index.dependencyKeys()).toEqual(new Set());
		expect(index.stats()).toEqual({ owners: 0, dependencyKeys: 0, edges: 0 });
	});

	it("produces deterministic revision fingerprints", () => {
		const revisions = new RevisionStore();
		revisions.bump("b");
		revisions.bump("a");
		revisions.bump("a");
		expect(revisions.fingerprint(["b", "a", "a"])).toBe("1:a@2;1:b@1;");
		expect(revisions.stats()).toEqual({ trackedKeys: 2 });
		revisions.clear();
		expect(revisions.stats()).toEqual({ trackedKeys: 0 });
	});

	it("does not collide when one dependency key contains the legacy fingerprint delimiters", () => {
		const revisions = new RevisionStore();
		const oneKey = revisions.fingerprint(["a@0\nb"]);
		const twoKeys = revisions.fingerprint(["a", "b"]);

		// Legacy `${key}@${revision}` + newline joining produced `a@0\nb@0`
		// for both vectors. Length-prefixing makes the vectors unambiguous.
		expect(oneKey).toBe("5:a@0\nb@0;");
		expect(twoKeys).toBe("1:a@0;1:b@0;");
		expect(oneKey).not.toBe(twoKeys);
	});

	it("compacts unowned revisions without changing active fingerprints", () => {
		const revisions = new RevisionStore();
		const active = "file:A:frontmatter:rating";
		const transient = "file:Deleted:content";
		const activeBefore = revisions.fingerprint([active]);
		const transientRevision = revisions.bump(transient);

		const result = revisions.compact([active]);
		expect(result).toEqual({ removed: 1, retained: 1, floorRevision: 2 });
		expect(revisions.fingerprint([active])).toBe(activeBefore);
		expect(revisions.current(transient)).toBeGreaterThan(transientRevision);
		expect(revisions.stats()).toEqual({ trackedKeys: 1 });
	});

	it("never lets a pruned zero-revision cache token become valid again", () => {
		const revisions = new RevisionStore();
		const staleToken = revisions.current("file:Ghost:content");
		expect(staleToken).toBe(0);

		revisions.bump("file:Other:content");
		revisions.compact([]);
		expect(revisions.current("file:Ghost:content")).toBeGreaterThan(staleToken);
	});
});
