import { describe, expect, it } from "vitest";
import { dependencyKey } from "../core/dependencies";
import { InvalidationEngine } from "../core/invalidation-engine";

describe("InvalidationEngine native Set reuse", () => {
	it("routes one coalesced owner once and advances each unique revision once", () => {
		const invalidated: string[] = [];
		const engine = new InvalidationEngine<string>(owner => invalidated.push(owner));
		const first = dependencyKey.index("files");
		const second = dependencyKey.index("folders");
		engine.commitDependencies("owner", [first, second]);

		const changed = new Set([first, second]);
		expect(engine.invalidateMany(changed)).toEqual(["owner"]);
		expect(invalidated).toEqual(["owner"]);
		expect(engine.revisions.current(first)).toBe(1);
		expect(engine.revisions.current(second)).toBe(1);
	});

	it("does not retain the caller Set and remains safe when owner callbacks mutate it", () => {
		const first = dependencyKey.file("A.md", "metadata");
		const second = dependencyKey.file("B.md", "metadata");
		const changed = new Set([first, second]);
		const invalidated: string[] = [];
		const engine = new InvalidationEngine<string>(owner => {
			invalidated.push(owner);
			changed.clear();
			changed.add(dependencyKey.settings());
		});
		engine.commitDependencies("owner", [first, second]);

		expect(engine.invalidateMany(changed)).toEqual(["owner"]);
		expect(invalidated).toEqual(["owner"]);
		expect(engine.revisions.current(first)).toBe(1);
		expect(engine.revisions.current(second)).toBe(1);
		expect(engine.revisions.current(dependencyKey.settings())).toBe(0);
	});

	it("keeps defensive duplicate elimination for non-Set iterables", () => {
		const key = dependencyKey.base("Example");
		const engine = new InvalidationEngine<string>(() => undefined);
		engine.commitDependencies("owner", [key]);

		expect(engine.invalidateMany([key, key, key])).toEqual(["owner"]);
		expect(engine.revisions.current(key)).toBe(1);
	});

	it("keeps defensive snapshot semantics for Set subclasses with custom iterators", () => {
		const first = dependencyKey.file("First.md", "metadata");
		const second = dependencyKey.file("Second.md", "metadata");
		const engine = new InvalidationEngine<string>(() => undefined);
		engine.commitDependencies("first-owner", [first]);
		engine.commitDependencies("second-owner", [second]);

		const changing = new ChangingSet(first, second);
		expect(engine.invalidateMany(changing)).toEqual(["first-owner"]);
		expect(engine.revisions.current(first)).toBe(1);
		expect(engine.revisions.current(second)).toBe(0);
	});
});

class ChangingSet extends Set<string> {
	private iteratorReads = 0;

	constructor(
		private readonly first: string,
		private readonly second: string,
	) {
		super([first, second]);
	}

	override [Symbol.iterator](): SetIterator<string> {
		this.iteratorReads++;
		return new Set([this.iteratorReads === 1 ? this.first : this.second]).values();
	}
}
