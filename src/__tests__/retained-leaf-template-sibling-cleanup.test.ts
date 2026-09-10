import { describe, expect, it, vi } from "vitest";
import { RetainedLeafTemplateTransactionSurface } from "../render/retained-leaf-template-transaction";
import { RetainedDomRuntime } from "../render/retained-slot-runtime";
import type { RetainedTemplateIrLike } from "../render/retained-template-dom-plan";

function createOwnerDocument(): Document {
	return new DOMParser().parseFromString(
		"<!doctype html><html><body></body></html>",
		"text/html",
	);
}

const template: RetainedTemplateIrLike<string> = {
	version: 1,
	sourceHash: "leaf-sibling-cleanup",
	nodes: [
		{ kind: "static-fragment", html: "<article>" },
		{ kind: "markdown-slot", id: "summary", expression: "summary" },
		{ kind: "content-slot", id: "body", expression: "content" },
		{ kind: "static-fragment", html: "</article>" },
	],
};

describe("RetainedLeafTemplateTransactionSurface sibling cleanup", () => {
	it("disposes a later prepared sibling when an earlier async slot fails", async () => {
		const ownerDocument = createOwnerDocument();
		const root = ownerDocument.createElement("div");
		ownerDocument.body.appendChild(root);
		const runtime = new RetainedDomRuntime(root);
		const surface = new RetainedLeafTemplateTransactionSurface(runtime, template);
		expect(surface.initialize(new Map())).toEqual({ status: "mounted" });

		const article = root.querySelector("article");
		const failure = new Error("Summary preparation failed");
		const bodyCleanup = vi.fn();
		const bodyRenderer = vi.fn(({ container, resources }) => {
			container.textContent = "Staged body";
			resources.register(bodyCleanup);
		});

		const result = await surface.prepareUpdate(new Map(), new Map([
			["summary", {
				renderKey: "summary-failed",
				renderer: () => {
					throw failure;
				},
			}],
			["body", {
				renderKey: "body-prepared",
				renderer: bodyRenderer,
			}],
		]));

		expect(result.status).toBe("failed");
		if (result.status !== "failed") throw new Error("Expected failed preparation");
		expect(result.error).toBe(failure);
		expect(bodyRenderer).toHaveBeenCalledTimes(1);
		expect(bodyCleanup).toHaveBeenCalledTimes(1);
		expect(root.querySelector("article")).toBe(article);
		expect(root.textContent).toBe("");
	});
});