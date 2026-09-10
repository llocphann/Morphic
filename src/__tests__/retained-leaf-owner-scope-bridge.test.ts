import { describe, expect, it, vi } from "vitest";
import { RetainedLeafOwnerRegistry } from "../render/retained-leaf-owner-registry";
import {
	RetainedLeafOwnerScopeBridge,
	type RetainedLeafOwnerScopePreparationResult,
	type RetainedPreparedLeafOwnerScope,
} from "../render/retained-leaf-owner-scope-bridge";

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

function ownerDocument(): Document {
	return new DOMParser().parseFromString(
		"<!doctype html><html><body></body></html>",
		"text/html",
	);
}

function expectPrepared<E>(
	result: RetainedLeafOwnerScopePreparationResult<E>,
): RetainedPreparedLeafOwnerScope<E> {
	if (result.status !== "prepared") {
		throw new Error(`Expected prepared retained owner scope, received ${result.status}`);
	}
	return result;
}

describe("RetainedLeafOwnerScopeBridge", () => {
	it("binds the first retained owner lease to its render scope", () => {
		const registry = new RetainedLeafOwnerRegistry<object>();
		const bridge = new RetainedLeafOwnerScopeBridge(registry);
		const owner = {};
		const root = ownerDocument().createElement("div");
		const scope = new FakeScope();
		const binding = expectPrepared(bridge.prepare(owner, root, scope, 1));
		const commit = vi.fn();

		expect(binding.isCurrent()).toBe(true);
		expect(binding.commitAfter(commit)).toBe("transferred");
		expect(binding.isCurrent()).toBe(false);
		expect(binding.commitAfter(commit)).toBe("stale");
		expect(commit).toHaveBeenCalledTimes(1);
		expect(registry.get(owner)).toBe(binding.coordinator);
		expect(registry.size).toBe(1);
		expect(bridge.size).toBe(1);

		scope.dispose();
		expect(binding.lease.isReleased).toBe(true);
		expect(binding.coordinator.isDisposed).toBe(true);
		expect(registry.size).toBe(0);
		expect(bridge.size).toBe(0);
	});

	it("transfers the same lease across successful same-root generations", () => {
		const registry = new RetainedLeafOwnerRegistry<object>();
		const bridge = new RetainedLeafOwnerScopeBridge(registry);
		const owner = {};
		const root = ownerDocument().createElement("div");
		const firstScope = new FakeScope();
		const secondScope = new FakeScope();
		const first = expectPrepared(bridge.prepare(owner, root, firstScope, 10));
		expect(first.commitAfter(() => undefined)).toBe("transferred");

		const second = expectPrepared(bridge.prepare(owner, root, secondScope, 11));
		expect(second.lease).toBe(first.lease);
		expect(second.coordinator).toBe(first.coordinator);
		expect(second.commitAfter(() => undefined)).toBe("transferred");

		firstScope.dispose();
		expect(first.lease.isReleased).toBe(false);
		expect(registry.size).toBe(1);
		expect(bridge.size).toBe(1);
		secondScope.dispose();
		expect(first.lease.isReleased).toBe(true);
		expect(registry.size).toBe(0);
		expect(bridge.size).toBe(0);
	});

	it("keeps previous scope ownership when a newer live commit throws", () => {
		const registry = new RetainedLeafOwnerRegistry<object>();
		const bridge = new RetainedLeafOwnerScopeBridge(registry);
		const owner = {};
		const root = ownerDocument().createElement("div");
		const firstScope = new FakeScope();
		const failedScope = new FakeScope();
		const first = expectPrepared(bridge.prepare(owner, root, firstScope, 1));
		expect(first.commitAfter(() => undefined)).toBe("transferred");
		const failed = expectPrepared(bridge.prepare(owner, root, failedScope, 2));

		expect(() => failed.commitAfter(() => {
			throw new Error("Synthetic live commit failure");
		})).toThrow("Synthetic live commit failure");
		failedScope.dispose();
		expect(first.lease.isReleased).toBe(false);
		expect(registry.get(owner)).toBe(first.coordinator);

		firstScope.dispose();
		expect(first.lease.isReleased).toBe(true);
		expect(bridge.size).toBe(0);
	});

	it("makes an older same-root preparation stale when a newer generation starts", () => {
		const registry = new RetainedLeafOwnerRegistry<object>();
		const bridge = new RetainedLeafOwnerScopeBridge(registry);
		const owner = {};
		const root = ownerDocument().createElement("div");
		const firstScope = new FakeScope();
		const secondScope = new FakeScope();
		const thirdScope = new FakeScope();
		const first = expectPrepared(bridge.prepare(owner, root, firstScope, 1));
		expect(first.commitAfter(() => undefined)).toBe("transferred");
		const older = expectPrepared(bridge.prepare(owner, root, secondScope, 2));
		const newer = expectPrepared(bridge.prepare(owner, root, thirdScope, 3));
		const oldCommit = vi.fn();

		expect(older.isCurrent()).toBe(false);
		expect(older.commitAfter(oldCommit)).toBe("stale");
		expect(oldCommit).not.toHaveBeenCalled();
		expect(newer.commitAfter(() => undefined)).toBe("transferred");

		firstScope.dispose();
		secondScope.dispose();
		expect(first.lease.isReleased).toBe(false);
		thirdScope.dispose();
		expect(first.lease.isReleased).toBe(true);
		expect(bridge.size).toBe(0);
	});

	it("keeps a successful generation authoritative when it prepares a newer transfer reentrantly", () => {
		const registry = new RetainedLeafOwnerRegistry<object>();
		const bridge = new RetainedLeafOwnerScopeBridge(registry);
		const owner = {};
		const root = ownerDocument().createElement("div");
		const firstScope = new FakeScope();
		const secondScope = new FakeScope();
		const first = expectPrepared(bridge.prepare(owner, root, firstScope, 1));
		const pending = {
			second: null as RetainedPreparedLeafOwnerScope<unknown> | null,
		};

		expect(first.commitAfter(() => {
			pending.second = expectPrepared(bridge.prepare(owner, root, secondScope, 2));
		})).toBe("transferred");
		if (!pending.second) throw new Error("Expected reentrant retained owner scope preparation");
		expect(pending.second.commitAfter(() => undefined)).toBe("transferred");

		firstScope.dispose();
		expect(first.lease.isReleased).toBe(false);
		secondScope.dispose();
		expect(first.lease.isReleased).toBe(true);
		expect(bridge.size).toBe(0);
	});

	it("rejects an older late generation before it can replace the retained root", () => {
		const registry = new RetainedLeafOwnerRegistry<object>();
		const bridge = new RetainedLeafOwnerScopeBridge(registry);
		const owner = {};
		const doc = ownerDocument();
		const root = doc.createElement("div");
		const staleRoot = doc.createElement("section");
		const firstScope = new FakeScope();
		const newerScope = new FakeScope();
		const first = expectPrepared(bridge.prepare(owner, root, firstScope, 5));
		expect(first.commitAfter(() => undefined)).toBe("transferred");
		expectPrepared(bridge.prepare(owner, root, newerScope, 6));

		const stale = bridge.prepare(owner, staleRoot, new FakeScope(), 5);
		expect(stale).toEqual({ status: "stale", generation: 5 });
		expect(registry.rootFor(owner)).toBe(root);
		expect(registry.get(owner)).toBe(first.coordinator);
	});

	it("invalidates the old lease before a newer root takes ownership", () => {
		const registry = new RetainedLeafOwnerRegistry<object>();
		const bridge = new RetainedLeafOwnerScopeBridge(registry);
		const owner = {};
		const doc = ownerDocument();
		const firstRoot = doc.createElement("div");
		const nextRoot = doc.createElement("section");
		const firstScope = new FakeScope();
		const nextScope = new FakeScope();
		const first = expectPrepared(bridge.prepare(owner, firstRoot, firstScope, 1));
		expect(first.commitAfter(() => undefined)).toBe("transferred");

		const next = expectPrepared(bridge.prepare(owner, nextRoot, nextScope, 2));
		expect(next.lease).not.toBe(first.lease);
		expect(first.lease.isReleased).toBe(true);
		expect(first.coordinator.isDisposed).toBe(true);
		expect(next.lease.isReleased).toBe(false);
		expect(next.commitAfter(() => undefined)).toBe("transferred");

		firstScope.dispose();
		expect(registry.get(owner)).toBe(next.coordinator);
		expect(next.lease.isReleased).toBe(false);
		nextScope.dispose();
		expect(next.lease.isReleased).toBe(true);
		expect(bridge.size).toBe(0);
	});

	it("does not allocate retained ownership for an already disposed pending scope", () => {
		const registry = new RetainedLeafOwnerRegistry<object>();
		const bridge = new RetainedLeafOwnerScopeBridge(registry);
		const owner = {};
		const root = ownerDocument().createElement("div");
		const scope = new FakeScope();
		scope.dispose();

		expect(bridge.prepare(owner, root, scope, 1)).toEqual({
			status: "stale",
			generation: 1,
		});
		expect(registry.size).toBe(0);
		expect(bridge.size).toBe(0);
	});

	it("makes explicit owner release authoritative over late prepared handles", () => {
		const registry = new RetainedLeafOwnerRegistry<object>();
		const bridge = new RetainedLeafOwnerScopeBridge(registry);
		const owner = {};
		const root = ownerDocument().createElement("div");
		const scope = new FakeScope();
		const binding = expectPrepared(bridge.prepare(owner, root, scope, 1));
		const commit = vi.fn();

		bridge.release(owner);
		expect(binding.lease.isReleased).toBe(true);
		expect(binding.coordinator.isDisposed).toBe(true);
		expect(registry.size).toBe(0);
		expect(bridge.size).toBe(0);
		expect(binding.commitAfter(commit)).toBe("disposed");
		expect(commit).not.toHaveBeenCalled();
	});

	it("tears down independent owners without cross-release", () => {
		const registry = new RetainedLeafOwnerRegistry<object>();
		const bridge = new RetainedLeafOwnerScopeBridge(registry);
		const doc = ownerDocument();
		const ownerA = {};
		const ownerB = {};
		const scopeA = new FakeScope();
		const scopeB = new FakeScope();
		const a = expectPrepared(bridge.prepare(ownerA, doc.createElement("div"), scopeA, 1));
		const b = expectPrepared(bridge.prepare(ownerB, doc.createElement("div"), scopeB, 1));
		expect(a.commitAfter(() => undefined)).toBe("transferred");
		expect(b.commitAfter(() => undefined)).toBe("transferred");
		expect(bridge.size).toBe(2);

		bridge.release(ownerA);
		expect(a.lease.isReleased).toBe(true);
		expect(b.lease.isReleased).toBe(false);
		expect(registry.get(ownerB)).toBe(b.coordinator);
		expect(bridge.size).toBe(1);

		bridge.dispose();
		expect(b.lease.isReleased).toBe(true);
		expect(registry.isDisposed).toBe(true);
		expect(bridge.size).toBe(0);
		expect(() => scopeA.dispose()).not.toThrow();
		expect(() => scopeB.dispose()).not.toThrow();
	});

	it("cleans a newly created lease when initial scope registration throws", () => {
		const registry = new RetainedLeafOwnerRegistry<object>();
		const bridge = new RetainedLeafOwnerScopeBridge(registry);
		const owner = {};
		const root = ownerDocument().createElement("div");
		const brokenScope = {
			isDisposed: false,
			registerDisposer() {
				throw new Error("Scope registration failed");
			},
		};

		expect(() => bridge.prepare(owner, root, brokenScope, 1))
			.toThrow("Scope registration failed");
		expect(registry.size).toBe(0);
		expect(bridge.size).toBe(0);
	});

	it("preserves current ownership when a transfer registration throws", () => {
		const registry = new RetainedLeafOwnerRegistry<object>();
		const bridge = new RetainedLeafOwnerScopeBridge(registry);
		const owner = {};
		const root = ownerDocument().createElement("div");
		const firstScope = new FakeScope();
		const laterScope = new FakeScope();
		const first = expectPrepared(bridge.prepare(owner, root, firstScope, 1));
		expect(first.commitAfter(() => undefined)).toBe("transferred");
		const brokenScope = {
			isDisposed: false,
			registerDisposer() {
				throw new Error("Candidate registration failed");
			},
		};

		expect(() => bridge.prepare(owner, root, brokenScope, 2))
			.toThrow("Candidate registration failed");
		expect(first.lease.isReleased).toBe(false);
		expect(registry.get(owner)).toBe(first.coordinator);

		const later = expectPrepared(bridge.prepare(owner, root, laterScope, 3));
		expect(later.commitAfter(() => undefined)).toBe("transferred");
		firstScope.dispose();
		expect(first.lease.isReleased).toBe(false);
		laterScope.dispose();
		expect(first.lease.isReleased).toBe(true);
		expect(bridge.size).toBe(0);
	});
});
