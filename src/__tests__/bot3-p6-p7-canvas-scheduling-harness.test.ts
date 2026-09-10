import { describe, expect, it, vi } from "vitest";
import {
	CanvasDirtyScheduler,
	type CanvasRenderToken,
} from "../render/canvas-dirty-scheduler";
import { BOT3_P6_P7_CERT_WORKLOAD } from "./support/bot3-p6-p7-cert-workloads";

interface CertificationNode {
	readonly id: string;
}

function createManualQueue() {
	const queued: Array<() => void> = [];
	return {
		queued,
		schedule(run: () => void) {
			queued.push(run);
		},
		drain() {
			while (queued.length > 0) queued.shift()?.();
		},
	};
}

async function flushPromises() {
	await Promise.resolve();
	await Promise.resolve();
}

describe("Bot 3 P6/P7 Canvas scheduling certification harness", () => {
	it("does zero idle work and bounds a multi-node dirty burst to one newest invocation per owner", async () => {
		const queue = createManualQueue();
		const seen = new Map<string, CanvasRenderToken<CertificationNode>>();
		const nodes = Array.from(
			{ length: BOT3_P6_P7_CERT_WORKLOAD.canvasNodes },
			(_, index) => Object.freeze({ id: `canvas-${index}` }),
		);
		const scheduler = new CanvasDirtyScheduler<CertificationNode>((token) => {
			seen.set(token.node.id, token);
		}, { schedule: queue.schedule });

		expect(queue.queued).toHaveLength(0);
		expect(scheduler.trackedNodeCount).toBe(0);

		for (const node of nodes) {
			for (let burst = 0; burst < BOT3_P6_P7_CERT_WORKLOAD.canvasBurstSize; burst++) {
				scheduler.markDirty(node);
			}
		}
		expect(scheduler.trackedNodeCount).toBe(BOT3_P6_P7_CERT_WORKLOAD.canvasNodes);
		expect(queue.queued).toHaveLength(BOT3_P6_P7_CERT_WORKLOAD.canvasNodes);

		queue.drain();
		expect(seen.size).toBe(BOT3_P6_P7_CERT_WORKLOAD.canvasNodes);
		for (const node of nodes) {
			const token = seen.get(node.id);
			expect(token?.generation).toBe(BOT3_P6_P7_CERT_WORKLOAD.canvasBurstSize);
			expect(token?.isCurrent()).toBe(true);
		}

		for (const node of nodes) scheduler.releaseNode(node);
		expect(scheduler.trackedNodeCount).toBe(0);
		for (const token of seen.values()) expect(token.isCurrent()).toBe(false);
		await flushPromises();
		expect(queue.queued).toHaveLength(0);
	});

	it("does not accumulate tracked owners across repeated Canvas attach/detach rounds", async () => {
		const queue = createManualQueue();
		let renderCount = 0;
		const scheduler = new CanvasDirtyScheduler<CertificationNode>(() => {
			renderCount += 1;
		}, { schedule: queue.schedule });

		for (let round = 0; round < 6; round++) {
			const nodes = Array.from(
				{ length: BOT3_P6_P7_CERT_WORKLOAD.canvasNodes },
				(_, index) => ({ id: `round-${round}-node-${index}` }),
			);
			for (const node of nodes) scheduler.markDirty(node);
			expect(scheduler.trackedNodeCount).toBe(BOT3_P6_P7_CERT_WORKLOAD.canvasNodes);
			queue.drain();
			for (const node of nodes) scheduler.releaseNode(node);
			expect(scheduler.trackedNodeCount).toBe(0);
			await flushPromises();
			expect(queue.queued).toHaveLength(0);
		}

		expect(renderCount).toBe(BOT3_P6_P7_CERT_WORKLOAD.canvasNodes * 6);
		scheduler.dispose();
		expect(scheduler.trackedNodeCount).toBe(0);
	});

	it("invokes the default microtask scheduler without rebinding a receiver-sensitive native function", async () => {
		const queued: Array<() => void> = [];
		const receiverSensitiveQueueMicrotask = function(this: unknown, run: () => void) {
			if (this !== undefined) {
				throw new TypeError("Illegal invocation");
			}
			queued.push(run);
		};

		vi.stubGlobal("queueMicrotask", receiverSensitiveQueueMicrotask);
		try {
			const node = { id: "receiver-safe-default" };
			let renderCount = 0;
			const scheduler = new CanvasDirtyScheduler<CertificationNode>(() => {
				renderCount += 1;
			});

			expect(() => scheduler.markDirty(node)).not.toThrow();
			expect(queued).toHaveLength(1);
			queued.shift()?.();
			await flushPromises();
			expect(renderCount).toBe(1);
			expect(scheduler.trackedNodeCount).toBe(1);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
