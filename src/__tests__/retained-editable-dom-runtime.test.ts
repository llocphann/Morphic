import { afterEach, describe, expect, it, vi } from "vitest";
import { RetainedEditableDomRuntime } from "../render/retained-editable-dom-runtime";

function createFixture(ownerDocument: Document = window.document) {
	const shell = ownerDocument.createElement("div");
	const origin = ownerDocument.createElement("section");
	const root = ownerDocument.createElement("section");
	const before = ownerDocument.createElement("span");
	const editor = ownerDocument.createElement("div");
	const after = ownerDocument.createElement("span");
	before.dataset.name = "before";
	editor.dataset.name = "editor";
	after.dataset.name = "after";
	origin.append(before, editor, after);
	shell.append(origin, root);
	ownerDocument.body.appendChild(shell);
	return { ownerDocument, shell, origin, root, before, editor, after };
}

function appendEditableStructure(
	context: Parameters<RetainedEditableDomRuntime["mountStructure"]>[1] extends (value: infer T) => void ? T : never,
	label: string,
) {
	const chrome = context.ownerDocument.createElement("div");
	chrome.dataset.label = label;
	chrome.append(context.editablePlaceholder);
	context.fragment.append(chrome);
}

afterEach(() => {
	window.document.body.replaceChildren();
	vi.restoreAllMocks();
});

describe("RetainedEditableDomRuntime", () => {
	it("mounts retained structure and attaches the exact live editor after commit", () => {
		const { root, editor } = createFixture();
		const activate = vi.fn();
		const measure = vi.fn();
		const runtime = new RetainedEditableDomRuntime(root, editor, {
			editable: { activate, requestMeasure: measure },
		});

		const result = runtime.mountStructure("shape:a", (context) => {
			const chrome = context.ownerDocument.createElement("div");
			const title = context.textSlot("title", "A");
			chrome.append(title, context.editablePlaceholder);
			context.fragment.append(chrome);
		});

		expect(result.status).toBe("mounted");
		expect(runtime.currentStructureKey).toBe("shape:a");
		expect(runtime.editablePlaceholder?.parentElement).toBe(root.firstElementChild);
		expect(editor.parentElement).toBe(runtime.editablePlaceholder);
		expect(editor.isConnected).toBe(true);
		expect(runtime.retained.patchText("title", "B")).toBe("patched");
		expect(root.textContent).toBe("B");
		expect(activate).toHaveBeenCalledTimes(1);
		expect(measure).toHaveBeenCalledTimes(1);
	});

	it("reuses the static tree and placeholder for an unchanged structure key", () => {
		const { root, editor } = createFixture();
		const activate = vi.fn();
		const measure = vi.fn();
		const runtime = new RetainedEditableDomRuntime(root, editor, {
			editable: { activate, requestMeasure: measure },
		});
		expect(runtime.mountStructure("same", (context) => appendEditableStructure(context, "one")).status).toBe("mounted");
		const placeholder = runtime.editablePlaceholder;
		const firstChild = root.firstChild;
		const secondBuilder = vi.fn();

		expect(runtime.mountStructure("same", secondBuilder).status).toBe("reused");
		expect(secondBuilder).not.toHaveBeenCalled();
		expect(runtime.editablePlaceholder).toBe(placeholder);
		expect(root.firstChild).toBe(firstChild);
		expect(editor.parentElement).toBe(placeholder);
		expect(activate).toHaveBeenCalledTimes(1);
		expect(measure).toHaveBeenCalledTimes(1);
	});

	it("parks the live editor at its native origin while a changed structure builds and commits", () => {
		const { origin, root, editor } = createFixture();
		const activate = vi.fn();
		const runtime = new RetainedEditableDomRuntime(root, editor, { editable: { activate } });
		expect(runtime.mountStructure("a", (context) => appendEditableStructure(context, "a")).status).toBe("mounted");
		const oldPlaceholder = runtime.editablePlaceholder;

		const result = runtime.mountStructure("b", (context) => {
			expect(editor.parentElement).toBe(origin);
			expect(editor.isConnected).toBe(true);
			expect(oldPlaceholder?.contains(editor)).toBe(false);
			appendEditableStructure(context, "b");
		});

		expect(result.status).toBe("mounted");
		expect(runtime.currentStructureKey).toBe("b");
		expect(runtime.editablePlaceholder).not.toBe(oldPlaceholder);
		expect(editor.parentElement).toBe(runtime.editablePlaceholder);
		expect(activate).toHaveBeenCalledTimes(1);
	});

	it("preserves the last-known-good retained tree and editor target when the new builder throws", () => {
		const { root, editor } = createFixture();
		const runtime = new RetainedEditableDomRuntime(root, editor);
		expect(runtime.mountStructure("good", (context) => appendEditableStructure(context, "good")).status).toBe("mounted");
		const oldTree = root.firstChild;
		const oldPlaceholder = runtime.editablePlaceholder;

		const result = runtime.mountStructure("bad", () => {
			throw new Error("builder failed");
		});

		expect(result.status).toBe("failed");
		expect(runtime.currentStructureKey).toBe("good");
		expect(root.firstChild).toBe(oldTree);
		expect(runtime.editablePlaceholder).toBe(oldPlaceholder);
		expect(editor.parentElement).toBe(oldPlaceholder);
	});

	it("rejects a staged structure that omits the editable placeholder before live mutation", () => {
		const { root, editor } = createFixture();
		const runtime = new RetainedEditableDomRuntime(root, editor);
		expect(runtime.mountStructure("good", (context) => appendEditableStructure(context, "good")).status).toBe("mounted");
		const oldTree = root.firstChild;
		const oldPlaceholder = runtime.editablePlaceholder;

		const result = runtime.mountStructure("missing", (context) => {
			context.fragment.append(context.ownerDocument.createElement("div"));
		});

		expect(result.status).toBe("failed");
		expect(root.firstChild).toBe(oldTree);
		expect(runtime.currentStructureKey).toBe("good");
		expect(editor.parentElement).toBe(oldPlaceholder);
	});

	it("rejects replace-children islands that contain the editable placeholder", () => {
		const { root, editor } = createFixture();
		const runtime = new RetainedEditableDomRuntime(root, editor);
		expect(runtime.mountStructure("good", (context) => appendEditableStructure(context, "good")).status).toBe("mounted");
		const oldTree = root.firstChild;
		const oldPlaceholder = runtime.editablePlaceholder;

		const result = runtime.mountStructure("unsafe", (context) => {
			const contentIsland = context.ownerDocument.createElement("div");
			context.contentSlot("content", contentIsland);
			contentIsland.append(context.editablePlaceholder);
			context.fragment.append(contentIsland);
		});

		expect(result.status).toBe("failed");
		expect(root.firstChild).toBe(oldTree);
		expect(runtime.currentStructureKey).toBe("good");
		expect(editor.parentElement).toBe(oldPlaceholder);
	});

	it("rejects a detached retained root before activation or builder execution", () => {
		const { root, origin, editor } = createFixture();
		root.remove();
		const activate = vi.fn();
		const builder = vi.fn();
		const runtime = new RetainedEditableDomRuntime(root, editor, { editable: { activate } });

		const result = runtime.mountStructure("a", builder);
		expect(result.status).toBe("failed");
		expect(builder).not.toHaveBeenCalled();
		expect(activate).not.toHaveBeenCalled();
		expect(editor.parentElement).toBe(origin);
	});

	it("rejects a placeholder factory that returns an already-connected element", () => {
		const { ownerDocument, root, origin, editor } = createFixture();
		const connected = ownerDocument.createElement("div");
		ownerDocument.body.appendChild(connected);
		const activate = vi.fn();
		const builder = vi.fn();
		const runtime = new RetainedEditableDomRuntime(root, editor, {
			editable: { activate },
			createPlaceholder: () => connected,
		});

		const result = runtime.mountStructure("a", builder);
		expect(result.status).toBe("failed");
		expect(builder).not.toHaveBeenCalled();
		expect(activate).not.toHaveBeenCalled();
		expect(editor.parentElement).toBe(origin);
	});

	it("can restore the editor natively and reattach it to an unchanged retained structure without rebuilding", () => {
		const { root, origin, editor } = createFixture();
		const activate = vi.fn();
		const deactivate = vi.fn();
		const runtime = new RetainedEditableDomRuntime(root, editor, {
			editable: { activate, deactivate },
		});
		expect(runtime.mountStructure("same", (context) => appendEditableStructure(context, "same")).status).toBe("mounted");
		const placeholder = runtime.editablePlaceholder;

		expect(runtime.restoreEditable().status).toBe("restored");
		expect(editor.parentElement).toBe(origin);
		const builder = vi.fn();
		expect(runtime.mountStructure("same", builder).status).toBe("reused");
		expect(builder).not.toHaveBeenCalled();
		expect(editor.parentElement).toBe(placeholder);
		expect(activate).toHaveBeenCalledTimes(2);
		expect(deactivate).toHaveBeenCalledTimes(1);
	});

	it("restores and deactivates the editor before retained island resources dispose", async () => {
		const { root, origin, editor } = createFixture();
		const events: string[] = [];
		const runtime = new RetainedEditableDomRuntime(root, editor, {
			editable: { deactivate: () => events.push("deactivate") },
		});
		expect(runtime.mountStructure("a", (context) => {
			const chrome = context.ownerDocument.createElement("div");
			const markdown = context.ownerDocument.createElement("div");
			context.markdownSlot("markdown", markdown);
			chrome.append(context.editablePlaceholder, markdown);
			context.fragment.append(chrome);
		}).status).toBe("mounted");

		expect((await runtime.retained.patchMarkdown("markdown", "v1", ({ container, resources }) => {
			resources.register(() => events.push(editor.parentElement === origin ? "cleanup:native" : "cleanup:custom"));
			container.textContent = "Rendered";
		})).status).toBe("patched");

		runtime.dispose();
		expect(events).toEqual(["deactivate", "cleanup:native"]);
		expect(editor.parentElement).toBe(origin);
		expect(runtime.isDisposed).toBe(true);
		expect(runtime.mountStructure("b", vi.fn()).status).toBe("disposed");
	});

	it("rejects overlapping retained-root/live-editor subtrees at construction", () => {
		const ownerDocument = window.document;
		const root = ownerDocument.createElement("div");
		const editor = ownerDocument.createElement("div");
		root.appendChild(editor);
		ownerDocument.body.appendChild(root);

		expect(() => new RetainedEditableDomRuntime(root, editor)).toThrow(/separate DOM subtrees/);
	});

	it("rejects retained root and live editor from different owner documents", () => {
		const { root } = createFixture();
		const foreignDocument = new DOMParser().parseFromString("<!doctype html><html><body></body></html>", "text/html");
		const foreignEditor = foreignDocument.createElement("div");
		foreignDocument.body.appendChild(foreignEditor);

		expect(() => new RetainedEditableDomRuntime(root, foreignEditor)).toThrow(/share an ownerDocument/);
	});

	it("creates and commits the editable placeholder in a foreign/pop-out-like ownerDocument", () => {
		const foreignDocument = new DOMParser().parseFromString("<!doctype html><html><body></body></html>", "text/html");
		const { root, origin, editor } = createFixture(foreignDocument);
		const runtime = new RetainedEditableDomRuntime(root, editor);

		expect(runtime.mountStructure("foreign", (context) => appendEditableStructure(context, "foreign")).status).toBe("mounted");
		expect(runtime.editablePlaceholder?.ownerDocument).toBe(foreignDocument);
		expect(editor.ownerDocument).toBe(foreignDocument);
		expect(editor.parentElement).toBe(runtime.editablePlaceholder);
		runtime.dispose();
		expect(editor.parentElement).toBe(origin);
	});
});
