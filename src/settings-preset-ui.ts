import {
	Setting,
	SettingGroup,
	requireApiVersion,
	setIcon,
	type SettingDefinitionItem,
} from "obsidian";
import { CustomViewsSettingTab } from "./settings-core";
import type { FilterGroup, ViewConfig } from "./types";

export const MORPHIC_FUNDING_URL = "https://www.buymeacoffee.com/llocphann";
const selectedViewIds = new WeakMap<CustomViewsSettingTab, string>();
let installed = false;

const EMPTY_RULES = (): FilterGroup => ({
	type: "group",
	operator: "AND",
	conditions: [],
});

type EditableSettingTab = {
	openEditModal(view: ViewConfig): void;
};

type LegacyDisplayTab = {
	display(): void;
};

type SettingsTabPrototype = {
	getSettingDefinitions(this: CustomViewsSettingTab): SettingDefinitionItem[];
	display(this: CustomViewsSettingTab): void;
};

type LooseSettingDefinition = SettingDefinitionItem & {
	type?: string;
	heading?: string;
};

export function nextViewName(views: readonly Pick<ViewConfig, "name">[]): string {
	let highest = 0;
	for (const view of views) {
		const match = /^View\s+(\d+)$/i.exec(view.name.trim());
		if (!match) continue;
		highest = Math.max(highest, Number(match[1]) || 0);
	}
	return `View ${highest + 1}`;
}

export function nextPresetTabIndex(
	currentIndex: number,
	key: string,
	length: number,
): number | undefined {
	if (length <= 0 || currentIndex < 0 || currentIndex >= length) return undefined;
	if (key === "ArrowLeft") return (currentIndex - 1 + length) % length;
	if (key === "ArrowRight") return (currentIndex + 1) % length;
	if (key === "Home") return 0;
	if (key === "End") return length - 1;
	return undefined;
}

function isLegacyViewsList(definition: SettingDefinitionItem): boolean {
	const candidate = definition as LooseSettingDefinition;
	return candidate.type === "list" && candidate.heading === "Views";
}

/**
 * The canonical settings core still exposes the historical Views list so that
 * its behavior remains available to older callers. Morphic replaces that list
 * with the compact preset workspace and names the remaining anonymous settings
 * group explicitly so the 1.13+ Settings API renders the intended order:
 * support -> Views -> General.
 */
export function normalizeBaseSettingDefinitions(
	definitions: readonly SettingDefinitionItem[],
): SettingDefinitionItem[] {
	let generalAssigned = false;
	return definitions
		.filter((definition) => !isLegacyViewsList(definition))
		.map((definition) => {
			const candidate = definition as LooseSettingDefinition;
			if (!generalAssigned && candidate.type === "group" && !candidate.heading) {
				generalAssigned = true;
				return { ...definition, heading: "General" } as SettingDefinitionItem;
			}
			return definition;
		});
}

function currentView(tab: CustomViewsSettingTab): ViewConfig | undefined {
	const views = tab.plugin.settings.views;
	const selectedId = selectedViewIds.get(tab);
	const selected = selectedId ? views.find((view) => view.id === selectedId) : undefined;
	if (selected) return selected;
	const fallback = views[0];
	if (fallback) selectedViewIds.set(tab, fallback.id);
	return fallback;
}

function refreshTab(tab: CustomViewsSettingTab): void {
	if (requireApiVersion("1.13.0")) tab.update();
	else (tab as unknown as LegacyDisplayTab).display();
}

function focusPresetButton(tab: CustomViewsSettingTab, viewId: string): void {
	queueMicrotask(() => {
		const buttons = Array.from(
			tab.containerEl.querySelectorAll<HTMLButtonElement>("[data-cv-view-id]"),
		);
		buttons.find((button) => button.dataset.cvViewId === viewId)?.focus();
	});
}

function selectView(tab: CustomViewsSettingTab, viewId: string, restoreFocus = false): void {
	selectedViewIds.set(tab, viewId);
	refreshTab(tab);
	if (restoreFocus) focusPresetButton(tab, viewId);
}

function renderSupportLink(setting: Setting): void {
	const link = setting.controlEl.createEl("a", {
		cls: "morphic-support-link",
		attr: {
			href: MORPHIC_FUNDING_URL,
			target: "_blank",
			rel: "noopener noreferrer",
			"aria-label": "Buy me a coffee",
		},
	});
	const icon = link.createSpan({ cls: "morphic-support-link-icon" });
	setIcon(icon, "coffee");
	link.createSpan({ cls: "morphic-support-link-label", text: "Buy me a coffee" });
}

function supportDefinition(): SettingDefinitionItem {
	return {
		type: "group",
		items: [
			{
				name: "Buy me a coffee",
				desc: "If this plugin is useful to you, you can support its continued development.",
				searchable: false,
				render: (setting: Setting) => renderSupportLink(setting),
			},
		],
	};
}

function updatePresetButtonLabel(tab: CustomViewsSettingTab, viewId: string, name: string): void {
	const buttons = Array.from(tab.containerEl.querySelectorAll<HTMLButtonElement>("[data-cv-view-id]"));
	const button = buttons.find((candidate) => candidate.dataset.cvViewId === viewId);
	if (!button) return;
	const label = name.trim() || "View";
	button.textContent = label;
	button.setAttribute("aria-label", `Select ${label}`);
	button.setAttribute("title", `Select ${label}`);
}

async function addView(tab: CustomViewsSettingTab): Promise<void> {
	const views = tab.plugin.settings.views;
	let id = `${Date.now()}`;
	let suffix = 1;
	while (views.some((view) => view.id === id)) id = `${Date.now()}-${suffix++}`;
	const view: ViewConfig = {
		id,
		name: nextViewName(views),
		rules: EMPTY_RULES(),
		template: "<h1>{{file.basename}}</h1>\n{{file.content}}",
	};
	views.push(view);
	selectedViewIds.set(tab, view.id);
	await tab.plugin.saveSettings();
	tab.plugin.refreshAllViews();
	refreshTab(tab);
	focusPresetButton(tab, view.id);
}

async function moveView(tab: CustomViewsSettingTab, offset: -1 | 1): Promise<void> {
	const views = tab.plugin.settings.views;
	const view = currentView(tab);
	if (!view) return;
	const index = views.indexOf(view);
	const target = index + offset;
	if (index < 0 || target < 0 || target >= views.length) return;
	views.splice(index, 1);
	views.splice(target, 0, view);
	await tab.plugin.saveSettings();
	tab.plugin.refreshAllViews();
	refreshTab(tab);
	focusPresetButton(tab, view.id);
}

async function deleteView(tab: CustomViewsSettingTab): Promise<void> {
	const views = tab.plugin.settings.views;
	const view = currentView(tab);
	if (!view) return;
	const index = views.indexOf(view);
	if (index < 0) return;
	views.splice(index, 1);
	const fallback = views[Math.min(index, views.length - 1)];
	if (fallback) selectedViewIds.set(tab, fallback.id);
	else selectedViewIds.delete(tab);
	await tab.plugin.saveSettings();
	tab.plugin.refreshAllViews();
	refreshTab(tab);
	if (fallback) focusPresetButton(tab, fallback.id);
}

function editView(tab: CustomViewsSettingTab): void {
	const view = currentView(tab);
	if (!view) return;
	const editableTab = tab as unknown as EditableSettingTab;
	editableTab.openEditModal(view);
}

function renderPresetSwitcher(tab: CustomViewsSettingTab, setting: Setting): () => void {
	setting.settingEl.addClass("cv-view-preset-switcher-setting");
	setting.controlEl.replaceChildren();

	const tabList = setting.controlEl.createDiv({ cls: "morphic-view-preset-tabs" });
	tabList.setAttribute("role", "tablist");
	tabList.setAttribute("aria-label", "Morphic view presets");

	const selected = currentView(tab);
	const tabButtons: HTMLButtonElement[] = [];
	for (const view of tab.plugin.settings.views) {
		const isSelected = view === selected;
		setting.addButton((button) => {
			button
				.setButtonText(view.name)
				.setTooltip(`Select ${view.name}`)
				.onClick(() => selectView(tab, view.id));
			button.buttonEl.dataset.cvViewId = view.id;
			button.buttonEl.setAttribute("role", "tab");
			button.buttonEl.setAttribute("aria-selected", String(isSelected));
			button.buttonEl.setAttribute("aria-label", `Select ${view.name}`);
			button.buttonEl.tabIndex = isSelected ? 0 : -1;
			if (isSelected) button.buttonEl.addClass("mod-cta");
			tabButtons.push(button.buttonEl);
			tabList.appendChild(button.buttonEl);
		});
	}

	const onKeyDown = (event: KeyboardEvent): void => {
		const currentIndex = tabButtons.indexOf(event.target as HTMLButtonElement);
		const nextIndex = nextPresetTabIndex(currentIndex, event.key, tabButtons.length);
		if (nextIndex === undefined) return;
		const nextView = tab.plugin.settings.views[nextIndex];
		if (!nextView) return;
		event.preventDefault();
		selectView(tab, nextView.id, true);
	};
	tabList.addEventListener("keydown", onKeyDown);

	setting.addButton((button) => {
		button
			.setIcon("plus")
			.setTooltip("Add view")
			.onClick(() => { void addView(tab); });
		button.buttonEl.setAttribute("aria-label", "Add view");
	});

	return () => tabList.removeEventListener("keydown", onKeyDown);
}

function renderSelectedViewManagement(tab: CustomViewsSettingTab, setting: Setting): void {
	const view = currentView(tab);
	if (!view) {
		setting.setName("Selected view").setDesc("No views yet. Use + above to create view 1.");
		return;
	}

	const views = tab.plugin.settings.views;
	const index = views.indexOf(view);
	setting.setName("Selected view").setDesc(`View ${index + 1} of ${views.length}`);
	setting.addText((text) => {
		text
			.setPlaceholder(`View ${index + 1}`)
			.setValue(view.name)
			.onChange((value) => {
				view.name = value;
				updatePresetButtonLabel(tab, view.id, value);
				void tab.plugin.saveSettings();
			});
	});
	setting.addExtraButton((button) => {
		button
			.setIcon("chevron-left")
			.setTooltip("Move left")
			.setDisabled(index <= 0)
			.onClick(() => { void moveView(tab, -1); });
	});
	setting.addExtraButton((button) => {
		button
			.setIcon("chevron-right")
			.setTooltip("Move right")
			.setDisabled(index < 0 || index >= views.length - 1)
			.onClick(() => { void moveView(tab, 1); });
	});
	setting.addExtraButton((button) => {
		button
			.setIcon("square-pen")
			.setTooltip(`Edit ${view.name}`)
			.onClick(() => editView(tab));
	});
	setting.addExtraButton((button) => {
		button
			.setIcon("trash-2")
			.setTooltip(`Delete ${view.name}`)
			.onClick(() => { void deleteView(tab); });
	});
}

function viewsDefinition(tab: CustomViewsSettingTab): SettingDefinitionItem {
	return {
		type: "group",
		heading: "Views",
		items: [
			{
				name: "View presets",
				desc: "Choose a view. Use + to create the next view.",
				searchable: false,
				render: (setting: Setting) => renderPresetSwitcher(tab, setting),
			},
			{
				name: "Selected view",
				searchable: false,
				render: (setting: Setting) => renderSelectedViewManagement(tab, setting),
			},
		],
	};
}

function renderLegacy(tab: CustomViewsSettingTab): void {
	const { containerEl } = tab;
	containerEl.empty();

	const support = new Setting(containerEl)
		.setName("Buy me a coffee")
		.setDesc("If this plugin is useful to you, you can support its continued development.");
	renderSupportLink(support);

	containerEl.createEl("h2", { text: "Views" });
	const preset = new Setting(containerEl);
	renderPresetSwitcher(tab, preset);
	const selected = new Setting(containerEl);
	renderSelectedViewManagement(tab, selected);

	const general = new SettingGroup(containerEl).setHeading("General");
	general.addSetting((setting) => {
		setting
			.setName("Work in live preview")
			.setDesc("Enable to allow custom views in both live preview and reading view. Disable to limit them to reading view only.")
			.addToggle((toggle) => toggle
				.setValue(tab.plugin.settings.workInLivePreview)
				.onChange(async (value) => {
					tab.plugin.settings.workInLivePreview = value;
					await tab.plugin.saveSettings();
					tab.plugin.refreshAllViews();
					renderLegacy(tab);
				}));
	});
	if (tab.plugin.settings.workInLivePreview) {
		general.addSetting((setting) => {
			setting
				.setName("Editable content in live preview")
				.setDesc("When enabled, the {{file.content}} area becomes an editable live editor instead of a read-only render.")
				.addToggle((toggle) => toggle
					.setValue(tab.plugin.settings.editableContent)
					.onChange(async (value) => {
						tab.plugin.settings.editableContent = value;
						await tab.plugin.saveSettings();
						tab.plugin.refreshAllViews();
					}));
		});
	}
	general.addSetting((setting) => {
		setting
			.setName("Work in canvas (experimental)")
			.addToggle((toggle) => toggle
				.setValue(tab.plugin.settings.workInCanvas)
				.onChange(async (value) => {
					tab.plugin.settings.workInCanvas = value;
					await tab.plugin.saveSettings();
					tab.plugin.refreshAllViews();
				}));
	});
	general.addSetting((setting) => {
		setting
			.setName("Allow JavaScript execution")
			.setDesc("When enabled, inline <script> tags and per-view JS fields are executed. Disable if you only use HTML/CSS templates and want to prevent dynamic code execution.")
			.addToggle((toggle) => toggle
				.setValue(tab.plugin.settings.allowJavaScript)
				.onChange(async (value) => {
					tab.plugin.settings.allowJavaScript = value;
					await tab.plugin.saveSettings();
					tab.plugin.refreshAllViews();
				}));
	});
}

export function installMorphicSettingsPresetUi(): void {
	if (installed) return;
	installed = true;
	const prototype = CustomViewsSettingTab.prototype as unknown as SettingsTabPrototype;
	const originalDefinitions: SettingsTabPrototype["getSettingDefinitions"] = Reflect.get(
		prototype,
		"getSettingDefinitions",
	);

	prototype.getSettingDefinitions = function getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			supportDefinition(),
			viewsDefinition(this),
			...normalizeBaseSettingDefinitions(originalDefinitions.call(this)),
		];
	};

	prototype.display = function display(): void {
		renderLegacy(this);
	};
}
