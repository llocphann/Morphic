import { describe, expect, it, vi } from "vitest";
import { RetainedLeafGenerationCoordinator } from "../render/retained-leaf-generation-coordinator";
import {
	RetainedLeafOwnerRegistry,
	RetainedLeafOwnerRegistryError,
} from "../render/retained-leaf-owner-registry";

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

function expectRegistryError(error: unknown, code: RetainedLeafOwnerRegistryError["code"]): void {
	expect(error).toBeInstanceOf(RetainedLeafOwnerRegistryError);
	expect((error as RetainedLeafOwnerRegistryError).code).toBe(code);
}

describe("RetainedLeafOwnerRegistry", () => {
	it("reuses the exact coordinator for the same owner and root", () => {
		const ownerDocument = createOwnerDocument();
		const owner = {};
		const root = createRoot(ownerDocument);
		const registry = new RetainedLeafOwnerRegistry<typeof owner>();

		const first = registry.getOrCreate(owner, root);
		const second = registry.getOrCreate(owner, root);

		expect(second).toBe(first);
		expect(registry.get(owner)).toBe(first);
		expect(registry.rootFor(owner)).toBe(root);
		expect(registry.size).toBe(1);
	});

	it("keeps different owners isolated", () => {
		const ownerDocument = createOwnerDocument();
		const firstOwner = {};
		const secondOwner = {};
		const firstRoot = createRoot(ownerDocument);
		const secondRoot = createRoot(ownerDocument);
		const registry = new RetainedLeafOwnerRegistry<object>();

		const first = registry.getOrCreate(firstOwner, firstRoot);
		const second = registry.getOrCreate(secondOwner, secondRoot);

		expect(first).not.toBe(second);
		expect([...registry.owners()]).toEqual([firstOwner, secondOwner]);
		expect(registry.size).toBe(2);
	});

	it("rejects one live root being claimed by two owners", () => {
		const ownerDocument = createOwnerDocument();
		const firstOwner = {};
		const secondOwner = {};
		const root = createRoot(ownerDocument);
		const registry = new RetainedLeafOwnerRegistry<object>();
		const first = registry.getOrCreate(firstOwner, root);

		let failure: unknown;
		try {
			registry.getOrCreate(secondOwner, root);
		} catch (error) {
			failure = error;
		}

		expectRegistryError(failure, "root-owned");
		expect(registry.get(firstOwner)).toBe(first);
		expect(registry.get(secondOwner)).toBeNull();
	});

	it("disposes the previous coordinator before replacing an owner's root", () => {
		const ownerDocument = createOwnerDocument();
		const owner = {};
		const firstRoot = createRoot(ownerDocument);
		const secondRoot = createRoot(ownerDocument);
		const events: string[] = [];
		let firstCoordinator: RetainedLeafGenerationCoordinator<unknown> | null = null;
		const registry = new RetainedLeafOwnerRegistry<typeof owner>({
			createCoordinator(root) {
				events.push(root === firstRoot ? "create-first" : "create-second");
				const coordinator = new RetainedLeafGenerationCoordinator(root);
				if (root === firstRoot) {
					firstCoordinator = coordinator;
					vi.spyOn(coordinator, "dispose").mockImplementation(() => {
						events.push("dispose-first");
					});
				}
				return coordinator;
			},
		});

		registry.getOrCreate(owner, firstRoot);
		const second = registry.getOrCreate(owner, secondRoot);

		expect(firstCoordinator).not.toBeNull();
		expect(events).toEqual(["create-first", "dispose-first", "create-second"]);
		expect(registry.get(owner)).toBe(second);
		expect(registry.rootFor(owner)).toBe(secondRoot);
	});

	it("recreates a same-root coordinator that was externally disposed", () => {
		const ownerDocument = createOwnerDocument();
		const owner = {};
		const root = createRoot(ownerDocument);
		const registry = new RetainedLeafOwnerRegistry<typeof owner>();
		const first = registry.getOrCreate(owner, root);
		first.dispose();

		const second = registry.getOrCreate(owner, root);

		expect(second).not.toBe(first);
		expect(second.isDisposed).toBe(false);
		expect(registry.get(owner)).toBe(second);
	});

	it("release removes root ownership and disposes exactly once", () => {
		const ownerDocument = createOwnerDocument();
		const owner = {};
		const root = createRoot(ownerDocument);
		const registry = new RetainedLeafOwnerRegistry<typeof owner>();
		const coordinator = registry.getOrCreate(owner, root);
		const dispose = vi.spyOn(coordinator, "dispose");

		registry.release(owner);
		registry.release(owner);

		expect(dispose).toHaveBeenCalledTimes(1);
		expect(registry.get(owner)).toBeNull();
		expect(registry.rootFor(owner)).toBeNull();
		expect(registry.size).toBe(0);
	});

	it("does not publish a coordinator when its owner is released reentrantly during creation", () => {
		const ownerDocument = createOwnerDocument();
		const owner = {};
		const root = createRoot(ownerDocument);
		const created: RetainedLeafGenerationCoordinator<unknown>[] = [];
		let registry!: RetainedLeafOwnerRegistry<typeof owner>;
		registry = new RetainedLeafOwnerRegistry({
			createCoordinator(nextRoot) {
				const coordinator = new RetainedLeafGenerationCoordinator(nextRoot);
				created.push(coordinator);
				registry.release(owner);
				return coordinator;
			},
		});

		let failure: unknown;
		try {
			registry.getOrCreate(owner, root);
		} catch (error) {
			failure = error;
		}

		expectRegistryError(failure, "owner-released");
		expect(created[0]?.isDisposed).toBe(true);
		expect(registry.size).toBe(0);
	});

	it("blocks reentrant coordinator creation for the same owner", () => {
		const ownerDocument = createOwnerDocument();
		const owner = {};
		const firstRoot = createRoot(ownerDocument);
		const secondRoot = createRoot(ownerDocument);
		let registry!: RetainedLeafOwnerRegistry<typeof owner>;
		registry = new RetainedLeafOwnerRegistry({
			createCoordinator(root) {
				registry.getOrCreate(owner, secondRoot);
				return new RetainedLeafGenerationCoordinator(root);
			},
		});

		let failure: unknown;
		try {
			registry.getOrCreate(owner, firstRoot);
		} catch (error) {
			failure = error;
		}

		expectRegistryError(failure, "reentrant-create");
		expect(registry.size).toBe(0);
	});

	it("rejects a factory that returns an already disposed coordinator", () => {
		const ownerDocument = createOwnerDocument();
		const owner = {};
		const root = createRoot(ownerDocument);
		const registry = new RetainedLeafOwnerRegistry<typeof owner>({
			createCoordinator(nextRoot) {
				const coordinator = new RetainedLeafGenerationCoordinator(nextRoot);
				coordinator.dispose();
				return coordinator;
			},
		});

		let failure: unknown;
		try {
			registry.getOrCreate(owner, root);
		} catch (error) {
			failure = error;
		}

		expectRegistryError(failure, "factory-disposed");
		expect(registry.size).toBe(0);
	});

	it("contains cleanup and reporter failures while disposing every owner", () => {
		const ownerDocument = createOwnerDocument();
		const firstOwner = {};
		const secondOwner = {};
		const reported: unknown[] = [];
		const cleanupFailure = new Error("Coordinator cleanup failed");
		const registry = new RetainedLeafOwnerRegistry<object>({
			onCleanupError(error) {
				reported.push(error);
				throw new Error("Reporter failed");
			},
		});
		const first = registry.getOrCreate(firstOwner, createRoot(ownerDocument));
		const second = registry.getOrCreate(secondOwner, createRoot(ownerDocument));
		vi.spyOn(first, "dispose").mockImplementation(() => {
			throw cleanupFailure;
		});
		const secondDispose = vi.spyOn(second, "dispose");

		registry.dispose();
		registry.dispose();

		expect(secondDispose).toHaveBeenCalledTimes(1);
		expect(reported).toEqual([cleanupFailure]);
		expect(registry.isDisposed).toBe(true);
		expect(registry.size).toBe(0);
	});

	it("disposes a coordinator created while the registry is torn down reentrantly", () => {
		const ownerDocument = createOwnerDocument();
		const owner = {};
		const root = createRoot(ownerDocument);
		const created: RetainedLeafGenerationCoordinator<unknown>[] = [];
		let registry!: RetainedLeafOwnerRegistry<typeof owner>;
		registry = new RetainedLeafOwnerRegistry({
			createCoordinator(nextRoot) {
				const coordinator = new RetainedLeafGenerationCoordinator(nextRoot);
				created.push(coordinator);
				registry.dispose();
				return coordinator;
			},
		});

		let failure: unknown;
		try {
			registry.getOrCreate(owner, root);
		} catch (error) {
			failure = error;
		}

		expectRegistryError(failure, "disposed");
		expect(created[0]?.isDisposed).toBe(true);
		expect(registry.isDisposed).toBe(true);
		expect(registry.size).toBe(0);
	});

	it("rejects new owners after registry disposal", () => {
		const ownerDocument = createOwnerDocument();
		const owner = {};
		const registry = new RetainedLeafOwnerRegistry<typeof owner>();
		registry.dispose();

		let failure: unknown;
		try {
			registry.getOrCreate(owner, createRoot(ownerDocument));
		} catch (error) {
			failure = error;
		}

		expectRegistryError(failure, "disposed");
	});
});
