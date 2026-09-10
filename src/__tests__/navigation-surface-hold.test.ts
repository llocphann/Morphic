import { afterEach, describe, expect, it } from "vitest";
import { NavigationSurfaceHold } from "../render/navigation-surface-hold";

const CUSTOM_VIEW_CLASS = "obsidian-custom-view-render";

afterEach(() => {
	document.body.replaceChildren();
});

function setup() {
	const parent = document.createElement("div");
	const container = document.createElement("div");
	container.setAttribute("data-cv-id", "cv-test");
	const overlay = document.createElement("div");
	overlay.className = CUSTOM_VIEW_CLASS;
	const content = document.createElement("div");
	content.className = "content";
	content.textContent = "Old view";
	const script = document.createElement("script");
	overlay.append(content, script);
	container.appendChild(overlay);
	parent.appendChild(container);
	document.body.appendChild(parent);
	return { parent, container, overlay };
}

describe("NavigationSurfaceHold", () => {
	it("keeps a static inert copy when the live custom surface is restored", () => {
		const { parent, container, overlay } = setup();
		const hold = new NavigationSurfaceHold(CUSTOM_VIEW_CLASS);

		expect(hold.hold(container)).toBe(true);
		overlay.remove();

		const snapshot = parent.querySelector<HTMLElement>(".morphic-navigation-hold");
		expect(snapshot).not.toBeNull();
		expect(snapshot?.textContent).toContain("Old view");
		expect(snapshot?.querySelector("script")).toBeNull();
		expect(snapshot?.inert).toBe(true);
		expect(container.inert).toBe(true);
		expect(hold.has(container)).toBe(true);
	});

	it("restores the container inert state and removes the snapshot on release", () => {
		const { parent, container } = setup();
		container.inert = false;
		const hold = new NavigationSurfaceHold(CUSTOM_VIEW_CLASS);

		hold.hold(container);
		hold.release(container);

		expect(parent.querySelector(".morphic-navigation-hold")).toBeNull();
		expect(container.inert).toBe(false);
		expect(container.classList.contains("morphic-navigation-preparing")).toBe(false);
	});

	it("does nothing when there is no committed custom surface", () => {
		const container = document.createElement("div");
		document.body.appendChild(container);
		const hold = new NavigationSurfaceHold(CUSTOM_VIEW_CLASS);

		expect(hold.hold(container)).toBe(false);
		expect(hold.has(container)).toBe(false);
	});

	it("does not stack duplicate holds for the same owner", () => {
		const { parent, container } = setup();
		const hold = new NavigationSurfaceHold(CUSTOM_VIEW_CLASS);

		expect(hold.hold(container)).toBe(true);
		expect(hold.hold(container)).toBe(true);
		expect(parent.querySelectorAll(".morphic-navigation-hold")).toHaveLength(1);
	});
});
