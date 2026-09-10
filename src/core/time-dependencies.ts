import { dependencyKey, type DependencyKey } from "./dependencies";

export interface TimeDependencyPolicyOptions {
	/** Granularity for now()-style values. Defaults to one minute. */
	nowResolutionMs?: number;
}

/** Minimal reverse-index membership surface needed to derive a wall-clock deadline. */
export interface ActiveTimeDependencySource {
	hasDependencyKey(key: DependencyKey): boolean;
}

/**
 * Pure time-dependency state machine. It owns no timers.
 *
 * Bot 1 may schedule exactly the next returned boundary only while an owner
 * actually depends on the corresponding key. This avoids global tight polling.
 */
export class TimeDependencyPolicy {
	readonly nowResolutionMs: number;
	private todayToken: string | undefined;
	private nowBucket: number | undefined;

	constructor(options: TimeDependencyPolicyOptions = {}) {
		this.nowResolutionMs = normalizeResolution(options.nowResolutionMs);
	}

	/**
	 * Observe wall clock progression and return only time keys whose semantic
	 * value crossed a boundary since the previous observation.
	 */
	advance(nowMs: number = Date.now()): readonly DependencyKey[] {
		const changed: DependencyKey[] = [];
		const today = localDateToken(nowMs);
		const bucket = Math.floor(nowMs / this.nowResolutionMs);

		if (this.todayToken !== undefined && this.todayToken !== today) {
			changed.push(dependencyKey.time("today"));
		}
		if (this.nowBucket !== undefined && this.nowBucket !== bucket) {
			changed.push(dependencyKey.time("now"));
		}

		this.todayToken = today;
		this.nowBucket = bucket;
		return changed;
	}

	/** Initialize boundary state without invalidating any owner. */
	seed(nowMs: number = Date.now()): void {
		this.todayToken = localDateToken(nowMs);
		this.nowBucket = Math.floor(nowMs / this.nowResolutionMs);
	}

	/**
	 * random() is render-volatile, not wall-clock volatile. Consumers call this
	 * only when an explicit render cycle is intended to resample random values.
	 */
	randomCycle(): readonly DependencyKey[] {
		return [dependencyKey.time("random")];
	}

	/** Absolute timestamp of the next semantic boundary, without starting a timer. */
	nextBoundary(kind: "now" | "today", nowMs: number = Date.now()): number {
		if (kind === "now") {
			return (Math.floor(nowMs / this.nowResolutionMs) + 1) * this.nowResolutionMs;
		}
		const date = new Date(nowMs);
		const next = new Date(
			date.getFullYear(),
			date.getMonth(),
			date.getDate() + 1,
			0,
			0,
			0,
			0,
		);
		return next.getTime();
	}
}

/**
 * Return the earliest wall-clock boundary that can affect a currently owned
 * dependency. `random()` is intentionally excluded because it is render-cycle
 * volatile rather than wall-clock volatile.
 *
 * The source is normally `InvalidationEngine.index`. This helper owns no timer
 * and retains neither owners nor the dependency source.
 */
export function nextActiveTimeBoundary(
	policy: TimeDependencyPolicy,
	source: ActiveTimeDependencySource,
	nowMs: number = Date.now(),
): number | null {
	let boundary: number | null = null;
	if (source.hasDependencyKey(dependencyKey.time("now"))) {
		boundary = policy.nextBoundary("now", nowMs);
	}
	if (source.hasDependencyKey(dependencyKey.time("today"))) {
		const todayBoundary = policy.nextBoundary("today", nowMs);
		boundary = boundary === null ? todayBoundary : Math.min(boundary, todayBoundary);
	}
	return boundary;
}

function normalizeResolution(value: number | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 1000) {
		return 60_000;
	}
	return Math.floor(value);
}

function localDateToken(nowMs: number): string {
	const date = new Date(nowMs);
	return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}
