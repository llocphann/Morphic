import { describe, expect, it } from "vitest";
import {
	RetainedLeafOwnerLinkHost,
	type RetainedLeafOwnerRenderHostPort,
	type RetainedOwnerLinkBinding,
} from "../render/retained-leaf-owner-link-host";
import type { RetainedTemplateIrLike } from "../render/retained-template-dom-plan";

describe("RetainedLeafOwnerLinkHost binding factory receiver", () => {
	it("preserves the options-object receiver when creating a committed binding", async () => {
		const renderHost: RetainedLeafOwnerRenderHostPort<object, string> = {
			isDisposed: false,
			async prepare(_owner, _root, _scope, generation) {
				return {
					status: "prepared",
					generation,
					mode: "replace",
					structureKey: "stable",
					isCurrent: () => true,
					commit: () => ({ status: "committed" }),
					dispose: () => undefined,
				};
			},
			release: () => undefined,
			dispose: () => undefined,
		};
		const created: RetainedOwnerLinkBinding[] = [];
		const options = {
			renderHost,
			factoryPrefix: "notes",
			createLinkBinding(root: HTMLElement, sourcePath: string): RetainedOwnerLinkBinding {
				if (this.factoryPrefix !== "notes") {
					throw new Error("Binding factory receiver was detached");
				}
				let currentSourcePath = sourcePath;
				let disposed = false;
				const binding: RetainedOwnerLinkBinding = {
					get currentSourcePath() {
						return currentSourcePath;
					},
					get isDisposed() {
						return disposed;
					},
					updateSourcePath(nextSourcePath: string) {
						currentSourcePath = nextSourcePath;
					},
					dispose() {
						disposed = true;
					},
				};
				created.push(binding);
				return binding;
			},
		};
		const host = new RetainedLeafOwnerLinkHost<object, string>(options);
		const doc = new DOMParser().parseFromString("<!doctype html><html><body></body></html>", "text/html");
		const root = doc.createElement("div");
		const ir: RetainedTemplateIrLike<string> = {
			version: 1,
			sourceHash: "stable",
			nodes: [{ kind: "static-fragment", html: "<article></article>" }],
		};

		const prepared = await host.prepare(
			{},
			root,
			{ isDisposed: false, registerDisposer: disposer => disposer },
			1,
			"notes/Owner.md",
			ir,
			new Map(),
			new Map(),
		);
		expect(prepared.status).toBe("prepared");
		if (prepared.status !== "prepared") throw new Error("Expected prepared result");
		expect(prepared.commit()).toEqual({ status: "committed" });
		expect(created).toHaveLength(1);
		expect(created[0].currentSourcePath).toBe("notes/Owner.md");
	});
});
