import { describe, expect, it } from "vitest";
import { RetainedKeyedSlotScope } from "../render/scoped-keyed-slot-runtime";
import { RetainedDomRuntime } from "../render/retained-slot-runtime";
import {
	RetainedTemplateDomPlan,
	RetainedTemplateDomPlanError,
	decodeRetainedHtmlAttributeSource,
	inspectRetainedTemplateDomSupport,
	type RetainedTemplateIrLike,
} from "../render/retained-template-dom-plan";

type TestExpression = string;

function template(
	sourceHash: string,
	nodes: RetainedTemplateIrLike<TestExpression>["nodes"],
): RetainedTemplateIrLike<TestExpression> {
	return { version: 1, sourceHash, nodes };
}

describe("RetainedTemplateDomPlan", () => {
	it("parses split static HTML as one structure and binds text in the correct parent", () => {
		const root = window.document.createElement("div");
		const runtime = new RetainedDomRuntime(root);
		const plan = new RetainedTemplateDomPlan(template("text", [
			{ kind: "static-fragment", html: "<p>Hello " },
			{ kind: "text-slot", id: "slot-0", expression: "title" },
			{ kind: "static-fragment", html: "</p>" },
		]));

		expect(plan.mount(runtime)).toBe("mounted");
		const paragraph = root.querySelector("p");
		expect(paragraph).not.toBeNull();
		runtime.patchText("slot-0", "Ada");
		expect(paragraph?.textContent).toBe("Hello Ada");
	});

	it("reuses exact static DOM identity for the same source hash", () => {
		const root = window.document.createElement("div");
		const runtime = new RetainedDomRuntime(root);
		const plan = new RetainedTemplateDomPlan(template("same", [
			{ kind: "static-fragment", html: "<article><strong>Stable</strong> " },
			{ kind: "text-slot", id: "slot-0", expression: "title" },
			{ kind: "static-fragment", html: "</article>" },
		]));

		expect(plan.mount(runtime)).toBe("mounted");
		const article = root.querySelector("article");
		const strong = root.querySelector("strong");
		runtime.patchText("slot-0", "A");

		expect(plan.mount(runtime)).toBe("reused");
		runtime.patchText("slot-0", "B");
		expect(root.querySelector("article")).toBe(article);
		expect(root.querySelector("strong")).toBe(strong);
		expect(article?.textContent).toBe("Stable B");
	});

	it("maps multiple atomic attribute slots to the same retained source element", () => {
		const root = window.document.createElement("div");
		const runtime = new RetainedDomRuntime(root);
		const plan = new RetainedTemplateDomPlan(template("attrs", [
			{ kind: "static-fragment", html: '<a href="' },
			{
				kind: "attribute-slot",
				id: "slot-0",
				attribute: "href",
				targetKey: "element-0",
				quote: '"',
				parts: [{ kind: "expression", expression: "url" }],
			},
			{ kind: "static-fragment", html: '" data-title="' },
			{
				kind: "attribute-slot",
				id: "slot-1",
				attribute: "data-title",
				targetKey: "element-0",
				quote: '"',
				parts: [
					{ kind: "static", value: "prefix &amp; ", encoding: "html-attribute-source" },
					{ kind: "expression", expression: "title" },
				],
			},
			{ kind: "static-fragment", html: '">Link</a>' },
		]));

		expect(plan.mount(runtime)).toBe("mounted");
		const anchor = root.querySelector("a");
		expect(anchor?.hasAttribute("href")).toBe(false);
		expect(anchor?.hasAttribute("data-title")).toBe(false);

		runtime.patchAttribute("slot-0", "People/Ada.md");
		runtime.patchAttribute("slot-1", "prefix & Ada");
		expect(anchor?.getAttribute("href")).toBe("People/Ada.md");
		expect(anchor?.getAttribute("data-title")).toBe("prefix & Ada");
	});

	it("creates legacy-compatible Markdown and content island shells", async () => {
		const root = window.document.createElement("div");
		const runtime = new RetainedDomRuntime(root);
		const plan = new RetainedTemplateDomPlan(template("islands", [
			{ kind: "static-fragment", html: "<section>" },
			{ kind: "markdown-slot", id: "slot-md", expression: "link" },
			{ kind: "content-slot", id: "slot-content", expression: "content" },
			{ kind: "static-fragment", html: "</section>" },
		]));

		plan.mount(runtime);
		const markdown = root.querySelector("section > span");
		const content = root.querySelector<HTMLElement>(".markdown-rendered-content");
		expect(markdown).not.toBeNull();
		expect(content?.classList.contains("markdown-preview-view")).toBe(true);
		expect(content?.classList.contains("markdown-rendered")).toBe(true);

		await runtime.patchMarkdown("slot-md", "md-1", ({ container }) => {
			container.textContent = "Markdown";
		});
		await runtime.patchContent("slot-content", "content-1", ({ container }) => {
			container.textContent = "Body";
		});
		expect(markdown?.textContent).toBe("Markdown");
		expect(content?.textContent).toBe("Body");
	});

	it("emits no DOM for set-prelude nodes", () => {
		const root = window.document.createElement("div");
		const runtime = new RetainedDomRuntime(root);
		const plan = new RetainedTemplateDomPlan(template("set", [
			{ kind: "set", variable: "label", expression: "title" },
			{ kind: "static-fragment", html: "<p>Static</p>" },
		]));

		plan.mount(runtime);
		expect(root.innerHTML).toBe("<p>Static</p>");
		expect(runtime.slotCount).toBe(0);
	});

	it("composes the same builder with a keyed-entry slot namespace", () => {
		const ownerDocument = window.document;
		const slots = new RetainedKeyedSlotScope(ownerDocument);
		const plan = new RetainedTemplateDomPlan(template("keyed", [
			{ kind: "static-fragment", html: "<li>" },
			{ kind: "text-slot", id: "slot-0", expression: "item.name" },
			{ kind: "static-fragment", html: "</li>" },
		]));

		const roots = slots.mount(plan.builder(), plan.structureKey);
		const host = ownerDocument.createElement("ul");
		host.append(...roots);
		slots.patchText("slot-0", "Grace");

		expect(host.textContent).toBe("Grace");
		expect(slots.slotCount).toBe(1);
		slots.dispose();
	});

	it("preserves the actual ownerDocument for pop-out-like DOM", () => {
		const ownerDocument = new window.DOMParser().parseFromString(
			"<!doctype html><html><body></body></html>",
			"text/html",
		);
		const root = ownerDocument.createElement("div");
		const runtime = new RetainedDomRuntime(root);
		const plan = new RetainedTemplateDomPlan(template("foreign", [
			{ kind: "static-fragment", html: "<p>" },
			{ kind: "text-slot", id: "slot-0", expression: "title" },
			{ kind: "static-fragment", html: "</p>" },
		]));

		plan.mount(runtime);
		runtime.patchText("slot-0", "Popup");
		const paragraph = root.querySelector("p");
		expect(paragraph?.ownerDocument).toBe(ownerDocument);
		expect(paragraph?.textContent).toBe("Popup");
	});

	it("fails detached marker parsing without destroying the stable live tree", () => {
		const root = window.document.createElement("div");
		const stable = window.document.createElement("strong");
		stable.textContent = "Stable";
		root.appendChild(stable);
		const runtime = new RetainedDomRuntime(root);
		const plan = new RetainedTemplateDomPlan(template("script-marker", [
			{ kind: "static-fragment", html: "<script>const value = '" },
			{ kind: "text-slot", id: "slot-0", expression: "title" },
			{ kind: "static-fragment", html: "';</script>" },
		]));

		expect(() => plan.mount(runtime)).toThrow(RetainedTemplateDomPlanError);
		expect(root.firstChild).toBe(stable);
		expect(stable.isConnected).toBe(false);
		expect(stable.textContent).toBe("Stable");
	});

	it("rejects marker collisions and conflicting source target keys before commit", () => {
		const collisionRoot = window.document.createElement("div");
		const collisionRuntime = new RetainedDomRuntime(collisionRoot);
		const collision = new RetainedTemplateDomPlan(template("x", [
			{ kind: "static-fragment", html: "<!--morphic-slot-78-0--><p>" },
			{ kind: "text-slot", id: "slot-0", expression: "title" },
			{ kind: "static-fragment", html: "</p>" },
		]));
		expect(() => collision.mount(collisionRuntime)).toThrow(/collides with template source/);

		const targetRoot = window.document.createElement("div");
		const targetRuntime = new RetainedDomRuntime(targetRoot);
		const targetConflict = new RetainedTemplateDomPlan(template("targets", [
			{ kind: "static-fragment", html: '<a href="' },
			{
				kind: "attribute-slot",
				id: "slot-0",
				attribute: "href",
				targetKey: "element-0",
				quote: '"',
				parts: [{ kind: "expression", expression: "url" }],
			},
			{ kind: "static-fragment", html: '"></a><b title="' },
			{
				kind: "attribute-slot",
				id: "slot-1",
				attribute: "title",
				targetKey: "element-0",
				quote: '"',
				parts: [{ kind: "expression", expression: "title" }],
			},
			{ kind: "static-fragment", html: '"></b>' },
		]));
		expect(() => targetConflict.mount(targetRuntime)).toThrow(/multiple elements/);
	});

	it("reports unsupported fallback requirements instead of weakening semantics", () => {
		const raw = template("raw", [{
			kind: "raw-html-slot",
			id: "slot-0",
			expression: "html(content)",
		}]);
		const conditional = template("if", [{
			kind: "if",
			branches: [{ condition: "active", children: [] }],
		}]);
		const contextual = template("context", [{
			kind: "expression-slot",
			id: "slot-0",
			expression: "value",
			context: "markdown",
		}]);

		expect(inspectRetainedTemplateDomSupport(raw)).toMatchObject({
			supported: false,
			code: "raw-html-range",
		});
		expect(inspectRetainedTemplateDomSupport(conditional)).toMatchObject({
			supported: false,
			code: "structural-control-flow",
		});
		expect(inspectRetainedTemplateDomSupport(contextual)).toMatchObject({
			supported: false,
			code: "non-text-expression-context",
		});
		expect(() => new RetainedTemplateDomPlan(raw)).toThrow(RetainedTemplateDomPlanError);
	});

	it("rejects duplicate slot ids before any DOM work", () => {
		const ir = template("duplicate", [
			{ kind: "text-slot", id: "slot-0", expression: "title" },
			{ kind: "markdown-slot", id: "slot-0", expression: "body" },
		]);
		expect(() => new RetainedTemplateDomPlan(ir)).toThrow(/Duplicate retained template slot id/);
	});
});

describe("decodeRetainedHtmlAttributeSource", () => {
	it("decodes compiler-owned HTML attribute source in the supplied document", () => {
		const ownerDocument = new window.DOMParser().parseFromString(
			"<!doctype html><html><body></body></html>",
			"text/html",
		);
		expect(
			decodeRetainedHtmlAttributeSource(ownerDocument, "A &amp; B &quot;C&quot;", '"'),
		).toBe('A & B "C"');
		expect(
			decodeRetainedHtmlAttributeSource(ownerDocument, "A &amp; &#39;B&#39;", "'"),
		).toBe("A & 'B'");
	});
});
