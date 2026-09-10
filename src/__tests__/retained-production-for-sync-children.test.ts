import { describe, expect, it, vi } from "vitest";
import type { CompiledExpression } from "../compiler/expression-compiler";
import type { ForNode, TemplateIRNode } from "../compiler/template-ir";
import type { ExprContext, ExprValue } from "../expression";
import {
	RetainedCommitTransaction,
	type RetainedCommitParticipant,
} from "../render/retained-commit-transaction";
import {
	RetainedProductionForSyncChildren,
	type RetainedProductionForSyncEvaluator,
} from "../render/retained-production-for-sync-children";

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

function forNode(
	children: readonly TemplateIRNode[],
	options: {
		iterable?: string;
		itemVariable?: string;
		key?: string;
	} = {},
): ForNode {
	return {
		kind: "for",
		iterable: expression(options.iterable ?? "items"),
		itemVariable: options.itemVariable ?? "item",
		...(options.key ? { key: expression(options.key) } : {}),
		children,
	};
}

function textChildren(source = "display"): TemplateIRNode[] {
	return [
		{ kind: "static-fragment", html: "<article><span>" },
		{ kind: "text-slot", id: "value", expression: expression(source) },
		{ kind: "static-fragment", html: "</span></article>" },
	];
}

function valuesEvaluator(values: {
	items: ExprValue;
	display?: (ctx: ExprContext) => ExprValue;
	key?: (ctx: ExprContext) => ExprValue;
	setValue?: (ctx: ExprContext) => ExprValue;
	afterSet?: (ctx: ExprContext) => ExprValue;
}): RetainedProductionForSyncEvaluator {
	return vi.fn(async (compiled, ctx) => {
		switch (compiled.source) {
			case "items": return values.items;
			case "display": return values.display?.(ctx) ?? ctx.variables.item;
			case "item-key": return values.key?.(ctx) ?? null;
			case "set-value": return values.setValue?.(ctx) ?? null;
			case "after-set": return values.afterSet?.(ctx) ?? ctx.variables.saved;
			default: return null;
		}
	});
}

function itemRecord(id: string, label: string): ExprValue {
	return { id, label };
}

function itemField(ctx: ExprContext, field: string): ExprValue {
	const item = ctx.variables.item;
	if (item === null || typeof item !== "object" || Array.isArray(item)) return null;
	return (item as Record<string, ExprValue>)[field] ?? null;
}

function loopField(ctx: ExprContext, field: string): ExprValue {
	const loop = ctx.variables.loop;
	if (loop === null || typeof loop !== "object" || Array.isArray(loop)) return null;
	return (loop as Record<string, ExprValue>)[field] ?? null;
}

function primitiveText(value: ExprValue): string {
	if (value === null) return "";
	if (
		typeof value === "string"
		|| typeof value === "number"
		|| typeof value === "boolean"
	) {
		return String(value);
	}
	throw new Error("Expected primitive expression value");
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function throwingParticipant(error: Error): RetainedCommitParticipant {
	return {
		isCurrent: () => true,
		apply: () => {
			throw error;
		},
		rollback: vi.fn(),
		finalize: vi.fn(),
		discard: vi.fn(),
	};
}

describe("RetainedProductionForSyncChildren", () => {
	it("builds all initial iterations detached and exposes them only at owner commit", async () => {
		const ownerDocument = createOwnerDocument();
		const parent = parentIn(ownerDocument);
		const evaluator = valuesEvaluator({ items: ["Alpha", "Bravo"] });
		const composer = new RetainedProductionForSyncChildren(parent, {
			evaluateExpression: evaluator,
		});
		const prepared = await composer.prepare({
			node: forNode(textChildren()),
			sourceHash: "for-initial",
			expressionContext: context(),
		});

		expect(prepared.status).toBe("prepared");
		if (prepared.status !== "prepared") return;
		expect(parent.querySelectorAll("article")).toHaveLength(0);
		expect(prepared.keys).toEqual([0, 1]);
		expect(prepared.commit(new RetainedCommitTransaction(() => true))).toEqual({
			status: "committed",
		});
		expect(Array.from(parent.querySelectorAll("article"), (node) => node.textContent)).toEqual([
			"Alpha",
			"Bravo",
		]);
	});

	it("returns unchanged for an equivalent generation and preserves every iteration node identity", async () => {
		const ownerDocument = createOwnerDocument();
		const parent = parentIn(ownerDocument);
		const values = { items: ["Alpha", "Bravo"] as ExprValue };
		const composer = new RetainedProductionForSyncChildren(parent, {
			evaluateExpression: valuesEvaluator(values),
		});
		const request = {
			node: forNode(textChildren()),
			sourceHash: "for-stable",
			expressionContext: context(),
		};
		const first = await composer.prepare(request);
		expect(first.status).toBe("prepared");
		if (first.status !== "prepared") return;
		first.commit(new RetainedCommitTransaction(() => true));
		const firstArticle = parent.querySelectorAll("article")[0];
		const secondArticle = parent.querySelectorAll("article")[1];
		const firstText = firstArticle.firstChild?.firstChild;
		const secondText = secondArticle.firstChild?.firstChild;

		const second = await composer.prepare(request);
		expect(second.status).toBe("unchanged");
		expect(parent.querySelectorAll("article")[0]).toBe(firstArticle);
		expect(parent.querySelectorAll("article")[1]).toBe(secondArticle);
		expect(parent.querySelectorAll("article")[0].firstChild?.firstChild).toBe(firstText);
		expect(parent.querySelectorAll("article")[1].firstChild?.firstChild).toBe(secondText);
	});

	it("defers same-position value patches until commit while preserving exact nodes", async () => {
		const ownerDocument = createOwnerDocument();
		const parent = parentIn(ownerDocument);
		const values = { items: ["Old", "Stable"] as ExprValue };
		const composer = new RetainedProductionForSyncChildren(parent, {
			evaluateExpression: valuesEvaluator(values),
		});
		const request = {
			node: forNode(textChildren()),
			sourceHash: "for-patch",
			expressionContext: context(),
		};
		const first = await composer.prepare(request);
		expect(first.status).toBe("prepared");
		if (first.status !== "prepared") return;
		first.commit(new RetainedCommitTransaction(() => true));
		const stableArticle = parent.querySelectorAll("article")[0];
		const stableText = stableArticle.firstChild?.firstChild;

		values.items = ["New", "Stable"];
		const second = await composer.prepare(request);
		expect(second.status).toBe("prepared");
		if (second.status !== "prepared") return;
		expect(parent.querySelectorAll("article")[0].textContent).toBe("Old");
		expect(second.commit(new RetainedCommitTransaction(() => true)).status).toBe("committed");
		expect(parent.querySelectorAll("article")[0]).toBe(stableArticle);
		expect(parent.querySelectorAll("article")[0].firstChild?.firstChild).toBe(stableText);
		expect(parent.querySelectorAll("article")[0].textContent).toBe("New");
	});

	it("preserves surviving positional entry identity across append and removal", async () => {
		const ownerDocument = createOwnerDocument();
		const parent = parentIn(ownerDocument);
		const values = { items: ["Alpha", "Bravo"] as ExprValue };
		const composer = new RetainedProductionForSyncChildren(parent, {
			evaluateExpression: valuesEvaluator(values),
		});
		const request = {
			node: forNode(textChildren()),
			sourceHash: "for-size",
			expressionContext: context(),
		};
		const first = await composer.prepare(request);
		expect(first.status).toBe("prepared");
		if (first.status !== "prepared") return;
		first.commit(new RetainedCommitTransaction(() => true));
		const firstArticle = parent.querySelectorAll("article")[0];
		const secondArticle = parent.querySelectorAll("article")[1];

		values.items = ["Alpha", "Bravo", "Charlie"];
		const appended = await composer.prepare(request);
		expect(appended.status).toBe("prepared");
		if (appended.status !== "prepared") return;
		appended.commit(new RetainedCommitTransaction(() => true));
		expect(parent.querySelectorAll("article")[0]).toBe(firstArticle);
		expect(parent.querySelectorAll("article")[1]).toBe(secondArticle);

		values.items = ["Alpha"];
		const removed = await composer.prepare(request);
		expect(removed.status).toBe("prepared");
		if (removed.status !== "prepared") return;
		removed.commit(new RetainedCommitTransaction(() => true));
		expect(parent.querySelectorAll("article")).toHaveLength(1);
		expect(parent.querySelector("article")).toBe(firstArticle);
	});

	it("uses explicit string keys to preserve item identity across reorder", async () => {
		const ownerDocument = createOwnerDocument();
		const parent = parentIn(ownerDocument);
		const values = {
			items: [itemRecord("a", "Alpha"), itemRecord("b", "Bravo")] as ExprValue,
			key: (ctx: ExprContext) => itemField(ctx, "id"),
			display: (ctx: ExprContext) => itemField(ctx, "label"),
		};
		const composer = new RetainedProductionForSyncChildren(parent, {
			evaluateExpression: valuesEvaluator(values),
		});
		const request = {
			node: forNode(textChildren(), { key: "item-key" }),
			sourceHash: "for-keyed-reorder",
			expressionContext: context(),
		};
		const first = await composer.prepare(request);
		expect(first.status).toBe("prepared");
		if (first.status !== "prepared") return;
		first.commit(new RetainedCommitTransaction(() => true));
		const alpha = parent.querySelectorAll("article")[0];
		const bravo = parent.querySelectorAll("article")[1];

		values.items = [itemRecord("b", "Bravo"), itemRecord("a", "Alpha")];
		const reordered = await composer.prepare(request);
		expect(reordered.status).toBe("prepared");
		if (reordered.status !== "prepared") return;
		expect(reordered.commit(new RetainedCommitTransaction(() => true)).status).toBe("committed");
		expect(parent.querySelectorAll("article")[0]).toBe(bravo);
		expect(parent.querySelectorAll("article")[1]).toBe(alpha);
	});

	it("rolls structure and live value patches back by exact identity when a later owner participant fails", async () => {
		const ownerDocument = createOwnerDocument();
		const parent = parentIn(ownerDocument);
		const values = { items: ["Alpha", "Bravo"] as ExprValue };
		const composer = new RetainedProductionForSyncChildren(parent, {
			evaluateExpression: valuesEvaluator(values),
		});
		const request = {
			node: forNode(textChildren()),
			sourceHash: "for-rollback",
			expressionContext: context(),
		};
		const first = await composer.prepare(request);
		expect(first.status).toBe("prepared");
		if (first.status !== "prepared") return;
		first.commit(new RetainedCommitTransaction(() => true));
		const stableFirst = parent.querySelectorAll("article")[0];
		const stableSecond = parent.querySelectorAll("article")[1];
		const stableFirstText = stableFirst.firstChild?.firstChild;

		values.items = ["Changed", "Bravo", "Charlie"];
		const next = await composer.prepare(request);
		expect(next.status).toBe("prepared");
		if (next.status !== "prepared") return;
		const claimed = next.claimParticipants();
		expect(claimed.status).toBe("claimed");
		if (claimed.status !== "claimed") return;
		const failure = new Error("Outer participant failed");
		const result = new RetainedCommitTransaction(() => true).commit([
			...claimed.claim.toCommitParticipants(),
			throwingParticipant(failure),
		]);
		expect(result.status).toBe("failed");
		expect(result.error).toBe(failure);
		expect(parent.querySelectorAll("article")).toHaveLength(2);
		expect(parent.querySelectorAll("article")[0]).toBe(stableFirst);
		expect(parent.querySelectorAll("article")[1]).toBe(stableSecond);
		expect(stableFirst.firstChild?.firstChild).toBe(stableFirstText);
		expect(stableFirst.textContent).toBe("Alpha");
		claimed.claim.dispose();
	});

	it("rejects duplicate explicit keys before live mutation and preserves last-known-good DOM", async () => {
		const ownerDocument = createOwnerDocument();
		const parent = parentIn(ownerDocument);
		const values = {
			items: [itemRecord("a", "Alpha"), itemRecord("b", "Bravo")] as ExprValue,
			key: (ctx: ExprContext) => itemField(ctx, "id"),
			display: (ctx: ExprContext) => itemField(ctx, "label"),
		};
		const composer = new RetainedProductionForSyncChildren(parent, {
			evaluateExpression: valuesEvaluator(values),
		});
		const request = {
			node: forNode(textChildren(), { key: "item-key" }),
			sourceHash: "for-duplicate",
			expressionContext: context(),
		};
		const first = await composer.prepare(request);
		expect(first.status).toBe("prepared");
		if (first.status !== "prepared") return;
		first.commit(new RetainedCommitTransaction(() => true));
		const stable = Array.from(parent.querySelectorAll("article"));

		values.items = [itemRecord("a", "Alpha"), itemRecord("a", "Duplicate")];
		const duplicate = await composer.prepare(request);
		expect(duplicate.status).toBe("failed");
		expect(parent.querySelectorAll("article")[0]).toBe(stable[0]);
		expect(parent.querySelectorAll("article")[1]).toBe(stable[1]);
		expect(Array.from(parent.querySelectorAll("article"), (node) => node.textContent)).toEqual([
			"Alpha",
			"Bravo",
		]);
	});

	it("treats a non-array iterable as an empty loop and commits removal transactionally", async () => {
		const ownerDocument = createOwnerDocument();
		const parent = parentIn(ownerDocument);
		const values = { items: ["Alpha"] as ExprValue };
		const composer = new RetainedProductionForSyncChildren(parent, {
			evaluateExpression: valuesEvaluator(values),
		});
		const request = {
			node: forNode(textChildren()),
			sourceHash: "for-non-array",
			expressionContext: context(),
		};
		const first = await composer.prepare(request);
		expect(first.status).toBe("prepared");
		if (first.status !== "prepared") return;
		first.commit(new RetainedCommitTransaction(() => true));
		expect(parent.querySelectorAll("article")).toHaveLength(1);

		values.items = "Not a list";
		const cleared = await composer.prepare(request);
		expect(cleared.status).toBe("prepared");
		if (cleared.status !== "prepared") return;
		expect(parent.querySelectorAll("article")).toHaveLength(1);
		cleared.commit(new RetainedCommitTransaction(() => true));
		expect(parent.querySelectorAll("article")).toHaveLength(0);
		expect(composer.keys).toEqual([]);
	});

	it("matches legacy item, loop metadata, isolated variables and sequential set semantics", async () => {
		const ownerDocument = createOwnerDocument();
		const parent = parentIn(ownerDocument);
		const values = {
			items: [itemRecord("a", "Alpha"), itemRecord("b", "Bravo")] as ExprValue,
			setValue: (ctx: ExprContext) => `${primitiveText(itemField(ctx, "label"))}-${primitiveText(loopField(ctx, "index0"))}`,
			afterSet: (ctx: ExprContext) => [
				ctx.variables.saved,
				loopField(ctx, "index"),
				loopField(ctx, "index0"),
				loopField(ctx, "first"),
				loopField(ctx, "last"),
				loopField(ctx, "length"),
			].map(primitiveText).join("|"),
		};
		const evaluator = valuesEvaluator(values);
		const children: TemplateIRNode[] = [
			{ kind: "set", variable: "saved", expression: expression("set-value") },
			{ kind: "static-fragment", html: "<article>" },
			{ kind: "text-slot", id: "value", expression: expression("after-set") },
			{ kind: "static-fragment", html: "</article>" },
		];
		const composer = new RetainedProductionForSyncChildren(parent, {
			evaluateExpression: evaluator,
		});
		const prepared = await composer.prepare({
			node: forNode(children),
			sourceHash: "for-loop-context",
			expressionContext: context({ saved: "Outer" }),
		});
		expect(prepared.status).toBe("prepared");
		if (prepared.status !== "prepared") return;
		prepared.commit(new RetainedCommitTransaction(() => true));
		expect(Array.from(parent.querySelectorAll("article"), (node) => node.textContent)).toEqual([
			"Alpha-0|1|0|true|false|2",
			"Bravo-1|2|1|false|true|2",
		]);
	});

	it("fails closed on async children before evaluating the iterable", async () => {
		const ownerDocument = createOwnerDocument();
		const parent = parentIn(ownerDocument);
		const evaluator = vi.fn(async () => ["Alpha"] as ExprValue);
		const composer = new RetainedProductionForSyncChildren(parent, {
			evaluateExpression: evaluator,
		});
		const prepared = await composer.prepare({
			node: forNode([
				{ kind: "markdown-slot", id: "markdown", expression: expression("display") },
			]),
			sourceHash: "for-async-fallback",
			expressionContext: context(),
		});

		expect(prepared).toMatchObject({ status: "fallback", code: "async-island" });
		expect(evaluator).not.toHaveBeenCalled();
		expect(parent.textContent).toBe("");
	});

	it("supersedes older async evaluation without allowing stale work to mutate the range", async () => {
		const ownerDocument = createOwnerDocument();
		const parent = parentIn(ownerDocument);
		const firstGate = deferred<ExprValue>();
		let iterableCall = 0;
		const evaluator: RetainedProductionForSyncEvaluator = vi.fn(async (compiled, ctx) => {
			if (compiled.source === "items") {
				iterableCall += 1;
				if (iterableCall === 1) return firstGate.promise;
				return ["Newest"];
			}
			return ctx.variables.item;
		});
		const composer = new RetainedProductionForSyncChildren(parent, {
			evaluateExpression: evaluator,
		});
		const request = {
			node: forNode(textChildren()),
			sourceHash: "for-supersede",
			expressionContext: context(),
		};
		const oldPromise = composer.prepare(request);
		await Promise.resolve();
		const newest = await composer.prepare(request);
		expect(newest.status).toBe("prepared");
		if (newest.status !== "prepared") return;
		newest.commit(new RetainedCommitTransaction(() => true));
		const newestArticle = parent.querySelector("article");

		firstGate.resolve(["Old"]);
		const old = await oldPromise;
		expect(old.status).toBe("stale");
		expect(parent.querySelector("article")).toBe(newestArticle);
		expect(parent.textContent).toBe("Newest");
	});

	it("disposes pending evaluation and rejects every late commit without DOM mutation", async () => {
		const ownerDocument = createOwnerDocument();
		const parent = parentIn(ownerDocument);
		const gate = deferred<ExprValue>();
		const evaluator: RetainedProductionForSyncEvaluator = vi.fn(async (compiled, ctx) => {
			if (compiled.source === "items") return gate.promise;
			return ctx.variables.item;
		});
		const composer = new RetainedProductionForSyncChildren(parent, {
			evaluateExpression: evaluator,
		});
		const pending = composer.prepare({
			node: forNode(textChildren()),
			sourceHash: "for-dispose",
			expressionContext: context(),
		});
		await Promise.resolve();
		composer.dispose();
		gate.resolve(["Late"]);
		const result = await pending;
		expect(result.status).toBe("disposed");
		expect(parent.querySelector("article")).toBeNull();
		expect(composer.size).toBe(0);
	});

	it("makes participant claims one-shot and keeps claimed authority explicit", async () => {
		const ownerDocument = createOwnerDocument();
		const parent = parentIn(ownerDocument);
		const composer = new RetainedProductionForSyncChildren(parent, {
			evaluateExpression: valuesEvaluator({ items: ["Alpha"] }),
		});
		const prepared = await composer.prepare({
			node: forNode(textChildren()),
			sourceHash: "for-claim",
			expressionContext: context(),
		});
		expect(prepared.status).toBe("prepared");
		if (prepared.status !== "prepared") return;
		const first = prepared.claimParticipants();
		expect(first.status).toBe("claimed");
		expect(prepared.claimParticipants()).toEqual({ status: "stale" });
		expect(prepared.commit(new RetainedCommitTransaction(() => true))).toEqual({ status: "stale" });
		if (first.status !== "claimed") return;
		expect(new RetainedCommitTransaction(() => true).commit(
			first.claim.toCommitParticipants(),
		).status).toBe("committed");
		expect(parent.textContent).toBe("Alpha");
		first.claim.dispose();
	});
});