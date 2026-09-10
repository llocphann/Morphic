import { describe, expect, it, vi } from "vitest";
import type { CompiledExpression } from "../compiler/expression-compiler";
import type {
	AttributeSlot,
	IfBranch,
	IfNode,
	TemplateIRNode,
} from "../compiler/template-ir";
import type { ExprContext, ExprValue } from "../expression";
import { RetainedCommitTransaction } from "../render/retained-commit-transaction";
import {
	RetainedProductionConditionalSyncChildren,
	type RetainedProductionConditionalSyncEvaluator,
} from "../render/retained-production-conditional-sync-children";

function createOwnerDocument(): Document {
	return new DOMParser().parseFromString(
		"<!doctype html><html><body></body></html>",
		"text/html",
	);
}

function parentIn(ownerDocument: Document): HTMLElement {
	const parent = ownerDocument.createElement("div");
	ownerDocument.body.appendChild(parent);
	return parent;
}

function expression(source: string): CompiledExpression {
	return { source } as unknown as CompiledExpression;
}

function context(variables: Record<string, ExprValue> = {}): ExprContext {
	return { variables } as unknown as ExprContext;
}

function branch(
	condition: CompiledExpression | null,
	children: readonly TemplateIRNode[],
): IfBranch {
	return { condition, children };
}

function ifNode(...branches: IfBranch[]): IfNode {
	return { kind: "if", branches };
}

function textChildren(id = "value", source = "value"): TemplateIRNode[] {
	return [
		{ kind: "static-fragment", html: "<span>" },
		{ kind: "text-slot", id, expression: expression(source) },
		{ kind: "static-fragment", html: "</span>" },
	];
}

function completeAttributeSlot(id = "label", source = "label"): AttributeSlot {
	const dynamic = expression(source);
	return {
		kind: "attribute-slot",
		id,
		expression: dynamic,
		attribute: "data-label",
		targetKey: "article",
		quote: "\"",
		parts: [
			{ kind: "static", value: "pre-&amp;", encoding: "html-attribute-source" },
			{ kind: "expression", expression: dynamic },
			{ kind: "static", value: "-post", encoding: "html-attribute-source" },
		],
	};
}

function attributeChildren(): TemplateIRNode[] {
	return [
		{ kind: "static-fragment", html: "<article data-label=\"" },
		completeAttributeSlot(),
		{ kind: "static-fragment", html: "\"><span>" },
		{ kind: "text-slot", id: "value", expression: expression("value") },
		{ kind: "static-fragment", html: "</span></article>" },
	];
}

function evaluatorFrom(
	values: Record<string, ExprValue>,
): RetainedProductionConditionalSyncEvaluator {
	return vi.fn(async (compiled) => values[compiled.source]);
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

describe("RetainedProductionConditionalSyncChildren", () => {
	it("builds and initializes a selected static/text branch off-DOM before commit", async () => {
		const ownerDocument = createOwnerDocument();
		const parent = parentIn(ownerDocument);
		const composer = new RetainedProductionConditionalSyncChildren(parent, {
			evaluateExpression: evaluatorFrom({ show: true, value: "Prepared" }),
		});
		const prepared = await composer.prepare({
			node: ifNode(branch(expression("show"), textChildren())),
			sourceHash: "template-a",
			expressionContext: context(),
		});

		expect(prepared.status).toBe("prepared");
		if (prepared.status !== "prepared") return;
		expect(parent.textContent).toBe("");
		expect(prepared.participantCount).toBe(2);
		expect(prepared.commit(new RetainedCommitTransaction(() => true))).toEqual({
			status: "committed",
		});
		expect(parent.textContent).toBe("Prepared");
		expect(composer.activeIndex).toBe(0);
	});

	it("assembles complete attributes with DOMParser-equivalent static decoding before branch commit", async () => {
		const ownerDocument = createOwnerDocument();
		const parent = parentIn(ownerDocument);
		const composer = new RetainedProductionConditionalSyncChildren(parent, {
			evaluateExpression: evaluatorFrom({ show: true, label: "X", value: "Body" }),
		});
		const prepared = await composer.prepare({
			node: ifNode(branch(expression("show"), attributeChildren())),
			sourceHash: "template-attr",
			expressionContext: context(),
		});

		expect(prepared.status).toBe("prepared");
		if (prepared.status !== "prepared") return;
		expect(parent.querySelector("article")).toBeNull();
		expect(prepared.commit(new RetainedCommitTransaction(() => true)).status).toBe("committed");
		const article = parent.querySelector("article");
		expect(article?.getAttribute("data-label")).toBe("pre-&X-post");
		expect(article?.textContent).toBe("Body");
	});

	it("keeps the exact same active DOM and does zero live patch work when resolved values are unchanged", async () => {
		const ownerDocument = createOwnerDocument();
		const parent = parentIn(ownerDocument);
		const values: Record<string, ExprValue> = { show: true, value: "Stable" };
		const composer = new RetainedProductionConditionalSyncChildren(parent, {
			evaluateExpression: evaluatorFrom(values),
		});
		const request = {
			node: ifNode(branch(expression("show"), textChildren())),
			sourceHash: "template-stable",
			expressionContext: context(),
		};
		const first = await composer.prepare(request);
		expect(first.status).toBe("prepared");
		if (first.status !== "prepared") return;
		first.commit(new RetainedCommitTransaction(() => true));
		const stableElement = parent.querySelector("span");
		const stableText = stableElement?.firstChild;
		const stableSlots = composer.activeSlots;

		const second = await composer.prepare(request);
		expect(second.status).toBe("unchanged");
		expect(parent.querySelector("span")).toBe(stableElement);
		expect(parent.querySelector("span")?.firstChild).toBe(stableText);
		expect(composer.activeSlots).toBe(stableSlots);
		expect(parent.textContent).toBe("Stable");
	});

	it("defers same-active live text patches until the owner transaction and preserves node identity", async () => {
		const ownerDocument = createOwnerDocument();
		const parent = parentIn(ownerDocument);
		const values: Record<string, ExprValue> = { show: true, value: "Old" };
		const composer = new RetainedProductionConditionalSyncChildren(parent, {
			evaluateExpression: evaluatorFrom(values),
		});
		const request = {
			node: ifNode(branch(expression("show"), textChildren())),
			sourceHash: "template-patch",
			expressionContext: context(),
		};
		const first = await composer.prepare(request);
		expect(first.status).toBe("prepared");
		if (first.status !== "prepared") return;
		first.commit(new RetainedCommitTransaction(() => true));
		const stableElement = parent.querySelector("span");
		const stableText = stableElement?.firstChild;

		values.value = "New";
		const second = await composer.prepare(request);
		expect(second.status).toBe("prepared");
		if (second.status !== "prepared") return;
		expect(second.participantCount).toBe(1);
		expect(parent.textContent).toBe("Old");
		expect(second.commit(new RetainedCommitTransaction(() => true)).status).toBe("committed");
		expect(parent.textContent).toBe("New");
		expect(parent.querySelector("span")).toBe(stableElement);
		expect(parent.querySelector("span")?.firstChild).toBe(stableText);
	});

	it("rolls back a same-active patch when the owner becomes stale after live apply", async () => {
		const ownerDocument = createOwnerDocument();
		const parent = parentIn(ownerDocument);
		const values: Record<string, ExprValue> = { show: true, value: "Old" };
		const composer = new RetainedProductionConditionalSyncChildren(parent, {
			evaluateExpression: evaluatorFrom(values),
		});
		const request = {
			node: ifNode(branch(expression("show"), textChildren())),
			sourceHash: "template-rollback",
			expressionContext: context(),
		};
		const first = await composer.prepare(request);
		expect(first.status).toBe("prepared");
		if (first.status !== "prepared") return;
		first.commit(new RetainedCommitTransaction(() => true));
		const stableText = parent.querySelector("span")?.firstChild;

		values.value = "Transient";
		const second = await composer.prepare(request);
		expect(second.status).toBe("prepared");
		if (second.status !== "prepared") return;
		let ownerChecks = 0;
		const result = second.commit(new RetainedCommitTransaction(() => ++ownerChecks < 3));
		expect(result.status).toBe("stale");
		expect(parent.textContent).toBe("Old");
		expect(parent.querySelector("span")?.firstChild).toBe(stableText);
	});

	it("initializes a changed branch detached and preserves exact old branch identity when the owner gate rejects commit", async () => {
		const ownerDocument = createOwnerDocument();
		const parent = parentIn(ownerDocument);
		const values: Record<string, ExprValue> = {
			first: true,
			second: false,
			firstValue: "First",
			secondValue: "Second",
		};
		const composer = new RetainedProductionConditionalSyncChildren(parent, {
			evaluateExpression: evaluatorFrom(values),
		});
		const request = {
			node: ifNode(
				branch(expression("first"), textChildren("first-text", "firstValue")),
				branch(expression("second"), textChildren("second-text", "secondValue")),
			),
			sourceHash: "template-switch",
			expressionContext: context(),
		};
		const first = await composer.prepare(request);
		expect(first.status).toBe("prepared");
		if (first.status !== "prepared") return;
		first.commit(new RetainedCommitTransaction(() => true));
		const stableNode = parent.querySelector("span");

		values.first = false;
		values.second = true;
		const second = await composer.prepare(request);
		expect(second.status).toBe("prepared");
		if (second.status !== "prepared") return;
		expect(parent.textContent).toBe("First");
		expect(second.commit(new RetainedCommitTransaction(() => false)).status).toBe("stale");
		expect(parent.querySelector("span")).toBe(stableNode);
		expect(parent.textContent).toBe("First");
	});

	it("applies set variables sequentially before later child expressions", async () => {
		const ownerDocument = createOwnerDocument();
		const parent = parentIn(ownerDocument);
		const evaluate = vi.fn(async (compiled: CompiledExpression, current: ExprContext) => {
			if (compiled.source === "show") return true;
			if (compiled.source === "set-value") return "Assigned";
			if (compiled.source === "read-local") return current.variables.local;
			return null;
		});
		const composer = new RetainedProductionConditionalSyncChildren(parent, {
			evaluateExpression: evaluate,
		});
		const children: TemplateIRNode[] = [
			{ kind: "set", variable: "local", expression: expression("set-value") },
			{ kind: "static-fragment", html: "<span>" },
			{ kind: "text-slot", id: "value", expression: expression("read-local") },
			{ kind: "static-fragment", html: "</span>" },
		];
		const prepared = await composer.prepare({
			node: ifNode(branch(expression("show"), children)),
			sourceHash: "template-set",
			expressionContext: context({ untouched: "yes" }),
		});
		expect(prepared.status).toBe("prepared");
		if (prepared.status !== "prepared") return;
		prepared.commit(new RetainedCommitTransaction(() => true));
		expect(parent.textContent).toBe("Assigned");
	});

	it("fails closed on unsupported branch children before any condition expression evaluates", async () => {
		const ownerDocument = createOwnerDocument();
		const evaluate = vi.fn(async () => true);
		const composer = new RetainedProductionConditionalSyncChildren(parentIn(ownerDocument), {
			evaluateExpression: evaluate,
		});
		const unsupported: TemplateIRNode = {
			kind: "markdown-slot",
			id: "markdown",
			expression: expression("markdown"),
		};
		const result = await composer.prepare({
			node: ifNode(
				branch(expression("show"), textChildren()),
				branch(null, [unsupported]),
			),
			sourceHash: "template-fallback",
			expressionContext: context(),
		});
		expect(result).toMatchObject({
			status: "fallback",
			code: "async-island",
			path: "branches[1].children[0]",
		});
		expect(evaluate).not.toHaveBeenCalled();
	});

	it("lets a newer fallback request stale an older prepared branch without mutating live DOM", async () => {
		const ownerDocument = createOwnerDocument();
		const parent = parentIn(ownerDocument);
		const composer = new RetainedProductionConditionalSyncChildren(parent, {
			evaluateExpression: evaluatorFrom({ show: true, value: "Old prepared" }),
		});
		const older = await composer.prepare({
			node: ifNode(branch(expression("show"), textChildren())),
			sourceHash: "template-old",
			expressionContext: context(),
		});
		expect(older.status).toBe("prepared");
		if (older.status !== "prepared") return;

		const newer = await composer.prepare({
			node: ifNode(branch(expression("show"), [{
				kind: "raw-html-slot",
				id: "raw",
				expression: expression("raw"),
				explicitRawHtml: true,
			}])),
			sourceHash: "template-new",
			expressionContext: context(),
		});
		expect(newer.status).toBe("fallback");
		expect(older.isCurrent()).toBe(false);
		expect(older.commit(new RetainedCommitTransaction(() => true)).status).toBe("stale");
		expect(parent.textContent).toBe("");
	});

	it("discards a staged changed branch when child evaluation fails and preserves last-known-good DOM", async () => {
		const ownerDocument = createOwnerDocument();
		const parent = parentIn(ownerDocument);
		const values: Record<string, ExprValue> = {
			first: true,
			second: false,
			firstValue: "Stable",
			secondValue: "Wrong",
		};
		let failSecond = false;
		const composer = new RetainedProductionConditionalSyncChildren(parent, {
			evaluateExpression: vi.fn(async (compiled) => {
				if (failSecond && compiled.source === "secondValue") throw new Error("Child failed");
				return values[compiled.source];
			}),
		});
		const request = {
			node: ifNode(
				branch(expression("first"), textChildren("first-text", "firstValue")),
				branch(expression("second"), textChildren("second-text", "secondValue")),
			),
			sourceHash: "template-failure",
			expressionContext: context(),
		};
		const first = await composer.prepare(request);
		expect(first.status).toBe("prepared");
		if (first.status !== "prepared") return;
		first.commit(new RetainedCommitTransaction(() => true));
		const stableNode = parent.querySelector("span");

		values.first = false;
		values.second = true;
		failSecond = true;
		const failed = await composer.prepare(request);
		expect(failed.status).toBe("failed");
		expect(parent.querySelector("span")).toBe(stableNode);
		expect(parent.textContent).toBe("Stable");
	});

	it("clears the selected branch transactionally and resets the child snapshot", async () => {
		const ownerDocument = createOwnerDocument();
		const parent = parentIn(ownerDocument);
		const values: Record<string, ExprValue> = { show: true, value: "Visible" };
		const composer = new RetainedProductionConditionalSyncChildren(parent, {
			evaluateExpression: evaluatorFrom(values),
		});
		const request = {
			node: ifNode(branch(expression("show"), textChildren())),
			sourceHash: "template-clear",
			expressionContext: context(),
		};
		const first = await composer.prepare(request);
		expect(first.status).toBe("prepared");
		if (first.status !== "prepared") return;
		first.commit(new RetainedCommitTransaction(() => true));
		expect(parent.textContent).toBe("Visible");

		values.show = false;
		const clear = await composer.prepare(request);
		expect(clear.status).toBe("prepared");
		if (clear.status !== "prepared") return;
		expect(clear.selectedIndex).toBeNull();
		expect(parent.textContent).toBe("Visible");
		expect(clear.commit(new RetainedCommitTransaction(() => true)).status).toBe("committed");
		expect(parent.textContent).toBe("");
		expect(composer.activeIndex).toBeNull();

		const stillClear = await composer.prepare(request);
		expect(stillClear.status).toBe("unchanged");
	});

	it("returns disposed with no late commit when teardown occurs during child evaluation", async () => {
		const ownerDocument = createOwnerDocument();
		const parent = parentIn(ownerDocument);
		const pending = deferred<ExprValue>();
		const composer = new RetainedProductionConditionalSyncChildren(parent, {
			evaluateExpression: vi.fn(async (compiled) => {
				if (compiled.source === "show") return true;
				return pending.promise;
			}),
		});
		const preparing = composer.prepare({
			node: ifNode(branch(expression("show"), textChildren())),
			sourceHash: "template-dispose",
			expressionContext: context(),
		});
		await Promise.resolve();
		composer.dispose();
		pending.resolve("Late");

		const result = await preparing;
		expect(result.status).toBe("disposed");
		expect(parent.textContent).toBe("");
	});
});
