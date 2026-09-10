import { afterEach, describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import type CustomViewsPlugin from "../main";
import { FilterBuilder } from "../settings";
import type { VaultSettingsDataSource } from "../core";
import type { Filter, FilterGroup } from "../types";

interface TestDomOptions {
	cls?: string | string[];
	text?: string;
	attr?: Record<string, unknown>;
	type?: string;
	value?: string;
}

function applyTestDomOptions(element: HTMLElement, options?: unknown): void {
	if (typeof options === "string") {
		element.className = options;
		return;
	}
	if (!options || typeof options !== "object") return;
	const info = options as TestDomOptions;
	if (info.cls) {
		const classes = Array.isArray(info.cls) ? info.cls : info.cls.split(/\s+/).filter(Boolean);
		element.classList.add(...classes);
	}
	if (info.text !== undefined) element.textContent = info.text;
	if (info.attr) {
		for (const [name, value] of Object.entries(info.attr)) {
			element.setAttribute(name, String(value));
		}
	}
	if (element.instanceOf(HTMLInputElement)) {
		if (info.type !== undefined) element.type = info.type;
		if (info.value !== undefined) element.value = info.value;
	}
}

function installObsidianDomHelpers(): () => void {
	const prototype = HTMLElement.prototype;
	const names = ["createDiv", "createEl", "createSpan", "addClass", "removeClass", "toggleClass", "instanceOf"] as const;
	const originals = new Map<string, PropertyDescriptor | undefined>();
	for (const name of names) originals.set(name, Object.getOwnPropertyDescriptor(prototype, name));

	const define = (name: string, value: unknown): void => {
		Object.defineProperty(prototype, name, { configurable: true, writable: true, value });
	};
	define("instanceOf", function (this: HTMLElement, type: { new (): unknown }): boolean {
		const typeName = (type as unknown as { name?: string }).name;
		return typeName !== undefined && this.constructor.name === typeName;
	});
	define("createDiv", function (this: HTMLElement, options?: unknown): HTMLDivElement {
		const child = document.createElement("div");
		applyTestDomOptions(child, options);
		this.appendChild(child);
		return child;
	});
	define("createEl", function (this: HTMLElement, tag: string, options?: unknown): HTMLElement {
		const child = document.createElement(tag);
		applyTestDomOptions(child, options);
		this.appendChild(child);
		return child;
	});
	define("createSpan", function (this: HTMLElement, options?: unknown): HTMLSpanElement {
		const child = document.createElement("span");
		applyTestDomOptions(child, options);
		this.appendChild(child);
		return child;
	});
	define("addClass", function (this: HTMLElement, ...classes: string[]): void {
		this.classList.add(...classes);
	});
	define("removeClass", function (this: HTMLElement, ...classes: string[]): void {
		this.classList.remove(...classes);
	});
	define("toggleClass", function (this: HTMLElement, className: string, value?: boolean): void {
		this.classList.toggle(className, value);
	});

	return () => {
		for (const name of names) {
			const original = originals.get(name);
			if (original) Object.defineProperty(prototype, name, original);
			else Reflect.deleteProperty(prototype, name);
		}
	};
}

afterEach(() => {
	vi.useRealTimers();
	document.body.replaceChildren();
});

describe("Settings RHS currentness", () => {
	it("rebuilds a long-lived row from the fresh property type without fallback scans", () => {
		const restoreDom = installObsidianDomHelpers();
		try {
			vi.useFakeTimers();

			let propertyType: "text" | "number" = "text";
			const fallbackScan = vi.fn(() => {
				throw new Error("production Settings must not fall back to whole-vault scans");
			});
			const source = {
				propertyDefinitions: vi.fn(() => Object.freeze([
					Object.freeze({ name: "rating", type: propertyType }),
				])),
			} as unknown as VaultSettingsDataSource;
			const plugin = {
				app: {
					vault: { getMarkdownFiles: fallbackScan },
					metadataCache: { getFileCache: fallbackScan },
					metadataTypeManager: { getAssignedType: () => undefined },
				} as unknown as App,
				getSettingsDataSource: () => source,
			} as unknown as CustomViewsPlugin;
			const filter: Filter = {
				type: "filter",
				field: "rating",
				operator: "is",
				value: "7",
			};
			const root: FilterGroup = { type: "group", operator: "AND", conditions: [filter] };
			const row = document.createElement("div");
			document.body.appendChild(row);

			let builder!: FilterBuilder;
			const rerender = vi.fn(() => {
				row.replaceChildren();
				builder.renderFilterRow(row, filter, root, 0);
			});
			builder = new FilterBuilder(plugin, root, () => undefined, rerender);
			let operatorValues: string[] = [];
			vi.spyOn(builder, "openCombobox").mockImplementation((items) => {
				operatorValues = items.map(item => item.value);
			});

			builder.renderFilterRow(row, filter, root, 0);
			expect(row.querySelector('input[type="text"]')).not.toBeNull();
			expect(row.querySelector('input[type="number"]')).toBeNull();
			expect(fallbackScan).not.toHaveBeenCalled();

			propertyType = "number";
			const operatorButton = row.querySelectorAll<HTMLElement>(".cv-combobox-button")[1];
			expect(operatorButton).toBeDefined();
			operatorButton.click();

			expect(rerender).toHaveBeenCalledTimes(1);
			expect(row.querySelector('input[type="number"]')).not.toBeNull();
			expect(row.querySelector('input[type="text"]')).toBeNull();
			expect(fallbackScan).not.toHaveBeenCalled();

			vi.runAllTimers();
			expect(operatorValues).toEqual(["=", "≠", "<", "≤", ">", "≥", "is empty", "is not empty"]);
			expect(fallbackScan).not.toHaveBeenCalled();
		} finally {
			restoreDom();
		}
	});
});
