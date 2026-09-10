export interface ActiveTimeScheduleSource {
	/** Absolute timestamp of the next active semantic boundary, or null when idle. */
	nextBoundary(nowMs: number): number | null;
	/** Advance wall-clock semantics at the observed firing time. */
	advance(nowMs: number): void;
}

export interface ActiveTimeSchedulerOptions {
	now?: () => number;
	setTimeout?: (callback: () => void, delayMs: number) => number;
	clearTimeout?: (handle: number) => void;
}

/**
 * Bot 1 lifecycle primitive for wall-clock dependency invalidation.
 *
 * Exactly one one-shot timeout may be armed. The source decides whether any
 * wall-clock dependency is currently owned and which semantic boundary is next.
 * There is deliberately no interval/polling loop: after a firing, the source is
 * advanced and the scheduler probes current ownership again before re-arming.
 */
export class ActiveTimeScheduler {
	private readonly now: () => number;
	private readonly schedule: (callback: () => void, delayMs: number) => number;
	private readonly cancel: (handle: number) => void;
	private timer: number | null = null;
	private deadline: number | null = null;
	private disposed = false;

	constructor(
		private readonly source: ActiveTimeScheduleSource,
		options: ActiveTimeSchedulerOptions = {},
	) {
		this.now = options.now ?? (() => Date.now());
		this.schedule = options.setTimeout ?? ((callback, delayMs) => window.setTimeout(callback, delayMs));
		this.cancel = options.clearTimeout ?? ((handle) => window.clearTimeout(handle));
	}

	/** Reconcile the single timeout with the source's currently active boundary. */
	rearm(): void {
		if (this.disposed) return;
		const nowMs = this.now();
		const next = this.source.nextBoundary(nowMs);

		if (next === null) {
			this.cancelTimer();
			return;
		}
		if (this.timer !== null && this.deadline === next) return;

		this.cancelTimer();
		this.deadline = next;
		this.timer = this.schedule(() => this.fire(), Math.max(0, next - nowMs));
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.cancelTimer();
	}

	private fire(): void {
		this.timer = null;
		this.deadline = null;
		if (this.disposed) return;

		this.source.advance(this.now());
		if (!this.disposed) this.rearm();
	}

	private cancelTimer(): void {
		if (this.timer !== null) this.cancel(this.timer);
		this.timer = null;
		this.deadline = null;
	}
}
