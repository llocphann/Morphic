import { describe, expect, it, vi } from "vitest";
import { RetainedLeafOwnerRegistry } from "../render/retained-leaf-owner-registry";

function createOwnerDocument(): Document {
	return new DOMParser().parseFromString(
		"<!doctype html><html><body></body></html>",
		"text/html",
	);
}

function createRoot(ownerDocument: Document): HTMLElement {
	const root = ownerDocument.createElement("div");
	ownerDocument.body.appendChild(root);
	return root;
}

describe("RetainedLeafOwnerRegistry scope leases", () => {
	it("reuses one lease identity for the current owner and root", () => {
		const ownerDocument = createOwnerDocument();
		const owner = {};
		const root = createRoot(ownerDocument);
		const registry = new RetainedLeafOwnerRegistry<typeof owner>();

		const first = registry.getOrCreateLease(owner, root);
		const second = registry.getOrCreateLease(owner, root);

		expect(second).toBe(first);
		expect(first.root).toBe(root);
		expect(first.coordinator).toBe(registry.get(owner));
		expect(first.isReleased).toBe(false);
	});

	it("releases the exact current entry once when the lease is disposed", () => {
		const ownerDocument = createOwnerDocument();
		const owner = {};
		const registry = new RetainedLeafOwnerRegistry<typeof owner>();
		const lease = registry.getOrCreateLease(owner, createRoot(ownerDocument));
		const dispose = vi.spyOn(lease.coordinator, "dispose");

		lease.dispose();
		lease.dispose();

		expect(lease.isReleased).toBe(true);
		expect(dispose).toHaveBeenCalledTimes(1);
		expect(registry.get(owner)).toBeNull();
		expect(registry.size).toBe(0);
	});

	it("makes an older lease harmless after the owner root is replaced", () => {
		const ownerDocument = createOwnerDocument();
		const owner = {};
		const registry = new RetainedLeafOwnerRegistry<typeof owner>();
		const first = registry.getOrCreateLease(owner, createRoot(ownerDocument));
		const secondRoot = createRoot(ownerDocument);

		const second = registry.getOrCreateLease(owner, secondRoot);
		const secondDispose = vi.spyOn(second.coordinator, "dispose");
		first.dispose();

		expect(first.isReleased).toBe(true);
		expect(second.isReleased).toBe(false);
		expect(secondDispose).not.toHaveBeenCalled();
		expect(registry.get(owner)).toBe(second.coordinator);
		expect(registry.rootFor(owner)).toBe(secondRoot);
	});

	it("invalidates the old lease before replacement teardown can reenter it", () => {
		const ownerDocument = createOwnerDocument();
		const owner = {};
		const firstRoot = createRoot(ownerDocument);
		const secondRoot = createRoot(ownerDocument);
		const registry = new RetainedLeafOwnerRegistry<typeof owner>();
		const first = registry.getOrCreateLease(owner, firstRoot);
		const originalDispose = first.coordinator.dispose.bind(first.coordinator);
		const reentrantReleased: boolean[] = [];

		vi.spyOn(first.coordinator, "dispose").mockImplementation(() => {
			reentrantReleased.push(first.isReleased);
			first.dispose();
			originalDispose();
		});

		const second = registry.getOrCreateLease(owner, secondRoot);

		expect(reentrantReleased).toEqual([true]);
		expect(first.isReleased).toBe(true);
		expect(second.isReleased).toBe(false);
		expect(registry.get(owner)).toBe(second.coordinator);
		expect(registry.rootFor(owner)).toBe(secondRoot);
	});

	it("invalidates a lease when an externally disposed same-root coordinator is recreated", () => {
		const ownerDocument = createOwnerDocument();
		const owner = {};
		const root = createRoot(ownerDocument);
		const registry = new RetainedLeafOwnerRegistry<typeof owner>();
		const first = registry.getOrCreateLease(owner, root);
		first.coordinator.dispose();

		const second = registry.getOrCreateLease(owner, root);
		first.dispose();

		expect(first.isReleased).toBe(true);
		expect(second.isReleased).toBe(false);
		expect(second.coordinator).not.toBe(first.coordinator);
		expect(registry.get(owner)).toBe(second.coordinator);
	});

	it("invalidates every lease before registry teardown disposes coordinators", () => {
		const ownerDocument = createOwnerDocument();
		const registry = new RetainedLeafOwnerRegistry<object>();
		const first = registry.getOrCreateLease({}, createRoot(ownerDocument));
		const second = registry.getOrCreateLease({}, createRoot(ownerDocument));
		const observed: boolean[] = [];
		const firstDispose = first.coordinator.dispose.bind(first.coordinator);
		const secondDispose = second.coordinator.dispose.bind(second.coordinator);
		vi.spyOn(first.coordinator, "dispose").mockImplementation(() => {
			observed.push(first.isReleased);
			firstDispose();
		});
		vi.spyOn(second.coordinator, "dispose").mockImplementation(() => {
			observed.push(second.isReleased);
			secondDispose();
		});

		registry.dispose();
		first.dispose();
		second.dispose();

		expect(observed).toEqual([true, true]);
		expect(first.isReleased).toBe(true);
		expect(second.isReleased).toBe(true);
		expect(registry.size).toBe(0);
	});
});
