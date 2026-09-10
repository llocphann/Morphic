import { describe, expect, it } from "vitest";
import { compileTemplateCompat } from "../compiler/template-compat";
import type {
	AttributeExpressionPart,
	AttributeSlot,
	TemplateIRNode,
} from "../compiler/template-ir";

function attributes(nodes: readonly TemplateIRNode[]): AttributeSlot[] {
	return nodes.filter((node): node is AttributeSlot => node.kind === "attribute-slot");
}

function expressionSources(slot: AttributeSlot): string[] {
	return (slot.parts ?? [])
		.filter((part): part is AttributeExpressionPart => part.kind === "expression")
		.map((part) => part.expression.expressionSource);
}

describe("template syntax does not become HTML attribute boundaries", () => {
	it("preserves the exact Bot 5 release oracle with > inside an unquoted expression", () => {
		const compiled = compileTemplateCompat(
			"<div data-ok={{score>10}} data-next=pre-{{next}}-post>X</div>",
		);
		const slots = attributes(compiled.nodes);

		expect(slots).toHaveLength(2);
		expect(slots[0]).toMatchObject({
			attribute: "data-ok",
			quote: null,
			targetKey: "element-0",
		});
		expect(expressionSources(slots[0])).toEqual(["score>10"]);
		expect(slots[1]).toMatchObject({
			attribute: "data-next",
			quote: null,
			targetKey: "element-0",
		});
		expect(expressionSources(slots[1])).toEqual(["next"]);
		expect(compiled.dependencyHints.candidateSelfProperties).toEqual(["next", "score"]);
	});

	it("preserves the same comparison boundary inside a structural branch", () => {
		const compiled = compileTemplateCompat(
			'{% if active %}<div data-ok={{score>10}} data-next=pre-{{next}}-post>X</div>{% endif %}',
		);
		const conditional = compiled.nodes.find((node) => node.kind === "if");
		if (!conditional || conditional.kind !== "if") throw new Error("Expected conditional");
		const slots = attributes(conditional.branches[0].children);

		expect(slots).toHaveLength(2);
		expect(slots.map((slot) => slot.attribute)).toEqual(["data-ok", "data-next"]);
		expect(slots.every((slot) => slot.quote === null && slot.parts !== undefined)).toBe(true);
		expect(expressionSources(slots[0])).toEqual(["score>10"]);
		expect(expressionSources(slots[1])).toEqual(["next"]);
	});

	it("ignores < and quote characters authored inside earlier template expressions", () => {
		const compiled = compileTemplateCompat(
			`<div data-low={{score<10}} title="{{concat('a', '>')}}-{{next}}-tail">X</div>`,
		);
		const slots = attributes(compiled.nodes);

		expect(slots).toHaveLength(2);
		expect(slots[0]).toMatchObject({ attribute: "data-low", quote: null, targetKey: "element-0" });
		expect(expressionSources(slots[0])).toEqual(["score<10"]);
		expect(slots[1]).toMatchObject({ attribute: "title", quote: '"', targetKey: "element-0" });
		expect(expressionSources(slots[1])).toEqual(["concat('a', '>')", "next"]);
	});
});