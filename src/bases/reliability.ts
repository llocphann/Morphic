import type { Component } from "obsidian";

interface LimiterWaiter {
	readonly signal: AbortSignal;
	readonly resolve: (release: () => void) => void;
	readonly reject: (error: Error) => void;
	readonly onAbort: () => void;
}

/** Small abort-aware semaphore used to bound internal Bases collector fan-out. */
export class CollectorLimiter {
	private active = 0;
	private readonly waiters: LimiterWaiter[] = [];

	constructor(private readonly limit: number) {
		if (!Number.isInteger(limit) || limit <= 0) {
			throw new Error("CollectorLimiter limit must be a positive integer.");
		}
	}

	tryAcquire(): (() => void) | null {
		if (this.active >= this.limit) return null;
		this.active++;
		return this.createRelease();
	}

	acquire(signal: AbortSignal): Promise<() => void> {
		if (signal.aborted) return Promise.reject(abortError(signal));
		const immediate = this.tryAcquire();
		if (immediate) return Promise.resolve(immediate);

		return new Promise((resolve, reject) => {
			const waiter: LimiterWaiter = {
				signal,
				resolve,
				reject,
				onAbort: () => {
					const index = this.waiters.indexOf(waiter);
					if (index >= 0) this.waiters.splice(index, 1);
					reject(abortError(signal));
				},
			};
			signal.addEventListener("abort", waiter.onAbort, { once: true });
			this.waiters.push(waiter);
		});
	}

	private createRelease(): () => void {
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.active--;
			this.drain();
		};
	}

	private drain(): void {
		while (this.active < this.limit && this.waiters.length > 0) {
			const waiter = this.waiters.shift();
			if (!waiter) return;
			waiter.signal.removeEventListener("abort", waiter.onAbort);
			if (waiter.signal.aborted) {
				waiter.reject(abortError(waiter.signal));
				continue;
			}
			this.active++;
			waiter.resolve(this.createRelease());
		}
	}
}

/**
 * Shared lifetime for one native Bases collector operation.
 * Multiple render owners may lease one identical in-flight operation. The
 * native resource is synchronously torn down when the last live owner unloads.
 */
export class CollectorLifetime {
	private readonly controller = new AbortController();
	private cleanup: (() => void) | null = null;
	private consumers = 0;
	private settled = false;

	get signal(): AbortSignal {
		return this.controller.signal;
	}

	retain(component: Component): void {
		if (this.settled || this.signal.aborted) return;
		this.consumers++;
		let released = false;
		component.register(() => {
			if (released) return;
			released = true;
			this.consumers = Math.max(0, this.consumers - 1);
			if (this.consumers === 0 && !this.settled) {
				this.abort(new Error("Bases collection owner was disposed."));
			}
		});
	}

	setCleanup(cleanup: () => void): void {
		if (this.cleanup) throw new Error("Bases collector cleanup is already registered.");
		this.cleanup = once(cleanup);
		if (this.signal.aborted || this.settled) this.cleanupNow();
	}

	abort(reason: Error): void {
		if (!this.signal.aborted) this.controller.abort(reason);
		this.cleanupNow();
	}

	finish(): void {
		if (this.settled) return;
		this.settled = true;
		this.cleanupNow();
	}

	private cleanupNow(): void {
		const cleanup = this.cleanup;
		if (!cleanup) return;
		this.cleanup = null;
		try {
			cleanup();
		} catch {
			// Internal Obsidian resources are best-effort; sibling cleanup is owned
			// by the single registered cleanup closure.
		}
	}
}

export function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(abortError(signal));
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(abortError(signal));
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			value => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			error => {
				signal.removeEventListener("abort", onAbort);
				reject(toError(error));
			},
		);
	});
}

export function abortError(signal: AbortSignal): Error {
	return signal.reason instanceof Error
		? signal.reason
		: new Error("Bases collection was cancelled.");
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

function once(callback: () => void): () => void {
	let called = false;
	return () => {
		if (called) return;
		called = true;
		callback();
	};
}
