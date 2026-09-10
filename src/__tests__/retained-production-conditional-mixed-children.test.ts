import { describe, expect, it, vi } from "vitest";
import {
	compileExpression,
	type CompiledExpression,
} from "../compiler/expression-compiler";
import type { IfNode, TemplateIRNode } from "../compiler/template-ir";
import type { ExprContext, ExprValue } from "../expression";
import { RetainedCommitTransaction } from "../render/retained-commit-transaction";
import {
	RetainedProductionConditionalMixedChildren,
	type RetainedProductionConditionalMixedIslandFactory,
} from "../render/retained-production-conditional-mixed-children";

function createOwnerDocument(): Document {
	return new DOMParser().parseFromString(
		"<!doctype html><html><body></body></html>",
		"text/html",
	);
}

function createParent(): { ownerDocument: Document; parent: HTMLElement } {
	const ownerDocument = createOwnerDocument();
	const parent = ownerDocument.createElement("div");
	ownerDocument.body.appendChild(parent);
	return { ownerDocument, parent };
}

const compiledExpressionTemplate = compileExpression("null");

function expression(source: string): CompiledExpression {
	return {
		...compiledExpressionTemplate,
		source,
		expressionSource: source,
	};
}

function context(variables: Record<string, ExprValue> = {}): ExprContext {
	return Object.assign(Object.create(null), { variables });
}

function requireString(value: ExprValue): string {
	if (typeof value !== "string") {
		throw new Error("Expected branch-local phase to be a string");
	}
	return value;
}

function ifNode(branches: IfNode["branches"]): IfNode {
	return { kind: "if", branches };
}

function mixedBranch(prefix: string): TemplateIRNode[] {
	return [
		{ kind: "static-fragment", html: `<section data-branch="${prefix}">` },
		{ kind: "text-slot", id: "title", expression: expression(`${prefix}:title`) },
		{ kind: "markdown-slot", id: "body", expression: expression(`${prefix}:body`) },
		{ kind: "static-fragment", html: "</section>" },
	];
}

function islandFactory(
	seen: string[] = [],
): RetainedProductionConditionalMixedIslandFactory {
	return ({ value }) => {
		seen.push(value);
		return {
			renderKey: value,
			renderer: async ({ container, ownerDocument }) => {
				const strong = ownerDocument.createElement("strong");
				strong.textContent = value;
				container.appendChild(strong);
			},
		};
	};
}

type EvaluatorValue = ExprValue | ((ctx: ExprContext) => ExprValue);

function evaluator(values: Record<string, EvaluatorValue>) {
	return async (
		compiled: CompiledExpression,
		runtimeContext: ExprContext,
	): Promise<ExprValue> => {
		const value = values[compiled.source];
		return typeof value === "function" ? value(runtimeContext) : value;
	};
}

describe("RetainedProductionConditionalMixedChildren", () => {
	it("commits selected branch sync values and Markdown through one retained transaction", async () => {
		const { parent } = createParent();
		const runtime = new RetainedProductionConditionalMixedChildren(parent, {
			evaluateExpression: evaluator({
				"a:title": "Alpha",
				"a:body": "Markdown A",
			}),
		});
		const prepared = await runtime.prepare({
			node: ifNode([{ condition: null, children: mixedBranch("a") }]),
			sourceHash: "source-a",
			expressionContext: context(),
			createIsland: islandFactory(),
		});

		expect(prepared.status).toBe("prepared");
		if (prepared.status !== "prepared") return;
		expect(prepared.selectedIndex).toBe(0);
		expect(prepared.syncParticipantCount).toBe(2);
		expect(prepared.islandParticipantCount).toBe(1);
		expect(prepared.commit(new RetainedCommitTransaction(() => true))).toEqual({ status: "committed" });

		const branch = parent.querySelector<HTMLElement>("[data-branch='a']");
		expect(branch?.textContent).toBe("AlphaMarkdown A");
		expect(branch?.querySelector("strong")?.textContent).toBe("Markdown A");
		expect(runtime.activeIndex).toBe(0);
	});

	it("preserves branch-local set ordering without mutating caller variables", async () => {
		const { parent } = createParent();
		const caller = context({ phase: "Caller" });
		const seen: string[] = [];
		const runtime = new RetainedProductionConditionalMixedChildren(parent, {
			evaluateExpression: async (compiled, runtimeContext) => {
				if (compiled.source === "set-phase") return "Branch";
				const phase = requireString(runtimeContext.variables.phase);
				return `${compiled.source}:${phase}`;
			},
		});
		const prepared = await runtime.prepare({
			node: ifNode([{ condition: null, children: [
				{ kind: "static-fragment", html: "<div>" },
				{ kind: "set", variable: "phase", expression: expression("set-phase") },
				{ kind: "text-slot", id: "title", expression: expression("text") },
				{ kind: "markdown-slot", id: "body", expression: expression("markdown") },
				{ kind: "static-fragment", html: "</div>" },
			] }]),
			sourceHash: "source-set",
			expressionContext: caller,
			createIsland: islandFactory(seen),
		});

		expect(prepared.status).toBe("prepared");
		if (prepared.status !== "prepared") return;
		expect(prepared.commit(new RetainedCommitTransaction(() => true)).status).toBe("committed");
		expect(parent.textContent).toBe("text:Branchmarkdown:Branch");
		expect(seen).toEqual(["markdown:Branch"]);
		expect(caller.variables.phase).toBe("Caller");
	});

	it("updates only the async island when the same active branch has unchanged sync values", async () => {
		const { parent } = createParent();
		const values: Record<string, EvaluatorValue> = {
			"a:title": "Stable",
			"a:body": "First",
		};
		const runtime = new RetainedProductionConditionalMixedChildren(parent, {
			evaluateExpression: evaluator(values),
		});
		const request = () => ({
			node: ifNode([{ condition: null, children: mixedBranch("a") }]),
			sourceHash: "source-same",
			expressionContext: context(),
			createIsland: islandFactory(),
		});
		const first = await runtime.prepare(request());
		expect(first.status).toBe("prepared");
		if (first.status !== "prepared") return;
		expect(first.commit(new RetainedCommitTransaction(() => true)).status).toBe("committed");
		const branch = parent.querySelector<HTMLElement>("[data-branch='a']");
		const textNode = branch?.firstChild;
		const oldIslandNode = branch?.querySelector("strong");

		values["a:body"] = "Second";
		const second = await runtime.prepare(request());
		expect(second.status).toBe("prepared");
		if (second.status !== "prepared") return;
		expect(second.syncParticipantCount).toBe(0);
		expect(second.islandParticipantCount).toBe(1);
		expect(second.commit(new RetainedCommitTransaction(() => true)).status).toBe("committed");

		const retainedBranch = parent.querySelector<HTMLElement>("[data-branch='a']");
		expect(retainedBranch).toBe(branch);
		expect(retainedBranch?.firstChild).toBe(textNode);
		expect(retainedBranch?.querySelector("strong")?.textContent).toBe("Second");
		expect(retainedBranch?.querySelector("strong")).not.toBe(oldIslandNode);
	});

	it("keeps branch authority in the async-only same-branch path so newer work stales older preparation", async () => {
		const { parent } = createParent();
		const values: Record<string, EvaluatorValue> = {
			"a:title": "Stable",
			"a:body": "First",
		};
		const runtime = new RetainedProductionConditionalMixedChildren(parent, {
			evaluateExpression: evaluator(values),
		});
		const request = () => ({
			node: ifNode([{ condition: null, children: mixedBranch("a") }]),
			sourceHash: "source-authority",
			expressionContext: context(),
			createIsland: islandFactory(),
		});
		const initial = await runtime.prepare(request());
		expect(initial.status).toBe("prepared");
		if (initial.status !== "prepared") return;
		expect(initial.commit(new RetainedCommitTransaction(() => true)).status).toBe("committed");

		values["a:body"] = "Older";
		const older = await runtime.prepare(request());
		expect(older.status).toBe("prepared");
		if (older.status !== "prepared") return;
		expect(older.syncParticipantCount).toBe(0);

		values["a:body"] = "Newer";
		const newer = await runtime.prepare(request());
		expect(newer.status).toBe("prepared");
		if (newer.status !== "prepared") return;
		expect(older.commit(new RetainedCommitTransaction(() => true)).status).toBe("stale");
		expect(newer.commit(new RetainedCommitTransaction(() => true)).status).toBe("committed");
		expect(parent.querySelector("strong")?.textContent).toBe("Newer");
	});

	it("rolls back branch structure and island identity when owner currentness is lost after apply", async () => {
		const { parent } = createParent();
		const values: Record<string, EvaluatorValue> = {
			flag: true,
			"a:title": "A",
			"a:body": "Body A",
			"b:title": "B",
			"b:body": "Body B",
		};
		const runtime = new RetainedProductionConditionalMixedChildren(parent, {
			evaluateExpression: evaluator(values),
		});
		const request = () => ({
			node: ifNode([
				{ condition: expression("flag"), children: mixedBranch("a") },
				{ condition: null, children: mixedBranch("b") },
			]),
			sourceHash: "source-switch",
			expressionContext: context(),
			createIsland: islandFactory(),
		});
		const first = await runtime.prepare(request());
		expect(first.status).toBe("prepared");
		if (first.status !== "prepared") return;
		expect(first.commit(new RetainedCommitTransaction(() => true)).status).toBe("committed");
		const oldBranch = parent.querySelector<HTMLElement>("[data-branch='a']");
		const oldIslandNode = oldBranch?.querySelector("strong");

		values.flag = false;
		const switched = await runtime.prepare(request());
		expect(switched.status).toBe("prepared");
		if (switched.status !== "prepared") return;
		let checks = 0;
		const result = switched.commit(new RetainedCommitTransaction(() => ++checks < 6));
		expect(result.status).toBe("stale");
		expect(runtime.activeIndex).toBe(0);
		expect(parent.querySelector<HTMLElement>("[data-branch='a']")).toBe(oldBranch);
		expect(parent.querySelector("strong")).toBe(oldIslandNode);
		expect(parent.querySelector("[data-branch='b']")).toBeNull();
	});

	it("clears the retained branch transactionally when no condition remains selected", async () => {
		const { parent } = createParent();
		const values: Record<string, EvaluatorValue> = {
			flag: true,
			"a:title": "A",
			"a:body": "Body A",
		};
		const runtime = new RetainedProductionConditionalMixedChildren(parent, {
			evaluateExpression: evaluator(values),
		});
		const request = () => ({
			node: ifNode([{ condition: expression("flag"), children: mixedBranch("a") }]),
			sourceHash: "source-clear",
			expressionContext: context(),
			createIsland: islandFactory(),
		});
		const first = await runtime.prepare(request());
		expect(first.status).toBe("prepared");
		if (first.status !== "prepared") return;
		expect(first.commit(new RetainedCommitTransaction(() => true)).status).toBe("committed");

		values.flag = false;
		const cleared = await runtime.prepare(request());
		expect(cleared.status).toBe("prepared");
		if (cleared.status !== "prepared") return;
		expect(cleared.selectedIndex).toBeNull();
		expect(cleared.islandParticipantCount).toBe(0);
		expect(cleared.commit(new RetainedCommitTransaction(() => true)).status).toBe("committed");
		expect(runtime.activeIndex).toBeNull();
		expect(parent.querySelector("[data-branch='a']")).toBeNull();
	});

	it("fails closed before condition evaluation when any branch contains unsupported structure", async () => {
		const { parent } = createParent();
		const evaluateExpression = vi.fn(async () => true);
		const runtime = new RetainedProductionConditionalMixedChildren(parent, { evaluateExpression });
		const result = await runtime.prepare({
			node: ifNode([{
				condition: expression("condition"),
				children: [{
					kind: "raw-html-slot",
					id: "raw",
					expression: expression("raw"),
					explicitRawHtml: true,
				}],
			}]),
			sourceHash: "source-fallback",
			expressionContext: context(),
			createIsland: islandFactory(),
		});

		expect(result).toMatchObject({
			status: "fallback",
			code: "raw-html-range",
			path: "branches[0].children[0]",
		});
		expect(evaluateExpression).not.toHaveBeenCalled();
	});

	it("returns failure from owner island binding without publishing the prepared branch", async () => {
		const { parent } = createParent();
		const runtime = new RetainedProductionConditionalMixedChildren(parent, {
			evaluateExpression: evaluator({
				"a:title": "A",
				"a:body": "Body A",
			}),
		});
		const failure = new Error("Owner identity unavailable");
		const result = await runtime.prepare({
			node: ifNode([{ condition: null, children: mixedBranch("a") }]),
			sourceHash: "source-owner-failure",
			expressionContext: context(),
			createIsland: () => {
				throw failure;
			},
		});

		expect(result.status).toBe("failed");
		if (result.status !== "failed") return;
		expect(result.error).toBe(failure);
		expect(runtime.activeIndex).toBeNull();
		expect(parent.querySelector("[data-branch='a']")).toBeNull();
	});

	it("uses a zero-island authority source for supported sync-only branches", async () => {
		const { parent } = createParent();
		const runtime = new RetainedProductionConditionalMixedChildren(parent, {
			evaluateExpression: evaluator({ title: "Only text" }),
		});
		const request = {
			node: ifNode([{ condition: null, children: [
				{ kind: "static-fragment", html: "<p>" },
				{ kind: "text-slot", id: "title", expression: expression("title") },
				{ kind: "static-fragment", html: "</p>" },
			] }]),
			sourceHash: "source-sync-only",
			expressionContext: context(),
			createIsland: islandFactory(),
		};
		const first = await runtime.prepare(request);
		expect(first.status).toBe("prepared");
		if (first.status !== "prepared") return;
		expect(first.islandParticipantCount).toBe(0);
		expect(first.commit(new RetainedCommitTransaction(() => true)).status).toBe("committed");
		expect(parent.textContent).toBe("Only text");

		const second = await runtime.prepare(request);
		expect(second).toMatchObject({ status: "unchanged", selectedIndex: 0 });
	});
});
