import { describe, expect, it } from "vitest";
import { DependencyIndex } from "../core/dependencies";

describe("DependencyIndex replacement precision", () => {
	it("does not retain an owner whose committed dependency set is empty", () => {
		const index = new DependencyIndex<object>();
		const owner = {};

		index.replace(owner, []);

		expect(index.dependenciesOf(owner)).toEqual(new Set());
		expect(index.stats()).toEqual({ owners: 0, dependencyKeys: 0, edges: 0 });
	});

	it("does not remove and re-add reverse edges when the dependency set is unchanged", () => {
		const index = new DependencyIndex<string>();
		index.replace("first", ["a", "b"]);
		index.replace("second", ["a", "b"]);
		expect(index.affected("a")).toEqual(["first", "second"]);

		// Order and duplicates in the input do not change set semantics. A remove +
		// re-add would move `first` behind `second` in the reverse Set.
		index.replace("first", ["b", "a", "a"]);

		expect(index.affected("a")).toEqual(["first", "second"]);
		expect(index.affected("b")).toEqual(["first", "second"]);
		expect(index.stats()).toEqual({ owners: 2, dependencyKeys: 2, edges: 4 });
	});

	it("still replaces changed dependency sets and releases owners that become empty", () => {
		const index = new DependencyIndex<string>();
		index.replace("owner", ["a", "b"]);

		index.replace("owner", ["b", "c"]);
		expect(index.affected("a")).toEqual([]);
		expect(index.affected("b")).toEqual(["owner"]);
		expect(index.affected("c")).toEqual(["owner"]);

		index.replace("owner", []);
		expect(index.affected("b")).toEqual([]);
		expect(index.affected("c")).toEqual([]);
		expect(index.stats()).toEqual({ owners: 0, dependencyKeys: 0, edges: 0 });
	});
});
