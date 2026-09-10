import { TFile, type App } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { compileTemplateCompat } from "../compiler/template-compat";
import type { CompiledExpression } from "../compiler/expression-compiler";
import type { TemplateIR } from "../compiler/template-ir";
import type { ExprContext, ExprValue } from "../expression";
import {
	RetainedProductionLeafRenderer,
	inspectRetainedProductionLeafSupport,
	type RetainedProductionExpressionEvaluator,
} from "../render/retained-production-leaf-renderer";

type AttributeTestPart =
	| {
		readonly kind: "static";
		readonly value: string;
		readonly encoding: "html-attribute-source";
	}
	| {
		readonly kind: "expression";
		readonly expression: CompiledExpression;
	};

function createOwnerDocument(): Document {
	return new DOMParser().parseFromString(
		"<!doctype html><html><body></body></html>",
		"text/html",
	);
}

function createRoot(ownerDocument: Document): HTMLElement {
	const root = ownerDocument.createElement("div");
	ownerDocument.body.appendChild(root);
	return root;
}

function createContext(overrides: Partial<ExprContext> = {}): ExprContext {
	const fileValue: unknown = Object.create(TFile.prototype);
	if (!(fileValue instanceof TFile)) {
		throw new Error("Expected TFile test fixture");
	}
	Object.assign(fileValue, {
		path: "Notes/Test.md",
		name: "Test.md",
		basename: "Test",
		extension: "md",
		stat: { ctime: 1, mtime: 2, size: 3 },
		parent: { path: "Notes" },
	});
	return {
		app: {} as App,
		file: fileValue,
		frontmatter: undefined,
		bodyContent: "Body source",
		variables: {},
		...overrides,
	};
}

function compiledExpression(source: string): CompiledExpression {
	const ir = compileTemplateCompat(`{{${source}}}`);
	const node = ir.nodes.find((candidate) => "expression" in candidate);
	if (!node || !("expression" in node)) {
		throw new Error(`Expected compiled expression for ${source}`);
	}
	return node.expression;
}

function completeAttributeIr(
	sourceHash: string,
	parts: readonly AttributeTestPart[],
	quote: "\"" | "'" | null = "\"",
): TemplateIR {
	const expressionPart = parts.find((part) => part.kind === "expression");
	if (!expressionPart || expressionPart.kind !== "expression") {
		throw new Error("Expected at least one dynamic attribute part");
	}
	const base = compileTemplateCompat("<article><span>Stable</span></article>");
	const opening = quote === "'" ? "<article data-label='" : "<article data-label=\"";
	const closing = quote === "'" ? "'><span>Stable</span></article>" : "\"><span>Stable</span></article>";
	return {
		...base,
		sourceHash,
		nodes: [
			{ kind: "static-fragment", html: opening },
			{
				kind: "attribute-slot",
				id: "attr-0",
				expression: expressionPart.expression,
				attribute: "data-label",
				targetKey: "element-0",
				quote,
				parts,
			},
			{ kind: "static-fragment", html: closing },
		],
	} as unknown as TemplateIR;
}

function request(
	ir: TemplateIR,
	context: ExprContext = createContext(),
	revisionKey = "rev-1",
) {
	return {
		ir,
		app: context.app,
		expressionContext: context,
		sourcePath: context.file.path,
		revisionKey,
	};
}

async function commitPrepared(
	prepared: Awaited<ReturnType<RetainedProductionLeafRenderer["prepare"]>>,
) {
	expect(prepared.status).toBe("prepared");
	if (prepared.status !== "prepared") throw new Error("Expected prepared retained generation");
	return prepared.commit(() => true);
}

describe("RetainedProductionLeafRenderer complete attributes", () => {
	it("assembles mixed parts once in source order and retains element identity", async () => {
		const ownerDocument = createOwnerDocument();
		const root = createRoot(ownerDocument);
		const firstExpression = compiledExpression("first");
		const secondExpression = compiledExpression("second");
		const ir = completeAttributeIr("mixed-attribute", [
			{ kind: "static", value: "pre &amp; ", encoding: "html-attribute-source" },
			{ kind: "expression", expression: firstExpression },
			{ kind: "static", value: "-", encoding: "html-attribute-source" },
			{ kind: "expression", expression: secondExpression },
		]);
		const values = new Map<string, ExprValue>([
			["first", "A"],
			["second", "B"],
		]);
		const order: string[] = [];
		const evaluateExpression: RetainedProductionExpressionEvaluator = async (expression) => {
			order.push(expression.expressionSource);
			return values.get(expression.expressionSource) ?? null;
		};
		const renderer = new RetainedProductionLeafRenderer(root, { evaluateExpression });

		const first = await renderer.prepare(request(ir));
		expect(await commitPrepared(first)).toEqual({ status: "committed" });
		const article = root.querySelector("article");
		const span = root.querySelector("span");
		expect(article?.getAttribute("data-label")).toBe("pre & A-B");
		expect(order).toEqual(["first", "second"]);

		values.set("first", "C");
		values.set("second", "D");
		const second = await renderer.prepare(request(ir, createContext(), "rev-2"));
		expect(await commitPrepared(second)).toEqual({ status: "committed" });
		expect(root.querySelector("article")).toBe(article);
		expect(root.querySelector("span")).toBe(span);
		expect(article?.getAttribute("data-label")).toBe("pre & C-D");
		expect(order).toEqual(["first", "second", "first", "second"]);
	});

	it("consumes the fixed unquoted-comparison handoff without losing a later attribute", async () => {
		const ownerDocument = createOwnerDocument();
		const root = createRoot(ownerDocument);
		const score = compiledExpression("score>10");
		const next = compiledExpression("next");
		const base = compileTemplateCompat("<div>X</div>");
		const ir = {
			...base,
			sourceHash: "two-attributes",
			nodes: [
				{ kind: "static-fragment", html: "<div data-ok=" },
				{
					kind: "attribute-slot",
					id: "attr-ok",
					expression: score,
					attribute: "data-ok",
					targetKey: "element-0",
					quote: null,
					parts: [{ kind: "expression", expression: score }],
				},
				{ kind: "static-fragment", html: " data-next=\"" },
				{
					kind: "attribute-slot",
					id: "attr-next",
					expression: next,
					attribute: "data-next",
					targetKey: "element-0",
					quote: '"',
					parts: [
						{ kind: "static", value: "pre-", encoding: "html-attribute-source" },
						{ kind: "expression", expression: next },
						{ kind: "static", value: "-post", encoding: "html-attribute-source" },
					],
				},
				{ kind: "static-fragment", html: "\">X</div>" },
			],
		} as unknown as TemplateIR;
		const evaluateExpression: RetainedProductionExpressionEvaluator = async (expression) => {
			if (expression.expressionSource === "score>10") return true;
			if (expression.expressionSource === "next") return "N";
			return null;
		};
		const renderer = new RetainedProductionLeafRenderer(root, { evaluateExpression });

		expect(inspectRetainedProductionLeafSupport(ir)).toBeNull();
		const prepared = await renderer.prepare(request(ir));
		expect(await commitPrepared(prepared)).toEqual({ status: "committed" });
		const element = root.querySelector("div");
		expect(element?.getAttribute("data-ok")).toBe("true");
		expect(element?.getAttribute("data-next")).toBe("pre-N-post");
	});

	it("fails closed on malformed complete metadata before evaluating any expression", async () => {
		const ownerDocument = createOwnerDocument();
		const root = createRoot(ownerDocument);
		const expression = compiledExpression("name");
		const base = completeAttributeIr("malformed", [
			{ kind: "expression", expression },
		]);
		const node = base.nodes[1];
		if (node.kind !== "attribute-slot") throw new Error("Expected attribute slot");
		const malformed = {
			...base,
			nodes: [
				base.nodes[0],
				{
					...node,
					targetKey: "element-0",
					quote: '"',
					parts: [{ kind: "static", value: "unsafe", encoding: "decoded" }],
				},
				base.nodes[2],
			],
		} as unknown as TemplateIR;
		const evaluateExpression = vi.fn(async () => "Should not run");
		const renderer = new RetainedProductionLeafRenderer(root, { evaluateExpression });

		expect(inspectRetainedProductionLeafSupport(malformed)).toMatchObject({
			status: "fallback",
			code: "attribute-slot",
		});
		const prepared = await renderer.prepare(request(malformed));
		expect(prepared).toMatchObject({ status: "fallback", code: "attribute-slot" });
		expect(evaluateExpression).not.toHaveBeenCalled();
		expect(root.childNodes).toHaveLength(0);
	});

	it("stales a superseded preparation in the middle of attribute assembly", async () => {
		const ownerDocument = createOwnerDocument();
		const root = createRoot(ownerDocument);
		const firstExpression = compiledExpression("first");
		const secondExpression = compiledExpression("second");
		const ir = completeAttributeIr("stale-attribute", [
			{ kind: "expression", expression: firstExpression },
			{ kind: "static", value: ":", encoding: "html-attribute-source" },
			{ kind: "expression", expression: secondExpression },
		]);
		let call = 0;
		let releaseOld!: (value: ExprValue) => void;
		const evaluateExpression: RetainedProductionExpressionEvaluator = async () => {
			call += 1;
			if (call === 1) return "Old A";
			if (call === 2) {
				return new Promise<ExprValue>((resolve) => {
					releaseOld = resolve;
				});
			}
			if (call === 3) return "New A";
			return "New B";
		};
		const renderer = new RetainedProductionLeafRenderer(root, { evaluateExpression });

		const oldPromise = renderer.prepare(request(ir, createContext(), "rev-old"));
		await Promise.resolve();
		await Promise.resolve();
		expect(call).toBe(2);

		const newer = await renderer.prepare(request(ir, createContext(), "rev-new"));
		expect(await commitPrepared(newer)).toEqual({ status: "committed" });
		const article = root.querySelector("article");
		expect(article?.getAttribute("data-label")).toBe("New A:New B");

		releaseOld("Old B");
		await expect(oldPromise).resolves.toEqual({ status: "stale" });
		expect(root.querySelector("article")).toBe(article);
		expect(article?.getAttribute("data-label")).toBe("New A:New B");
	});

	it("decodes static attribute source in the retained root ownerDocument", async () => {
		const ownerDocument = new window.DOMParser().parseFromString(
			"<!doctype html><html><body></body></html>",
			"text/html",
		);
		const root = createRoot(ownerDocument);
		const expression = compiledExpression("name");
		const ir = completeAttributeIr("foreign-attribute", [
			{ kind: "static", value: "Tom &amp; Jerry / ", encoding: "html-attribute-source" },
			{ kind: "expression", expression },
		]);
		const renderer = new RetainedProductionLeafRenderer(root, {
			evaluateExpression: async () => "Popup",
		});

		const prepared = await renderer.prepare(request(ir));
		expect(await commitPrepared(prepared)).toEqual({ status: "committed" });
		const article = root.querySelector("article");
		expect(article?.ownerDocument).toBe(ownerDocument);
		expect(article?.getAttribute("data-label")).toBe("Tom & Jerry / Popup");
	});
});
