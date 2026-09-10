import { describe, expect, it, vi } from "vitest";
import type { CompiledExpression } from "../compiler/expression-compiler";
import type { IfBranch, IfNode } from "../compiler/template-ir";
import type { ExprContext, ExprValue } from "../expression";
import { RetainedCommitTransaction } from "../render/retained-commit-transaction";
import {
	RetainedProductionConditionalSelector,
	type RetainedProductionConditionalEvaluator,
} from "../render/retained-production-conditional-selector";
import type { RetainedStructureBuilder } from "../render/retained-slot-runtime";

function createOwnerDocument(): Document {
	return new DOMParser().parseFromString(
		"<!doctype html><html><body></body></html>",
		"text/html",
	);
}

function expression(source: string): CompiledExpression {
	return { source } as unknown as CompiledExpression;
}

function branch(condition: CompiledExpression | null): IfBranch {
	return { condition, children: [] };
}

function ifNode(...branches: IfBranch[]): IfNode {
	return { kind: "if", branches };
}

function context(): ExprContext {
	return { variables: {} } as unknown as ExprContext;
}

function textBuilder(text: string): RetainedStructureBuilder {
	return ({ ownerDocument, fragment }) => {
		const element = ownerDocument.createElement("span");
		element.textContent = text;
		fragment.appendChild(element);
	};
}

function parentIn(ownerDocument: Document): HTMLElement {
	const parent = ownerDocument.createElement("div");
	ownerDocument.body.appendChild(parent);
	return parent;
}

function evaluatorFrom(values: Readonly<Record<string, ExprValue>>): RetainedProductionConditionalEvaluator {
	return vi.fn(async (compiled) => values[compiled.source]);
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

describe("RetainedProductionConditionalSelector", () => {
	it("evaluates conditions lazily in source order and selects the first truthy branch", async () => {
		const ownerDocument = createOwnerDocument();
		const parent = parentIn(ownerDocument);
		const evaluate = evaluatorFrom({ first: false, second: true, third: true });
		const selector = new RetainedProductionConditionalSelector(parent, {
			evaluateExpression: evaluate,
		});
		const build = vi.fn((_selected: IfBranch, index: number) => textBuilder(`Branch ${index}`));

		const prepared = await selector.prepare(
			ifNode(branch(expression("first")), branch(expression("second")), branch(expression("third"))),
			context(),
			build,
		);

		expect(prepared.status).toBe("prepared");
		if (prepared.status !== "prepared") return;
		expect(prepared.selectedIndex).toBe(1);
		expect(evaluate).toHaveBeenCalledTimes(2);
		expect(build).toHaveBeenCalledTimes(1);
		expect(build.mock.calls[0][1]).toBe(1);
		expect(prepared.commit(new RetainedCommitTransaction(() => true))).toEqual({
			status: "committed",
		});
		expect(parent.textContent).toBe("Branch 1");
	});

	it("matches legacy falsy semantics for zero, empty string, false, null and empty arrays", async () => {
		const ownerDocument = createOwnerDocument();
		const evaluate = evaluatorFrom({
			zero: 0,
			empty: "",
			falseValue: false,
			nullValue: null,
			emptyArray: [],
			truthy: [0],
		});
		const selector = new RetainedProductionConditionalSelector(parentIn(ownerDocument), {
			evaluateExpression: evaluate,
		});
		const node = ifNode(
			branch(expression("zero")),
			branch(expression("empty")),
			branch(expression("falseValue")),
			branch(expression("nullValue")),
			branch(expression("emptyArray")),
			branch(expression("truthy")),
		);

		const prepared = await selector.prepare(node, context(), (_selected, index) => textBuilder(String(index)));
		expect(prepared.status).toBe("prepared");
		if (prepared.status !== "prepared") return;
		expect(prepared.selectedIndex).toBe(5);
		expect(evaluate).toHaveBeenCalledTimes(6);
	});

	it("selects a final else branch without evaluating it", async () => {
		const ownerDocument = createOwnerDocument();
		const evaluate = evaluatorFrom({ condition: false });
		const selector = new RetainedProductionConditionalSelector(parentIn(ownerDocument), {
			evaluateExpression: evaluate,
		});

		const prepared = await selector.prepare(
			ifNode(branch(expression("condition")), branch(null)),
			context(),
			(_selected, index) => textBuilder(`Branch ${index}`),
		);
		expect(prepared.status).toBe("prepared");
		if (prepared.status !== "prepared") return;
		expect(prepared.selectedIndex).toBe(1);
		expect(evaluate).toHaveBeenCalledTimes(1);
	});

	it("clears a previously committed branch transactionally when no branch matches", async () => {
		const ownerDocument = createOwnerDocument();
		const parent = parentIn(ownerDocument);
		const values: Record<string, ExprValue> = { show: true };
		const selector = new RetainedProductionConditionalSelector(parent, {
			evaluateExpression: vi.fn(async (compiled) => values[compiled.source]),
		});
		const node = ifNode(branch(expression("show")));
		const first = await selector.prepare(node, context(), () => textBuilder("Visible"));
		expect(first.status).toBe("prepared");
		if (first.status !== "prepared") return;
		expect(first.commit(new RetainedCommitTransaction(() => true)).status).toBe("committed");
		const stableNode = selector.nodes[0];

		values.show = false;
		const clear = await selector.prepare(node, context(), () => textBuilder("Should not build"));
		expect(clear.status).toBe("prepared");
		if (clear.status !== "prepared") return;
		expect(clear.selectedIndex).toBeNull();
		expect(clear.commit(new RetainedCommitTransaction(() => true)).status).toBe("committed");
		expect(selector.nodes).toEqual([]);
		expect(stableNode.parentNode).toBeNull();
	});

	it("reuses an unchanged active branch without rerunning its builder factory", async () => {
		const ownerDocument = createOwnerDocument();
		const parent = parentIn(ownerDocument);
		const selector = new RetainedProductionConditionalSelector(parent, {
			evaluateExpression: evaluatorFrom({ show: true }),
		});
		const node = ifNode(branch(expression("show")));
		const firstBuild = vi.fn(() => textBuilder("Stable"));
		const first = await selector.prepare(node, context(), firstBuild);
		expect(first.status).toBe("prepared");
		if (first.status !== "prepared") return;
		expect(first.commit(new RetainedCommitTransaction(() => true)).status).toBe("committed");
		const stableNode = selector.nodes[0];
		const stableSlots = selector.activeSlots;
		const secondBuild = vi.fn(() => textBuilder("Wrong"));

		const second = await selector.prepare(node, context(), secondBuild);
		expect(second.status).toBe("unchanged");
		expect(secondBuild).not.toHaveBeenCalled();
		expect(selector.nodes[0]).toBe(stableNode);
		expect(second.slots).toBe(stableSlots);
	});

	it("exposes the selected branch slot scope for detached initialization before commit", async () => {
		const ownerDocument = createOwnerDocument();
		const parent = parentIn(ownerDocument);
		const selector = new RetainedProductionConditionalSelector(parent, {
			evaluateExpression: evaluatorFrom({ show: true }),
		});

		const prepared = await selector.prepare(
			ifNode(branch(expression("show"))),
			context(),
			() => ({ fragment, textSlot }) => {
				fragment.appendChild(textSlot("branch-value", "Initial"));
			},
		);
		expect(prepared.status).toBe("prepared");
		if (prepared.status !== "prepared" || !prepared.slots) return;
		expect(prepared.slots.patchText("branch-value", "Updated")).toBe("patched");
		expect(parent.textContent).toBe("");
		expect(prepared.commit(new RetainedCommitTransaction(() => true)).status).toBe("committed");
		expect(parent.textContent).toBe("Updated");
	});

	it("preserves last-known-good DOM when condition evaluation fails", async () => {
		const ownerDocument = createOwnerDocument();
		const parent = parentIn(ownerDocument);
		const failure = new Error("Condition failed");
		let fail = false;
		const selector = new RetainedProductionConditionalSelector(parent, {
			evaluateExpression: vi.fn(async () => {
				if (fail) throw failure;
				return true;
			}),
		});
		const node = ifNode(branch(expression("condition")));
		const first = await selector.prepare(node, context(), () => textBuilder("Stable"));
		expect(first.status).toBe("prepared");
		if (first.status !== "prepared") return;
		first.commit(new RetainedCommitTransaction(() => true));
		const stableNode = selector.nodes[0];

		fail = true;
		const failed = await selector.prepare(node, context(), () => textBuilder("Wrong"));
		expect(failed.status).toBe("failed");
		if (failed.status !== "failed") return;
		expect(failed.error).toBe(failure);
		expect(selector.nodes[0]).toBe(stableNode);
		expect(parent.textContent).toBe("Stable");
	});

	it("preserves last-known-good DOM when the selected branch builder throws", async () => {
		const ownerDocument = createOwnerDocument();
		const parent = parentIn(ownerDocument);
		const values: Record<string, ExprValue> = { first: true, second: false };
		const selector = new RetainedProductionConditionalSelector(parent, {
			evaluateExpression: vi.fn(async (compiled) => values[compiled.source]),
		});
		const node = ifNode(branch(expression("first")), branch(expression("second")));
		const first = await selector.prepare(node, context(), (_selected, index) => textBuilder(`Branch ${index}`));
		expect(first.status).toBe("prepared");
		if (first.status !== "prepared") return;
		first.commit(new RetainedCommitTransaction(() => true));
		const stableNode = selector.nodes[0];

		values.first = false;
		values.second = true;
		const failure = new Error("Builder failed");
		const failed = await selector.prepare(node, context(), () => {
			throw failure;
		});
		expect(failed.status).toBe("failed");
		if (failed.status !== "failed") return;
		expect(failed.error).toBe(failure);
		expect(selector.nodes[0]).toBe(stableNode);
		expect(parent.textContent).toBe("Branch 0");
	});

	it("makes an older in-flight condition preparation stale when a newer request wins", async () => {
		const ownerDocument = createOwnerDocument();
		const parent = parentIn(ownerDocument);
		const slow = deferred<ExprValue>();
		const selector = new RetainedProductionConditionalSelector(parent, {
			evaluateExpression: vi.fn(async (compiled) => {
				if (compiled.source === "slow") return slow.promise;
				return true;
			}),
		});
		const oldPromise = selector.prepare(
			ifNode(branch(expression("slow"))),
			context(),
			() => textBuilder("Old"),
		);
		const newer = await selector.prepare(
			ifNode(branch(expression("fast"))),
			context(),
			() => textBuilder("New"),
		);
		expect(newer.status).toBe("prepared");
		if (newer.status !== "prepared") return;
		expect(newer.commit(new RetainedCommitTransaction(() => true)).status).toBe("committed");

		slow.resolve(true);
		const old = await oldPromise;
		expect(old.status).toBe("stale");
		expect(parent.textContent).toBe("New");
	});

	it("lets a newer malformed request revoke an already-prepared older branch", async () => {
		const ownerDocument = createOwnerDocument();
		const parent = parentIn(ownerDocument);
		const selector = new RetainedProductionConditionalSelector(parent, {
			evaluateExpression: evaluatorFrom({ valid: true }),
		});
		const older = await selector.prepare(
			ifNode(branch(expression("valid"))),
			context(),
			() => textBuilder("Old"),
		);
		expect(older.status).toBe("prepared");
		if (older.status !== "prepared") return;
		const malformed = {
			kind: "if",
			branches: [branch(null), branch(expression("valid"))],
		} as IfNode;

		const rejected = await selector.prepare(malformed, context(), () => textBuilder("Wrong"));
		expect(rejected.status).toBe("failed");
		expect(older.isCurrent()).toBe(false);
		expect(older.commit(new RetainedCommitTransaction(() => true)).status).toBe("stale");
		expect(parent.textContent).toBe("");
	});

	it("returns disposed when owner teardown occurs while condition evaluation is pending", async () => {
		const ownerDocument = createOwnerDocument();
		const parent = parentIn(ownerDocument);
		const pending = deferred<ExprValue>();
		const build = vi.fn(() => textBuilder("Wrong"));
		const selector = new RetainedProductionConditionalSelector(parent, {
			evaluateExpression: vi.fn(async () => pending.promise),
		});
		const preparation = selector.prepare(
			ifNode(branch(expression("pending"))),
			context(),
			build,
		);
		selector.dispose();
		pending.resolve(true);

		const result = await preparation;
		expect(result.status).toBe("disposed");
		expect(build).not.toHaveBeenCalled();
		expect(parent.textContent).toBe("");
	});

	it("keeps exact old branch node identity when the owner transaction gate is stale", async () => {
		const ownerDocument = createOwnerDocument();
		const parent = parentIn(ownerDocument);
		const values: Record<string, ExprValue> = { first: true, second: false };
		const selector = new RetainedProductionConditionalSelector(parent, {
			evaluateExpression: vi.fn(async (compiled) => values[compiled.source]),
		});
		const node = ifNode(branch(expression("first")), branch(expression("second")));
		const first = await selector.prepare(node, context(), (_selected, index) => textBuilder(`Branch ${index}`));
		expect(first.status).toBe("prepared");
		if (first.status !== "prepared") return;
		first.commit(new RetainedCommitTransaction(() => true));
		const stableNode = selector.nodes[0];

		values.first = false;
		values.second = true;
		const switchBranch = await selector.prepare(node, context(), (_selected, index) => textBuilder(`Branch ${index}`));
		expect(switchBranch.status).toBe("prepared");
		if (switchBranch.status !== "prepared") return;
		expect(switchBranch.commit(new RetainedCommitTransaction(() => false)).status).toBe("stale");
		expect(selector.nodes[0]).toBe(stableNode);
		expect(parent.textContent).toBe("Branch 0");
	});
});
