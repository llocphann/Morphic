import { describe, expect, it, vi } from "vitest";
import { RetainedLeafGenerationCoordinator } from "../render/retained-leaf-generation-coordinator";
import { RetainedLeafOwnerRegistry } from "../render/retained-leaf-owner-registry";
import { RetainedLeafOwnerScopeBridge } from "../render/retained-leaf-owner-scope-bridge";

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

describe("RetainedLeafOwnerScopeBridge release reentry", () => {
	it("blocks same-owner preparation during coordinator cleanup", () => {
		const document = ownerDocument();
		const owner = {};
		const firstRoot = document.createElement("div");
		const nestedRoot = document.createElement("section");
		const firstScope = new FakeScope();
		const nestedScope = new FakeScope();
		let bridge!: RetainedLeafOwnerScopeBridge<typeof owner>;
		let createCount = 0;
		let nestedStatus: string | null = null;

		const registry = new RetainedLeafOwnerRegistry<typeof owner>({
			createCoordinator(root) {
				createCount++;
				const coordinator = new RetainedLeafGenerationCoordinator(root);
				if (createCount === 1) {
					const originalDispose = coordinator.dispose.bind(coordinator);
					vi.spyOn(coordinator, "dispose").mockImplementation(() => {
						nestedStatus = bridge.prepare(owner, nestedRoot, nestedScope, 2).status;
						originalDispose();
					});
				}
				return coordinator;
			},
		});
		bridge = new RetainedLeafOwnerScopeBridge(registry);

		const first = bridge.prepare(owner, firstRoot, firstScope, 1);
		expect(first.status).toBe("prepared");
		if (first.status !== "prepared") throw new Error("Expected first retained owner scope");
		expect(first.commitAfter(() => undefined)).toBe("transferred");

		bridge.release(owner);

		expect(nestedStatus).toBe("stale");
		expect(createCount).toBe(1);
		expect(bridge.size).toBe(0);
		expect(registry.size).toBe(0);
		expect(registry.get(owner)).toBeNull();
	});

	it("allows a fresh owner generation after explicit release returns", () => {
		const document = ownerDocument();
		const owner = {};
		const registry = new RetainedLeafOwnerRegistry<typeof owner>();
		const bridge = new RetainedLeafOwnerScopeBridge(registry);
		const firstScope = new FakeScope();
		const nextScope = new FakeScope();
		const first = bridge.prepare(owner, document.createElement("div"), firstScope, 1);
		expect(first.status).toBe("prepared");
		if (first.status !== "prepared") throw new Error("Expected first retained owner scope");
		expect(first.commitAfter(() => undefined)).toBe("transferred");

		bridge.release(owner);

		const next = bridge.prepare(owner, document.createElement("section"), nextScope, 2);
		expect(next.status).toBe("prepared");
		if (next.status !== "prepared") throw new Error("Expected replacement retained owner scope");
		expect(next.commitAfter(() => undefined)).toBe("transferred");
		expect(bridge.size).toBe(1);
		expect(registry.size).toBe(1);

		nextScope.dispose();
		expect(bridge.size).toBe(0);
		expect(registry.size).toBe(0);
	});
});
