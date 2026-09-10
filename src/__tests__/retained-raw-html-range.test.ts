import { describe, expect, it } from "vitest";
import { RetainedRawHtmlRange } from "../render/retained-raw-html-range";
import type { ExplicitRawHtml } from "../render/retained-slot-runtime";

function raw(html: string): ExplicitRawHtml {
	return { explicitRawHtml: true, html };
}

describe("RetainedRawHtmlRange", () => {
	it("commits multiple raw HTML roots without a semantic wrapper", () => {
		const ownerDocument = window.document;
		const parent = ownerDocument.createElement("div");
		const before = ownerDocument.createElement("i");
		const after = ownerDocument.createElement("i");
		parent.append(before, after);
		const range = new RetainedRawHtmlRange(parent, { before: after });

		expect(range.patch(raw("<span>A</span><em>B</em>"))).toBe("patched");
		expect(range.nodes).toHaveLength(2);
		expect((range.nodes[0] as Element).tagName).toBe("SPAN");
		expect((range.nodes[1] as Element).tagName).toBe("EM");
		expect(range.nodes.every((node) => node.parentNode === parent)).toBe(true);
		expect(before.parentNode).toBe(parent);
		expect(after.parentNode).toBe(parent);
	});

	it("retains exact node identities for an unchanged HTML value", () => {
		const parent = window.document.createElement("div");
		const range = new RetainedRawHtmlRange(parent);

		expect(range.patch(raw("<strong>Stable</strong><!--tail-->"))).toBe("patched");
		const first = [...range.nodes];
		expect(range.patch(raw("<strong>Stable</strong><!--tail-->"))).toBe("unchanged");
		expect(range.nodes[0]).toBe(first[0]);
		expect(range.nodes[1]).toBe(first[1]);
	});

	it("replaces only the bounded raw range while preserving outside siblings", () => {
		const ownerDocument = window.document;
		const parent = ownerDocument.createElement("div");
		const before = ownerDocument.createElement("div");
		const after = ownerDocument.createElement("div");
		parent.append(before, after);
		const range = new RetainedRawHtmlRange(parent, { before: after });

		range.patch(raw('<span id="old">Old</span>'));
		const oldNode = range.nodes[0];
		expect(range.patch(raw('<strong id="new">New</strong>'))).toBe("patched");

		expect(oldNode.parentNode).toBeNull();
		expect((range.nodes[0] as Element).id).toBe("new");
		expect(before.parentNode).toBe(parent);
		expect(after.parentNode).toBe(parent);
	});

	it("treats an empty explicit HTML value as a committed retained value", () => {
		const parent = window.document.createElement("div");
		const range = new RetainedRawHtmlRange(parent);

		expect(range.patch(raw(""))).toBe("patched");
		expect(range.nodes).toHaveLength(0);
		expect(range.currentHtml).toBe("");
		expect(range.patch(raw(""))).toBe("unchanged");
	});

	it("clears the active raw range without disturbing its structural anchors", () => {
		const parent = window.document.createElement("div");
		const range = new RetainedRawHtmlRange(parent);
		range.patch(raw("<span>Value</span>"));

		expect(range.clear()).toBe("patched");
		expect(range.nodes).toHaveLength(0);
		expect(range.currentHtml).toBeNull();
		expect(range.clear()).toBe("unchanged");
	});

	it("imports parsed head and body nodes into the parent ownerDocument", () => {
		const foreignDocument = window.document.implementation.createHTMLDocument("popout");
		const parent = foreignDocument.createElement("div");
		foreignDocument.body.append(parent);
		const range = new RetainedRawHtmlRange(parent);

		range.patch(raw("<style>.x{display:block}</style><p>Body</p>"));
		expect(range.nodes).toHaveLength(2);
		expect(range.nodes.every((node) => node.ownerDocument === foreignDocument)).toBe(true);
		expect((range.nodes[0] as Element).tagName).toBe("STYLE");
		expect((range.nodes[1] as Element).tagName).toBe("P");
	});

	it("retains raw text and comment nodes without synthesizing elements", () => {
		const parent = window.document.createElement("div");
		const range = new RetainedRawHtmlRange(parent);

		range.patch(raw("alpha<!--marker--><b>beta</b>"));
		expect(range.nodes.map((node) => node.nodeType)).toEqual([3, 8, 1]);
		expect(range.nodes[0].textContent).toBe("alpha");
		expect(range.nodes[1].textContent).toBe("marker");
	});

	it("does not copy raw source into diagnostic comment anchors", () => {
		const parent = window.document.createElement("div");
		const range = new RetainedRawHtmlRange(parent, { label: "explicit" });
		const secret = "sensitive-raw-source";

		range.patch(raw(`<span data-secret="${secret}">Visible</span>`));
		const comments = Array.from(parent.childNodes)
			.filter((node) => node.nodeType === 8)
			.map((node) => node.textContent ?? "");
		expect(comments.join("\n")).not.toContain(secret);
	});

	it("rolls back a failed live commit and keeps the prior raw DOM current", () => {
		const parent = window.document.createElement("div");
		const range = new RetainedRawHtmlRange(parent);
		range.patch(raw('<span id="stable">Stable</span>'));
		const stableNode = range.nodes[0];
		const originalInsertBefore = parent.insertBefore;

		parent.insertBefore = function <T extends Node>(
			this: HTMLElement,
			newNode: T,
			referenceNode: Node | null,
		): T {
			if (newNode.nodeType === 1 && (newNode as unknown as Element).hasAttribute("data-fail")) {
				throw new Error("synthetic raw commit failure");
			}
			return originalInsertBefore.call(this, newNode, referenceNode) as T;
		};

		try {
			expect(() => range.patch(raw('<em data-fail="true">Next</em>')))
				.toThrow("synthetic raw commit failure");
		} finally {
			parent.insertBefore = originalInsertBefore;
		}

		expect(range.currentHtml).toBe('<span id="stable">Stable</span>');
		expect(range.nodes).toHaveLength(1);
		expect(range.nodes[0]).toBe(stableNode);
		expect(stableNode.parentNode).toBe(parent);
	});

	it("rejects an insertion point owned by another parent before creating anchors", () => {
		const ownerDocument = window.document;
		const parent = ownerDocument.createElement("div");
		const other = ownerDocument.createElement("div");
		const foreignChild = ownerDocument.createElement("span");
		other.append(foreignChild);

		expect(() => new RetainedRawHtmlRange(parent, { before: foreignChild }))
			.toThrow("insertion point is not a child");
		expect(parent.childNodes).toHaveLength(0);
	});

	it("disposes idempotently, prevents later patches, and leaves final DOM to owner teardown", () => {
		const parent = window.document.createElement("div");
		const range = new RetainedRawHtmlRange(parent);
		range.patch(raw("<span>Committed</span>"));
		const committed = range.nodes[0];

		range.dispose();
		range.dispose();
		expect(range.isDisposed).toBe(true);
		expect(range.currentHtml).toBeNull();
		expect(range.nodes).toHaveLength(0);
		expect(range.patch(raw("<em>Late</em>"))).toBe("disposed");
		expect(range.clear()).toBe("disposed");
		expect(committed.parentNode).toBe(parent);
	});
});
