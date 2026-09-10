import { describe, expect, it } from "vitest";
import { RetainedRenderScopeHandoff } from "../render/retained-render-scope-handoff";

class FakeScope {
	isDisposed = false;
	private readonly disposers: Array<() => void> = [];

	registerDisposer(disposer: () => void): () => void {
		if (this.isDisposed) {
			disposer();
			return disposer;
		}
		this.disposers.push(disposer);
		return disposer;
	}

	dispose(): void {
		if (this.isDisposed) return;
		this.isDisposed = true;
		for (const disposer of this.disposers.splice(0)) disposer();
	}
}

function disposable(onDispose: () => void = () => undefined) {
	return { dispose: onDispose };
}

describe("RetainedRenderScopeHandoff", () => {
	it("keeps the initial retained resource owned by its committed scope", () => {
		const scope = new FakeScope();
		let disposals = 0;
		const handoff = new RetainedRenderScopeHandoff(
			disposable(() => disposals++),
			scope,
			1,
		);

		expect(handoff.currentGeneration).toBe(1);
		scope.dispose();
		expect(disposals).toBe(1);
		expect(handoff.isDisposed).toBe(true);
		expect(handoff.currentGeneration).toBeNull();
	});

	it("promotes a newer scope only after the synchronous commit succeeds", () => {
		const first = new FakeScope();
		const second = new FakeScope();
		let disposals = 0;
		const handoff = new RetainedRenderScopeHandoff(
			disposable(() => disposals++),
			first,
			10,
		);
		const transfer = handoff.prepareTransfer(second, 11);
		const order: string[] = [];

		expect(transfer.commitAfter(() => order.push("live-commit"))).toBe("transferred");
		expect(order).toEqual(["live-commit"]);
		expect(handoff.currentGeneration).toBe(11);

		first.dispose();
		expect(disposals).toBe(0);
		second.dispose();
		expect(disposals).toBe(1);
	});

	it("keeps a successful commit authoritative when it reentrantly prepares a newer generation", () => {
		const first = new FakeScope();
		const second = new FakeScope();
		const third = new FakeScope();
		let disposals = 0;
		const handoff = new RetainedRenderScopeHandoff(
			disposable(() => disposals++),
			first,
			1,
		);
		const secondTransfer = handoff.prepareTransfer(second, 2);
		const pending = {
			thirdTransfer: null as ReturnType<typeof handoff.prepareTransfer> | null,
		};

		expect(secondTransfer.commitAfter(() => {
			pending.thirdTransfer = handoff.prepareTransfer(third, 3);
		})).toBe("transferred");
		expect(handoff.currentGeneration).toBe(2);

		first.dispose();
		expect(disposals).toBe(0);
		if (!pending.thirdTransfer) throw new Error("Expected reentrant third-generation transfer");
		expect(pending.thirdTransfer.commitAfter(() => undefined)).toBe("transferred");
		expect(handoff.currentGeneration).toBe(3);

		second.dispose();
		expect(disposals).toBe(0);
		third.dispose();
		expect(disposals).toBe(1);
	});

	it("preserves previous ownership when the live commit throws", () => {
		const first = new FakeScope();
		const second = new FakeScope();
		let disposals = 0;
		const handoff = new RetainedRenderScopeHandoff(
			disposable(() => disposals++),
			first,
			1,
		);
		const transfer = handoff.prepareTransfer(second, 2);

		expect(() => transfer.commitAfter(() => {
			throw new Error("synthetic commit failure");
		})).toThrow("synthetic commit failure");
		expect(handoff.currentGeneration).toBe(1);

		second.dispose();
		expect(disposals).toBe(0);
		first.dispose();
		expect(disposals).toBe(1);
	});

	it("does not run a commit callback after its pending scope was disposed", () => {
		const first = new FakeScope();
		const second = new FakeScope();
		const handoff = new RetainedRenderScopeHandoff(disposable(), first, 1);
		const transfer = handoff.prepareTransfer(second, 2);
		let commits = 0;

		second.dispose();
		expect(transfer.commitAfter(() => commits++)).toBe("stale");
		expect(commits).toBe(0);
		expect(handoff.currentGeneration).toBe(1);
	});

	it("makes an older prepared generation stale when a newer generation starts", () => {
		const first = new FakeScope();
		const second = new FakeScope();
		const third = new FakeScope();
		const handoff = new RetainedRenderScopeHandoff(disposable(), first, 4);
		const older = handoff.prepareTransfer(second, 5);
		const newer = handoff.prepareTransfer(third, 6);
		let olderCommits = 0;

		expect(older.commitAfter(() => olderCommits++)).toBe("stale");
		expect(olderCommits).toBe(0);
		expect(newer.commitAfter(() => undefined)).toBe("transferred");
		expect(handoff.currentGeneration).toBe(6);
	});

	it("keeps the current owner after a newer candidate is cancelled, then allows a later generation", () => {
		const first = new FakeScope();
		const cancelled = new FakeScope();
		const later = new FakeScope();
		let disposals = 0;
		const handoff = new RetainedRenderScopeHandoff(
			disposable(() => disposals++),
			first,
			20,
		);

		handoff.prepareTransfer(cancelled, 21);
		cancelled.dispose();
		expect(disposals).toBe(0);
		expect(handoff.currentGeneration).toBe(20);

		const next = handoff.prepareTransfer(later, 22);
		expect(next.commitAfter(() => undefined)).toBe("transferred");
		first.dispose();
		expect(disposals).toBe(0);
		later.dispose();
		expect(disposals).toBe(1);
	});

	it("disposes immediately when the initial scope is already disposed", () => {
		const scope = new FakeScope();
		scope.dispose();
		let disposals = 0;
		const handoff = new RetainedRenderScopeHandoff(
			disposable(() => disposals++),
			scope,
			1,
		);

		expect(disposals).toBe(1);
		expect(handoff.isDisposed).toBe(true);
	});

	it("returns stale without running user commit for an already disposed candidate scope", () => {
		const first = new FakeScope();
		const second = new FakeScope();
		second.dispose();
		const handoff = new RetainedRenderScopeHandoff(disposable(), first, 1);
		const transfer = handoff.prepareTransfer(second, 2);
		let commits = 0;

		expect(transfer.commitAfter(() => commits++)).toBe("stale");
		expect(commits).toBe(0);
	});

	it("manual disposal is idempotent and prevents later ownership transfers", () => {
		const first = new FakeScope();
		const second = new FakeScope();
		let disposals = 0;
		const handoff = new RetainedRenderScopeHandoff(
			disposable(() => disposals++),
			first,
			1,
		);
		const transfer = handoff.prepareTransfer(second, 2);

		handoff.dispose();
		handoff.dispose();
		expect(disposals).toBe(1);
		expect(transfer.commitAfter(() => undefined)).toBe("disposed");
		expect(handoff.prepareTransfer(new FakeScope(), 3).commitAfter(() => undefined)).toBe("disposed");
	});

	it("keeps cleanup reporter failures non-fatal", () => {
		const scope = new FakeScope();
		const handoff = new RetainedRenderScopeHandoff(
			{
				dispose() {
					throw new Error("resource cleanup failed");
				},
			},
			scope,
			1,
			{
				onCleanupError() {
					throw new Error("reporter failed");
				},
			},
		);

		expect(() => scope.dispose()).not.toThrow();
		expect(handoff.isDisposed).toBe(true);
	});

	it("cleans the resource if initial owner registration throws", () => {
		let disposals = 0;
		const brokenOwner = {
			isDisposed: false,
			registerDisposer() {
				throw new Error("registration failed");
			},
		};

		expect(() => new RetainedRenderScopeHandoff(
			disposable(() => disposals++),
			brokenOwner,
			1,
		)).toThrow("registration failed");
		expect(disposals).toBe(1);
	});

	it("does not release current ownership when candidate registration throws", () => {
		const first = new FakeScope();
		let disposals = 0;
		const handoff = new RetainedRenderScopeHandoff(
			disposable(() => disposals++),
			first,
			1,
		);
		const brokenOwner = {
			isDisposed: false,
			registerDisposer() {
				throw new Error("candidate registration failed");
			},
		};

		expect(() => handoff.prepareTransfer(brokenOwner, 2))
			.toThrow("candidate registration failed");
		expect(disposals).toBe(0);
		expect(handoff.currentGeneration).toBe(1);
		first.dispose();
		expect(disposals).toBe(1);
	});

	it("keeps multiple owner handoffs independent", () => {
		const firstA = new FakeScope();
		const firstB = new FakeScope();
		const nextA = new FakeScope();
		let disposalsA = 0;
		let disposalsB = 0;
		const ownerA = new RetainedRenderScopeHandoff(
			disposable(() => disposalsA++),
			firstA,
			1,
		);
		new RetainedRenderScopeHandoff(
			disposable(() => disposalsB++),
			firstB,
			1,
		);

		expect(ownerA.prepareTransfer(nextA, 2).commitAfter(() => undefined)).toBe("transferred");
		firstA.dispose();
		firstB.dispose();
		expect(disposalsA).toBe(0);
		expect(disposalsB).toBe(1);
		nextA.dispose();
		expect(disposalsA).toBe(1);
	});
});
