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

describe("RetainedLeafOwnerRegistry replacement reentrancy", () => {
	it("blocks same-owner replacement reentry from previous coordinator cleanup", () => {
		const ownerDocument = createOwnerDocument();
		const owner = {};
		const firstRoot = createRoot(ownerDocument);
		const secondRoot = createRoot(ownerDocument);
		const registry = new RetainedLeafOwnerRegistry<typeof owner>();
		const first = registry.getOrCreate(owner, firstRoot);
		const originalDispose = first.dispose.bind(first);
		const nested = { coordinator: null as RetainedLeafGenerationCoordinator<unknown> | null };
		let nestedFailure: unknown;

		vi.spyOn(first, "dispose").mockImplementation(() => {
			try {
				nested.coordinator = registry.getOrCreate(owner, secondRoot);
			} catch (error) {
				nestedFailure = error;
			}
			originalDispose();
		});

		const replacement = registry.getOrCreate(owner, secondRoot);

		expectRegistryError(nestedFailure, "reentrant-create");
		expect(nested.coordinator).toBeNull();
		expect(first.isDisposed).toBe(true);
		expect(replacement.isDisposed).toBe(false);
		expect(registry.get(owner)).toBe(replacement);
		expect(registry.rootFor(owner)).toBe(secondRoot);
		expect(registry.size).toBe(1);
	});

	it("reserves the replacement root against cross-owner cleanup reentry", () => {
		const ownerDocument = createOwnerDocument();
		const firstOwner = {};
		const secondOwner = {};
		const firstRoot = createRoot(ownerDocument);
		const replacementRoot = createRoot(ownerDocument);
		const registry = new RetainedLeafOwnerRegistry<object>();
		const first = registry.getOrCreate(firstOwner, firstRoot);
		const originalDispose = first.dispose.bind(first);
		let nestedFailure: unknown;

		vi.spyOn(first, "dispose").mockImplementation(() => {
			try {
				registry.getOrCreate(secondOwner, replacementRoot);
			} catch (error) {
				nestedFailure = error;
			}
			originalDispose();
		});

		const replacement = registry.getOrCreate(firstOwner, replacementRoot);

		expectRegistryError(nestedFailure, "reentrant-create");
		expect(registry.get(secondOwner)).toBeNull();
		expect(registry.get(firstOwner)).toBe(replacement);
		expect(registry.rootFor(firstOwner)).toBe(replacementRoot);
		expect(registry.size).toBe(1);
	});

	it("honors owner release that occurs while the previous coordinator is disposed", () => {
		const ownerDocument = createOwnerDocument();
		const owner = {};
		const firstRoot = createRoot(ownerDocument);
		const secondRoot = createRoot(ownerDocument);
		let createCount = 0;
		const registry = new RetainedLeafOwnerRegistry<typeof owner>({
			createCoordinator(root) {
				createCount++;
				return new RetainedLeafGenerationCoordinator(root);
			},
		});
		const first = registry.getOrCreate(owner, firstRoot);
		const originalDispose = first.dispose.bind(first);

		vi.spyOn(first, "dispose").mockImplementation(() => {
			registry.release(owner);
			originalDispose();
		});

		let failure: unknown;
		try {
			registry.getOrCreate(owner, secondRoot);
		} catch (error) {
			failure = error;
		}

		expectRegistryError(failure, "owner-released");
		expect(createCount).toBe(1);
		expect(first.isDisposed).toBe(true);
		expect(registry.get(owner)).toBeNull();
		expect(registry.rootFor(owner)).toBeNull();
		expect(registry.size).toBe(0);
	});
});
