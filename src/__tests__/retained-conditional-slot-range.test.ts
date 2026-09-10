import { afterEach, describe, expect, it, vi } from "vitest";
import { RetainedConditionalSlotRange } from "../render/retained-conditional-slot-range";
import type { RetainedStructureContext } from "../render/retained-slot-runtime";

function createFixture(ownerDocument: Document = window.document) {
	const parent = ownerDocument.createElement("section");
	const before = ownerDocument.createElement("span");
	const after = ownerDocument.createElement("span");
	before.dataset.name = "before";
	after.dataset.name = "after";
	parent.append(before, after);
	ownerDocument.body.appendChild(parent);
	return { ownerDocument, parent, before, after };
}

function appendBranch(
	context: RetainedStructureContext,
	name: string,
	initialText = name,
) {
	const root = context.ownerDocument.createElement("div");
	root.dataset.branch = name;
	root.append(context.textSlot("label", initialText));
	context.fragment.append(root);
}

afterEach(() => {
	window.document.body.replaceChildren();
	vi.restoreAllMocks();
});

describe("RetainedConditionalSlotRange", () => {
	it("mounts one branch between anchors without replacing static siblings", () => {
		const { parent, before, after } = createFixture();
		const range = new RetainedConditionalSlotRange<string>(parent, { before: after, label: "if" });

		const result = range.select("if:0", (context) => appendBranch(context, "a", "A"));
		expect(result.status).toBe("patched");
		expect(result.created).toBe(true);
		expect(result.activeKey).toBe("if:0");
		expect(result.slots).toBe(range.activeSlots);
		expect(parent.firstChild).toBe(before);
		expect(parent.lastChild).toBe(after);
		expect(parent.querySelector("[data-branch='a']")?.textContent).toBe("A");

		expect(range.activeSlots?.patchText("label", "B")).toBe("patched");
		expect(parent.querySelector("[data-branch='a']")?.textContent).toBe("B");
	});

	it("reuses exact branch DOM and slot scope when branch identity is unchanged", () => {
		const { parent } = createFixture();
		const range = new RetainedConditionalSlotRange<string>(parent);
		const firstBuilder = vi.fn((context: RetainedStructureContext) => appendBranch(context, "same"));
		const secondBuilder = vi.fn((context: RetainedStructureContext) => appendBranch(context, "unexpected"));

		expect(range.select("branch", firstBuilder).status).toBe("patched");
		const firstRoot = parent.querySelector("[data-branch='same']");
		const firstSlots = range.activeSlots;
		const second = range.select("branch", secondBuilder);

		expect(second.status).toBe("unchanged");
		expect(second.created).toBe(false);
		expect(secondBuilder).not.toHaveBeenCalled();
		expect(range.activeSlots).toBe(firstSlots);
		expect(parent.querySelector("[data-branch='same']")).toBe(firstRoot);
	});

	it("stages the next branch while the previous branch remains live", () => {
		const { parent } = createFixture();
		const range = new RetainedConditionalSlotRange<string>(parent);
		expect(range.select("a", (context) => appendBranch(context, "a")).status).toBe("patched");
		const oldRoot = parent.querySelector("[data-branch='a']") as HTMLElement;
		const oldSlots = range.activeSlots;

		const result = range.select("b", (context) => {
			expect(oldRoot.isConnected).toBe(true);
			expect(parent.contains(oldRoot)).toBe(true);
			appendBranch(context, "b");
		});

		expect(result.status).toBe("patched");
		expect(result.removedKey).toBe("a");
		expect(oldRoot.isConnected).toBe(false);
		expect(oldSlots?.isDisposed).toBe(true);
		expect(parent.querySelector("[data-branch='b']")).not.toBeNull();
	});

	it("preserves the last-known-good branch when next-branch construction throws", () => {
		const { parent } = createFixture();
		const range = new RetainedConditionalSlotRange<string>(parent);
		expect(range.select("good", (context) => appendBranch(context, "good")).status).toBe("patched");
		const oldRoot = parent.querySelector("[data-branch='good']");
		const oldSlots = range.activeSlots;

		expect(() => range.select("bad", () => {
			throw new Error("branch build failed");
		})).toThrow(/branch build failed/);

		expect(range.activeKey).toBe("good");
		expect(range.activeSlots).toBe(oldSlots);
		expect(oldSlots?.isDisposed).toBe(false);
		expect(parent.querySelector("[data-branch='good']")).toBe(oldRoot);
	});

	it("rejects unclaimed slot targets without disturbing the active branch", () => {
		const { parent } = createFixture();
		const range = new RetainedConditionalSlotRange<string>(parent);
		expect(range.select("good", (context) => appendBranch(context, "good")).status).toBe("patched");
		const oldRoot = parent.querySelector("[data-branch='good']");

		expect(() => range.select("bad", (context) => {
			const detached = context.ownerDocument.createElement("div");
			context.attributeSlot("orphan", detached, "data-value");
		})).toThrow(/not part of its mounted structure/);

		expect(range.activeKey).toBe("good");
		expect(parent.querySelector("[data-branch='good']")).toBe(oldRoot);
	});

	it("clears the active branch and disposes pending async island work", async () => {
		const { parent } = createFixture();
		const range = new RetainedConditionalSlotRange<string>(parent);
		expect(range.select("async", (context) => {
			const island = context.ownerDocument.createElement("div");
			island.dataset.branch = "async";
			context.markdownSlot("markdown", island);
			context.fragment.append(island);
		}).status).toBe("patched");
		const slots = range.activeSlots;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const pending = slots!.patchMarkdown("markdown", "v1", async ({ container }) => {
			await gate;
			container.textContent = "Late Markdown";
		});

		const cleared = range.clear();
		expect(cleared.status).toBe("patched");
		expect(cleared.removedKey).toBe("async");
		expect(range.activeKey).toBeNull();
		expect(range.activeSlots).toBeNull();
		expect(slots?.isDisposed).toBe(true);
		release();
		expect((await pending).status).toBe("disposed");
		expect(parent.querySelector("[data-branch='async']")).toBeNull();
	});

	it("reselects a previously removed branch with fresh DOM and slot scope", () => {
		const { parent } = createFixture();
		const range = new RetainedConditionalSlotRange<string>(parent);
		expect(range.select("a", (context) => appendBranch(context, "a")).status).toBe("patched");
		const firstRoot = parent.querySelector("[data-branch='a']");
		const firstSlots = range.activeSlots;
		expect(range.select("b", (context) => appendBranch(context, "b")).status).toBe("patched");
		expect(range.select("a", (context) => appendBranch(context, "a")).status).toBe("patched");

		expect(range.activeSlots).not.toBe(firstSlots);
		expect(parent.querySelector("[data-branch='a']")).not.toBe(firstRoot);
		expect(firstSlots?.isDisposed).toBe(true);
	});

	it("supports a selected branch with no rendered nodes", () => {
		const { parent } = createFixture();
		const range = new RetainedConditionalSlotRange<string>(parent);
		const builder = vi.fn((_context: RetainedStructureContext) => undefined);

		expect(range.select("empty", builder).status).toBe("patched");
		expect(range.activeKey).toBe("empty");
		expect(range.activeSlots?.slotCount).toBe(0);
		const repeatBuilder = vi.fn((_context: RetainedStructureContext) => undefined);
		expect(range.select("empty", repeatBuilder).status).toBe("unchanged");
		expect(repeatBuilder).not.toHaveBeenCalled();
	});

	it("treats clearing an already-empty region as unchanged", () => {
		const { parent } = createFixture();
		const range = new RetainedConditionalSlotRange<string>(parent);
		const result = range.clear();
		expect(result.status).toBe("unchanged");
		expect(result.removedKey).toBeNull();
	});

	it("keeps same branch ids isolated across independent conditional regions", () => {
		const { ownerDocument, parent } = createFixture();
		const separator = ownerDocument.createElement("hr");
		parent.appendChild(separator);
		const first = new RetainedConditionalSlotRange<string>(parent, { before: separator, label: "first" });
		const second = new RetainedConditionalSlotRange<string>(parent, { label: "second" });

		expect(first.select("if:0", (context) => appendBranch(context, "first", "A")).status).toBe("patched");
		expect(second.select("if:0", (context) => appendBranch(context, "second", "B")).status).toBe("patched");
		expect(first.activeSlots?.patchText("label", "A1")).toBe("patched");

		expect(parent.querySelector("[data-branch='first']")?.textContent).toBe("A1");
		expect(parent.querySelector("[data-branch='second']")?.textContent).toBe("B");
	});

	it("disposes the active branch idempotently and rejects later selection", () => {
		const { parent } = createFixture();
		const range = new RetainedConditionalSlotRange<string>(parent);
		expect(range.select("a", (context) => appendBranch(context, "a")).status).toBe("patched");
		const slots = range.activeSlots;
		range.dispose();
		range.dispose();

		expect(range.isDisposed).toBe(true);
		expect(slots?.isDisposed).toBe(true);
		const builder = vi.fn((context: RetainedStructureContext) => appendBranch(context, "b"));
		const result = range.select("b", builder);
		expect(result.status).toBe("disposed");
		expect(result.activeKey).toBeNull();
		expect(result.slots).toBeNull();
		expect(builder).not.toHaveBeenCalled();
	});

	it("uses the parent ownerDocument for branch DOM in a pop-out-like document", () => {
		const foreignDocument = new DOMParser().parseFromString("<!doctype html><html><body></body></html>", "text/html");
		const { parent } = createFixture(foreignDocument);
		const range = new RetainedConditionalSlotRange<string>(parent);
		expect(range.select("foreign", (context) => {
			expect(context.ownerDocument).toBe(foreignDocument);
			appendBranch(context, "foreign");
		}).status).toBe("patched");

		const branch = parent.querySelector("[data-branch='foreign']");
		expect(branch?.ownerDocument).toBe(foreignDocument);
	});
});
