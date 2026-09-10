import { describe, expect, it, vi } from "vitest";
import {
	CanvasDirtyScheduler,
	type CanvasRenderToken,
} from "../render/canvas-dirty-scheduler";

interface TestNode {
	id: string;
}

function createManualQueue() {
	const queued: Array<() => void> = [];
	return {
		queued,
		schedule(run: () => void) {
			queued.push(run);
		},
		runNext() {
			const run = queued.shift();
			expect(run).toBeDefined();
			run?.();
		},
	};
}

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function flushPromises() {
	await Promise.resolve();
	await Promise.resolve();
}

describe("CanvasDirtyScheduler", () => {
	it("does zero idle work and coalesces a dirty burst to the newest generation", () => {
		const queue = createManualQueue();
		const seen: CanvasRenderToken<TestNode>[] = [];
		const node = { id: "node-a" };
		const scheduler = new CanvasDirtyScheduler<TestNode>(
			(token) => { seen.push(token); },
			{ schedule: queue.schedule },
		);

		expect(queue.queued).toHaveLength(0);
		expect(scheduler.trackedNodeCount).toBe(0);
		expect(scheduler.markDirty(node)).toBe(1);
		expect(scheduler.markDirty(node)).toBe(2);
		expect(scheduler.markDirty(node)).toBe(3);
		expect(queue.queued).toHaveLength(1);

		queue.runNext();
		expect(seen).toHaveLength(1);
		expect(seen[0].generation).toBe(3);
		expect(seen[0].isCurrent()).toBe(true);
	});

	it("allows one in-flight render and schedules one follow-up for newer dirtiness", async () => {
		const queue = createManualQueue();
		const firstRender = deferred();
		const seen: CanvasRenderToken<TestNode>[] = [];
		const node = { id: "node-a" };
		let activeRenders = 0;
		let maxActiveRenders = 0;
		const scheduler = new CanvasDirtyScheduler<TestNode>(async (token) => {
			seen.push(token);
			activeRenders += 1;
			maxActiveRenders = Math.max(maxActiveRenders, activeRenders);
			try {
				if (seen.length === 1) await firstRender.promise;
			} finally {
				activeRenders -= 1;
			}
		}, { schedule: queue.schedule });

		scheduler.markDirty(node);
		queue.runNext();
		expect(seen).toHaveLength(1);
		scheduler.markDirty(node);
		scheduler.markDirty(node);
		expect(seen[0].isCurrent()).toBe(false);
		expect(queue.queued).toHaveLength(0);

		firstRender.resolve();
		await flushPromises();
		expect(queue.queued).toHaveLength(1);
		queue.runNext();
		await flushPromises();
		expect(seen).toHaveLength(2);
		expect(seen[1].generation).toBe(3);
		expect(seen[1].isCurrent()).toBe(true);
		expect(maxActiveRenders).toBe(1);
	});

	it("makes in-flight work stale when a node is released", async () => {
		const queue = createManualQueue();
		const pending = deferred();
		const node = { id: "node-a" };
		let token: CanvasRenderToken<TestNode> | undefined;
		const scheduler = new CanvasDirtyScheduler<TestNode>(async (nextToken) => {
			token = nextToken;
			await pending.promise;
		}, { schedule: queue.schedule });

		scheduler.markDirty(node);
		queue.runNext();
		expect(token?.isCurrent()).toBe(true);
		scheduler.releaseNode(node);
		expect(token?.isCurrent()).toBe(false);
		expect(scheduler.trackedNodeCount).toBe(0);

		pending.resolve();
		await flushPromises();
		expect(queue.queued).toHaveLength(0);
	});

	it("serializes release and re-add of the same node object with the old renderer", async () => {
		const queue = createManualQueue();
		const firstRender = deferred();
		const node = { id: "node-a" };
		const seen: CanvasRenderToken<TestNode>[] = [];
		let activeRenders = 0;
		let maxActiveRenders = 0;
		const scheduler = new CanvasDirtyScheduler<TestNode>(async (token) => {
			seen.push(token);
			activeRenders += 1;
			maxActiveRenders = Math.max(maxActiveRenders, activeRenders);
			try {
				if (seen.length === 1) await firstRender.promise;
			} finally {
				activeRenders -= 1;
			}
		}, { schedule: queue.schedule });

		expect(scheduler.markDirty(node)).toBe(1);
		queue.runNext();
		expect(seen).toHaveLength(1);
		expect(seen[0].isCurrent()).toBe(true);

		scheduler.releaseNode(node);
		expect(seen[0].isCurrent()).toBe(false);
		expect(scheduler.trackedNodeCount).toBe(0);
		expect(scheduler.markDirty(node)).toBe(2);
		expect(scheduler.trackedNodeCount).toBe(1);
		expect(queue.queued).toHaveLength(0);
		expect(seen[0].isCurrent()).toBe(false);

		firstRender.resolve();
		await flushPromises();
		expect(queue.queued).toHaveLength(1);
		queue.runNext();
		await flushPromises();

		expect(seen).toHaveLength(2);
		expect(seen[1].generation).toBe(2);
		expect(seen[1].isCurrent()).toBe(true);
		expect(maxActiveRenders).toBe(1);
	});

	it("invalidates queued and in-flight work when disposed", async () => {
		const queue = createManualQueue();
		const pending = deferred();
		const runningNode = { id: "running" };
		const queuedNode = { id: "queued" };
		let runningToken: CanvasRenderToken<TestNode> | undefined;
		const render = vi.fn(async (token: CanvasRenderToken<TestNode>) => {
			runningToken = token;
			await pending.promise;
		});
		const scheduler = new CanvasDirtyScheduler<TestNode>(render, { schedule: queue.schedule });

		scheduler.markDirty(runningNode);
		queue.runNext();
		scheduler.markDirty(queuedNode);
		scheduler.dispose();
		expect(runningToken?.isCurrent()).toBe(false);
		expect(scheduler.trackedNodeCount).toBe(0);
		expect(scheduler.markDirty({ id: "after" })).toBe(0);

		queue.runNext();
		expect(render).toHaveBeenCalledTimes(1);
		pending.resolve();
		await flushPromises();
	});

	it("reports renderer failures without creating idle retry work", async () => {
		const queue = createManualQueue();
		const onError = vi.fn();
		const failure = new Error("render failed");
		const scheduler = new CanvasDirtyScheduler<TestNode>(() => { throw failure; }, {
			schedule: queue.schedule,
			onError,
		});

		scheduler.markDirty({ id: "node-a" });
		queue.runNext();
		await flushPromises();
		expect(onError).toHaveBeenCalledTimes(1);
		expect(onError.mock.calls[0][0]).toBe(failure);
		expect(queue.queued).toHaveLength(0);
	});
});
