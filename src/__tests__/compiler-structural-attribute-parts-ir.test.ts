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

describe("structural mixed attribute TemplateIR", () => {
	it("assembles multiple expressions inside a for-loop attribute", () => {
		const compiled = compileTemplateCompat(
			"{% for item in items %}<a data-key='row-{{item.id}}-{{index}}'>{{item.name}}</a>{% endfor %}",
		);
		const loop = compiled.nodes.find((node) => node.kind === "for");
		expect(loop?.kind).toBe("for");
		if (!loop || loop.kind !== "for") throw new Error("Expected loop");

		const slot = attributes(loop.children)[0];
		expect(slot).toMatchObject({ attribute: "data-key", quote: "'" });
		expect(slot.parts?.map((part) => part.kind)).toEqual([
			"static",
			"expression",
			"static",
			"expression",
		]);
		expect(slot.parts?.[0]).toEqual(staticPart("row-"));
		expect(expressionSource(slot.parts?.[1] as AttributeExpressionPart)).toBe("item.id");
		expect(slot.parts?.[2]).toEqual(staticPart("-"));
		expect(expressionSource(slot.parts?.[3] as AttributeExpressionPart)).toBe("index");
		expect(loop.children.some(
			(node) => node.kind === "text-slot" && node.expression.expressionSource === "item.name",
		)).toBe(true);
	});

	it("assembles branch-local and outer flat attributes independently", () => {
		const compiled = compileTemplateCompat(
			'<div class="outer-{{outer}}"></div>{% if active %}<span title="inner-{{inner}}-tail">X</span>{% endif %}',
		);
		const outer = attributes(compiled.nodes)[0];
		expect(outer.parts?.[0]).toEqual(staticPart("outer-"));
		expect(expressionSource(outer.parts?.[1] as AttributeExpressionPart)).toBe("outer");

		const branch = compiled.nodes.find((node) => node.kind === "if");
		if (!branch || branch.kind !== "if") throw new Error("Expected branch");
		const inner = attributes(branch.branches[0].children)[0];
		expect(inner.parts?.map((part) => part.kind)).toEqual(["static", "expression", "static"]);
		expect(inner.parts?.[0]).toEqual(staticPart("inner-"));
		expect(expressionSource(inner.parts?.[1] as AttributeExpressionPart)).toBe("inner");
		expect(inner.parts?.[2]).toEqual(staticPart("-tail"));
	});

	it("recurses through nested if/for child lists", () => {
		const compiled = compileTemplateCompat(
			'{% if active %}{% for item in items %}<div data-id={{item.id}}-{{index}}></div>{% endfor %}{% endif %}',
		);
		const branch = compiled.nodes.find((node) => node.kind === "if");
		if (!branch || branch.kind !== "if") throw new Error("Expected branch");
		const loop = branch.branches[0].children.find((node) => node.kind === "for");
		if (!loop || loop.kind !== "for") throw new Error("Expected nested loop");
		const slot = attributes(loop.children)[0];

		expect(slot.quote).toBeNull();
		expect(slot.parts?.map((part) => part.kind)).toEqual(["expression", "static", "expression"]);
		expect(expressionSource(slot.parts?.[0] as AttributeExpressionPart)).toBe("item.id");
		expect(slot.parts?.[1]).toEqual(staticPart("-"));
		expect(expressionSource(slot.parts?.[2] as AttributeExpressionPart)).toBe("index");
	});

	it("stays fail-closed when control flow splits the attribute value itself", () => {
		const compiled = compileTemplateCompat(
			'<div class="pre-{% if active %}on{% endif %}-{{name}}-post"></div>',
		);
		const slot = attributes(compiled.nodes)[0];
		expect(slot).toBeDefined();
		expect(slot.parts).toBeUndefined();
		expect(slot.quote).toBeUndefined();
	});

	it("preserves fail-soft interpolation inside a structural complete attribute", () => {
		const compiled = compileTemplateCompat(
			'{% if active %}<div data-x="pre-{{ ) }}-post"></div>{% endif %}',
		);
		const branch = compiled.nodes.find((node) => node.kind === "if");
		if (!branch || branch.kind !== "if") throw new Error("Expected branch");
		const slot = attributes(branch.branches[0].children)[0];

		expect(compiled.diagnostics).toHaveLength(1);
		expect(slot.parts?.map((part) => part.kind)).toEqual(["static", "expression", "static"]);
		expect(expressionSource(slot.parts?.[1] as AttributeExpressionPart)).toBe("null");
		expect(compiled.dependencyHints.usesDynamicLinkedFile).toBe(true);
	});
});