import { describe, expect, it } from "vitest";
import { RetainedStaticOwnerSurfaceRegistry } from "../render/retained-static-owner-surface";

describe("RetainedStaticOwnerSurfaceRegistry transactional replacement", () => {
	it("keeps the committed surface alive until a cross-document candidate is adopted", () => {
		const registry = new RetainedStaticOwnerSurfaceRegistry<object>("obsidian-custom-view-render");
		const owner = {};
		const firstContainer = document.createElement("div");
		document.body.appendChild(firstContainer);

		const first = registry.prepare(owner, firstContainer);
		firstContainer.appendChild(first.surface.root);
		expect(first.commit()).toBe(true);
		const committedRoot = first.surface.root;
		expect(committedRoot.parentElement).toBe(firstContainer);

		const otherDocument = document.implementation.createHTMLDocument("popout");
		const secondContainer = otherDocument.createElement("div");
		otherDocument.body.appendChild(secondContainer);
		const pending = registry.prepare(owner, secondContainer);

		expect(pending.surface.root.ownerDocument).toBe(otherDocument);
		expect(pending.surface.root).not.toBe(committedRoot);
		expect(committedRoot.parentElement).toBe(firstContainer);

		pending.dispose();
		expect(committedRoot.parentElement).toBe(firstContainer);

		const replacement = registry.prepare(owner, secondContainer);
		secondContainer.appendChild(replacement.surface.root);
		expect(committedRoot.parentElement).toBe(firstContainer);
		expect(replacement.commit()).toBe(true);
		expect(committedRoot.parentElement).toBeNull();
		expect(replacement.surface.root.parentElement).toBe(secondContainer);

		registry.release(owner);
		expect(replacement.surface.root.parentElement).toBeNull();
		firstContainer.remove();
	});

	it("reuses one committed surface across same-document containers without moving it during prepare", () => {
		const registry = new RetainedStaticOwnerSurfaceRegistry<object>("obsidian-custom-view-render");
		const owner = {};
		const firstContainer = document.createElement("div");
		const secondContainer = document.createElement("div");
		const first = registry.prepare(owner, firstContainer);
		firstContainer.appendChild(first.surface.root);
		expect(first.commit()).toBe(true);

		const pending = registry.prepare(owner, secondContainer);
		expect(pending.surface).toBe(first.surface);
		expect(first.surface.root.parentElement).toBe(firstContainer);
		expect(pending.isCurrent()).toBe(true);

		secondContainer.appendChild(pending.surface.root);
		expect(pending.commit()).toBe(true);
		expect(first.surface.root.parentElement).toBe(secondContainer);
		registry.dispose();
	});
});
