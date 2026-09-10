import { describe, expect, it } from "vitest";
import { DependencyIndex, dependencyKey } from "../core/dependencies";
import {
	TimeDependencyPolicy,
	nextActiveTimeBoundary,
} from "../core/time-dependencies";

describe("active wall-clock time boundaries", () => {
	it("stays timer-free when no wall-clock dependency is owned", () => {
		const policy = new TimeDependencyPolicy({ nowResolutionMs: 60_000 });
		const index = new DependencyIndex<string>();
		const now = new Date(2026, 0, 2, 12, 34, 20, 0).getTime();

		expect(nextActiveTimeBoundary(policy, index, now)).toBeNull();

		index.replace("random-owner", [dependencyKey.time("random")]);
		expect(nextActiveTimeBoundary(policy, index, now)).toBeNull();
	});

	it("schedules exactly the next now boundary while now is active", () => {
		const policy = new TimeDependencyPolicy({ nowResolutionMs: 60_000 });
		const index = new DependencyIndex<string>();
		const now = new Date(2026, 0, 2, 12, 34, 20, 0).getTime();
		index.replace("now-owner", [dependencyKey.time("now")]);

		expect(nextActiveTimeBoundary(policy, index, now)).toBe(
			policy.nextBoundary("now", now),
		);
	});

	it("schedules local midnight when only today is active", () => {
		const policy = new TimeDependencyPolicy({ nowResolutionMs: 60_000 });
		const index = new DependencyIndex<string>();
		const now = new Date(2026, 0, 2, 12, 34, 20, 0).getTime();
		index.replace("today-owner", [dependencyKey.time("today")]);

		expect(nextActiveTimeBoundary(policy, index, now)).toBe(
			policy.nextBoundary("today", now),
		);
	});

	it("chooses the earliest active boundary and follows owner replacement", () => {
		const policy = new TimeDependencyPolicy({ nowResolutionMs: 60_000 });
		const index = new DependencyIndex<string>();
		const now = new Date(2026, 0, 2, 23, 59, 20, 0).getTime();

		index.replace("now-owner", [dependencyKey.time("now")]);
		index.replace("today-owner", [dependencyKey.time("today")]);
		index.replace("random-owner", [dependencyKey.time("random")]);
		expect(nextActiveTimeBoundary(policy, index, now)).toBe(Math.min(
			policy.nextBoundary("now", now),
			policy.nextBoundary("today", now),
		));

		index.replace("now-owner", [dependencyKey.time("random")]);
		expect(nextActiveTimeBoundary(policy, index, now)).toBe(
			policy.nextBoundary("today", now),
		);

		index.remove("today-owner");
		expect(nextActiveTimeBoundary(policy, index, now)).toBeNull();
	});

	it("does not retain the dependency source between probes", () => {
		const policy = new TimeDependencyPolicy({ nowResolutionMs: 5_000 });
		const now = 10_001;
		let active = true;
		const source = {
			hasDependencyKey(key: string): boolean {
				return active && key === dependencyKey.time("now");
			},
		};

		expect(nextActiveTimeBoundary(policy, source, now)).toBe(15_000);
		active = false;
		expect(nextActiveTimeBoundary(policy, source, now)).toBeNull();
	});
});
