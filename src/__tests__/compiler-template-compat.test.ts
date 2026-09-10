import { describe, expect, it } from "vitest";
import { classifyTemplateDependencies } from "../compiler/expression-classification";
import { compileTemplateCompat } from "../compiler/template-compat";
import { compileTemplate, TemplateCompileError } from "../compiler/template-compiler";
import type { TemplateIRNode } from "../compiler/template-ir";
import { compileView } from "../compiler/view-compiler";
import type { ViewConfig } from "../types";

function findNode<T extends TemplateIRNode["kind"]>(
	nodes: readonly TemplateIRNode[],
	kind: T,
): Extract<TemplateIRNode, { kind: T }> {
	const found = nodes.find(
		(node): node is Extract<TemplateIRNode, { kind: T }> => node.kind === kind,
	);
	if (!found) throw new Error(`Missing node kind: ${kind}`);
	return found;
}

function makeView(template: string): ViewConfig {
	return {
		id: "compat-view",
		name: "Compatibility",
		template,
		rules: {
			type: "group",
			operator: "AND",
			conditions: [],
		},
	};
}

describe("compileTemplateCompat", () => {
	it("keeps strict compileTemplate throwing for authoring diagnostics", () => {
		expect(() => compileTemplate("before {{ ) }} after")).toThrow(TemplateCompileError);
	});

	it("recovers malformed interpolation as the legacy null/empty-value boundary", () => {
		const compiled = compileTemplateCompat("before {{ ) }} after");
		const slot = findNode(compiled.nodes, "text-slot");

		expect(slot.expression.expressionSource).toBe("null");
		expect(compiled.diagnostics).toHaveLength(1);
		expect(compiled.diagnostics[0]).toMatchObject({
			kind: "legacy-null-fallback",
			context: "interpolation",
			source: ")",
		});
	});

	it("recovers an empty interpolation instead of aborting the whole template", () => {
		const compiled = compileTemplateCompat("a{{   }}b");
		const slot = findNode(compiled.nodes, "text-slot");

		expect(slot.expression.expressionSource).toBe("null");
		expect(compiled.diagnostics[0]?.context).toBe("interpolation");
	});

	it("turns malformed if/elif conditions into false branches", () => {
		const compiled = compileTemplateCompat(
			"{% if ) %}bad{% elif ( %}also bad{% else %}fallback{% endif %}",
		);
		const conditional = findNode(compiled.nodes, "if");

		expect(conditional.branches).toHaveLength(3);
		expect(conditional.branches[0].condition?.expressionSource).toBe("null");
		expect(conditional.branches[1].condition?.expressionSource).toBe("null");
		expect(conditional.branches[2].condition).toBeNull();
		expect(compiled.diagnostics.map((entry) => entry.context)).toEqual([
			"if-condition",
			"elif-condition",
		]);
	});

	it("turns a malformed for iterable into the legacy no-loop value", () => {
		const compiled = compileTemplateCompat("{% for item in ) %}{{item}}{% endfor %}");
		const loop = findNode(compiled.nodes, "for");

		expect(loop.iterable.expressionSource).toBe("null");
		expect(compiled.diagnostics).toHaveLength(1);
		expect(compiled.diagnostics[0]?.context).toBe("for-iterable");
	});

	it("does not apply interpolation-style pipe filters inside legacy logic tags", () => {
		const compiled = compileTemplateCompat(
			"{% if status | upper %}yes{% endif %}{% for item in items | upper %}{{item}}{% endfor %}",
		);
		const conditional = findNode(compiled.nodes, "if");
		const loop = findNode(compiled.nodes, "for");

		expect(conditional.branches[0].condition?.expressionSource).toBe("status");
		expect(conditional.branches[0].condition?.pipeFilters).toBeNull();
		expect(loop.iterable.expressionSource).toBe("items");
		expect(loop.iterable.pipeFilters).toBeNull();
		expect(compiled.diagnostics).toEqual([]);
	});

	it("preserves the original source hash rather than hashing sanitized syntax", () => {
		const original = compileTemplateCompat("before {{ ) }} after");
		const sanitized = compileTemplate("before {{ null }} after");
		const repeated = compileTemplateCompat("before {{ ) }} after");

		expect(original.sourceHash).toBe(repeated.sourceHash);
		expect(original.sourceHash).not.toBe(sanitized.sourceHash);
	});

	it("marks recovered syntax maximally conservative instead of static", () => {
		const compiled = compileTemplateCompat("{{ ) }}");
		const classification = classifyTemplateDependencies(compiled);

		expect(compiled.dependencyHints).toMatchObject({
			usesSelfMetadata: true,
			usesSelfContent: true,
			usesDynamicLinkedFile: true,
			usesLinkedMetadata: true,
			usesLinkedContent: true,
			usesBases: true,
		});
		expect(compiled.dependencyHints.volatility).toEqual(["now", "random", "today"]);
		expect(classification.dependencyClasses).toContain("unknown-runtime-dynamic");
		expect(classification.purity).toBe("unknown");
	});

	it("leaves valid templates unchanged and diagnostic-free", () => {
		const source = "{% if status %}<p>{{title}}</p>{% endif %}";
		const strict = compileTemplate(source);
		const compatible = compileTemplateCompat(source);

		expect(compatible.nodes).toEqual(strict.nodes);
		expect(compatible.dependencyHints).toEqual(strict.dependencyHints);
		expect(compatible.sourceHash).toBe(strict.sourceHash);
		expect(compatible.diagnostics).toEqual([]);
	});
});

describe("compileView malformed-template boundary", () => {
	it("uses compatibility compilation for production-facing compiled views", () => {
		const compiled = compileView(makeView("<p>{{ ) }}</p>"), "rev-malformed");
		const slot = findNode(compiled.template.nodes, "text-slot");

		expect(slot.expression.expressionSource).toBe("null");
		expect(compiled.dependencyHints.template.usesDynamicLinkedFile).toBe(true);
	});
});
