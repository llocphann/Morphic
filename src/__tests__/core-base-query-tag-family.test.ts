import { describe, expect, it } from "vitest";
import { collectBaseQueryDependencies } from "../core/base-query-dependencies";
import { InvalidationEngine } from "../core/invalidation-engine";
import {
	collectTagFamilyChanges,
	tagFamilyDependencyKey,
} from "../core/tag-family-dependencies";

describe("Bases nested tag-family dependencies", () => {
	it("routes nested membership changes to a literal hasTag owner", () => {
		const invalidated: string[] = [];
		const invalidation = new InvalidationEngine<string>(owner => invalidated.push(owner));
		const dependencies = collectBaseQueryDependencies({
			filters: 'file.hasTag("topic")',
			views: [{ type: "table", name: "Rows" }],
		});
		invalidation.commitDependencies("base-owner", dependencies);

		expect(new Set(dependencies).has(tagFamilyDependencyKey("topic"))).toBe(true);
		expect(invalidation.invalidateMany(
			collectTagFamilyChanges(["#other"], ["#topic/sub"]),
		)).toEqual(["base-owner"]);
		expect(invalidated).toEqual(["base-owner"]);
	});

	it("keeps a parent family quiet while the file stays under another child", () => {
		const changed = new Set(collectTagFamilyChanges(
			["#topic/alpha"],
			["#topic/beta"],
		));

		expect(changed.has(tagFamilyDependencyKey("topic"))).toBe(false);
		expect(changed.has(tagFamilyDependencyKey("topic/alpha"))).toBe(true);
		expect(changed.has(tagFamilyDependencyKey("topic/beta"))).toBe(true);
	});

	it("keeps ancestor membership while at least one nested tag still supplies it", () => {
		const changed = new Set(collectTagFamilyChanges(
			["#topic/alpha", "#topic/beta/deep"],
			["#topic/beta/deep"],
		));

		expect(changed.has(tagFamilyDependencyKey("topic"))).toBe(false);
		expect(changed.has(tagFamilyDependencyKey("topic/beta"))).toBe(false);
		expect(changed.has(tagFamilyDependencyKey("topic/beta/deep"))).toBe(false);
		expect(changed.has(tagFamilyDependencyKey("topic/alpha"))).toBe(true);
	});

	it("normalizes leading hashes and invalidates every newly entered ancestor", () => {
		const changed = new Set(collectTagFamilyChanges([], ["topic/alpha/deep"]));

		for (const tag of ["#topic", "#topic/alpha", "#topic/alpha/deep"]) {
			expect(changed.has(tagFamilyDependencyKey(tag)), tag).toBe(true);
		}
		expect(tagFamilyDependencyKey("topic")).toBe(tagFamilyDependencyKey("#topic"));
	});
});
