import {
	FuzzySuggestModal,
	MarkdownView,
	Modal,
	Setting,
	type App,
	type Plugin,
	type PluginSettingTab,
	type SettingDefinitionItem,
	type TFile,
} from "obsidian";
import { NativeRuleEngine } from "./native-filters/engine";
import { mountNativeFilters } from "./native-filters/editor";
import { NavigationSurfaceHold } from "./render/navigation-surface-hold";
import { loadValidatedSettings } from "./settings-loader";
import { getSharedSettingsWriter } from "./settings-writer";
import type { ViewConfig } from "./types";

interface MorphicSettingsLike {
	enabled: boolean;
	views: ViewConfig[];
	[key: string]: unknown;
}

interface RenderControllerLike {
	readonly currentPendingKey: string | null;
}

interface ControllerRegistryLike {
	get(owner: MarkdownView): RenderControllerLike | undefined;
}

interface MorphicCapabilityHost extends Plugin {
	settings: MorphicSettingsLike;
	saveSettings(): Promise<void>;
	refreshAllViews(): void;
	findMatchedConfig(file: TFile): ViewConfig | null;
	applyViewDisplayOptions(container: HTMLElement, viewConfig?: ViewConfig): void;
	restoreDisplayOptions(container: HTMLElement): void;
	restoreStaleOwnerSurface(view: MarkdownView, file: TFile): void;
	renderMarkdownView(view: MarkdownView, file: TFile, forceSemanticRefresh?: boolean): Promise<void>;
	containerIsRenderedForFile(container: HTMLElement, file: TFile): boolean;
	markdownControllers?: ControllerRegistryLike | null;
	pendingMarkdownRequests?: Map<MarkdownView, unknown>;
}

interface Installation {
	dispose(): void;
}

const installKey = Symbol("morphic.cv04-capability-adapter");
const settingsUiKey = Symbol("morphic.cv04-settings-ui");
type InstallableHost = MorphicCapabilityHost & { [installKey]?: Installation };
type DecoratedSettingTab = Record<string, unknown> & {
	[settingsUiKey]?: boolean;
	containerEl: HTMLElement;
};
type SettingDefinitionsMethod = (this: PluginSettingTab) => SettingDefinitionItem[];
type LegacyDisplayMethod = (this: PluginSettingTab) => void;

/**
 * Adapt selected Custom Views 0.4 capabilities at stable Morphic lifecycle
 * boundaries while leaving Core V2 render ownership authoritative.
 */
export function installCustomViews04Capabilities(plugin: Plugin, app: App): void {
	const host = plugin as unknown as InstallableHost;
	if (host[installKey]) return;
	if (!hasCapabilityHostShape(host)) return;

	let disposed = false;
	const restores: (() => void)[] = [];
	const navigation = new NavigationSurfaceHold("obsidian-custom-view-render");

	validateCurrentSettings(host);
	installSerializedSettings(host, app, restores);

	const nativeRules = new NativeRuleEngine(app, () => {
		if (!disposed) host.refreshAllViews();
	});
	installNativeRuleMatching(host, app, nativeRules, restores);
	installDisplayPreferences(host, restores);
	installNavigationContinuity(host, navigation, restores);
	installSettingsUi(host, app, restores);
	installCapabilityCommands(host, app);

	void nativeRules.prepare().then(() => {
		if (!disposed && host.settings.views.some(view => view.basesFilters !== undefined)) {
			host.refreshAllViews();
		}
	}).catch(() => {
		// Native Bases filters are optional. Legacy compiled rules continue to work
		// when the Bases core plugin is unavailable.
	});

	const installation: Installation = {
		dispose() {
			if (disposed) return;
			disposed = true;
			navigation.dispose();
			nativeRules.clear();
			for (const restore of restores.reverse()) restore();
			delete host[installKey];
		},
	};
	host[installKey] = installation;
	plugin.register(() => installation.dispose());
}

function hasCapabilityHostShape(host: Partial<MorphicCapabilityHost>): host is MorphicCapabilityHost {
	return !!host.settings
		&& Array.isArray(host.settings.views)
		&& typeof host.saveSettings === "function"
		&& typeof host.refreshAllViews === "function"
		&& typeof host.findMatchedConfig === "function"
		&& typeof host.applyViewDisplayOptions === "function"
		&& typeof host.restoreDisplayOptions === "function"
		&& typeof host.restoreStaleOwnerSurface === "function"
		&& typeof host.renderMarkdownView === "function"
		&& typeof host.containerIsRenderedForFile === "function";
}

function validateCurrentSettings(host: MorphicCapabilityHost): void {
	const result = loadValidatedSettings(host.settings);
	host.settings = result.settings as unknown as MorphicSettingsLike;
	if (result.recovered) {
		console.warn("[Morphic] Recovered malformed settings; original data is retained in recoveryData.");
	}
}

function installSerializedSettings(
	host: MorphicCapabilityHost,
	app: App,
	restores: (() => void)[],
): void {
	const original = host.saveSettings.bind(host);
	const writer = getSharedSettingsWriter<MorphicSettingsLike>(app, snapshot => host.saveData(snapshot));
	host.saveSettings = () => writer.save(host.settings);
	restores.push(() => { host.saveSettings = original; });
}

function installNativeRuleMatching(
	host: MorphicCapabilityHost,
	app: App,
	engine: NativeRuleEngine,
	restores: (() => void)[],
): void {
	const originalFind = host.findMatchedConfig.bind(host);
	const originalRefresh = host.refreshAllViews.bind(host);

	host.findMatchedConfig = (file: TFile): ViewConfig | null => {
		if (!host.settings.enabled) return null;
		const cache = app.metadataCache.getFileCache(file);
		for (const view of host.settings.views) {
			if (engine.matches(view, file, cache?.frontmatter)) return view;
		}
		return null;
	};

	host.refreshAllViews = () => {
		engine.clear();
		originalRefresh();
	};

	restores.push(() => {
		host.findMatchedConfig = originalFind;
		host.refreshAllViews = originalRefresh;
	});
}

function installDisplayPreferences(host: MorphicCapabilityHost, restores: (() => void)[]): void {
	const originalApply = host.applyViewDisplayOptions.bind(host);
	const originalRestore = host.restoreDisplayOptions.bind(host);

	host.applyViewDisplayOptions = (container, viewConfig) => {
		originalApply(container, viewConfig);
		const hidden = viewConfig?.showNavigationBar === false;
		container.toggleClass("cv-hide-navigation", hidden);
		container.parentElement?.toggleClass("cv-hide-navigation", hidden);
	};

	host.restoreDisplayOptions = (container) => {
		originalRestore(container);
		container.removeClass("cv-hide-navigation");
		container.parentElement?.removeClass("cv-hide-navigation");
	};

	restores.push(() => {
		host.applyViewDisplayOptions = originalApply;
		host.restoreDisplayOptions = originalRestore;
	});
}

function installNavigationContinuity(
	host: MorphicCapabilityHost,
	navigation: NavigationSurfaceHold,
	restores: (() => void)[],
): void {
	const originalRestoreStale = host.restoreStaleOwnerSurface.bind(host);
	const originalRenderMarkdown = host.renderMarkdownView.bind(host);

	host.restoreStaleOwnerSurface = (view, file) => {
		if (!host.containerIsRenderedForFile(view.contentEl, file)) {
			navigation.hold(view.contentEl);
		}
		originalRestoreStale(view, file);
	};

	host.renderMarkdownView = async (view, file, forceSemanticRefresh = true) => {
		await originalRenderMarkdown(view, file, forceSemanticRefresh);
		if (view.file !== file) return;

		const current = host.containerIsRenderedForFile(view.contentEl, file);
		const controllerPending = host.markdownControllers?.get(view)?.currentPendingKey;
		const queued = host.pendingMarkdownRequests?.has(view) ?? false;
		if (current || (!controllerPending && !queued)) navigation.release(view.contentEl);
		navigation.releaseDetached();
	};

	restores.push(() => {
		host.restoreStaleOwnerSurface = originalRestoreStale;
		host.renderMarkdownView = originalRenderMarkdown;
	});
}

function installSettingsUi(
	host: MorphicCapabilityHost,
	app: App,
	restores: (() => void)[],
): void {
	const originalAddSettingTab = host.addSettingTab.bind(host);

	host.addSettingTab = (settingTab: PluginSettingTab): void => {
		decorateSettingsTab(settingTab, host, app);
		originalAddSettingTab(settingTab);
	};

	restores.push(() => { host.addSettingTab = originalAddSettingTab; });
}

function decorateSettingsTab(
	settingTab: PluginSettingTab,
	host: MorphicCapabilityHost,
	app: App,
): void {
	const tab = settingTab as unknown as DecoratedSettingTab;
	if (tab[settingsUiKey]) return;
	tab[settingsUiKey] = true;

	// Obsidian 1.13+ consumes declarative setting definitions. Read the method
	// structurally so Morphic can keep minAppVersion 1.11.10 without statically
	// depending on the newer API surface.
	const definitionsMember = tab["getSettingDefinitions"];
	if (typeof definitionsMember === "function") {
		const originalDefinitions = definitionsMember as SettingDefinitionsMethod;
		tab["getSettingDefinitions"] = () => [
			...originalDefinitions.call(settingTab),
			createViewBehaviorDefinition(host, app),
		];
		return;
	}

	// Obsidian 1.11–1.12 uses the imperative display lifecycle. This branch is
	// reached only when the 1.13+ definitions API is absent, preventing duplicate
	// sections on newer releases while preserving compatibility with older ones.
	const displayMember = tab["display"];
	if (typeof displayMember === "function") {
		const originalDisplay = displayMember as LegacyDisplayMethod;
		tab["display"] = () => {
			originalDisplay.call(settingTab);
			renderLegacyViewBehaviorSection(tab.containerEl, host, app);
		};
	}
}

function createViewBehaviorDefinition(
	host: MorphicCapabilityHost,
	app: App,
): SettingDefinitionItem {
	return {
		type: "list",
		heading: "View behavior and filters",
		emptyState: "No views added yet.",
		items: host.settings.views.map(view => ({
			name: view.name,
			searchable: true,
			render: (setting: Setting) => renderViewBehaviorControls(setting, host, app, view),
		})),
	};
}

function renderLegacyViewBehaviorSection(
	container: HTMLElement,
	host: MorphicCapabilityHost,
	app: App,
): void {
	container.createEl("h3", { text: "View behavior and filters" });
	if (!host.settings.views.length) {
		new Setting(container).setName("No views added yet.");
		return;
	}

	for (const view of host.settings.views) {
		renderViewBehaviorControls(new Setting(container).setName(view.name), host, app, view);
	}
}

function renderViewBehaviorControls(
	setting: Setting,
	host: MorphicCapabilityHost,
	app: App,
	view: ViewConfig,
): void {
	const mode = view.basesFilters === undefined ? "Legacy morphic rules" : "Native bases filters";
	setting
		.setDesc(mode)
		.addToggle(toggle => toggle
			.setValue(view.showNavigationBar ?? true)
			.onChange(value => {
				view.showNavigationBar = value;
				void host.saveSettings().then(() => host.refreshAllViews());
			}))
		.addButton(button => button
			.setButtonText("Edit filters")
			.onClick(() => new NativeFiltersModal(app, host, view).open()));
}

function installCapabilityCommands(host: MorphicCapabilityHost, app: App): void {
	host.addCommand({
		id: "edit-native-bases-filters",
		name: "Edit native bases filters",
		checkCallback: checking => {
			if (!host.settings.views.length) return false;
			if (!checking) new ViewFilterSuggestModal(app, host).open();
			return true;
		},
	});

	host.addCommand({
		id: "toggle-current-view-navigation-bar",
		name: "Toggle navigation bar for current view",
		checkCallback: checking => {
			const markdown = app.workspace.getActiveViewOfType(MarkdownView);
			const file = markdown?.file;
			const view = file ? host.findMatchedConfig(file) : null;
			if (!view) return false;
			if (!checking) {
				view.showNavigationBar = view.showNavigationBar === false;
				void host.saveSettings().then(() => host.refreshAllViews());
			}
			return true;
		},
	});
}

class ViewFilterSuggestModal extends FuzzySuggestModal<ViewConfig> {
	constructor(app: App, private readonly host: MorphicCapabilityHost) {
		super(app);
		this.setPlaceholder("Choose a morphic view");
	}

	getItems(): ViewConfig[] {
		return this.host.settings.views;
	}

	getItemText(item: ViewConfig): string {
		return item.name;
	}

	onChooseItem(item: ViewConfig): void {
		new NativeFiltersModal(this.app, this.host, item).open();
	}
}

class NativeFiltersModal extends Modal {
	private disposeEditor?: () => void;

	constructor(
		app: App,
		private readonly host: MorphicCapabilityHost,
		private readonly view: ViewConfig,
	) {
		super(app);
		this.setTitle(`Native Bases filters — ${view.name}`);
	}

	onOpen(): void {
		this.contentEl.empty();

		new Setting(this.contentEl)
			.setName("Show navigation bar")
			.setDesc("Keep the Obsidian view header visible while this custom view is active.")
			.addToggle(toggle => toggle
				.setValue(this.view.showNavigationBar ?? true)
				.onChange(value => {
					this.view.showNavigationBar = value;
					void this.host.saveSettings().then(() => this.host.refreshAllViews());
				}));

		new Setting(this.contentEl)
			.setName("Rule engine")
			.setDesc(this.view.basesFilters === undefined
				? "Legacy morphic rules stay active until the native filter below is changed."
				: "Native bases filters are active for this view.");

		const hostEl = this.contentEl.createDiv({ cls: "cv-bases-query-container" });
		this.disposeEditor = mountNativeFilters(this.app, hostEl, this.view, () => {
			void this.host.saveSettings().then(() => this.host.refreshAllViews());
		});

		if (this.view.basesFilters !== undefined) {
			new Setting(this.contentEl)
				.setName("Use legacy morphic rules")
				.setDesc("Return this view to the compiled morphic rule matcher without deleting its legacy rule configuration.")
				.addButton(button => button.setButtonText("Use legacy rules").onClick(() => {
					this.view.basesFilters = undefined;
					void this.host.saveSettings().then(() => {
						this.host.refreshAllViews();
						this.close();
					});
				}));
		}
	}

	onClose(): void {
		this.disposeEditor?.();
		this.disposeEditor = undefined;
		this.contentEl.empty();
	}
}
