import type { App } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import {
	ActiveTimeScheduler,
	InvalidationEngine,
	ReactiveDataCore,
	dependencyKey,
	nextActiveTimeBoundary,
} from "../core";

interface TimerRecord {
	callback: () => void;
	delayMs: number;
	handle: number;
}

describe("production wall-clock invalidation composition", () => {
	it("invalidates only active now owners and keeps random timer-free", () => {
		const affected: string[] = [];
		const invalidation = new InvalidationEngine<string>((owner) => affected.push(owner));
		const core = new ReactiveDataCore<string>({} as App, invalidation, {
			time: { nowResolutionMs: 60_000 },
		});
		let now = new Date(2026, 8, 1, 12, 34, 20, 0).getTime();
		core.time.seed(now);
		const timers: TimerRecord[] = [];
		const cleared: number[] = [];
		let nextHandle = 1;
		const scheduler = new ActiveTimeScheduler({
			nextBoundary(at) {
				return nextActiveTimeBoundary(core.time, invalidation.index, at);
			},
			advance(at) {
				core.advanceTime(at);
			},
		}, {
			now: () => now,
			setTimeout: (callback, delayMs) => {
				const handle = nextHandle++;
				timers.push({ callback, delayMs, handle });
				return handle;
			},
			clearTimeout: (handle) => cleared.push(handle),
		});

		invalidation.commitDependencies("random", [dependencyKey.time("random")]);
		scheduler.rearm();
		expect(timers).toEqual([]);

		invalidation.commitDependencies("now", [dependencyKey.time("now")]);
		scheduler.rearm();
		expect(timers).toHaveLength(1);
		expect(timers[0]?.delayMs).toBe(40_000);

		now = new Date(2026, 8, 1, 12, 35, 0, 0).getTime();
		timers[0]?.callback();
		expect(affected).toEqual(["now"]);
		expect(timers).toHaveLength(2);

		invalidation.remove("now");
		scheduler.rearm();
		expect(cleared).toContain(timers[1]?.handle);
		expect(timers).toHaveLength(2);
	});

	it("coalesces a shared midnight crossing across now and today owners", () => {
		const affected: string[] = [];
		const invalidation = new InvalidationEngine<string>((owner) => affected.push(owner));
		const core = new ReactiveDataCore<string>({} as App, invalidation, {
			time: { nowResolutionMs: 60_000 },
		});
		let now = new Date(2026, 8, 1, 23, 59, 30, 0).getTime();
		core.time.seed(now);
		const timers: TimerRecord[] = [];
		const scheduler = new ActiveTimeScheduler({
			nextBoundary(at) {
				return nextActiveTimeBoundary(core.time, invalidation.index, at);
			},
			advance(at) {
				core.advanceTime(at);
			},
		}, {
			now: () => now,
			setTimeout: (callback, delayMs) => {
				const handle = timers.length + 1;
				timers.push({ callback, delayMs, handle });
				return handle;
			},
			clearTimeout: vi.fn(),
		});

		invalidation.commitDependencies("now", [dependencyKey.time("now")]);
		invalidation.commitDependencies("today", [dependencyKey.time("today")]);
		invalidation.commitDependencies("both", [
			dependencyKey.time("now"),
			dependencyKey.time("today"),
		]);
		scheduler.rearm();
		expect(timers[0]?.delayMs).toBe(30_000);

		now = new Date(2026, 8, 2, 0, 0, 0, 0).getTime();
		timers[0]?.callback();

		expect(new Set(affected)).toEqual(new Set(["now", "today", "both"]));
		expect(affected.filter(owner => owner === "both")).toHaveLength(1);
	});
});
