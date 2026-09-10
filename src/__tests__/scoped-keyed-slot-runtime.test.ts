import { describe, expect, it, vi } from "vitest";
import { RetainedScopedKeyedRange } from "../render/scoped-keyed-slot-runtime";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function flushPromises() {
	await Promise.resolve();
	await Promise.resolve();
}

describe("RetainedScopedKeyedRange", () => {
	it("isolates identical compiler slot ids per key and retains them across reorder", () => {
		const root = document.createElement("div");
		const range = new RetainedScopedKeyedRange<string>(root);

		range.reconcile(["a", "b"], ({ key, ownerDocument, slots }) =>
			slots.mount(({ fragment, textSlot }) => {
				const item = ownerDocument.createElement("span");
				item.append(textSlot("label", key.toUpperCase()));
				fragment.append(item);
			}));

		const entryA = range.entry("a");
		const entryB = range.entry("b");
		const nodeA = range.nodesFor("a")[0];
		const nodeB = range.nodesFor("b")[0];
		expect(entryA).toBeDefined();
		expect(entryB).toBeDefined();
		expect(entryA?.slots).not.toBe(entryB?.slots);

		entryA?.slots.patchText("label", "Alpha");
		entryB?.slots.patchText("label", "Beta");
		expect(root.textContent).toBe("AlphaBeta");

		const scopeA = entryA?.slots;
		const scopeB = entryB?.slots;
		range.reconcile(["b", "a"], vi.fn());
		expect(root.textContent).toBe("BetaAlpha");
		expect(range.nodesFor("a")[0]).toBe(nodeA);
		expect(range.nodesFor("b")[0]).toBe(nodeB);
		expect(range.entry("a")?.slots).toBe(scopeA);
		expect(range.entry("b")?.slots).toBe(scopeB);
	});

	it("rejects duplicate slot ids inside one key without mutating stable content", () => {
		const root = document.createElement("div");
		const range = new RetainedScopedKeyedRange<string>(root);
		range.reconcile(["stable"], ({ ownerDocument }) => {
			const node = ownerDocument.createElement("span");
			node.textContent = "Stable";
			return node;
		});
		const previous = Array.from(root.childNodes);

		expect(() => range.reconcile(["stable", "bad"], ({ slots }) =>
			slots.mount(({ fragment, textSlot }) => {
				fragment.append(textSlot("duplicate", "A"));
				fragment.append(textSlot("duplicate", "B"));
			}))).toThrow("Duplicate retained slot id");

		expect(Array.from(root.childNodes)).toEqual(previous);
		expect(root.textContent).toBe("Stable");
		expect(range.keys).toEqual(["stable"]);
	});

	it("rejects a mounted slot structure that the keyed entry does not claim", () => {
		const root = document.createElement("div");
		const range = new RetainedScopedKeyedRange<string>(root);
		range.reconcile(["stable"], ({ ownerDocument }) => {
			const node = ownerDocument.createElement("span");
			node.textContent = "Stable";
			return node;
		});

		expect(() => range.reconcile(["stable", "bad"], ({ ownerDocument, slots }) => {
			slots.mount(({ fragment, textSlot }) => {
				fragment.append(textSlot("label", "Orphan"));
			});
			const unrelated = ownerDocument.createElement("span");
			unrelated.textContent = "Unrelated";
			return unrelated;
		})).toThrow("not owned by its keyed entry");

		expect(root.textContent).toBe("Stable");
		expect(range.keys).toEqual(["stable"]);
	});

	it("rejects slot targets omitted from the mounted structure before keyed commit", () => {
		const root = document.createElement("div");
		const range = new RetainedScopedKeyedRange<string>(root);

		expect(() => range.reconcile(["bad"], ({ ownerDocument, slots }) =>
			slots.mount(({ fragment, textSlot }) => {
				textSlot("orphan", "Orphan");
				fragment.append(ownerDocument.createElement("span"));
			}))).toThrow("not part of its mounted structure");

		expect(root.textContent).toBe("");
		expect(range.keys).toEqual([]);
	});

	it("disposes pending async island work when its keyed entry is removed", async () => {
		const root = document.createElement("div");
		const range = new RetainedScopedKeyedRange<string>(root);
		range.reconcile(["a"], ({ ownerDocument, slots }) =>
			slots.mount(({ fragment, markdownSlot }) => {
				const island = ownerDocument.createElement("div");
				markdownSlot("body", island);
				fragment.append(island);
			}));

		const entry = range.entry("a");
		expect(entry).toBeDefined();
		const gate = deferred();
		const cleanup = vi.fn();
		const pending = entry!.slots.patchMarkdown("body", "v1", async (context) => {
			context.resources.register(cleanup);
			await gate.promise;
			context.container.textContent = "Late";
		});

		range.reconcile([], vi.fn());
		expect(entry?.slots.isDisposed).toBe(true);
		expect(cleanup).toHaveBeenCalledTimes(1);
		expect(root.textContent).toBe("");

		gate.resolve();
		await flushPromises();
		expect((await pending).status).toBe("disposed");
		expect(root.textContent).toBe("");
	});

	it("uses the keyed region ownerDocument for slot staging in pop-out-like documents", () => {
		const popupDocument = document.implementation.createHTMLDocument("Popup");
		const root = popupDocument.createElement("div");
		popupDocument.body.append(root);
		const range = new RetainedScopedKeyedRange<string>(root);

		range.reconcile(["popup"], ({ ownerDocument, slots }) => {
			expect(ownerDocument).toBe(popupDocument);
			expect(slots.ownerDocument).toBe(popupDocument);
			return slots.mount(({ fragment, textSlot }) => {
				fragment.append(textSlot("label", "Popup"));
			});
		});

		expect(range.nodesFor("popup")[0]?.ownerDocument).toBe(popupDocument);
		expect(root.textContent).toBe("Popup");
	});
});
