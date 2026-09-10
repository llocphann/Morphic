import { TFile, type App } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { compileTemplateCompat } from "../compiler/template-compat";
import type { CompiledExpression } from "../compiler/expression-compiler";
import type { ExprContext, ExprValue } from "../expression";
import {
	RetainedProductionLeafRenderer,
	inspectRetainedProductionLeafSupport,
	type RetainedProductionExpressionEvaluator,
} from "../render/retained-production-leaf-renderer";

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
	const file = fileValue;
	return {
		app: {} as App,
		file,
		frontmatter: undefined,
		bodyContent: "Body source",
		variables: {},
		...overrides,
	};
}

function request(
	template: string,
	context: ExprContext = createContext(),
	revisionKey = "rev-1",
) {
	return {
		ir: compileTemplateCompat(template),
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

describe("RetainedProductionLeafRenderer", () => {
	it("mounts a compiler text leaf then patches it without replacing static DOM", async () => {
		const ownerDocument = createOwnerDocument();
		const root = createRoot(ownerDocument);
		const renderer = new RetainedProductionLeafRenderer(root);
		const context = createContext();

		const first = await renderer.prepare(request("<article>Hello {{name}}</article>", context));
		expect(await commitPrepared(first)).toEqual({ status: "committed" });
		const article = root.querySelector("article");
		expect(article?.textContent).toBe("Hello Test.md");

		context.file.name = "Renamed.md";
		const second = await renderer.prepare(request("<article>Hello {{name}}</article>", context, "rev-2"));
		expect(await commitPrepared(second)).toEqual({ status: "committed" });
		expect(root.querySelector("article")).toBe(article);
		expect(article?.textContent).toBe("Hello Renamed.md");
	});

	it("evaluates set nodes before later leaf expressions in a private variable scope", async () => {
		const ownerDocument = createOwnerDocument();
		const root = createRoot(ownerDocument);
		const renderer = new RetainedProductionLeafRenderer(root);
		const context = createContext({ variables: { outside: "Keep" } });

		const prepared = await renderer.prepare(request(
			"{% set greeting = 'Hello' %}<p>{{greeting}}</p>",
			context,
		));
		expect(await commitPrepared(prepared)).toEqual({ status: "committed" });
		expect(root.textContent).toBe("Hello");
		expect(context.variables).toEqual({ outside: "Keep" });
	});

	it("uses legacy resultToString semantics for retained text values", async () => {
		const ownerDocument = createOwnerDocument();
		const root = createRoot(ownerDocument);
		const evaluateExpression = vi.fn(async () => ["A", null, { value: 2 }] as ExprValue);
		const renderer = new RetainedProductionLeafRenderer(root, { evaluateExpression });

		const prepared = await renderer.prepare(request("<p>{{anything}}</p>"));
		expect(await commitPrepared(prepared)).toEqual({ status: "committed" });
		expect(root.textContent).toBe('A, , {"value":2}');
	});

	it("prepares Markdown through the retained Obsidian island on the stable slot host", async () => {
		const ownerDocument = createOwnerDocument();
		const root = createRoot(ownerDocument);
		const evaluateExpression = vi.fn(async () => "[[Target]]");
		const renderer = new RetainedProductionLeafRenderer(root, { evaluateExpression });
		const template = "<section>{{ link('Target') }}</section>";

		const first = await renderer.prepare(request(template));
		expect(await commitPrepared(first)).toEqual({ status: "committed" });
		const section = root.querySelector("section");
		const island = section?.firstElementChild;
		expect(island?.textContent).toBe("[[Target]]");

		const second = await renderer.prepare(request(template, createContext(), "rev-2"));
		expect(await commitPrepared(second)).toEqual({ status: "committed" });
		expect(root.querySelector("section")).toBe(section);
		expect(section?.firstElementChild).toBe(island);
	});

	it("renders unfiltered content from the already-loaded body without evaluating it again", async () => {
		const ownerDocument = createOwnerDocument();
		const root = createRoot(ownerDocument);
		const evaluateExpression = vi.fn<RetainedProductionExpressionEvaluator>();
		const renderer = new RetainedProductionLeafRenderer(root, { evaluateExpression });
		const context = createContext({ bodyContent: "# Current body" });

		const prepared = await renderer.prepare(request("<main>{{content}}</main>", context));
		expect(await commitPrepared(prepared)).toEqual({ status: "committed" });
		expect(root.textContent).toBe("# Current body");
		expect(evaluateExpression).not.toHaveBeenCalled();
	});

	it("returns structural fallback before expression evaluation", async () => {
		const ownerDocument = createOwnerDocument();
		const root = createRoot(ownerDocument);
		const evaluateExpression = vi.fn(async () => "value");
		const renderer = new RetainedProductionLeafRenderer(root, { evaluateExpression });

		const result = await renderer.prepare(request("{% if name %}<b>{{name}}</b>{% endif %}"));
		expect(result).toMatchObject({ status: "fallback", code: "structural-control-flow" });
		expect(evaluateExpression).not.toHaveBeenCalled();
		expect(root.childNodes).toHaveLength(0);
	});

	it("fences an older evaluating leaf as soon as a newer fallback request begins", async () => {
		const ownerDocument = createOwnerDocument();
		const root = createRoot(ownerDocument);
		let release!: (value: ExprValue) => void;
		const evaluateExpression = vi.fn<RetainedProductionExpressionEvaluator>(async () => {
			return new Promise<ExprValue>((resolve) => {
				release = resolve;
			});
		});
		const renderer = new RetainedProductionLeafRenderer(root, { evaluateExpression });

		const oldPromise = renderer.prepare(request("<p>{{name}}</p>"));
		await Promise.resolve();
		const fallback = await renderer.prepare(request("{% if name %}<b>{{name}}</b>{% endif %}"));
		expect(fallback).toMatchObject({ status: "fallback", code: "structural-control-flow" });
		expect(evaluateExpression).toHaveBeenCalledTimes(1);

		release("Old");
		await expect(oldPromise).resolves.toEqual({ status: "stale" });
		expect(root.childNodes).toHaveLength(0);
	});

	it("revokes an already-prepared leaf handle when a newer request falls back", async () => {
		const ownerDocument = createOwnerDocument();
		const root = createRoot(ownerDocument);
		const evaluateExpression = vi.fn(async () => "Prepared");
		const renderer = new RetainedProductionLeafRenderer(root, { evaluateExpression });
		const prepared = await renderer.prepare(request("<p>{{name}}</p>"));
		expect(prepared.status).toBe("prepared");
		if (prepared.status !== "prepared") throw new Error("Expected prepared retained generation");
		expect(prepared.isCurrent()).toBe(true);

		const fallback = await renderer.prepare(request("{% if name %}<b>{{name}}</b>{% endif %}"));
		expect(fallback).toMatchObject({ status: "fallback", code: "structural-control-flow" });
		expect(evaluateExpression).toHaveBeenCalledTimes(1);
		expect(prepared.isCurrent()).toBe(false);
		expect(prepared.commit(() => true)).toEqual({ status: "stale" });
		expect(root.childNodes).toHaveLength(0);
	});

	it("keeps structural and raw HTML constructs on explicit semantic fallback", () => {
		expect(inspectRetainedProductionLeafSupport(
			compileTemplateCompat("{% if name %}<b>{{name}}</b>{% endif %}"),
		)).toMatchObject({ status: "fallback", code: "structural-control-flow" });
		expect(inspectRetainedProductionLeafSupport(
			compileTemplateCompat("<div>{{ html('<b>raw</b>') }}</div>"),
		)).toMatchObject({ status: "fallback", code: "raw-html-range" });
	});

	it("stales an older expression preparation before it can supersede a newer generation", async () => {
		const ownerDocument = createOwnerDocument();
		const root = createRoot(ownerDocument);
		let releaseFirst!: (value: ExprValue) => void;
		let call = 0;
		const evaluateExpression: RetainedProductionExpressionEvaluator = async () => {
			call += 1;
			if (call === 1) {
				return new Promise<ExprValue>((resolve) => {
					releaseFirst = resolve;
				});
			}
			return "New";
		};
		const renderer = new RetainedProductionLeafRenderer(root, { evaluateExpression });
		const template = "<p>{{name}}</p>";

		const oldPromise = renderer.prepare(request(template));
		await Promise.resolve();
		const newer = await renderer.prepare(request(template, createContext(), "rev-2"));
		expect(await commitPrepared(newer)).toEqual({ status: "committed" });
		expect(root.textContent).toBe("New");

		releaseFirst("Old");
		await expect(oldPromise).resolves.toEqual({ status: "stale" });
		expect(root.textContent).toBe("New");
	});

	it("returns disposed when teardown wins during expression preparation", async () => {
		const ownerDocument = createOwnerDocument();
		const root = createRoot(ownerDocument);
		let release!: (value: ExprValue) => void;
		const evaluateExpression: RetainedProductionExpressionEvaluator = async () => {
			return new Promise<ExprValue>((resolve) => {
				release = resolve;
			});
		};
		const renderer = new RetainedProductionLeafRenderer(root, { evaluateExpression });
		const pending = renderer.prepare(request("<p>{{name}}</p>"));
		await Promise.resolve();

		renderer.dispose();
		release("Late");
		await expect(pending).resolves.toEqual({ status: "disposed" });
		expect(root.childNodes).toHaveLength(0);
	});

	it("preserves last-good DOM when expression preparation fails", async () => {
		const ownerDocument = createOwnerDocument();
		const root = createRoot(ownerDocument);
		let fail = false;
		const evaluateExpression: RetainedProductionExpressionEvaluator = async (
			expression: CompiledExpression,
			context: ExprContext,
		) => {
			if (fail) throw new Error("Evaluation failed");
			return expression.expressionSource === "name" ? context.file.name : null;
		};
		const renderer = new RetainedProductionLeafRenderer(root, { evaluateExpression });
		const template = "<p>{{name}}</p>";

		const first = await renderer.prepare(request(template));
		expect(await commitPrepared(first)).toEqual({ status: "committed" });
		const paragraph = root.querySelector("p");

		fail = true;
		const failed = await renderer.prepare(request(template, createContext(), "rev-2"));
		expect(failed.status).toBe("failed");
		expect(root.querySelector("p")).toBe(paragraph);
		expect(root.textContent).toBe("Test.md");
	});

	it("lets the existing owner-currentness gate reject final live commit", async () => {
		const ownerDocument = createOwnerDocument();
		const root = createRoot(ownerDocument);
		const renderer = new RetainedProductionLeafRenderer(root);
		const prepared = await renderer.prepare(request("<p>{{name}}</p>"));
		expect(prepared.status).toBe("prepared");
		if (prepared.status !== "prepared") throw new Error("Expected prepared retained generation");

		expect(prepared.commit(() => false)).toEqual({ status: "stale" });
		expect(root.childNodes).toHaveLength(0);
	});
});
