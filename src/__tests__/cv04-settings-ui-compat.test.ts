import { describe, expect, it, vi } from "vitest";
import type { App, Plugin, PluginSettingTab, SettingDefinitionItem } from "obsidian";
import { installCustomViews04Capabilities } from "../cv04-capability-adapter";
import type { ViewConfig } from "../types";

function makeView(): ViewConfig {
	return {
		id: "view-1",
		name: "View 1",
		rules: { type: "group", operator: "AND", conditions: [] },
		template: "{{file.content}}",
	};
}

function makeHarness() {
	const addedTabs: PluginSettingTab[] = [];
	const cleanups: (() => void)[] = [];
	const commands: unknown[] = [];
	const view = makeView();

	const app = {
		metadataCache: { getFileCache: () => null },
		workspace: { getActiveViewOfType: () => null },
	} as unknown as App;

	const host = {
		settings: {
			enabled: true,
			workInLivePreview: true,
			workInCanvas: false,
			editableContent: true,
			allowJavaScript: true,
			views: [view],
		},
		saveSettings: async () => {},
		saveData: async () => {},
		refreshAllViews: () => {},
		findMatchedConfig: () => null,
		applyViewDisplayOptions: () => {},
		restoreDisplayOptions: () => {},
		restoreStaleOwnerSurface: () => {},
		renderMarkdownView: async () => {},
		containerIsRenderedForFile: () => false,
		markdownControllers: null,
		pendingMarkdownRequests: new Map(),
		addCommand: (command: unknown) => { commands.push(command); },
		addSettingTab: (tab: PluginSettingTab) => { addedTabs.push(tab); },
		register: (cleanup: () => void) => { cleanups.push(cleanup); },
	} as unknown as Plugin;

	installCustomViews04Capabilities(host, app);
	return { host, addedTabs, cleanups, commands };
}

describe("Custom Views 0.4 settings UI compatibility", () => {
	it("decorates the Obsidian 1.13+ definitions lifecycle without wrapping legacy display", () => {
		const { host, addedTabs } = makeHarness();
		const baseDefinitions: SettingDefinitionItem[] = [{ type: "group", items: [] }];
		const originalDefinitions = vi.fn(() => baseDefinitions);
		const originalDisplay = vi.fn();
		const tab = {
			containerEl: document.createElement("div"),
			getSettingDefinitions: originalDefinitions,
			display: originalDisplay,
		} as unknown as PluginSettingTab;

		(host as unknown as { addSettingTab(tab: PluginSettingTab): void }).addSettingTab(tab);

		expect(addedTabs).toEqual([tab]);
		const decorated = tab as unknown as {
			getSettingDefinitions(): SettingDefinitionItem[];
			display(): void;
		};
		const definitions = decorated.getSettingDefinitions();
		expect(originalDefinitions).toHaveBeenCalledTimes(1);
		expect(definitions).toHaveLength(2);
		expect(definitions[1]).toMatchObject({
			type: "list",
			heading: "View behavior and filters",
		});
		expect(decorated.display).toBe(originalDisplay);
	});

	it("decorates only the legacy display lifecycle when definitions are unavailable", () => {
		const { host, addedTabs } = makeHarness();
		const originalDisplay = vi.fn();
		const tab = {
			containerEl: document.createElement("div"),
			display: originalDisplay,
		} as unknown as PluginSettingTab;
		const before = (tab as unknown as { display(): void }).display;

		(host as unknown as { addSettingTab(tab: PluginSettingTab): void }).addSettingTab(tab);

		expect(addedTabs).toEqual([tab]);
		const decorated = tab as unknown as Record<string, unknown> & { display(): void };
		expect(decorated.display).not.toBe(before);
		expect(decorated["getSettingDefinitions"]).toBeUndefined();
	});

	it("installs the settings decorator only once", () => {
		const { host } = makeHarness();
		installCustomViews04Capabilities(host, {
			metadataCache: { getFileCache: () => null },
			workspace: { getActiveViewOfType: () => null },
		} as unknown as App);

		const originalDefinitions = vi.fn((): SettingDefinitionItem[] => []);
		const tab = {
			containerEl: document.createElement("div"),
			getSettingDefinitions: originalDefinitions,
		} as unknown as PluginSettingTab;
		(host as unknown as { addSettingTab(tab: PluginSettingTab): void }).addSettingTab(tab);

		const definitions = (tab as unknown as { getSettingDefinitions(): SettingDefinitionItem[] })
			.getSettingDefinitions();
		expect(definitions.filter(item => "type" in item && item.type === "list")).toHaveLength(1);
	});
});
