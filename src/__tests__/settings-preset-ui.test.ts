import { describe, expect, it } from "vitest";
import type { SettingDefinitionItem } from "obsidian";
import {
	MORPHIC_FUNDING_URL,
	nextPresetTabIndex,
	nextViewName,
	normalizeBaseSettingDefinitions,
} from "../settings-preset-ui";

describe("nextViewName", () => {
	it("starts at View 1", () => {
		expect(nextViewName([])).toBe("View 1");
	});

	it("advances compact View preset names", () => {
		expect(nextViewName([
			{ name: "View 1" },
			{ name: "View 2" },
			{ name: "View 3" },
			{ name: "View 4" },
		])).toBe("View 5");
	});

	it("uses the highest numbered View after renames or gaps", () => {
		expect(nextViewName([
			{ name: "Inbox" },
			{ name: "View 2" },
			{ name: "View 7" },
		])).toBe("View 8");
	});

	it("does not let unrelated names consume View 1", () => {
		expect(nextViewName([{ name: "Projects" }, { name: "Archive" }])).toBe("View 1");
	});
});

describe("Morphic settings workspace composition", () => {
	it("uses the canonical Morphic funding destination", () => {
		expect(MORPHIC_FUNDING_URL).toBe("https://www.buymeacoffee.com/llocphann");
	});

	it("removes the legacy Views list and names the remaining settings group General", () => {
		const anonymousGeneral = {
			type: "group",
			items: [],
		} as unknown as SettingDefinitionItem;
		const legacyViews = {
			type: "list",
			heading: "Views",
			items: [],
		} as unknown as SettingDefinitionItem;

		const normalized = normalizeBaseSettingDefinitions([anonymousGeneral, legacyViews]);
		expect(normalized).toHaveLength(1);
		expect(normalized[0]).toMatchObject({ type: "group", heading: "General" });
	});

	it("does not overwrite an existing group heading", () => {
		const advanced = {
			type: "group",
			heading: "Advanced",
			items: [],
		} as unknown as SettingDefinitionItem;
		const anonymousGeneral = {
			type: "group",
			items: [],
		} as unknown as SettingDefinitionItem;

		const normalized = normalizeBaseSettingDefinitions([advanced, anonymousGeneral]);
		expect(normalized[0]).toMatchObject({ heading: "Advanced" });
		expect(normalized[1]).toMatchObject({ heading: "General" });
	});
});

describe("preset keyboard navigation", () => {
	it("wraps with ArrowLeft and ArrowRight", () => {
		expect(nextPresetTabIndex(0, "ArrowLeft", 4)).toBe(3);
		expect(nextPresetTabIndex(3, "ArrowRight", 4)).toBe(0);
	});

	it("supports Home and End", () => {
		expect(nextPresetTabIndex(2, "Home", 4)).toBe(0);
		expect(nextPresetTabIndex(1, "End", 4)).toBe(3);
	});

	it("ignores unrelated keys and invalid selections", () => {
		expect(nextPresetTabIndex(1, "Enter", 4)).toBeUndefined();
		expect(nextPresetTabIndex(-1, "ArrowRight", 4)).toBeUndefined();
		expect(nextPresetTabIndex(0, "ArrowRight", 0)).toBeUndefined();
	});
});
