import { describe, expect, it } from "vitest";
import { dependencyKey } from "../core/dependencies";
import { TimeDependencyPolicy } from "../core/time-dependencies";

describe("Morphic time dependency policy", () => {
	it("invalidates now only when its configured bucket changes", () => {
		const policy = new TimeDependencyPolicy({ nowResolutionMs: 60_000 });
		policy.seed(120_000);

		expect(policy.advance(179_999)).toEqual([]);
		expect(policy.advance(180_000)).toEqual([dependencyKey.time("now")]);
		expect(policy.advance(180_001)).toEqual([]);
	});

	it("invalidates today only when the local calendar date changes", () => {
		const policy = new TimeDependencyPolicy({ nowResolutionMs: 24 * 60 * 60 * 1000 });
		const beforeMidnight = new Date(2026, 7, 31, 23, 59, 59, 900).getTime();
		const afterMidnight = new Date(2026, 8, 1, 0, 0, 0, 100).getTime();
		policy.seed(beforeMidnight);

		expect(policy.advance(afterMidnight)).toContain(dependencyKey.time("today"));
	});

	it("does not tie random invalidation to wall clock", () => {
		const policy = new TimeDependencyPolicy();
		policy.seed(0);

		expect(policy.advance(10_000)).not.toContain(dependencyKey.time("random"));
		expect(policy.randomCycle()).toEqual([dependencyKey.time("random")]);
	});

	it("reports exact next boundaries without creating timers", () => {
		const policy = new TimeDependencyPolicy({ nowResolutionMs: 60_000 });
		expect(policy.nextBoundary("now", 120_001)).toBe(180_000);

		const noon = new Date(2026, 7, 31, 12, 0, 0, 0);
		const nextMidnight = new Date(2026, 8, 1, 0, 0, 0, 0);
		expect(policy.nextBoundary("today", noon.getTime())).toBe(nextMidnight.getTime());
	});
});
