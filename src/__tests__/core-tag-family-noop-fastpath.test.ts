import { describe, expect, it } from "vitest";
import {
	collectTagFamilyChanges,
	tagFamilyDependencyKey,
} from "../core/tag-family-dependencies";

describe("tag-family no-op fast path", () => {
	it("keeps freshly allocated identical tag sequences quiet", () => {
		const previous = ["#topic/alpha", "#other"];
		const next = ["#topic/alpha", "#other"];

		expect(previous).not.toBe(next);
		expect(collectTagFamilyChanges(previous, next)).toEqual([]);
	});

	it("falls back to family-set semantics when sequence order changes", () => {
		const changed = collectTagFamilyChanges(
			["#topic/alpha", "#topic/beta/deep"],
			["#topic/beta/deep", "#topic/alpha"],
		);

		expect(changed).toEqual([]);
	});

	it("still reports real nested-family membership changes exactly", () => {
		const changed = new Set(collectTagFamilyChanges(
			["#topic/alpha", "#other"],
			["#topic/beta", "#other"],
		));

		expect(changed.has(tagFamilyDependencyKey("topic"))).toBe(false);
		expect(changed).toEqual(new Set([
			tagFamilyDependencyKey("topic/alpha"),
			tagFamilyDependencyKey("topic/beta"),
		]));
	});
});
