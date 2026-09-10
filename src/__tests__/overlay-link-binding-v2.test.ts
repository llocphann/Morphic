import { App, Keymap, Menu } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import {
	OverlayLinkBinding,
	type OverlayLinkActions,
} from "../render/overlay-link-binding";
import {
	createObsidianOverlayLinkBinding,
	type OverlayLinkLifetimeOwner,
} from "../render/obsidian-overlay-link-binding";

function createActions() {
	const openInternalLink = vi.fn<(href: string, sourcePath: string, newLeaf: boolean) => void>();
	const openInternalLinkContextMenu = vi.fn<(
		event: MouseEvent,
		href: string,
		sourcePath: string,
	) => void>();
	const openExternalLinkContextMenu = vi.fn<(event: MouseEvent, href: string) => void>();
	const actions: OverlayLinkActions = {
		isModEvent: () => false,
		openInternalLink,
		openInternalLinkContextMenu,
		openExternalLinkContextMenu,
	};
	return {
		actions,
		openInternalLink,
		openInternalLinkContextMenu,
		openExternalLinkContextMenu,
	};
}

function createInternalLink(ownerDocument: Document, href = "../Child.md"): HTMLAnchorElement {
	const link = ownerDocument.createElement("a");
	link.className = "internal-link";
	link.setAttribute("data-href", href);
	const child = ownerDocument.createElement("span");
	child.textContent = "Child note";
	link.appendChild(child);
	return link;
}

class TestOwner implements OverlayLinkLifetimeOwner {
	private readonly disposers: Array<() => void> = [];

	registerDisposer(disposer: () => void): void {
		this.disposers.push(disposer);
	}

	dispose(): void {
		for (const disposer of this.disposers.splice(0).reverse()) disposer();
	}
}

describe("OverlayLinkBinding current-source contract", () => {
	it("resolves retained-overlay clicks against the latest source path", () => {
		const root = window.document.createElement("div");
		const link = createInternalLink(root.ownerDocument);
		root.appendChild(link);
		const fixture = createActions();
		const binding = new OverlayLinkBinding(root, "Folder/A.md", fixture.actions);

		binding.updateSourcePath("Other/B.md");
		const event = new MouseEvent("click", { bubbles: true, cancelable: true });
		link.firstElementChild?.dispatchEvent(event);

		expect(event.defaultPrevented).toBe(true);
		expect(fixture.openInternalLink).toHaveBeenCalledWith("../Child.md", "Other/B.md", false);
	});

	it("uses the latest source path for internal context menus", () => {
		const root = window.document.createElement("div");
		const link = createInternalLink(root.ownerDocument, "Sibling.md");
		root.appendChild(link);
		const fixture = createActions();
		const binding = new OverlayLinkBinding(root, "A.md", fixture.actions);

		binding.updateSourcePath("Nested/B.md");
		const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
		link.dispatchEvent(event);

		expect(fixture.openInternalLinkContextMenu).toHaveBeenCalledWith(
			event,
			"Sibling.md",
			"Nested/B.md",
		);
	});

	it("keeps external context menus source-independent and preserves raw href", () => {
		const root = window.document.createElement("div");
		const link = root.ownerDocument.createElement("a");
		link.className = "external-link";
		link.setAttribute("href", "https://example.com");
		root.appendChild(link);
		const fixture = createActions();
		const binding = new OverlayLinkBinding(root, "A.md", fixture.actions);

		binding.updateSourcePath("B.md");
		const event = new MouseEvent("contextmenu", { bubbles: true });
		link.dispatchEvent(event);

		expect(fixture.openExternalLinkContextMenu).toHaveBeenCalledWith(event, "https://example.com");
		expect(fixture.openInternalLinkContextMenu).not.toHaveBeenCalled();
	});

	it("preserves editable-surface skip behavior and removes listeners on dispose", () => {
		const root = window.document.createElement("div");
		const editor = root.ownerDocument.createElement("div");
		editor.className = "markdown-source-view";
		const link = createInternalLink(root.ownerDocument);
		editor.appendChild(link);
		root.appendChild(editor);
		const fixture = createActions();
		const binding = new OverlayLinkBinding(root, "A.md", fixture.actions, {
			skipSelector: ".markdown-source-view",
		});

		link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
		expect(fixture.openInternalLink).not.toHaveBeenCalled();

		binding.dispose();
		binding.updateSourcePath("B.md");
		root.appendChild(createInternalLink(root.ownerDocument, "Outside.md"));
		root.lastElementChild?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

		expect(binding.currentSourcePath).toBe("A.md");
		expect(binding.isDisposed).toBe(true);
		expect(fixture.openInternalLink).not.toHaveBeenCalled();
	});

	it("does not depend on the active document for target traversal", () => {
		const ownerDocument = new DOMParser().parseFromString(
			"<!doctype html><html><body></body></html>",
			"text/html",
		);
		const root = ownerDocument.createElement("div");
		const link = createInternalLink(ownerDocument, "Relative.md");
		root.appendChild(link);
		const fixture = createActions();
		const binding = new OverlayLinkBinding(root, "Popup/A.md", fixture.actions);

		binding.updateSourcePath("Popup/B.md");
		link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

		expect(root.ownerDocument).toBe(ownerDocument);
		expect(fixture.openInternalLink).toHaveBeenCalledWith("Relative.md", "Popup/B.md", false);
	});
});

describe("createObsidianOverlayLinkBinding", () => {
	it("adapts Obsidian click semantics and lifecycle ownership", () => {
		const openLinkText = vi.fn();
		const app = { workspace: { openLinkText } } as unknown as App;
		const owner = new TestOwner();
		const root = window.document.createElement("div");
		const link = createInternalLink(root.ownerDocument, "Target.md");
		root.appendChild(link);
		const modSpy = vi.spyOn(Keymap, "isModEvent").mockReturnValue(true);
		try {
			const binding = createObsidianOverlayLinkBinding(root, "A.md", app, owner);
			binding.updateSourcePath("B.md");
			link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

			expect(openLinkText).toHaveBeenCalledWith("Target.md", "B.md", true);

			owner.dispose();
			link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
			expect(binding.isDisposed).toBe(true);
			expect(openLinkText).toHaveBeenCalledTimes(1);
		} finally {
			modSpy.mockRestore();
		}
	});

	it("routes internal and external context menus through Obsidian workspace handlers", () => {
		const handleLinkContextMenu = vi.fn();
		const handleExternalLinkContextMenu = vi.fn();
		const app = {
			workspace: {
				openLinkText: vi.fn(),
				handleLinkContextMenu,
				handleExternalLinkContextMenu,
			},
		} as unknown as App;
		const root = window.document.createElement("div");
		const internal = createInternalLink(root.ownerDocument, "Sibling.md");
		const external = root.ownerDocument.createElement("a");
		external.className = "external-link";
		external.setAttribute("href", "https://example.com");
		root.append(internal, external);
		const menuSpy = vi.spyOn(Menu, "forEvent");
		try {
			const binding = createObsidianOverlayLinkBinding(root, "A.md", app);
			binding.updateSourcePath("Nested/B.md");

			const internalEvent = new MouseEvent("contextmenu", { bubbles: true });
			internal.dispatchEvent(internalEvent);
			const externalEvent = new MouseEvent("contextmenu", { bubbles: true });
			external.dispatchEvent(externalEvent);

			expect(menuSpy).toHaveBeenCalledTimes(2);
			expect(handleLinkContextMenu).toHaveBeenCalledWith(
				expect.any(Menu),
				"Sibling.md",
				"Nested/B.md",
			);
			expect(handleExternalLinkContextMenu).toHaveBeenCalledWith(
				expect.any(Menu),
				"https://example.com",
			);
		} finally {
			menuSpy.mockRestore();
		}
	});

	it("disposes listeners if lifecycle registration fails", () => {
		const openLinkText = vi.fn();
		const app = { workspace: { openLinkText } } as unknown as App;
		const root = window.document.createElement("div");
		const link = createInternalLink(root.ownerDocument, "Target.md");
		root.appendChild(link);
		const owner: OverlayLinkLifetimeOwner = {
			registerDisposer: () => {
				throw new Error("owner registration failed");
			},
		};

		expect(() => createObsidianOverlayLinkBinding(root, "A.md", app, owner)).toThrow(
			"owner registration failed",
		);
		link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
		expect(openLinkText).not.toHaveBeenCalled();
	});
});
