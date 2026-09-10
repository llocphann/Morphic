import { describe, expect, it } from "vitest";
import { compileTemplate, TemplateCompileError } from "../compiler/template-compiler";
import type { AttributeSlot, TemplateIRNode } from "../compiler/template-ir";

function findNode<T extends TemplateIRNode["kind"]>(
	nodes: readonly TemplateIRNode[],
	kind: T,
): Extract<TemplateIRNode, { kind: T }> {
	const found = nodes.find((node): node is Extract<TemplateIRNode, { kind: T }> => node.kind === kind);
	if (!found) throw new Error(`Missing node kind: ${kind}`);
	return found;
}

describe("compileTemplate typed slots", () => {
	it("separates static markup from a simple text slot", () => {
		const compiled = compileTemplate("<p>Hello {{title}}</p>");
		expect(compiled.nodes).toHaveLength(3);
		expect(compiled.nodes[0]).toEqual({ kind: "static-fragment", html: "<p>Hello " });
		expect(compiled.nodes[1].kind).toBe("text-slot");
		expect(compiled.nodes[2]).toEqual({ kind: "static-fragment", html: "</p>" });
	});

	it("classifies placeholders inside HTML attributes without interpolating raw HTML", () => {
		const compiled = compileTemplate('<a href="{{url}}" data-title="prefix {{title}}">x</a>');
		const attributes = compiled.nodes.filter((node): node is AttributeSlot => node.kind === "attribute-slot");
		expect(attributes).toHaveLength(2);
		expect(attributes.map((node) => node.attribute)).toEqual(["href", "data-title"]);
		expect(attributes[0].targetKey).toBe("element-0");
	});

	it("uses a dedicated content slot for unfiltered note content", () => {
		const compiled = compileTemplate("<article>{{content}}</article>");
		const content = findNode(compiled.nodes, "content-slot");
		expect(content.expression.expressionSource).toBe("content");
		expect(compiled.dependencyHints.usesSelfContent).toBe(true);
	});

	it("keeps filtered content out of the editable content-slot contract", () => {
		const compiled = compileTemplate("{{content | trim}}");
		expect(compiled.nodes.some((node) => node.kind === "content-slot")).toBe(false);
	});

	it("marks explicit html() as the raw-HTML escape hatch", () => {
		const compiled = compileTemplate("{{ html(content) }}");
		const raw = findNode(compiled.nodes, "raw-html-slot");
		expect(raw.explicitRawHtml).toBe(true);
	});

	it("marks link/image and markdown-producing filters as markdown slots", () => {
		const linkTemplate = compileTemplate('{{ link("Target") }}');
		const imageTemplate = compileTemplate("{{cover | image:'poster'}}");
		const markdownTemplate = compileTemplate("{{body | markdown}}");
		expect(findNode(linkTemplate.nodes, "markdown-slot")).toBeTruthy();
		expect(findNode(imageTemplate.nodes, "markdown-slot")).toBeTruthy();
		expect(findNode(markdownTemplate.nodes, "markdown-slot")).toBeTruthy();
	});

	it("uses compiled filter names without normalizing legacy whitespace semantics", () => {
		const compiled = compileTemplate("{{body | markdown :ignored}}");
		expect(compiled.nodes).toHaveLength(1);
		expect(compiled.nodes[0].kind).toBe("expression-slot");
	});
});

describe("compileTemplate control flow", () => {
	it("compiles if/elif/else without evaluating branches", () => {
		const compiled = compileTemplate(
			"{% if rating > 8 %}great{% elif rating > 5 %}ok{% else %}low{% endif %}",
		);
		const node = findNode(compiled.nodes, "if");
		expect(node.branches).toHaveLength(3);
		expect(node.branches[0].condition?.expressionSource).toBe("rating > 8");
		expect(node.branches[1].condition?.expressionSource).toBe("rating > 5");
		expect(node.branches[2].condition).toBeNull();
		expect(compiled.dependencyHints.candidateSelfProperties).toEqual(["rating"]);
	});

	it("compiles nested loops and removes loop variables from self-property hints", () => {
		const compiled = compileTemplate(
			"{% for actor in cast %}{% if actor.rating > 8 %}{{actor.name}}{% endif %}{% endfor %}",
		);
		const loop = findNode(compiled.nodes, "for");
		expect(loop.itemVariable).toBe("actor");
		expect(loop.iterable.expressionSource).toBe("cast");
		const nestedIf = findNode(loop.children, "if");
		expect(nestedIf.branches[0].condition?.expressionSource).toBe("actor.rating > 8");
		expect(compiled.dependencyHints.candidateSelfProperties).toEqual(["cast"]);
	});

	it("preserves legacy set-first behavior by compiling assignments into a prelude", () => {
		const compiled = compileTemplate(
			"before{% if false %}{% set label = title %}{% endif %}after {{label}}",
		);
		const set = findNode(compiled.nodes, "set");
		expect(set.variable).toBe("label");
		expect(set.expression.expressionSource).toBe("title");
		expect(compiled.dependencyHints.candidateSelfProperties).toEqual(["title"]);
	});

	it("preserves legacy malformed-set fallback as a compiled string literal", () => {
		const compiled = compileTemplate("{% set label = ) %}{{label}}");
		const set = findNode(compiled.nodes, "set");
		expect(set.expression.expressionSource).toContain('"');
	});

	it("throws on structurally unclosed control-flow blocks", () => {
		expect(() => compileTemplate("{% if rating %}x")).toThrow(TemplateCompileError);
		expect(() => compileTemplate("{% for item in cast %}x")).toThrow(TemplateCompileError);
	});

	it("keeps unknown logic tags literal during migration", () => {
		const compiled = compileTemplate("a{% custom foo %}b");
		expect(compiled.nodes).toEqual([
			{ kind: "static-fragment", html: "a" },
			{ kind: "static-fragment", html: "{% custom foo %}" },
			{ kind: "static-fragment", html: "b" },
		]);
	});
});

describe("compileTemplate dependency aggregation", () => {
	it("merges expressions across slots and control flow", () => {
		const compiled = compileTemplate(
			"{% if status == 'active' %}{{file('People/Ada').rating}}{% endif %}{{today()}}",
		);
		expect(compiled.dependencyHints.candidateSelfProperties).toContain("status");
		expect(compiled.dependencyHints.staticLinkedFileTargets).toEqual(["People/Ada"]);
		expect(compiled.dependencyHints.usesLinkedMetadata).toBe(true);
		expect(compiled.dependencyHints.volatility).toContain("today");
	});

	it("produces a deterministic source hash that changes with source", () => {
		const first = compileTemplate("{{title}}");
		const second = compileTemplate("{{title}}");
		const changed = compileTemplate("{{title}}!");
		expect(first.sourceHash).toBe(second.sourceHash);
		expect(first.sourceHash).not.toBe(changed.sourceHash);
	});
});
