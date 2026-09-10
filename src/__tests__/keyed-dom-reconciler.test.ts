import { describe, expect, it, vi } from "vitest";
import { RetainedKeyedRange } from "../render/keyed-dom-reconciler";

function textElement(ownerDocument: Document, text: string): HTMLElement {
	const element = ownerDocument.createElement("span");
	element.textContent = text;
	return element;
}

describe("RetainedKeyedRange", () => {
	it("retains unchanged keyed ranges without rebuilding", () => {
		const root = document.createElement("div");
		const range = new RetainedKeyedRange<string>(root);
		const create = vi.fn(({ ownerDocument, key }: { ownerDocument: Document; key: string }) =>
			textElement(ownerDocument, key.toUpperCase()));

		const first = range.reconcile(["a", "b"], create);
		const aNode = range.nodesFor("a")[0];
		const bNode = range.nodesFor("b")[0];
		expect(first.status).toBe("patched");
		expect(root.textContent).toBe("AB");
		expect(create).toHaveBeenCalledTimes(2);

		const secondCreate = vi.fn();
		const second = range.reconcile(["a", "b"], secondCreate);
		expect(second.status).toBe("unchanged");
		expect(secondCreate).not.toHaveBeenCalled();
		expect(range.nodesFor("a")[0]).toBe(aNode);
		expect(range.nodesFor("b")[0]).toBe(bNode);
	});

	it("preserves static siblings outside a region placed before an existing child", () => {
		const root = document.createElement("div");
		const prefix = textElement(document, "Prefix|");
		const suffix = textElement(document, "|Suffix");
		root.append(prefix, suffix);
		const range = new RetainedKeyedRange<string>(root, { before: suffix, label: "loop" });

		range.reconcile(["a", "b"], ({ ownerDocument, key }) => textElement(ownerDocument, key.toUpperCase()));
		expect(root.textContent).toBe("Prefix|AB|Suffix");
		expect(root.firstElementChild).toBe(prefix);
		expect(root.lastElementChild).toBe(suffix);
		const aNode = range.nodesFor("a")[0];

		range.reconcile(["b", "a"], vi.fn());
		expect(root.textContent).toBe("Prefix|BA|Suffix");
		expect(root.firstElementChild).toBe(prefix);
		expect(root.lastElementChild).toBe(suffix);
		expect(range.nodesFor("a")[0]).toBe(aNode);
	});

	it("rejects a region insertion point from another parent before mutating either parent", () => {
		const root = document.createElement("div");
		const other = document.createElement("div");
		const before = document.createElement("span");
		other.appendChild(before);

		expect(() => new RetainedKeyedRange(root, { before })).toThrow("not a child");
		expect(root.childNodes).toHaveLength(0);
		expect(other.firstChild).toBe(before);
	});

	it("reorders existing ranges by identity without recreating content", () => {
		const root = document.createElement("div");
		const range = new RetainedKeyedRange<string>(root);
		range.reconcile(["a", "b", "c"], ({ ownerDocument, key }) =>
			textElement(ownerDocument, key.toUpperCase()));
		const aNode = range.nodesFor("a")[0];
		const bNode = range.nodesFor("b")[0];
		const cNode = range.nodesFor("c")[0];

		const create = vi.fn();
		const result = range.reconcile(["c", "a", "b"], create);
		expect(result.status).toBe("patched");
		expect(create).not.toHaveBeenCalled();
		expect(root.textContent).toBe("CAB");
		expect(range.nodesFor("a")[0]).toBe(aNode);
		expect(range.nodesFor("b")[0]).toBe(bNode);
		expect(range.nodesFor("c")[0]).toBe(cNode);
	});

	it("creates only inserted keys and disposes removed-key resources after commit", () => {
		const root = document.createElement("div");
		const range = new RetainedKeyedRange<string>(root);
		range.reconcile(["a", "b"], ({ ownerDocument, key }) => textElement(ownerDocument, key));
		const bNode = range.nodesFor("b")[0];
		const cleanupA = vi.fn();
		range.entry("a")?.resources.register(cleanupA);

		const create = vi.fn(({ ownerDocument, key }: { ownerDocument: Document; key: string }) =>
			textElement(ownerDocument, key));
		const result = range.reconcile(["b", "c"], create);

		expect(result.createdKeys).toEqual(["c"]);
		expect(result.removedKeys).toEqual(["a"]);
		expect(create).toHaveBeenCalledTimes(1);
		expect(root.textContent).toBe("bc");
		expect(range.nodesFor("b")[0]).toBe(bNode);
		expect(cleanupA).toHaveBeenCalledTimes(1);
	});

	it("rejects duplicate keys before creating or mutating anything", () => {
		const root = document.createElement("div");
		const range = new RetainedKeyedRange<string>(root);
		range.reconcile(["stable"], ({ ownerDocument }) => textElement(ownerDocument, "Stable"));
		const previous = Array.from(root.childNodes);
		const create = vi.fn();

		expect(() => range.reconcile(["x", "x"], create)).toThrow("Duplicate retained key");
		expect(create).not.toHaveBeenCalled();
		expect(Array.from(root.childNodes)).toEqual(previous);
		expect(root.textContent).toBe("Stable");
		expect(range.keys).toEqual(["stable"]);
	});

	it("rejects one staged node reused by different new keys and cleans both scopes", () => {
		const root = document.createElement("div");
		const range = new RetainedKeyedRange<string>(root);
		const shared = document.createElement("span");
		const cleanupX = vi.fn();
		const cleanupY = vi.fn();

		expect(() => range.reconcile(["x", "y"], ({ key, resources }) => {
			resources.register(key === "x" ? cleanupX : cleanupY);
			return shared;
		})).toThrow("same staged node");
		expect(root.textContent).toBe("");
		expect(range.keys).toEqual([]);
		expect(cleanupX).toHaveBeenCalledTimes(1);
		expect(cleanupY).toHaveBeenCalledTimes(1);
		expect(shared.parentNode).toBeNull();
	});

	it("preserves the live region and cleans staged resources when creation fails", () => {
		const root = document.createElement("div");
		const range = new RetainedKeyedRange<string>(root);
		range.reconcile(["stable"], ({ ownerDocument }) => textElement(ownerDocument, "Stable"));
		const previous = Array.from(root.childNodes);
		const cleanupX = vi.fn();
		const cleanupY = vi.fn();

		expect(() => range.reconcile(["stable", "x", "y"], ({ ownerDocument, key, resources }) => {
			if (key === "x") {
				resources.register(cleanupX);
				return textElement(ownerDocument, "X");
			}
			resources.register(cleanupY);
			throw new Error("Create failed");
		})).toThrow("Create failed");

		expect(Array.from(root.childNodes)).toEqual(previous);
		expect(root.textContent).toBe("Stable");
		expect(range.keys).toEqual(["stable"]);
		expect(cleanupX).toHaveBeenCalledTimes(1);
		expect(cleanupY).toHaveBeenCalledTimes(1);
	});

	it("rejects foreign-document and already-attached new nodes without disturbing live content", () => {
		const root = document.createElement("div");
		const range = new RetainedKeyedRange<string>(root);
		range.reconcile(["stable"], ({ ownerDocument }) => textElement(ownerDocument, "Stable"));
		const foreignDocument = document.implementation.createHTMLDocument("Foreign");

		expect(() => range.reconcile(["stable", "foreign"], () =>
			foreignDocument.createElement("span"))).toThrow("different document");
		expect(root.textContent).toBe("Stable");
		expect(range.keys).toEqual(["stable"]);

		const attached = document.createElement("span");
		document.body.appendChild(attached);
		expect(() => range.reconcile(["stable", "attached"], () => attached)).toThrow("must be detached");
		expect(attached.parentNode).toBe(document.body);
		expect(root.textContent).toBe("Stable");
		attached.remove();
	});

	it("moves nodes added later inside an existing keyed range together with that key", () => {
		const root = document.createElement("div");
		const range = new RetainedKeyedRange<string>(root);
		range.reconcile(["a", "b"], ({ ownerDocument, key }) =>
			textElement(ownerDocument, key.toUpperCase()));
		const entryA = range.entry("a");
		expect(entryA).toBeDefined();
		const extra = root.ownerDocument.createTextNode("!");
		root.insertBefore(extra, entryA!.end);

		range.reconcile(["b", "a"], vi.fn());
		expect(root.textContent).toBe("BA!");
		expect(range.nodesFor("a")).toContain(extra);
	});

	it("rolls back original region identity and cleans staged resources if commit mutation throws", () => {
		const root = document.createElement("div");
		const range = new RetainedKeyedRange<string>(root);
		range.reconcile(["a", "b"], ({ ownerDocument, key }) => textElement(ownerDocument, key.toUpperCase()));
		const originalChildren = Array.from(root.childNodes);
		const originalA = range.nodesFor("a")[0];
		const originalB = range.nodesFor("b")[0];
		const stagedCleanup = vi.fn();
		const commitError = new Error("Commit mutation failed");
		const originalInsertBefore = root.insertBefore;
		let insertCalls = 0;

		root.insertBefore = function<T extends Node>(newNode: T, referenceNode: Node | null): T {
			insertCalls += 1;
			if (insertCalls === 2) throw commitError;
			return originalInsertBefore.call(this, newNode, referenceNode) as T;
		};
		try {
			expect(() => range.reconcile(["b", "c", "a"], ({ ownerDocument, key, resources }) => {
				resources.register(stagedCleanup);
				return textElement(ownerDocument, key.toUpperCase());
			})).toThrow(commitError);
		} finally {
			root.insertBefore = originalInsertBefore;
		}

		expect(Array.from(root.childNodes)).toEqual(originalChildren);
		expect(root.textContent).toBe("AB");
		expect(range.keys).toEqual(["a", "b"]);
		expect(range.nodesFor("a")[0]).toBe(originalA);
		expect(range.nodesFor("b")[0]).toBe(originalB);
		expect(stagedCleanup).toHaveBeenCalledTimes(1);
	});

	it("uses the region ownerDocument for pop-out-safe anchors and created content", () => {
		const popupDocument = document.implementation.createHTMLDocument("Popup");
		const root = popupDocument.createElement("div");
		popupDocument.body.appendChild(root);
		const range = new RetainedKeyedRange<string>(root);

		range.reconcile(["popup"], ({ ownerDocument }) => {
			expect(ownerDocument).toBe(popupDocument);
			return textElement(ownerDocument, "Popup");
		});

		const entry = range.entry("popup");
		expect(entry?.start.ownerDocument).toBe(popupDocument);
		expect(entry?.end.ownerDocument).toBe(popupDocument);
		expect(range.nodesFor("popup")[0]?.ownerDocument).toBe(popupDocument);
	});

	it("disposes keyed resources exactly once without clearing owner-controlled DOM", () => {
		const root = document.createElement("div");
		const range = new RetainedKeyedRange<string>(root);
		range.reconcile(["a"], ({ ownerDocument }) => textElement(ownerDocument, "A"));
		const cleanup = vi.fn();
		range.entry("a")?.resources.register(cleanup);

		range.dispose();
		range.dispose();
		expect(cleanup).toHaveBeenCalledTimes(1);
		expect(root.textContent).toBe("A");
		expect(range.size).toBe(0);
		expect(range.reconcile(["b"], vi.fn()).status).toBe("disposed");
	});
});
