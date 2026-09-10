import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectedEditableHost } from "../render/connected-editable-host";

function createFixture() {
	const doc = window.document;
	const root = doc.createElement("div");
	const origin = doc.createElement("section");
	const chrome = doc.createElement("section");
	const before = doc.createElement("span");
	const editor = doc.createElement("div");
	const after = doc.createElement("span");
	const target = doc.createElement("div");
	before.dataset.name = "before";
	editor.dataset.name = "editor";
	after.dataset.name = "after";
	target.dataset.name = "target";
	origin.append(before, editor, after);
	chrome.appendChild(target);
	root.append(origin, chrome);
	doc.body.appendChild(root);
	return { doc, root, origin, chrome, before, editor, after, target };
}

afterEach(() => {
	window.document.body.replaceChildren();
	vi.restoreAllMocks();
});

describe("ConnectedEditableHost", () => {
	it("moves one live editor into a connected target and activates once", () => {
		const { editor, target } = createFixture();
		const activate = vi.fn();
		const measure = vi.fn();
		const host = new ConnectedEditableHost(editor, { activate, requestMeasure: measure });

		expect(host.attach(target).status).toBe("attached");
		expect(editor.parentElement).toBe(target);
		expect(editor.isConnected).toBe(true);
		expect(host.attachedTarget).toBe(target);
		expect(host.isActive).toBe(true);
		expect(activate).toHaveBeenCalledTimes(1);
		expect(measure).toHaveBeenCalledTimes(1);
	});

	it("deduplicates attachment to the same target", () => {
		const { editor, target } = createFixture();
		const activate = vi.fn();
		const measure = vi.fn();
		const host = new ConnectedEditableHost(editor, { activate, requestMeasure: measure });

		expect(host.attach(target).status).toBe("attached");
		expect(host.attach(target).status).toBe("unchanged");
		expect(activate).toHaveBeenCalledTimes(1);
		expect(measure).toHaveBeenCalledTimes(1);
	});

	it("refuses a detached direct target before moving the editor", () => {
		const { doc, origin, editor } = createFixture();
		const detached = doc.createElement("div");
		const activate = vi.fn();
		const host = new ConnectedEditableHost(editor, { activate });

		const result = host.attach(detached);
		expect(result.status).toBe("failed");
		expect(editor.parentElement).toBe(origin);
		expect(editor.isConnected).toBe(true);
		expect(activate).not.toHaveBeenCalled();
	});

	it("rejects foreign-document targets before lifecycle mutation", () => {
		const { origin, editor } = createFixture();
		const foreignDocument = new DOMParser().parseFromString(
			"<!doctype html><html><body><div id=target></div></body></html>",
			"text/html",
		);
		const foreignTarget = foreignDocument.querySelector("#target") as HTMLElement;
		const activate = vi.fn();
		const host = new ConnectedEditableHost(editor, { activate });

		const result = host.attach(foreignTarget);
		expect(result.status).toBe("failed");
		expect(editor.parentElement).toBe(origin);
		expect(activate).not.toHaveBeenCalled();
	});

	it("parks the editor at its connected native origin during a structure commit", () => {
		const { doc, origin, chrome, editor, target } = createFixture();
		const host = new ConnectedEditableHost(editor);
		expect(host.attach(target).status).toBe("attached");

		const nextTarget = doc.createElement("div");
		const result = host.placeAfterCommit(nextTarget, () => {
			expect(editor.parentElement).toBe(origin);
			expect(editor.isConnected).toBe(true);
			expect(nextTarget.isConnected).toBe(false);
			chrome.replaceChildren(nextTarget);
		});

		expect(result.status).toBe("attached");
		expect(editor.parentElement).toBe(nextTarget);
		expect(editor.isConnected).toBe(true);
		expect(host.attachedTarget).toBe(nextTarget);
	});

	it("reattaches the last-known-good target when the structure commit throws", () => {
		const { doc, editor, target } = createFixture();
		const host = new ConnectedEditableHost(editor);
		expect(host.attach(target).status).toBe("attached");
		const nextTarget = doc.createElement("div");

		const result = host.placeAfterCommit(nextTarget, () => {
			throw new Error("builder failed");
		});

		expect(result.status).toBe("failed");
		expect(editor.parentElement).toBe(target);
		expect(editor.isConnected).toBe(true);
		expect(host.attachedTarget).toBe(target);
		expect(host.isActive).toBe(true);
	});

	it("keeps the last-known-good target when a commit does not connect the new target", () => {
		const { doc, editor, target } = createFixture();
		const host = new ConnectedEditableHost(editor);
		expect(host.attach(target).status).toBe("attached");
		const nextTarget = doc.createElement("div");

		const result = host.placeAfterCommit(nextTarget, () => undefined);

		expect(result.status).toBe("failed");
		expect(editor.parentElement).toBe(target);
		expect(editor.isConnected).toBe(true);
		expect(host.attachedTarget).toBe(target);
	});

	it("does not run the structure commit when initial editor activation fails", () => {
		const { doc, origin, editor } = createFixture();
		const nextTarget = doc.createElement("div");
		const commit = vi.fn();
		const deactivate = vi.fn();
		const host = new ConnectedEditableHost(editor, {
			activate: () => {
				throw new Error("extension activation failed");
			},
			deactivate,
		});

		const result = host.placeAfterCommit(nextTarget, commit);
		expect(result.status).toBe("failed");
		expect(commit).not.toHaveBeenCalled();
		expect(deactivate).not.toHaveBeenCalled();
		expect(editor.parentElement).toBe(origin);
		expect(host.isActive).toBe(false);
	});

	it("restores the editor at a stable origin anchor after sibling churn", () => {
		const { doc, origin, before, editor, after, target } = createFixture();
		const deactivate = vi.fn();
		const host = new ConnectedEditableHost(editor, { deactivate });
		expect(host.attach(target).status).toBe("attached");

		const inserted = doc.createElement("span");
		origin.insertBefore(inserted, after);
		expect(host.restore().status).toBe("restored");

		expect(Array.from(origin.children)).toEqual([before, editor, inserted, after]);
		expect(deactivate).toHaveBeenCalledTimes(1);
		expect(host.isActive).toBe(false);
		expect(host.attachedTarget).toBeNull();
	});

	it("restores from a target that was externally detached", () => {
		const { origin, editor, target } = createFixture();
		const host = new ConnectedEditableHost(editor);
		expect(host.attach(target).status).toBe("attached");
		target.remove();
		expect(editor.isConnected).toBe(false);

		expect(host.restore().status).toBe("restored");
		expect(editor.parentElement).toBe(origin);
		expect(editor.isConnected).toBe(true);
	});

	it("reports measurement errors without undoing a successful placement", () => {
		const { editor, target } = createFixture();
		const cleanupErrors: unknown[] = [];
		const host = new ConnectedEditableHost(editor, {
			requestMeasure: () => {
				throw new Error("measure failed");
			},
			onCleanupError: (error) => cleanupErrors.push(error),
		});

		expect(host.attach(target).status).toBe("attached");
		expect(editor.parentElement).toBe(target);
		expect(cleanupErrors).toHaveLength(1);
	});

	it("disposes idempotently, restores native placement, and rejects later attachment", () => {
		const { origin, editor, target } = createFixture();
		const deactivate = vi.fn();
		const measure = vi.fn();
		const host = new ConnectedEditableHost(editor, {
			deactivate,
			requestMeasure: measure,
		});
		expect(host.attach(target).status).toBe("attached");

		host.dispose();
		host.dispose();
		expect(editor.parentElement).toBe(origin);
		expect(editor.isConnected).toBe(true);
		expect(deactivate).toHaveBeenCalledTimes(1);
		expect(measure).toHaveBeenCalledTimes(2);
		expect(host.isDisposed).toBe(true);
		expect(host.attach(target).status).toBe("disposed");
	});

	it("still deactivates owned editor extensions when native origin is already gone", () => {
		const { origin, editor, target } = createFixture();
		const deactivate = vi.fn();
		const cleanupErrors: unknown[] = [];
		const host = new ConnectedEditableHost(editor, {
			deactivate,
			onCleanupError: (error) => cleanupErrors.push(error),
		});
		expect(host.attach(target).status).toBe("attached");
		origin.remove();
		expect(editor.isConnected).toBe(true);

		host.dispose();
		expect(host.isDisposed).toBe(true);
		expect(host.isActive).toBe(false);
		expect(editor.parentElement).toBe(target);
		expect(deactivate).toHaveBeenCalledTimes(1);
		expect(cleanupErrors).toHaveLength(1);
	});
});
