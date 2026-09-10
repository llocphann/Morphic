import { describe, expect, it, vi } from "vitest";
import { RenderScope } from "../core/render-scope";
import { RetainedOwnerScope, type RetainedDisposable } from "../render/retained-owner-scope";
import { RetainedDomRuntime } from "../render/retained-slot-runtime";
import { RetainedScopedKeyedRange } from "../render/scoped-keyed-slot-runtime";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

class TestOwner {
	private disposer: (() => void) | null = null;
	isDisposed = false;
	registrations = 0;

	registerDisposer(disposer: () => void): () => void {
		this.registrations += 1;
		if (this.isDisposed) disposer();
		else this.disposer = disposer;
		return disposer;
	}

	dispose(): void {
		if (this.isDisposed) return;
		this.isDisposed = true;
		this.disposer?.();
		this.disposer = null;
	}
}

function disposable(dispose: () => void): RetainedDisposable {
	return { dispose };
}

describe("RetainedOwnerScope", () => {
	it("registers one Core owner disposer for many retained resources and cleans them LIFO", () => {
		const owner = new TestOwner();
		const order: string[] = [];
		const bridge = new RetainedOwnerScope(owner);
		bridge.own(disposable(() => order.push("first")));
		bridge.own(disposable(() => order.push("second")));
		bridge.own(disposable(() => order.push("third")));

		expect(owner.registrations).toBe(1);
		expect(bridge.trackedResourceCount).toBe(3);
		owner.dispose();

		expect(order).toEqual(["third", "second", "first"]);
		expect(bridge.isDisposed).toBe(true);
		expect(bridge.trackedResourceCount).toBe(0);
	});

	it("removes an early-disposed handle so owner teardown cannot retain or dispose it twice", () => {
		const owner = new TestOwner();
		const dispose = vi.fn();
		const bridge = new RetainedOwnerScope(owner);
		const handle = bridge.own(disposable(dispose));

		handle.dispose();
		expect(handle.isDisposed).toBe(true);
		expect(bridge.trackedResourceCount).toBe(0);
		expect(dispose).toHaveBeenCalledTimes(1);

		owner.dispose();
		expect(dispose).toHaveBeenCalledTimes(1);
	});

	it("immediately disposes resources added after the Core owner has already ended", () => {
		const owner = new TestOwner();
		owner.dispose();
		const bridge = new RetainedOwnerScope(owner);
		const dispose = vi.fn();
		const handle = bridge.own(disposable(dispose));

		expect(bridge.isDisposed).toBe(true);
		expect(handle.isDisposed).toBe(true);
		expect(bridge.trackedResourceCount).toBe(0);
		expect(dispose).toHaveBeenCalledTimes(1);
	});

	it("continues owner cleanup after one retained resource throws", () => {
		const owner = new TestOwner();
		const failure = new Error("cleanup failed");
		const onCleanupError = vi.fn();
		const cleaned = vi.fn();
		const bridge = new RetainedOwnerScope(owner, { onCleanupError });
		bridge.own(disposable(cleaned));
		bridge.own(disposable(() => { throw failure; }));
		bridge.own(disposable(cleaned));

		owner.dispose();

		expect(cleaned).toHaveBeenCalledTimes(2);
		expect(onCleanupError).toHaveBeenCalledTimes(1);
		expect(onCleanupError).toHaveBeenCalledWith(failure);
	});

	it("continues LIFO cleanup when the cleanup-error reporter also throws", () => {
		const owner = new TestOwner();
		const cleanupFailure = new Error("cleanup failed");
		const reporterFailure = new Error("reporter failed");
		const order: string[] = [];
		const onCleanupError = vi.fn(() => { throw reporterFailure; });
		const bridge = new RetainedOwnerScope(owner, { onCleanupError });
		const first = bridge.own(disposable(() => order.push("first")));
		const failing = bridge.own(disposable(() => { throw cleanupFailure; }));
		const third = bridge.own(disposable(() => order.push("third")));

		expect(() => owner.dispose()).not.toThrow();

		expect(order).toEqual(["third", "first"]);
		expect(onCleanupError).toHaveBeenCalledTimes(1);
		expect(onCleanupError).toHaveBeenCalledWith(cleanupFailure);
		expect(first.isDisposed).toBe(true);
		expect(failing.isDisposed).toBe(true);
		expect(third.isDisposed).toBe(true);
		expect(bridge.trackedResourceCount).toBe(0);
	});

	it("makes pending Markdown island work disposed when the owning RenderScope ends", async () => {
		const owner = new RenderScope();
		owner.load();
		const bridge = new RetainedOwnerScope(owner);
		const root = document.createElement("div");
		const runtime = new RetainedDomRuntime(root);
		bridge.own(runtime);
		const gate = deferred();
		const cleanup = vi.fn();

		runtime.mountStructure("article", ({ ownerDocument, fragment, markdownSlot }) => {
			const island = ownerDocument.createElement("div");
			markdownSlot("body", island);
			fragment.appendChild(island);
		});
		const render = runtime.patchMarkdown("body", "rev-1", async ({ container, resources }) => {
			resources.register(cleanup);
			container.textContent = "Late Markdown";
			await gate.promise;
		});

		owner.dispose();
		expect(cleanup).toHaveBeenCalledTimes(1);
		gate.resolve();

		expect((await render).status).toBe("disposed");
		expect(root.textContent).toBe("");
	});

	it("owns a scoped keyed range transitively so keyed slot resources die with the RenderScope", () => {
		const owner = new RenderScope();
		owner.load();
		const bridge = new RetainedOwnerScope(owner);
		const parent = document.createElement("div");
		const range = new RetainedScopedKeyedRange<string>(parent);
		bridge.own(range);

		range.reconcile(["a"], ({ slots, ownerDocument }) => {
			return slots.mount(({ fragment, textSlot }) => {
				const row = ownerDocument.createElement("span");
				row.appendChild(textSlot("label", "A"));
				fragment.appendChild(row);
			});
		});
		expect(range.entry("a")?.slots.patchText("label", "A2")).toBe("patched");

		owner.dispose();

		expect(range.isDisposed).toBe(true);
		expect(range.entry("a")).toBeUndefined();
	});

	it("disposing the bridge is one-way and does not dispose its Core RenderScope owner", () => {
		const owner = new RenderScope();
		owner.load();
		const bridge = new RetainedOwnerScope(owner);
		const dispose = vi.fn();
		bridge.own(disposable(dispose));

		bridge.dispose();

		expect(dispose).toHaveBeenCalledTimes(1);
		expect(owner.isDisposed).toBe(false);
		owner.dispose();
	});
});
