import { describe, expect, it } from "vitest";
import type { CompiledExpression } from "../compiler/expression-compiler";
import type { TemplateIRNode } from "../compiler/template-ir";
import type { ExprContext } from "../expression";
import type { RetainedStructureContext } from "../render/retained-slot-runtime";
import {
	RetainedConditionalMixedBranchPlanError,
	RetainedProductionConditionalMixedBranchPlan,
	inspectRetainedProductionConditionalMixedBranchSupport,
} from "../render/retained-production-conditional-mixed-branch-plan";

function createOwnerDocument(): Document {
	return new DOMParser().parseFromString(
		"<!doctype html><html><body></body></html>",
		"text/html",
	);
}

function expression(source: string): CompiledExpression {
	return { source } as unknown as CompiledExpression;
}

function context(variables: Record<string, unknown> = {}): ExprContext {
	return { variables } as unknown as ExprContext;
}

function mixedChildren(): TemplateIRNode[] {
	return [
		{ kind: "static-fragment", html: "<div>" },
		{ kind: "text-slot", id: "title", expression: expression("title") },
		{ kind: "markdown-slot", id: "body", expression: expression("markdown") },
		{ kind: "content-slot", id: "content", expression: expression("content") },
		{ kind: "static-fragment", html: "</div>" },
	];
}

describe("RetainedProductionConditionalMixedBranchPlan", () => {
	it("accepts Markdown and content slots while retaining typed slot metadata", () => {
		const support = inspectRetainedProductionConditionalMixedBranchSupport(mixedChildren());
		expect(support).toEqual({ supported: true });

		const plan = new RetainedProductionConditionalMixedBranchPlan(
			createOwnerDocument(),
			"source-a",
			2,
			mixedChildren(),
		);
		expect(plan.syncSlots).toEqual([{ id: "title", kind: "text" }]);
		expect(plan.asyncSlots.map(({ id, kind }) => ({ id, kind }))).toEqual([
			{ id: "body", kind: "markdown" },
			{ id: "content", kind: "content" },
		]);
	});

	it("builds detached Markdown and content placeholders in the supplied owner document", () => {
		const ownerDocument = createOwnerDocument();
		const plan = new RetainedProductionConditionalMixedBranchPlan(
			ownerDocument,
			"source-b",
			0,
			mixedChildren(),
		);
		const fragment = ownerDocument.createDocumentFragment();
		const markdownTargets: HTMLElement[] = [];
		const contentTargets: HTMLElement[] = [];
		const buildContext: RetainedStructureContext = {
			ownerDocument,
			fragment,
			textSlot: (_id, initialValue) => ownerDocument.createTextNode(String(initialValue ?? "")),
			attributeSlot: () => undefined,
			rawHtmlSlot: () => undefined,
			markdownSlot: (_id, element) => markdownTargets.push(element),
			contentSlot: (_id, element) => contentTargets.push(element),
		};

		plan.builder()(buildContext);
		expect(markdownTargets).toHaveLength(1);
		expect(markdownTargets[0].ownerDocument).toBe(ownerDocument);
		expect(markdownTargets[0].tagName).toBe("SPAN");
		expect(contentTargets).toHaveLength(1);
		expect(contentTargets[0].ownerDocument).toBe(ownerDocument);
		expect(contentTargets[0].classList.contains("markdown-rendered-content")).toBe(true);
	});

	it("evaluates set, sync, Markdown, and content expressions in lexical order", async () => {
		const ownerDocument = createOwnerDocument();
		const children: TemplateIRNode[] = [
			{ kind: "set", variable: "phase", expression: expression("set-alpha") },
			{ kind: "text-slot", id: "text", expression: expression("read-text") },
			{ kind: "markdown-slot", id: "markdown", expression: expression("read-markdown") },
			{ kind: "set", variable: "phase", expression: expression("set-bravo") },
			{ kind: "content-slot", id: "content", expression: expression("read-content") },
		];
		const plan = new RetainedProductionConditionalMixedBranchPlan(
			ownerDocument,
			"source-c",
			0,
			children,
		);
		const result = await plan.evaluate(context({ phase: "Initial" }), async (compiled, runtimeContext) => {
			if (compiled.source === "set-alpha") return "Alpha";
			if (compiled.source === "set-bravo") return "Bravo";
			const phase = runtimeContext.variables.phase;
			if (typeof phase !== "string") {
				throw new Error("Expected branch-local phase to be a string");
			}
			return `${compiled.source}:${phase}`;
		});

		expect(result.status).toBe("resolved");
		if (result.status !== "resolved") return;
		expect(result.syncValues.get("text")).toBe("read-text:Alpha");
		expect(result.asyncValues.get("markdown")).toBe("read-markdown:Alpha");
		expect(result.asyncValues.get("content")).toBe("read-content:Bravo");
	});

	it("assembles complete attributes with DOMParser-equivalent static decoding", async () => {
		const ownerDocument = createOwnerDocument();
		const plan = new RetainedProductionConditionalMixedBranchPlan(
			ownerDocument,
			"source-d",
			0,
			[
				{
					kind: "attribute-slot",
					id: "class-slot",
					attribute: "class",
					expression: expression("attribute"),
					targetKey: "target-0",
					quote: "\"",
					parts: [
						{ kind: "static", value: "A&amp;B ", encoding: "html-attribute-source" },
						{ kind: "expression", expression: expression("suffix") },
					],
				},
			],
		);
		const result = await plan.evaluate(context(), async () => "Dynamic");

		expect(result.status).toBe("resolved");
		if (result.status !== "resolved") return;
		expect(result.syncValues.get("class-slot")).toBe("A&B Dynamic");
	});

	it("returns stale without publishing partial values when generation currentness changes", async () => {
		const ownerDocument = createOwnerDocument();
		const plan = new RetainedProductionConditionalMixedBranchPlan(
			ownerDocument,
			"source-e",
			0,
			[
				{ kind: "text-slot", id: "text", expression: expression("text") },
				{ kind: "markdown-slot", id: "markdown", expression: expression("markdown") },
			],
		);
		let current = true;
		const result = await plan.evaluate(
			context(),
			async () => {
				current = false;
				return "Staged";
			},
			() => current,
		);
		expect(result).toEqual({ status: "stale" });
	});

	it("returns evaluator failures without weakening the branch support contract", async () => {
		const failure = new Error("Evaluation failed");
		const plan = new RetainedProductionConditionalMixedBranchPlan(
			createOwnerDocument(),
			"source-f",
			0,
			[{ kind: "markdown-slot", id: "markdown", expression: expression("markdown") }],
		);
		const result = await plan.evaluate(context(), async () => {
			throw failure;
		});
		expect(result).toEqual({ status: "failed", error: failure });
	});

	it("rejects raw HTML until the transactional raw-HTML child range is composed", () => {
		const support = inspectRetainedProductionConditionalMixedBranchSupport([
			{
				kind: "raw-html-slot",
				id: "raw",
				expression: expression("raw"),
				explicitRawHtml: true,
			},
		]);
		expect(support).toMatchObject({
			supported: false,
			code: "raw-html-range",
			path: "children[0]",
		});
	});

	it("rejects nested conditional and loop control flow", () => {
		for (const child of [
			{ kind: "if", branches: [{ condition: null, children: [] }] },
			{
				kind: "for",
				iterable: expression("items"),
				itemVariable: "item",
				children: [],
			},
		] as const) {
			const support = inspectRetainedProductionConditionalMixedBranchSupport([
				child,
			]);
			expect(support).toMatchObject({
				supported: false,
				code: "nested-structural-control-flow",
			});
		}
	});

	it("rejects non-text generic expression contexts", () => {
		const support = inspectRetainedProductionConditionalMixedBranchSupport([
			{
				kind: "expression-slot",
				id: "markdown-expression",
				expression: expression("value"),
				context: "markdown",
			},
		]);
		expect(support).toMatchObject({
			supported: false,
			code: "non-text-expression-context",
			path: "children[0]",
		});
	});

	it("rejects incomplete attribute metadata before a plan is built", () => {
		const children: TemplateIRNode[] = [
			{
				kind: "attribute-slot",
				id: "class-slot",
				attribute: "class",
				expression: expression("value"),
			},
		];
		const support = inspectRetainedProductionConditionalMixedBranchSupport(children);
		expect(support).toMatchObject({ supported: false, code: "attribute-slot" });
		expect(() => new RetainedProductionConditionalMixedBranchPlan(
			createOwnerDocument(),
			"source-g",
			0,
			children,
		)).toThrow(RetainedConditionalMixedBranchPlanError);
	});

	it("uses branch identity in the retained structure key", () => {
		const ownerDocument = createOwnerDocument();
		const first = new RetainedProductionConditionalMixedBranchPlan(
			ownerDocument,
			"same-source",
			0,
			mixedChildren(),
		);
		const second = new RetainedProductionConditionalMixedBranchPlan(
			ownerDocument,
			"same-source",
			1,
			mixedChildren(),
		);
		expect(first.plan.structureKey).not.toBe(second.plan.structureKey);
	});
});
