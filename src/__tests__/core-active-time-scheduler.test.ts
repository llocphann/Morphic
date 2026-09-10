import { describe, expect, it, vi } from "vitest";
import { ActiveTimeScheduler, type ActiveTimeScheduleSource } from "../core/active-time-scheduler";

interface Harness {
	now: number;
	boundary: number | null;
	advance: ReturnType<typeof vi.fn<(nowMs: number) => void>>;
	scheduled: Array<{ callback: () => void; delayMs: number; handle: number }>;
	cleared: number[];
}

function createScheduler(harness: Harness): ActiveTimeScheduler {
	const source: ActiveTimeScheduleSource = {
		nextBoundary: () => harness.boundary,
		advance: harness.advance,
	};
	let nextHandle = 1;
	return new ActiveTimeScheduler(source, {
		now: () => harness.now,
		setTimeout: (callback, delayMs) => {
			const handle = nextHandle++;
			harness.scheduled.push({ callback, delayMs, handle });
			return handle;
		},
		clearTimeout: (handle) => harness.cleared.push(handle),
	});
}

function harness(): Harness {
	return {
		now: 1_000,
		boundary: null,
		advance: vi.fn(),
		scheduled: [],
		cleared: [],
	};
}

describe("ActiveTimeScheduler", () => {
	it("stays completely idle when no wall-clock boundary is active", () => {
		const state = harness();
		const scheduler = createScheduler(state);

		scheduler.rearm();

		expect(state.scheduled).toEqual([]);
		expect(state.advance).not.toHaveBeenCalled();
	});

	it("keeps exactly one one-shot timeout for an unchanged deadline", () => {
		const state = harness();
		state.boundary = 1_500;
		const scheduler = createScheduler(state);

		scheduler.rearm();
		scheduler.rearm();

		expect(state.scheduled).toHaveLength(1);
		expect(state.scheduled[0]?.delayMs).toBe(500);
		expect(state.cleared).toEqual([]);
	});

	it("cancels and replaces the timeout when active ownership changes the boundary", () => {
		const state = harness();
		state.boundary = 2_000;
		const scheduler = createScheduler(state);
		scheduler.rearm();
		const first = state.scheduled[0]?.handle;

		state.boundary = 1_250;
		scheduler.rearm();

		expect(state.cleared).toEqual([first]);
		expect(state.scheduled).toHaveLength(2);
		expect(state.scheduled[1]?.delayMs).toBe(250);
	});

	it("advances once at firing time and re-arms from current ownership", () => {
		const state = harness();
		state.boundary = 1_500;
		const scheduler = createScheduler(state);
		scheduler.rearm();
		const first = state.scheduled[0];

		state.now = 1_500;
		state.boundary = 2_000;
		first?.callback();

		expect(state.advance).toHaveBeenCalledTimes(1);
		expect(state.advance).toHaveBeenCalledWith(1_500);
		expect(state.scheduled).toHaveLength(2);
		expect(state.scheduled[1]?.delayMs).toBe(500);
	});

	it("drops the timeout immediately when no active boundary remains", () => {
		const state = harness();
		state.boundary = 2_000;
		const scheduler = createScheduler(state);
		scheduler.rearm();
		const handle = state.scheduled[0]?.handle;

		state.boundary = null;
		scheduler.rearm();

		expect(state.cleared).toEqual([handle]);
	});

	it("dispose cancels the timeout and prevents late callback resurrection", () => {
		const state = harness();
		state.boundary = 2_000;
		const scheduler = createScheduler(state);
		scheduler.rearm();
		const pending = state.scheduled[0];

		scheduler.dispose();
		state.now = 2_000;
		pending?.callback();
		scheduler.rearm();

		expect(state.cleared).toEqual([pending?.handle]);
		expect(state.advance).not.toHaveBeenCalled();
		expect(state.scheduled).toHaveLength(1);
	});
});
