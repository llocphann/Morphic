import { describe, expect, it } from "vitest";
import { RetainedDomRuntime } from "../render/retained-slot-runtime";
import {
	RetainedSyncTemplateSurface,
	inspectRetainedSyncTemplateSupport,
} from "../render/retained-sync-template-surface";
import type { RetainedTemplateIrLike } from "../render/retained-template-dom-plan";

function createOwnerDocument(): Document {
	return window.document.implementation.createHTMLDocument("retained-sync-template");
}

function basicIr(sourceHash = "sync-basic"): RetainedTemplateIrLike<string> {
	return {
		version: 1,
		sourceHash,
		nodes: [
			{ kind: "static-fragment", html: "<section data-label=\"" },
			{
				kind: "attribute-slot",
				id: "label",
				attribute: "data-label",
				targetKey: "section:0",
				quote: "\"",
				parts: [],
			},
			{ kind: "static-fragment", html: "\"><span>" },
			{ kind: "text-slot", id: "title", expression: "title" },
			{ kind: "static-fragment", html: "</span><em>static</em></section>" },
		],
	};
}

function resolved(label: unknown, title: unknown): ReadonlyMap<string, string | number | boolean | null | undefined> {
	return new Map([
		["label", label as string | number | boolean | null | undefined],
		["title", title as string | number | boolean | null | undefined],
	]);
}

describe("RetainedSyncTemplateSurface", () => {
	it("initializes synchronous values in detached structure before live replacement", () => {
		const ownerDocument = createOwnerDocument();
		const root = ownerDocument.createElement("div");
		const old = ownerDocument.createElement("p");
		old.textContent = "Old";
		root.appendChild(old);
		const runtime = new RetainedDomRuntime(root);
		const surface = new RetainedSyncTemplateSurface(runtime, basicIr());
		const originalReplaceChildren = root.replaceChildren.bind(root);
		let observedTitle: string | null = null;
		let observedLabel: string | null = null;

		root.replaceChildren = (...nodes: Array<Node | string>) => {
			const fragment = nodes[0] as DocumentFragment;
			observedTitle = fragment.querySelector("span")?.textContent ?? null;
			observedLabel = fragment.querySelector("section")?.getAttribute("data-label") ?? null;
			originalReplaceChildren(...nodes);
		};

		expect(surface.commit(resolved("ready", "hello"))).toEqual({ status: "mounted" });
		expect(observedTitle).toBe("hello");
		expect(observedLabel).toBe("ready");
		expect(root.querySelector("span")?.textContent).toBe("hello");
	});

	it("normalizes equivalent scalar output and skips redundant mutations", () => {
		const ownerDocument = createOwnerDocument();
		const root = ownerDocument.createElement("div");
		const runtime = new RetainedDomRuntime(root);
		const surface = new RetainedSyncTemplateSurface(runtime, basicIr());

		expect(surface.commit(resolved(true, 1))).toEqual({ status: "mounted" });
		const section = root.querySelector("section");
		const title = root.querySelector("span")?.firstChild;
		expect(surface.commit(resolved("true", "1"))).toEqual({ status: "unchanged" });
		expect(root.querySelector("section")).toBe(section);
		expect(root.querySelector("span")?.firstChild).toBe(title);
	});

	it("patches changed leaves while retaining static DOM identity", () => {
		const ownerDocument = createOwnerDocument();
		const root = ownerDocument.createElement("div");
		const runtime = new RetainedDomRuntime(root);
		const surface = new RetainedSyncTemplateSurface(runtime, basicIr());
		surface.commit(resolved("old", "alpha"));
		const section = root.querySelector("section");
		const staticNode = root.querySelector("em");

		expect(surface.commit(resolved(null, "bravo"))).toEqual({ status: "patched" });
		expect(root.querySelector("section")).toBe(section);
		expect(root.querySelector("em")).toBe(staticNode);
		expect(section?.hasAttribute("data-label")).toBe(false);
		expect(root.querySelector("span")?.textContent).toBe("bravo");
	});

	it("rejects missing resolved values before mutating live DOM", () => {
		const ownerDocument = createOwnerDocument();
		const root = ownerDocument.createElement("div");
		const runtime = new RetainedDomRuntime(root);
		const surface = new RetainedSyncTemplateSurface(runtime, basicIr());
		surface.commit(resolved("old", "alpha"));
		const html = root.innerHTML;

		const result = surface.commit(new Map([["title", "bravo"]]));
		expect(result.status).toBe("failed");
		expect(root.innerHTML).toBe(html);
	});

	it("rejects unexpected resolved values before mutating live DOM", () => {
		const ownerDocument = createOwnerDocument();
		const root = ownerDocument.createElement("div");
		const runtime = new RetainedDomRuntime(root);
		const surface = new RetainedSyncTemplateSurface(runtime, basicIr());
		surface.commit(resolved("old", "alpha"));
		const html = root.innerHTML;
		const next = new Map(resolved("new", "bravo"));
		next.set("unexpected", "value");

		const result = surface.commit(next);
		expect(result.status).toBe("failed");
		expect(root.innerHTML).toBe(html);
	});

	it("rolls back earlier leaf patches when a later DOM write throws", () => {
		const ownerDocument = createOwnerDocument();
		const root = ownerDocument.createElement("div");
		const runtime = new RetainedDomRuntime(root);
		const surface = new RetainedSyncTemplateSurface(runtime, basicIr());
		surface.commit(resolved("old", "alpha"));
		const section = root.querySelector("section") as HTMLElement;
		const originalSetAttribute = section.setAttribute.bind(section);
		section.setAttribute = (name: string, value: string) => {
			if (name === "data-label" && value === "boom") throw new Error("synthetic attribute failure");
			originalSetAttribute(name, value);
		};

		const result = surface.commit(resolved("boom", "bravo"));
		expect(result.status).toBe("failed");
		expect(root.querySelector("span")?.textContent).toBe("alpha");
		expect(section.getAttribute("data-label")).toBe("old");
		expect(surface.isPoisoned).toBe(false);

		section.setAttribute = originalSetAttribute;
		expect(surface.commit(resolved("new", "bravo"))).toEqual({ status: "patched" });
	});

	it("preserves the previous tree when detached marker validation fails", () => {
		const ownerDocument = createOwnerDocument();
		const root = ownerDocument.createElement("div");
		const runtime = new RetainedDomRuntime(root);
		const stable = new RetainedSyncTemplateSurface(runtime, basicIr("stable"));
		stable.commit(resolved("old", "alpha"));
		const stableSection = root.querySelector("section");

		const collidingIr: RetainedTemplateIrLike<string> = {
			version: 1,
			sourceHash: "x",
			nodes: [
				{ kind: "static-fragment", html: "<div><!--morphic-slot-78-0--></div>" },
				{ kind: "text-slot", id: "value", expression: "value" },
			],
		};
		const colliding = new RetainedSyncTemplateSurface(runtime, collidingIr);
		const result = colliding.commit(new Map([["value", "next"]]));

		expect(result.status).toBe("failed");
		expect(root.querySelector("section")).toBe(stableSection);
		expect(root.querySelector("span")?.textContent).toBe("alpha");
	});

	it("does not adopt an already-mounted same-key runtime without rollback ownership", () => {
		const ownerDocument = createOwnerDocument();
		const root = ownerDocument.createElement("div");
		const runtime = new RetainedDomRuntime(root);
		const first = new RetainedSyncTemplateSurface(runtime, basicIr());
		first.commit(resolved("old", "alpha"));
		const second = new RetainedSyncTemplateSurface(runtime, basicIr());
		const html = root.innerHTML;

		const result = second.commit(resolved("new", "bravo"));
		expect(result.status).toBe("failed");
		expect(root.innerHTML).toBe(html);
	});

	it("ignores evaluator-only set nodes when validating resolved DOM slots", () => {
		const ownerDocument = createOwnerDocument();
		const root = ownerDocument.createElement("div");
		const runtime = new RetainedDomRuntime(root);
		const ir: RetainedTemplateIrLike<string> = {
			version: 1,
			sourceHash: "set-node",
			nodes: [
				{ kind: "set", variable: "local", expression: "source" },
				{ kind: "static-fragment", html: "<p>" },
				{ kind: "text-slot", id: "value", expression: "local" },
				{ kind: "static-fragment", html: "</p>" },
			],
		};
		const surface = new RetainedSyncTemplateSurface(runtime, ir);

		expect(surface.commit(new Map([["value", "resolved"]]))).toEqual({ status: "mounted" });
		expect(root.textContent).toBe("resolved");
	});

	it("reports asynchronous islands as explicit fallback requirements", () => {
		const ir: RetainedTemplateIrLike<string> = {
			version: 1,
			sourceHash: "markdown",
			nodes: [{ kind: "markdown-slot", id: "md", expression: "body" }],
		};

		expect(inspectRetainedSyncTemplateSupport(ir)).toEqual({
			supported: false,
			code: "async-island",
			path: "nodes[0]",
			message: "nodes[0] requires generation-staged async island commit",
		});
	});

	it("forwards structural and raw-html fallback classifications", () => {
		const structural: RetainedTemplateIrLike<string> = {
			version: 1,
			sourceHash: "if",
			nodes: [{
				kind: "if",
				branches: [{ condition: "condition", children: [] }],
			}],
		};
		const raw: RetainedTemplateIrLike<string> = {
			version: 1,
			sourceHash: "raw",
			nodes: [{ kind: "raw-html-slot", id: "raw", expression: "html" }],
		};

		expect(inspectRetainedSyncTemplateSupport(structural)).toMatchObject({
			supported: false,
			code: "structural-control-flow",
		});
		expect(inspectRetainedSyncTemplateSupport(raw)).toMatchObject({
			supported: false,
			code: "raw-html-range",
		});
	});

	it("creates retained nodes in the root ownerDocument", () => {
		const ownerDocument = createOwnerDocument();
		const root = ownerDocument.createElement("div");
		const runtime = new RetainedDomRuntime(root);
		const surface = new RetainedSyncTemplateSurface(runtime, basicIr());

		expect(surface.commit(resolved("foreign", "doc"))).toEqual({ status: "mounted" });
		expect(root.firstChild?.ownerDocument).toBe(ownerDocument);
		expect(root.querySelector("span")?.ownerDocument).toBe(ownerDocument);
	});

	it("returns disposed when the retained runtime has already been disposed", () => {
		const ownerDocument = createOwnerDocument();
		const root = ownerDocument.createElement("div");
		const runtime = new RetainedDomRuntime(root);
		const surface = new RetainedSyncTemplateSurface(runtime, basicIr());
		runtime.dispose();

		expect(surface.commit(resolved("label", "title"))).toEqual({ status: "disposed" });
	});
});
