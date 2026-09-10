import { describe, expect, it } from "vitest";
import { compileTemplateCompat } from "../compiler/template-compat";
import type {
	AttributeExpressionPart,
	AttributeSlot,
	AttributeStaticPart,
	TemplateIRNode,
} from "../compiler/template-ir";

function attributes(nodes: readonly TemplateIRNode[]): AttributeSlot[] {
	return nodes.filter((node): node is AttributeSlot => node.kind === "attribute-slot");
}

function staticPart(value: string): AttributeStaticPart {
	return { kind: "static", value, encoding: "html-attribute-source" };
}

function expressionSource(part: AttributeExpressionPart): string {
	return part.expression.expressionSource;
}

describe("production-compatible mixed attribute TemplateIR", () => {
	it("aggregates static prefix/suffix and multiple expressions into one attribute slot", () => {
		const compiled = compileTemplateCompat(
			'<a href="/notes/{{slug}}.md" class="pre-{{kind}}-{{state}}-post">X</a>',
		);
		const slots = attributes(compiled.nodes);

		expect(slots).toHaveLength(2);
		expect(slots[0]).toMatchObject({
			attribute: "href",
			targetKey: "element-0",
			quote: '"',
		});
		expect(slots[0].parts).toHaveLength(3);
		expect(slots[0].parts?.[0]).toEqual(staticPart("/notes/"));
		expect(expressionSource(slots[0].parts?.[1] as AttributeExpressionPart)).toBe("slug");
		expect(slots[0].parts?.[2]).toEqual(staticPart(".md"));

		expect(slots[1]).toMatchObject({
			attribute: "class",
			targetKey: "element-0",
			quote: '"',
		});
		expect(slots[1].parts?.map((part) => part.kind)).toEqual([
			"static",
			"expression",
			"static",
			"expression",
			"static",
		]);
		expect(slots[1].parts?.[0]).toEqual(staticPart("pre-"));
		expect(expressionSource(slots[1].parts?.[1] as AttributeExpressionPart)).toBe("kind");
		expect(slots[1].parts?.[2]).toEqual(staticPart("-"));
		expect(expressionSource(slots[1].parts?.[3] as AttributeExpressionPart)).toBe("state");
		expect(slots[1].parts?.[4]).toEqual(staticPart("-post"));

		expect(compiled.nodes.filter((node) => node.kind === "static-fragment")).toEqual([
			{ kind: "static-fragment", html: '<a href="' },
			{ kind: "static-fragment", html: '" class="' },
			{ kind: "static-fragment", html: '">X</a>' },
		]);
		expect(compiled.dependencyHints.candidateSelfProperties).toEqual(["kind", "slug", "state"]);
	});

	it("preserves single-quoted and unquoted source modes", () => {
		const compiled = compileTemplateCompat(
			"<div title='pre-{{title}}-post' data-key=key-{{name}}-tail></div>",
		);
		const slots = attributes(compiled.nodes);
		expect(slots).toHaveLength(2);
		expect(slots[0].quote).toBe("'");
		expect(slots[0].parts?.[0]).toEqual(staticPart("pre-"));
		expect(slots[0].parts?.[2]).toEqual(staticPart("-post"));
		expect(slots[1].quote).toBeNull();
		expect(slots[1].parts?.[0]).toEqual(staticPart("key-"));
		expect(slots[1].parts?.[2]).toEqual(staticPart("-tail"));
	});

	it("keeps set prelude semantics while assembling later attribute values", () => {
		const compiled = compileTemplateCompat(
			"{% set prefix = 'pre' %}<div class=\"{{prefix}}-{{name}}\"></div>",
		);
		expect(compiled.nodes[0]).toMatchObject({ kind: "set", variable: "prefix" });
		const slot = attributes(compiled.nodes)[0];
		expect(slot.parts?.map((part) => part.kind)).toEqual(["expression", "static", "expression"]);
		expect(expressionSource(slot.parts?.[0] as AttributeExpressionPart)).toBe("prefix");
		expect(slot.parts?.[1]).toEqual(staticPart("-"));
		expect(expressionSource(slot.parts?.[2] as AttributeExpressionPart)).toBe("name");
		expect(compiled.nodes.some(
			(node) => node.kind === "static-fragment" && node.html.includes("{% set"),
		)).toBe(false);
	});

	it("assembles complete attribute values inside structural branch child lists", () => {
		const compiled = compileTemplateCompat(
			'{% if active %}<div class="pre-{{name}}-post"></div>{% endif %}',
		);
		const branch = compiled.nodes.find((node) => node.kind === "if");
		expect(branch?.kind).toBe("if");
		if (!branch || branch.kind !== "if") throw new Error("Expected structural branch");
		const slot = attributes(branch.branches[0].children)[0];
		expect(slot.quote).toBe('"');
		expect(slot.parts?.map((part) => part.kind)).toEqual(["static", "expression", "static"]);
		expect(slot.parts?.[0]).toEqual(staticPart("pre-"));
		expect(expressionSource(slot.parts?.[1] as AttributeExpressionPart)).toBe("name");
		expect(slot.parts?.[2]).toEqual(staticPart("-post"));
		expect(branch.branches[0].children.filter((node) => node.kind === "static-fragment")).toEqual([
			{ kind: "static-fragment", html: '<div class="' },
			{ kind: "static-fragment", html: '"></div>' },
		]);
	});

	it("retains fail-soft null expressions inside complete attribute assembly", () => {
		const compiled = compileTemplateCompat('<div data-x="pre-{{ ) }}-post"></div>');
		const slot = attributes(compiled.nodes)[0];
		expect(compiled.diagnostics).toHaveLength(1);
		expect(slot.parts?.map((part) => part.kind)).toEqual(["static", "expression", "static"]);
		expect(expressionSource(slot.parts?.[1] as AttributeExpressionPart)).toBe("null");
		expect(compiled.dependencyHints.usesSelfMetadata).toBe(true);
		expect(compiled.dependencyHints.usesDynamicLinkedFile).toBe(true);
	});
});