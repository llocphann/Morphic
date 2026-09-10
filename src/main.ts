import { Component, Keymap, MarkdownView, Menu, Notice, Plugin, TFile, TFolder, type TAbstractFile, WorkspaceLeaf } from "obsidian";
import { Compartment, StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { CustomViewsSettings, DEFAULT_SETTINGS, CustomViewsSettingTab } from "./settings";
import { checkRules } from "./matcher";
import { stripFrontmatter } from "./frontmatter";
import { EDITABLE_PLACEHOLDER_ATTR, renderTemplate, templateHasEditableContent } from "./renderer";
import { createEditableContentExtensions } from "./editable-content";
import { warmCustomViewScriptEngine } from "./script-engine";
import type { ViewConfig } from "./types";
import { EmbeddedBasesProvider } from "./bases/provider";
import { registerAssignedPropertyTypeInvalidation } from "./assigned-property-type-invalidation";
import {
	ActiveTimeScheduler,
	InvalidationEngine,
	ReactiveDataCore,
	RenderControllerRegistry,
	beginRevisionTrackedRuntimeRender,
	dependencyKey,
	nextActiveTimeBoundary,
	type DependencyKey,
	type RenderPreparationContext,
	type RenderTransaction,
	type TimeDependencyPolicy,
	type VaultSettingsDataSource,
} from "./core";
import {
	CanvasDirtyScheduler,
	type CanvasRenderToken,
} from "./render/canvas-dirty-scheduler";
import {
	RetainedStaticOwnerSurfaceRegistry,
	compileRetainedStaticTemplate,
} from "./render/retained-static-owner-surface";
import {
	RetainedSimpleStructuralOwnerSurfaceRegistry,
	compileRetainedSimpleStructuralTemplate,
} from "./render/retained-production-simple-structural-owner";

const CUSTOM_VIEW_CLASS = "obsidian-custom-view-render";
const HIDE_MARKDOWN_CLASS = "obsidian-custom-view-hidden";
const EDITABLE_MODE_CLASS = "obsidian-custom-view-editable";
const PENDING_VIEW_CLASS = "obsidian-custom-view-pending";
const MAX_MARKDOWN_SELF_STALE_RETRIES = 1;

interface CanvasNode {
	file?: TFile;
	nodeEl?: HTMLElement;
}

type RuntimeDataOwner = MarkdownView | CanvasNode;

interface CanvasNodeCollection {
	forEach(callback: (node: CanvasNode) => void): void;
}

interface CanvasView {
	containerEl?: HTMLElement;
	canvas?: {
		nodes?: CanvasNodeCollection;
	};
}

function isCanvasView(view: unknown): view is CanvasView {
	return typeof view === "object" && view !== null && "canvas" in view;
}

function isAnchorElement(element: Element | null): element is HTMLAnchorElement {
	return element?.tagName === "A";
}

function getCM6EditorView(view: MarkdownView): EditorView | null {
	try {
		const cm = (view.editor as { cm?: EditorView }).cm;
		if (cm instanceof EditorView) return cm;
	} catch {
		// Fall through to DOM lookup.
	}
	const cmDom = view.contentEl.querySelector(".cm-editor");
	if (cmDom) return EditorView.findFromDOM(cmDom as HTMLElement) ?? null;
	return null;
}

interface EditableState {
	originalParent: HTMLElement;
	originalNextSibling: Node | null;
	editorEl: HTMLElement;
	cmView: EditorView;
}

interface CompartmentEntry {
	compartment: Compartment;
	appended: boolean;
}

type MarkdownMode = "source" | "livepreview" | "preview";

interface MarkdownRenderInput {
	view: MarkdownView;
	file: TFile;
	matchedConfig: ViewConfig | null;
	mode: MarkdownMode;
	stateKey: string;
	requestKey?: string;
	sourceContent?: string;
}

interface MarkdownSourceRevisionState {
	stateKey: string;
	sourceContent: string;
	revision: number;
}

interface PendingMarkdownRequest {
	file: TFile;
	timer: number;
}

interface MarkdownSelfStaleRetryState {
	requestKey: string;
	retries: number;
}

interface CanvasRenderInput {
	node: CanvasNode;
	file: TFile;
	container: HTMLElement;
	matchedConfig: ViewConfig | null;
	isSchedulerCurrent: () => boolean;
	stateKey: string;
}

interface CanvasNodeSnapshot {
	file: TFile | null;
	container: HTMLElement | null;
}

interface CanvasOwnerState {
	scheduler: CanvasDirtyScheduler<CanvasNode>;
	observer: MutationObserver | null;
	root: HTMLElement | null;
	nodes: Map<CanvasNode, CanvasNodeSnapshot>;
}

interface ScopedOverlayElement extends HTMLElement {
	__cvScopeObserver?: MutationObserver | null;
}

export default class CustomViewsPlugin extends Plugin {
	settings: CustomViewsSettings;

	private editableStates: WeakMap<HTMLElement, EditableState> = new WeakMap();
	private compartments: WeakMap<EditorView, CompartmentEntry> = new WeakMap();
	private settingsVersion = 0;
	private nextScopeId = 0;
	private scopeIds: WeakMap<HTMLElement, string> = new WeakMap();
	private basesProvider: EmbeddedBasesProvider | undefined;
	private unloaded = false;
	private runtimeDataInvalidation: InvalidationEngine<RuntimeDataOwner> | null = null;
	private runtimeDataCore: ReactiveDataCore<RuntimeDataOwner> | null = null;
	private runtimeTimeScheduler: ActiveTimeScheduler | null = null;
	private retainedOwnerSurfaces?: RetainedStaticOwnerSurfaceRegistry<RuntimeDataOwner>;
	private retainedStructuralOwnerSurfaces?: RetainedSimpleStructuralOwnerSurfaceRegistry<RuntimeDataOwner>;

	/** Every MarkdownView is an independent render owner. */
	private markdownControllers: RenderControllerRegistry<MarkdownView, MarkdownRenderInput> | null = null;

	/** Event coalescing is keyed per owner; there is no single global pending file. */
	private pendingMarkdownRequests = new Map<MarkdownView, PendingMarkdownRequest>();
	private markdownSourceRevisions: WeakMap<MarkdownView, MarkdownSourceRevisionState> = new WeakMap();
	private markdownSelfStaleRetries?: WeakMap<MarkdownView, MarkdownSelfStaleRetryState>;


	/** Every Canvas node has an independent transactional render controller. */
	private canvasControllers: RenderControllerRegistry<CanvasNode, CanvasRenderInput> | null = null;

	/** Canvas lifecycle state is owned per Canvas view, never globally per file. */
	private canvasOwners = new Map<CanvasView, CanvasOwnerState>();

	async onload() {
		this.unloaded = false;
		await this.loadSettings();
		this.prepareScriptEngine();

		this.markdownControllers = new RenderControllerRegistry((owner) => {
			return (input, context) => this.prepareMarkdownRender(owner, input, context);
		});


		this.canvasControllers = new RenderControllerRegistry((owner) => {
			return (input, context) => this.prepareCanvasRender(owner, input, context);
		});

		this.initializeRuntimeDataCore();
		registerAssignedPropertyTypeInvalidation(this, this.app, this.runtimeDataInvalidation);
		this.basesProvider = new EmbeddedBasesProvider(
			this,
			this.ensureRuntimeDataCore().snapshots.revisions,
		);
		this.basesProvider.register();
		this.addSettingTab(new CustomViewsSettingTab(this.app, this));

		this.app.workspace.onLayoutReady(() => {
			window.setTimeout(() => {
				if (!this.unloaded) this.refreshAllViews();
			}, 0);
		});

		this.addCommand({
			id: "enable",
			name: "Enable",
			checkCallback: (checking) => {
				if (checking) return !this.settings.enabled;
				void this.setPluginState(true);
				return true;
			},
		});

		this.addCommand({
			id: "disable",
			name: "Disable",
			checkCallback: (checking) => {
				if (checking) return this.settings.enabled;
				void this.setPluginState(false);
				return true;
			},
		});

		this.registerEvent(
			this.app.workspace.on("file-open", (file) => {
				if (!file) return;

				// file-open may arrive before MarkdownView.file settles. Cancel the active
				// owner's pending generation immediately and fall back to Obsidian's native
				// surface instead of leaving an overlay for the previous file visible/hidden.
				const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (activeView) {
					this.markdownControllers?.get(activeView)?.cancelPending();
					this.restoreStaleOwnerSurface(activeView, file);
				}

				this.queueMarkdownOwnersForFile(file);
				window.setTimeout(() => {
					if (!this.unloaded) this.queueMarkdownOwnersForFile(file);
				}, 0);
			})
		);

		this.registerEvent(
			this.app.workspace.on("layout-change", () => {
				this.sweepMarkdownOwners();
				this.queueAllMarkdownOwners();
				this.syncCanvasOwners();
			})
		);

		this.registerEvent(
			this.app.workspace.on("active-leaf-change", (leaf) => {
				this.syncCanvasOwners();

				if (leaf && leaf.view instanceof MarkdownView && leaf.view.file) {
					const view = leaf.view;
					const file = view.file;
					if (!file) return;
					this.restoreStaleOwnerSurface(view, file);
					this.queueMarkdownView(view, file);
				}
			})
		);

		this.registerEvent(
			this.app.workspace.on("editor-change", (_editor, info) => {
				if (!this.settings.enabled || !this.settings.workInLivePreview) return;
				if (info instanceof MarkdownView && info.file) {
					this.queueMarkdownView(info, info.file);
				}
			})
		);

		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (file instanceof TFile) this.runtimeDataCore?.fileContentModified(file);
				if (file instanceof TFile) this.markCanvasFileDirty(file);
			})
		);

		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				this.forwardRuntimeRename(file, oldPath);
				if (file instanceof TFile) this.markCanvasFileDirty(file);
			})
		);

		this.registerEvent(
			this.app.vault.on("create", (file) => {
				this.forwardRuntimeCreate(file);
				if (file instanceof TFile) this.markCanvasFileDirty(file);
			})
		);

		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				this.forwardRuntimeDelete(file);
			})
		);

		this.registerEvent(
			this.app.metadataCache.on("changed", (file) => {
				this.runtimeDataCore?.fileMetadataRefreshed(file);
				this.markCanvasFileDirty(file);
			})
		);
	}

	async setPluginState(enabled: boolean) {
		this.settings.enabled = enabled;
		await this.saveSettings();
		new Notice(enabled ? "Custom Views Enabled" : "Custom Views Disabled");
		this.refreshAllViews();
	}

	onunload() {
		this.unloaded = true;
		for (const request of this.pendingMarkdownRequests.values()) {
			window.clearTimeout(request.timer);
		}
		this.pendingMarkdownRequests.clear();

		this.app.workspace.iterateAllLeaves((leaf) => {
			if (leaf.view instanceof MarkdownView) {
				this.restoreEditableView(leaf.view);
				this.restoreDefaultView(leaf.view);
			}
		});

		this.markdownControllers?.dispose();
		this.markdownControllers = null;

		this.disposeCanvasOwners(true);
		this.canvasControllers?.dispose();
		this.canvasControllers = null;

		this.retainedOwnerSurfaces?.dispose();
		this.retainedOwnerSurfaces = undefined;
		this.retainedStructuralOwnerSurfaces?.dispose();
		this.retainedStructuralOwnerSurfaces = undefined;

		this.basesProvider?.dispose();
		this.basesProvider = undefined;
		this.runtimeTimeScheduler?.dispose();
		this.runtimeTimeScheduler = null;
		this.runtimeDataCore = null;
		this.runtimeDataInvalidation = null;
	}

	private prepareScriptEngine() {
		if (!this.settings.allowJavaScript) return;
		void warmCustomViewScriptEngine().catch((e) => {
			console.error("[Custom Views] Failed to initialize script engine:", e);
		});
	}

	private restoreStaleOwnerSurface(view: MarkdownView, file: TFile) {
		if (!this.settings.enabled) return;
		const container = view.contentEl;
		if (this.containerIsRenderedForFile(container, file)) return;

		const ownsMorphicSurface =
			this.editableStates.has(container) ||
			!!container.querySelector(`.${CUSTOM_VIEW_CLASS}`) ||
			container.hasAttribute("data-cv-file-path") ||
			container.hasAttribute("data-cv-state");
		if (!ownsMorphicSurface) return;

		// Navigation invalidation is not a partial render commit: restore the native
		// owner surface synchronously, then let the new generation prepare off-surface.
		// If preparation fails, the pane remains usable instead of becoming blank.
		this.markdownControllers?.get(view)?.releaseCommitted();
		this.restoreEditableView(view);
		this.restoreDefaultView(view);
	}

	private containerIsRenderedForFile(container: HTMLElement, file: TFile): boolean {
		const renderedFilePath = container.getAttribute("data-cv-file-path");
		if (renderedFilePath) return renderedFilePath === file.path;
		const appliedState = container.getAttribute("data-cv-state");
		return appliedState?.startsWith(`${file.path}::`) ?? false;
	}

	private setAppliedState(container: HTMLElement, file: TFile, stateKey: string) {
		container.setAttribute("data-cv-state", stateKey);
		container.setAttribute("data-cv-file-path", file.path);
	}

	private clearAppliedState(container: HTMLElement) {
		container.removeAttribute("data-cv-state");
		container.removeAttribute("data-cv-file-path");
	}

	private getViewSourceContent(view: MarkdownView, file: TFile): string | undefined {
		const state = view.getState();
		if (state.mode !== "source" || state.source !== false || view.file !== file) {
			return undefined;
		}
		try {
			return view.getViewData();
		} catch {
			return undefined;
		}
	}

	private computeMarkdownRequestKey(
		view: MarkdownView,
		stateKey: string,
		mode: MarkdownMode,
		sourceContent: string | undefined,
	): string {
		if (mode !== "livepreview" || sourceContent === undefined) return stateKey;
		const revisions = this.markdownSourceRevisions ??= new WeakMap<MarkdownView, MarkdownSourceRevisionState>();
		const previous = revisions.get(view);
		if (previous?.stateKey === stateKey && previous.sourceContent === sourceContent) {
			return `${stateKey}::source:${previous.revision}`;
		}
		const revision = previous?.stateKey === stateKey ? previous.revision + 1 : 1;
		revisions.set(view, { stateKey, sourceContent, revision });
		return `${stateKey}::source:${revision}`;
	}

	private currentMarkdownRequestKey(view: MarkdownView, file: TFile): string | null {
		if (view.file !== file) return null;
		const matchedConfig = this.findMatchedConfig(file);
		const mode = this.getMarkdownMode(view);
		const stateKey = this.computeStateKey(file, mode, matchedConfig);
		const sourceContent = this.getViewSourceContent(view, file);
		return this.computeMarkdownRequestKey(view, stateKey, mode, sourceContent);
	}

	/** Compatibility entry point: process every MarkdownView currently showing file. */
	async processActiveView(file: TFile | null) {
		if (!file) return;
		const tasks: Promise<void>[] = [];
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (leaf.view instanceof MarkdownView && leaf.view.file === file) {
				tasks.push(this.renderMarkdownView(leaf.view, file));
			}
		});
		await Promise.all(tasks);
	}

	private queueMarkdownOwnersForFile(file: TFile) {
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (leaf.view instanceof MarkdownView && leaf.view.file === file) {
				this.queueMarkdownView(leaf.view, file);
			}
		});
	}

	private queueAllMarkdownOwners() {
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (leaf.view instanceof MarkdownView && leaf.view.file) {
				this.queueMarkdownView(leaf.view, leaf.view.file);
			}
		});
	}

	private queueMarkdownView(view: MarkdownView, file: TFile) {
		if (this.unloaded) return;

		const candidate = this.buildMarkdownRenderInput(view, file);
		if (!candidate) return;
		const controller = this.markdownControllers?.getOrCreate(view);
		if (!controller) return;
		const candidateRequestKey = candidate.requestKey ?? candidate.stateKey;

		// Repeated layout/file-open bursts for the same owner/request do not restart
		// an already-preparing generation. Live Preview source revisions are private
		// request identity and never change the stable DOM data-cv-state key.
		if (controller.currentPendingKey === candidateRequestKey) return;

		// A different owner request invalidates pending work immediately so an old
		// async render cannot commit while this zero-delay coalescer is waiting.
		if (controller.currentPendingKey && controller.currentPendingKey !== candidateRequestKey) {
			controller.cancelPending();
		}

		const previous = this.pendingMarkdownRequests.get(view);
		if (previous) window.clearTimeout(previous.timer);

		const timer = window.setTimeout(() => {
			const request = this.pendingMarkdownRequests.get(view);
			if (!request || request.timer !== timer) return;
			this.pendingMarkdownRequests.delete(view);
			if (this.unloaded || view.file !== request.file) return;
			// Generic layout/file-open churn is not itself a semantic invalidation.
			// Data/settings/source paths change request identity before queueing;
			// unchanged owners therefore retain the RenderController zero-work skip.
			void this.renderMarkdownView(view, request.file, false);
		}, 0);

		this.pendingMarkdownRequests.set(view, { file, timer });
	}

	private forwardRuntimeCreate(file: TAbstractFile): void {
		const core = this.runtimeDataCore;
		if (!core) return;
		if (file instanceof TFile) core.fileCreated(file);
		else if (file instanceof TFolder) core.folderCreated(file.path);
	}

	private forwardRuntimeDelete(file: TAbstractFile): void {
		const core = this.runtimeDataCore;
		if (!core) return;
		if (file instanceof TFile) core.fileDeleted(file.path);
		else if (file instanceof TFolder) core.folderTreeDeleted(file.path);
	}

	private forwardRuntimeRename(file: TAbstractFile, oldPath: string): void {
		const core = this.runtimeDataCore;
		if (!core) return;
		if (file instanceof TFile) {
			core.fileRenamed(oldPath, file);
			return;
		}
		if (!(file instanceof TFolder)) return;

		const files: TFile[] = [];
		const folderPaths: string[] = [];
		const visit = (folder: TFolder): void => {
			for (const child of folder.children) {
				if (child instanceof TFile) {
					if (child.extension === "md") files.push(child);
				} else if (child instanceof TFolder) {
					folderPaths.push(child.path);
					visit(child);
				}
			}
		};
		visit(file);
		core.folderTreeRenamed(oldPath, file.path, files, folderPaths);
	}

	private initializeRuntimeDataCore(): void {
		const core = this.ensureRuntimeDataCore();
		core.bootstrap(this.app.vault.getMarkdownFiles(), this.collectVaultFolderPaths());
	}

	private collectVaultFolderPaths(): readonly string[] {
		const result: string[] = [];
		const visit = (folder: TFolder): void => {
			for (const child of folder.children) {
				if (!(child instanceof TFolder)) continue;
				result.push(child.path);
				visit(child);
			}
		};
		visit(this.app.vault.getRoot());
		return result;
	}

	private beginRuntimeDataRender(file: TFile) {
		// Production Plugin instances always own an App. A few focused owner-state
		// unit tests intentionally construct the prototype without running Plugin
		// lifecycle; preserve those scheduler-only tests without weakening real
		// production transactions.
		if (this.app === undefined) return null;
		const runtimeRender = beginRevisionTrackedRuntimeRender(this.ensureRuntimeDataCore());
		runtimeRender.trackRequiredDependency(dependencyKey.settings());
		runtimeRender.runtime.file(file).metadata();
		return runtimeRender;
	}

	getSettingsDataSource(): VaultSettingsDataSource {
		return this.ensureRuntimeDataCore().settingsData;
	}

	private ensureRuntimeDataCore(): ReactiveDataCore<RuntimeDataOwner> {
		if (this.runtimeDataCore) return this.runtimeDataCore;

		const invalidation = new InvalidationEngine<RuntimeDataOwner>((owner) => {
			this.invalidateRuntimeDataOwner(owner);
		});
		const core = new ReactiveDataCore<RuntimeDataOwner>(this.app, invalidation);
		this.runtimeDataInvalidation = invalidation;
		this.runtimeDataCore = core;
		const policy: TimeDependencyPolicy = core.time;
		this.runtimeTimeScheduler = new ActiveTimeScheduler({
			nextBoundary(nowMs) {
				return nextActiveTimeBoundary(policy, invalidation.index, nowMs);
			},
			advance(nowMs) {
				core.advanceTime(nowMs);
			},
		});
		return core;
	}

	private commitRuntimeDependencies(owner: RuntimeDataOwner, dependencies: Iterable<DependencyKey>): void {
		this.runtimeDataInvalidation?.commitDependencies(owner, dependencies);
		this.runtimeTimeScheduler?.rearm();
	}

	private removeRuntimeDataOwner(owner: RuntimeDataOwner): void {
		this.runtimeDataInvalidation?.remove(owner);
		this.runtimeTimeScheduler?.rearm();
	}

	private invalidateRuntimeDataOwner(owner: RuntimeDataOwner): void {
		if (this.unloaded) return;
		if (owner instanceof MarkdownView) {
			const controller = this.markdownControllers?.get(owner);
			controller?.cancelPending();
			controller?.invalidate();
			if (owner.file) this.queueMarkdownView(owner, owner.file);
			return;
		}

		const controller = this.canvasControllers?.get(owner);
		controller?.cancelPending();
		controller?.invalidate();
		for (const state of this.canvasOwners.values()) {
			if (state.nodes.has(owner)) state.scheduler.markDirty(owner);
		}
	}


	private sweepMarkdownOwners() {
		const liveViews = new Set<MarkdownView>();
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (leaf.view instanceof MarkdownView) liveViews.add(leaf.view);
		});

		for (const [view, request] of Array.from(this.pendingMarkdownRequests.entries())) {
			if (liveViews.has(view)) continue;
			window.clearTimeout(request.timer);
			this.pendingMarkdownRequests.delete(view);
		}

		if (!this.markdownControllers) return;
		for (const owner of Array.from(this.markdownControllers.owners())) {
			if (liveViews.has(owner)) continue;
			this.releaseAllRetainedOwnerSurfaces(owner);
			this.removeRuntimeDataOwner(owner);
			this.markdownControllers.delete(owner);
		}
	}

	private getMarkdownMode(view: MarkdownView): MarkdownMode {
		const state = view.getState();
		if (state.mode === "source") return state.source ? "source" : "livepreview";
		return "preview";
	}

	private findMatchedConfig(file: TFile): ViewConfig | null {
		if (!this.settings.enabled) return null;
		const cache = this.app.metadataCache.getFileCache(file);
		for (const viewConfig of this.settings.views) {
			if (checkRules(this.app, viewConfig.rules, file, cache?.frontmatter)) {
				return viewConfig;
			}
		}
		return null;
	}

	private computeStateKey(file: TFile, mode: MarkdownMode, matchedConfig: ViewConfig | null): string {
		const configId = matchedConfig?.id ?? "none";
		return `${file.path}::${configId}::${mode}::${this.settingsVersion}`;
	}

	private currentMarkdownStateKey(view: MarkdownView, file: TFile): string | null {
		if (view.file !== file) return null;
		const matchedConfig = this.findMatchedConfig(file);
		const mode = this.getMarkdownMode(view);
		return this.computeStateKey(file, mode, matchedConfig);
	}

	private buildMarkdownRenderInput(view: MarkdownView, file: TFile): MarkdownRenderInput | null {
		if (view.file !== file) return null;
		const matchedConfig = this.findMatchedConfig(file);
		const mode = this.getMarkdownMode(view);
		const stateKey = this.computeStateKey(file, mode, matchedConfig);
		const sourceContent = this.getViewSourceContent(view, file);
		return {
			view,
			file,
			matchedConfig,
			mode,
			stateKey,
			requestKey: this.computeMarkdownRequestKey(view, stateKey, mode, sourceContent),
			sourceContent,
		};
	}

	private shouldRenderCustomView(input: MarkdownRenderInput): boolean {
		if (!this.settings.enabled || !input.matchedConfig) return false;
		if (input.mode === "source") return false;
		return input.mode === "preview" || this.settings.workInLivePreview;
	}

	private appliedDomIsValid(input: MarkdownRenderInput): boolean {
		const customEl = input.view.contentEl.querySelector(`.${CUSTOM_VIEW_CLASS}`);
		return this.shouldRenderCustomView(input) ? !!customEl : !customEl;
	}

	private shouldRetrySelfStaleMarkdownRender(
		view: MarkdownView,
		file: TFile,
		requestKey: string,
		resultGeneration: number,
		currentGeneration: number,
	): boolean {
		// A stale result can be expected when an async freshness fence observes
		// Obsidian state moving while this generation prepares. Retry only when
		// that generation is still authoritative; a newer generation must win.
		if (
			resultGeneration !== currentGeneration ||
			this.unloaded ||
			view.file !== file ||
			this.currentMarkdownRequestKey(view, file) !== requestKey
		) {
			return false;
		}

		const retryStates = this.markdownSelfStaleRetries ??= new WeakMap<MarkdownView, MarkdownSelfStaleRetryState>();
		const previous = retryStates.get(view);
		const retries = previous?.requestKey === requestKey ? previous.retries : 0;
		if (retries >= MAX_MARKDOWN_SELF_STALE_RETRIES) {
			// Bound retries so a permanently invalid owner cannot spin forever.
			retryStates.delete(view);
			return false;
		}

		retryStates.set(view, {
			requestKey,
			retries: retries + 1,
		});
		return true;
	}

	private async renderMarkdownView(
		view: MarkdownView,
		file: TFile,
		forceSemanticRefresh: boolean = true,
	): Promise<void> {
		const input = this.buildMarkdownRenderInput(view, file);
		if (!input || !this.markdownControllers) return;

		const controller = this.markdownControllers.getOrCreate(view);
		const appliedKey = view.contentEl.getAttribute("data-cv-state");
		if (
			forceSemanticRefresh ||
			appliedKey !== input.stateKey ||
			!this.appliedDomIsValid(input)
		) {
			controller.invalidate();
		}

		try {
			const requestKey = input.requestKey ?? input.stateKey;
			const result = await controller.render(input, requestKey);
			if (result.status === "stale") {
				if (
					this.shouldRetrySelfStaleMarkdownRender(
						view,
						file,
						requestKey,
						result.generation,
						controller.currentGeneration,
					)
				) {
					// Rebuild the input instead of replaying a potentially stale source snapshot.
					this.queueMarkdownView(view, file);
				}
			} else {
				this.markdownSelfStaleRetries?.delete(view);
			}
		} catch (error) {
			this.markdownSelfStaleRetries?.delete(view);
			// Same-file refresh failures keep the prior committed custom surface.
			// Initial/navigation failures have already fallen back to native Markdown.
			if (this.containerIsRenderedForFile(view.contentEl, file)) {
				view.contentEl.querySelector<HTMLElement>(`.${CUSTOM_VIEW_CLASS}`)?.removeClass(PENDING_VIEW_CLASS);
			} else if (view.file === file) {
				view.contentEl.removeClass(HIDE_MARKDOWN_CLASS);
			}
			console.error(`[Custom Views] Failed to render ${file.path}:`, error);
		}
	}

	private async prepareMarkdownRender(
		owner: MarkdownView,
		input: MarkdownRenderInput,
		context: RenderPreparationContext,
	): Promise<RenderTransaction> {
		if (owner !== input.view) {
			throw new Error("Markdown render owner/input mismatch");
		}

		const { view, file, matchedConfig, mode, stateKey, requestKey, sourceContent } = input;
		const ownerRequestKey = requestKey ?? this.computeMarkdownRequestKey(view, stateKey, mode, sourceContent);
		const container = view.contentEl;
		const shouldRender = this.shouldRenderCustomView(input);
		const runtimeRender = this.beginRuntimeDataRender(file);

		if (!shouldRender || !matchedConfig) {
			const readSet = runtimeRender?.freezeReadSet();
			return {
				isValid: () =>
					this.currentMarkdownRequestKey(view, file) === ownerRequestKey &&
					!context.signal.aborted &&
					(readSet === undefined ||
						(runtimeRender !== null && readSet.isCurrent() && runtimeRender.isSynchronouslyCurrent())),
				commit: () => {
					this.restoreEditableView(view);
					this.restoreDefaultView(view);
					this.setAppliedState(container, file, stateKey);
					if (readSet) this.commitRuntimeDependencies(view, readSet.dependencies());
				},
			};
		}

		const canUseEditableMode =
			this.settings.editableContent &&
			this.settings.workInLivePreview &&
			mode === "livepreview" &&
			templateHasEditableContent(matchedConfig.template);

		let cmView: EditorView | null = null;
		let editorEl: HTMLElement | null = null;
		if (canUseEditableMode) {
			cmView = getCM6EditorView(view);
			editorEl = container.querySelector<HTMLElement>(".markdown-source-view");
			if (!cmView || !editorEl) {
				console.warn("[Custom Views] Could not access live editor; falling back to read-only overlay.");
				cmView = null;
				editorEl = null;
			}
		}

		const editableMode = !!cmView && !!editorEl;
		const scopeId = this.getOrCreateScopeId(container);

		const structuralCandidate = compileRetainedSimpleStructuralTemplate(matchedConfig, editableMode);
		const structuralIr = structuralCandidate &&
			!(mode === "livepreview" && structuralCandidate.dependencyHints.usesSelfContent)
			? structuralCandidate
			: null;
		if (structuralIr) {
			let structuralBodyContent = "";
			if (structuralIr.dependencyHints.usesSelfContent) {
				const cache = this.app.metadataCache.getFileCache(file);
				if (sourceContent !== undefined) {
					runtimeRender?.trackRequiredDependency(dependencyKey.file(file.path, "content"));
					structuralBodyContent = stripFrontmatter(cache, sourceContent);
				} else if (runtimeRender) {
					structuralBodyContent = await runtimeRender.runtime.file(file).body();
				} else {
					structuralBodyContent = stripFrontmatter(cache, await this.app.vault.cachedRead(file));
				}
			}

			const surfacePreparation = this.prepareRetainedStructuralOwnerSurface(view, container);
			const surface = surfacePreparation.surface;
			let surfaceAuthorityCommitted = false;
			context.scope.registerDisposer(() => {
				if (!surfaceAuthorityCommitted) surfacePreparation.dispose();
			});
			const prepared = await surface.renderer.prepare({
				ir: structuralIr,
				app: this.app,
				expressionContext: {
					app: this.app,
					file,
					frontmatter: this.app.metadataCache.getFileCache(file)?.frontmatter,
					bodyContent: structuralBodyContent,
					variables: {},
				},
				sourcePath: file.path,
				revisionKey: `${ownerRequestKey}::${context.generation}`,
			});

			const readSet = runtimeRender?.freezeReadSet();
			if (runtimeRender) await runtimeRender.settleSynchronousValidation();
			const ownerIsCurrent = () =>
				this.currentMarkdownRequestKey(view, file) === ownerRequestKey &&
				!context.signal.aborted &&
				surfacePreparation.isCurrent() &&
				(readSet === undefined ||
					(runtimeRender !== null && readSet.isCurrent() && runtimeRender.isSynchronouslyCurrent()));

			if (prepared.status === "failed") {
				surfacePreparation.dispose();
				throw prepared.error instanceof Error ? prepared.error : new Error(String(prepared.error));
			}
			if (prepared.status === "fallback") {
				surfacePreparation.dispose();
			} else {
				const commitOwnerSurface = () => {
					this.restoreEditableView(view);
					const previous = container.querySelector<HTMLElement>(`.${CUSTOM_VIEW_CLASS}`);
					if (previous && previous !== surface.root) previous.remove();
					this.restoreDisplayOptions(container);
					container.removeClass(EDITABLE_MODE_CLASS);
					container.setAttribute("data-cv-id", scopeId);
					if (surface.root.parentElement !== container) container.appendChild(surface.root);
					container.addClass(HIDE_MARKDOWN_CLASS);
					this.applyViewDisplayOptions(container, matchedConfig);
					this.setAppliedState(container, file, stateKey);
				};

				if (prepared.status !== "prepared") {
					if (prepared.status === "unchanged") {
						return {
							isValid: ownerIsCurrent,
							commit: () => {
								if (!surfacePreparation.commit(this.app, file.path)) {
									throw new Error("Retained structural Markdown owner surface authority changed before adoption");
								}
								surfaceAuthorityCommitted = true;
								commitOwnerSurface();
								if (readSet) this.commitRuntimeDependencies(view, readSet.dependencies());
								this.releaseRetainedOwnerSurface(view);
							},
							dispose: () => surfacePreparation.dispose(),
						};
					}
					surfacePreparation.dispose();
					return { isValid: () => false, commit: () => undefined };
				}

				let committed = false;
				return {
					isValid: () => ownerIsCurrent() && prepared.isCurrent(),
					commit: () => {
						const result = prepared.commit(ownerIsCurrent);
						if (result.status !== "committed") {
							throw new Error(`Retained structural Markdown owner commit returned ${result.status}`);
						}
						if (!surfacePreparation.commit(this.app, file.path)) {
							surfacePreparation.dispose();
							throw new Error("Retained structural Markdown owner surface authority changed before adoption");
						}
						surfaceAuthorityCommitted = true;
						commitOwnerSurface();
						if (readSet) this.commitRuntimeDependencies(view, readSet.dependencies());
						this.releaseRetainedOwnerSurface(view);
						committed = true;
					},
					dispose: () => {
						if (!committed) {
							prepared.dispose();
							surfacePreparation.dispose();
						}
					},
				};
			}
		}

		const retainedIr = compileRetainedStaticTemplate(matchedConfig, editableMode);
		if (retainedIr) {
			const surfacePreparation = this.prepareRetainedOwnerSurface(view, container);
			const surface = surfacePreparation.surface;
			let surfaceAuthorityCommitted = false;
			context.scope.registerDisposer(() => {
				if (!surfaceAuthorityCommitted) surfacePreparation.dispose();
			});
			const prepared = await surface.renderer.prepare({
				ir: retainedIr,
				app: this.app,
				expressionContext: {
					app: this.app,
					file,
					frontmatter: this.app.metadataCache.getFileCache(file)?.frontmatter,
					bodyContent: "",
					variables: {},
				},
				sourcePath: file.path,
				revisionKey: `${ownerRequestKey}::${context.generation}`,
			});

			const readSet = runtimeRender?.freezeReadSet();
			if (runtimeRender) await runtimeRender.settleSynchronousValidation();
			const ownerIsCurrent = () =>
				this.currentMarkdownRequestKey(view, file) === ownerRequestKey &&
				!context.signal.aborted &&
				surfacePreparation.isCurrent() &&
				(readSet === undefined ||
					(runtimeRender !== null && readSet.isCurrent() && runtimeRender.isSynchronouslyCurrent()));

			if (prepared.status === "failed") {
				surfacePreparation.dispose();
				throw prepared.error instanceof Error ? prepared.error : new Error(String(prepared.error));
			}
			if (prepared.status === "fallback") {
				surfacePreparation.dispose();
				throw new Error(`Static retained eligibility unexpectedly fell back: ${prepared.code}`);
			}
			const commitOwnerSurface = () => {
				this.restoreEditableView(view);
				const previous = container.querySelector<HTMLElement>(`.${CUSTOM_VIEW_CLASS}`);
				if (previous && previous !== surface.root) previous.remove();
				this.restoreDisplayOptions(container);
				container.removeClass(EDITABLE_MODE_CLASS);
				container.setAttribute("data-cv-id", scopeId);
				if (surface.root.parentElement !== container) container.appendChild(surface.root);
				container.addClass(HIDE_MARKDOWN_CLASS);
				this.applyViewDisplayOptions(container, matchedConfig);
				this.setAppliedState(container, file, stateKey);
			};

			if (prepared.status !== "prepared") {
				if (prepared.status === "unchanged") {
					return {
						isValid: ownerIsCurrent,
						commit: () => {
							if (!surfacePreparation.commit()) {
								throw new Error("Retained Markdown owner surface authority changed before adoption");
							}
							surfaceAuthorityCommitted = true;
							commitOwnerSurface();
							if (readSet) this.commitRuntimeDependencies(view, readSet.dependencies());
							this.releaseRetainedStructuralOwnerSurface(view);
						},
						dispose: () => surfacePreparation.dispose(),
					};
				}
				surfacePreparation.dispose();
				return { isValid: () => false, commit: () => undefined };
			}

			let committed = false;
			return {
				isValid: () => ownerIsCurrent() && prepared.isCurrent(),
				commit: () => {
					const result = prepared.commit(ownerIsCurrent);
					if (result.status !== "committed") {
						throw new Error(`Retained Markdown owner commit returned ${result.status}`);
					}
					if (!surfacePreparation.commit()) {
						surfacePreparation.dispose();
						throw new Error("Retained Markdown owner surface authority changed before adoption");
					}
					surfaceAuthorityCommitted = true;
					commitOwnerSurface();
					if (readSet) this.commitRuntimeDependencies(view, readSet.dependencies());
					this.releaseRetainedStructuralOwnerSurface(view);
					committed = true;
				},
				dispose: () => {
					if (!committed) {
						prepared.dispose();
						surfacePreparation.dispose();
					}
				},
			};
		}
		const staging = container.ownerDocument.win.createDiv() as ScopedOverlayElement;
		staging.addClass(CUSTOM_VIEW_CLASS);

		this.registerOverlayLinkHandlers(
			staging,
			file.path,
			context.scope,
			editableMode ? ".markdown-source-view" : undefined,
		);

		await renderTemplate(
			this.app,
			matchedConfig.template,
			file,
			staging,
			context.scope,
			editableMode,
			matchedConfig,
			scopeId,
			this.settings.allowJavaScript,
			sourceContent,
			this.basesProvider,
			runtimeRender?.runtime,
		);

		const readSet = runtimeRender?.freezeReadSet();
		if (runtimeRender) await runtimeRender.settleSynchronousValidation();

		// renderTemplate's CSS scoper currently stores its MutationObserver on the
		// rendered container. Bind that observer to this generation's RenderScope so
		// stale/replaced/unloaded Markdown generations cannot retain detached DOM.
		context.scope.registerDisposer(() => {
			staging.__cvScopeObserver?.disconnect();
			staging.__cvScopeObserver = null;
		});

		return {
			isValid: () =>
				this.currentMarkdownRequestKey(view, file) === ownerRequestKey &&
				!context.signal.aborted &&
				(readSet === undefined ||
					(runtimeRender !== null && readSet.isCurrent() && runtimeRender.isSynchronouslyCurrent())),
			commit: () => {
				this.releaseAllRetainedOwnerSurfaces(view);
				this.restoreEditableView(view);
				container.querySelector(`.${CUSTOM_VIEW_CLASS}`)?.remove();
				this.restoreDisplayOptions(container);
				container.removeClass(EDITABLE_MODE_CLASS);
				container.setAttribute("data-cv-id", scopeId);
				container.appendChild(staging);

				if (editableMode && cmView && editorEl) {
					const placeholder = staging.querySelector<HTMLElement>(`[${EDITABLE_PLACEHOLDER_ATTR}]`);
					if (!placeholder) {
						container.addClass(HIDE_MARKDOWN_CLASS);
					} else {
						const originalParent = editorEl.parentElement;
						if (!originalParent) {
							container.addClass(HIDE_MARKDOWN_CLASS);
						} else {
							const originalNextSibling = editorEl.nextSibling;
							const compartment = this.getOrCreateCompartment(cmView);
							cmView.dispatch({
								effects: compartment.reconfigure(createEditableContentExtensions()),
							});
							placeholder.appendChild(editorEl);
							cmView.requestMeasure();
							container.removeClass(HIDE_MARKDOWN_CLASS);
							container.addClass(EDITABLE_MODE_CLASS);
							this.editableStates.set(container, {
								originalParent,
								originalNextSibling,
								editorEl,
								cmView,
							});
						}
					}
				} else {
					container.addClass(HIDE_MARKDOWN_CLASS);
				}

				this.applyViewDisplayOptions(container, matchedConfig);
				this.setAppliedState(container, file, stateKey);
				if (readSet) this.commitRuntimeDependencies(view, readSet.dependencies());
			},
			dispose: () => {
				staging.remove();
			},
		};
	}


	private prepareRetainedOwnerSurface(
		owner: RuntimeDataOwner,
		container: HTMLElement,
	) {
		const registry = this.retainedOwnerSurfaces ??=
			new RetainedStaticOwnerSurfaceRegistry<RuntimeDataOwner>(CUSTOM_VIEW_CLASS);
		return registry.prepare(owner, container);
	}

	private releaseRetainedOwnerSurface(owner: RuntimeDataOwner): void {
		this.retainedOwnerSurfaces?.release(owner);
	}

	private prepareRetainedStructuralOwnerSurface(
		owner: RuntimeDataOwner,
		container: HTMLElement,
	) {
		const registry = this.retainedStructuralOwnerSurfaces ??=
			new RetainedSimpleStructuralOwnerSurfaceRegistry<RuntimeDataOwner>(CUSTOM_VIEW_CLASS);
		return registry.prepare(owner, container);
	}

	private releaseRetainedStructuralOwnerSurface(owner: RuntimeDataOwner): void {
		this.retainedStructuralOwnerSurfaces?.release(owner);
	}

	private releaseAllRetainedOwnerSurfaces(owner: RuntimeDataOwner): void {
		this.releaseRetainedOwnerSurface(owner);
		this.releaseRetainedStructuralOwnerSurface(owner);
	}

	private getOrCreateScopeId(container: HTMLElement): string {
		const applied = container.getAttribute("data-cv-id");
		if (applied) {
			this.scopeIds.set(container, applied);
			return applied;
		}
		let scopeId = this.scopeIds.get(container);
		if (!scopeId) {
			scopeId = `cv-${this.nextScopeId++}`;
			this.scopeIds.set(container, scopeId);
		}
		return scopeId;
	}

	// ─── Legacy overlay entry point (Canvas uses this until Bot 4 integration) ──

	async injectCustomView(
		container: HTMLElement,
		file: TFile,
		template: string,
		viewConfig?: ViewConfig,
		sourceContent?: string,
	) {
		container.addClass(HIDE_MARKDOWN_CLASS);

		let customEl = container.querySelector(`.${CUSTOM_VIEW_CLASS}`) as HTMLElement;
		if (!customEl) {
			customEl = container.ownerDocument.win.createDiv();
			customEl.addClass(CUSTOM_VIEW_CLASS);
			container.appendChild(customEl);
			this.registerOverlayLinkHandlers(customEl, file.path, this);
		}

		const scopeId = this.getOrCreateScopeId(container);
		container.setAttribute("data-cv-id", scopeId);

		customEl.addClass(PENDING_VIEW_CLASS);
		try {
			await renderTemplate(
				this.app,
				template,
				file,
				customEl,
				this,
				false,
				viewConfig,
				scopeId,
				this.settings.allowJavaScript,
				sourceContent,
				this.basesProvider,
			);
		} finally {
			customEl.removeClass(PENDING_VIEW_CLASS);
		}

		this.applyViewDisplayOptions(container, viewConfig);
		container.addClass(HIDE_MARKDOWN_CLASS);
	}

	restoreDefaultView(view: MarkdownView) {
		const container = view.contentEl;
		this.releaseAllRetainedOwnerSurfaces(view);
		this.restoreDisplayOptions(container);
		container.removeClass(HIDE_MARKDOWN_CLASS);
		container.removeClass(EDITABLE_MODE_CLASS);
		container.removeAttribute("data-cv-id");
		this.clearAppliedState(container);
		container.querySelector(`.${CUSTOM_VIEW_CLASS}`)?.remove();
	}

	private registerOverlayLinkHandlers(
		customEl: HTMLElement,
		sourcePath: string,
		component: Component,
		skipSelector?: string,
	) {
		component.registerDomEvent(customEl, "click", (evt: MouseEvent) => {
			const target = evt.target as HTMLElement;
			if (skipSelector && target.closest(skipSelector)) return;

			const link = target.closest(".internal-link");
			if (isAnchorElement(link)) {
				evt.preventDefault();
				const href = link.getAttribute("data-href") || link.getAttribute("href");
				if (href) {
					const newLeaf = Keymap.isModEvent(evt);
					void this.app.workspace.openLinkText(href, sourcePath, newLeaf);
				}
			}
		});

		component.registerDomEvent(customEl, "contextmenu", (evt: MouseEvent) => {
			const target = evt.target as HTMLElement;
			if (skipSelector && target.closest(skipSelector)) return;

			const internalLink = target.closest(".internal-link");
			const externalLink = internalLink ? null : target.closest(".external-link");
			const linkEl = internalLink ?? externalLink;
			if (!isAnchorElement(linkEl)) return;

			const href = linkEl.getAttribute("data-href") || linkEl.getAttribute("href");
			if (!href) return;

			const workspace = this.app.workspace as unknown as {
				handleLinkContextMenu?(menu: Menu, linktext: string, sourcePath: string): boolean;
				handleExternalLinkContextMenu?(menu: Menu, url: string): boolean;
			};

			if (internalLink) {
				if (typeof workspace.handleLinkContextMenu !== "function") return;
				const menu = Menu.forEvent(evt);
				workspace.handleLinkContextMenu(menu, href, sourcePath);
			} else {
				if (typeof workspace.handleExternalLinkContextMenu !== "function") return;
				const menu = Menu.forEvent(evt);
				workspace.handleExternalLinkContextMenu(menu, href);
			}
		});
	}

	private getOrCreateCompartment(cmView: EditorView): Compartment {
		let entry = this.compartments.get(cmView);
		if (!entry) {
			entry = { compartment: new Compartment(), appended: false };
			this.compartments.set(cmView, entry);
		}
		if (!entry.appended) {
			cmView.dispatch({
				effects: StateEffect.appendConfig.of(entry.compartment.of([])),
			});
			entry.appended = true;
		}
		return entry.compartment;
	}

	private restoreEditableView(view: MarkdownView) {
		const container = view.contentEl;
		const state = this.editableStates.get(container);
		if (!state) return;

		try {
			const entry = this.compartments.get(state.cmView);
			if (entry) {
				state.cmView.dispatch({
					effects: entry.compartment.reconfigure([]),
				});
			}
		} catch {
			// Editor may already be destroyed.
		}

		if (state.originalNextSibling && state.originalParent.contains(state.originalNextSibling)) {
			state.originalParent.insertBefore(state.editorEl, state.originalNextSibling);
		} else {
			state.originalParent.appendChild(state.editorEl);
		}

		try {
			state.cmView.requestMeasure();
		} catch {
			// Editor may already be destroyed.
		}

		this.restoreDisplayOptions(container);
		container.removeClass(EDITABLE_MODE_CLASS);
		container.querySelector(`.${CUSTOM_VIEW_CLASS}`)?.remove();
		this.editableStates.delete(container);
	}
	private applyViewDisplayOptions(container: HTMLElement, viewConfig?: ViewConfig) {
		if (!viewConfig) return;
		container.toggleClass("cv-hide-properties", viewConfig.showProperties === false);
		container.toggleClass("cv-hide-inline-title", viewConfig.showInlineTitle === false);
	}

	private restoreDisplayOptions(container: HTMLElement) {
		container.removeClass("cv-hide-properties");
		container.removeClass("cv-hide-inline-title");
	}

	async loadSettings() {
		const loadedData = await this.loadData() as Partial<CustomViewsSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, loadedData);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	refreshAllViews() {
		this.settingsVersion++;
		this.runtimeDataCore?.settingsChanged();
		this.basesProvider?.invalidateAll();
		this.prepareScriptEngine();

		this.app.workspace.iterateAllLeaves((leaf) => {
			if (leaf.view instanceof MarkdownView && leaf.view.file) {
				this.markdownControllers?.invalidate(leaf.view);
				this.queueMarkdownView(leaf.view, leaf.view.file);
			}
		});

		this.syncCanvasOwners();
		if (this.settings.enabled && this.settings.workInCanvas) {
			this.markAllCanvasNodesDirty();
		} else {
			this.restoreAllCanvasNodes();
		}
	}

	// ─── Canvas Support (Core V2 per-owner lifecycle) ─────────────────────────

	private getCanvasNodeFile(node: CanvasNode): TFile | null {
		const file = node.file;
		return file instanceof TFile && file.extension === "md" ? file : null;
	}

	private getCanvasPreviewContainer(node: CanvasNode): HTMLElement | null {
		const nodeEl = node.nodeEl;
		if (!nodeEl) return null;
		return nodeEl.querySelector<HTMLElement>(".markdown-preview-view");
	}

	private getCanvasRoot(view: CanvasView): HTMLElement | null {
		return view.containerEl ?? null;
	}

	private computeCanvasStateKey(
		file: TFile,
		matchedConfig: ViewConfig | null,
		container: HTMLElement,
	): string {
		const configId = matchedConfig?.id ?? "none";
		const enabled = this.settings.enabled && this.settings.workInCanvas ? "on" : "off";
		const ownerId = this.getOrCreateScopeId(container);
		return `${file.path}::${configId}::canvas-${enabled}::${this.settingsVersion}::${ownerId}`;
	}

	private buildCanvasRenderInput(
		node: CanvasNode,
		isSchedulerCurrent: () => boolean = () => true,
	): CanvasRenderInput | null {
		const file = this.getCanvasNodeFile(node);
		const container = this.getCanvasPreviewContainer(node);
		if (!file || !container) return null;
		const matchedConfig = this.findMatchedConfig(file);
		return {
			node,
			file,
			container,
			matchedConfig,
			isSchedulerCurrent,
			stateKey: this.computeCanvasStateKey(file, matchedConfig, container),
		};
	}

	private currentCanvasStateKey(
		node: CanvasNode,
		file: TFile,
		container: HTMLElement,
	): string | null {
		if (this.getCanvasNodeFile(node) !== file) return null;
		if (this.getCanvasPreviewContainer(node) !== container) return null;
		const matchedConfig = this.findMatchedConfig(file);
		return this.computeCanvasStateKey(file, matchedConfig, container);
	}

	private shouldRenderCanvas(input: CanvasRenderInput): boolean {
		return this.settings.enabled && this.settings.workInCanvas && !!input.matchedConfig;
	}

	private canvasDomIsValid(input: CanvasRenderInput): boolean {
		if (input.container.getAttribute("data-cv-state") !== input.stateKey) return false;
		const customEl = input.container.querySelector(`.${CUSTOM_VIEW_CLASS}`);
		return this.shouldRenderCanvas(input) ? !!customEl : !customEl;
	}

	private async prepareCanvasRender(
		owner: CanvasNode,
		input: CanvasRenderInput,
		context: RenderPreparationContext,
	): Promise<RenderTransaction> {
		if (owner !== input.node) throw new Error("Canvas render owner/input mismatch");

		const { node, file, container, matchedConfig, isSchedulerCurrent, stateKey } = input;
		const ownerIsValid = () =>
			isSchedulerCurrent() &&
			this.currentCanvasStateKey(node, file, container) === stateKey &&
			!context.signal.aborted;
		const runtimeRender = this.beginRuntimeDataRender(file);

		if (!this.shouldRenderCanvas(input) || !matchedConfig) {
			const readSet = runtimeRender?.freezeReadSet();
			return {
				isValid: () => ownerIsValid() && (readSet === undefined || (runtimeRender !== null && readSet.isCurrent() && runtimeRender.isSynchronouslyCurrent())),
				commit: () => {
					this.releaseAllRetainedOwnerSurfaces(node);
					this.restoreCanvasContainer(container);
					this.setAppliedState(container, file, stateKey);
					if (readSet) this.commitRuntimeDependencies(node, readSet.dependencies());
				},
			};
		}

		const scopeId = this.getOrCreateScopeId(container);

		const structuralIr = compileRetainedSimpleStructuralTemplate(matchedConfig, false);
		if (structuralIr) {
			let structuralBodyContent = "";
			if (structuralIr.dependencyHints.usesSelfContent) {
				const cache = this.app.metadataCache.getFileCache(file);
				structuralBodyContent = runtimeRender
					? await runtimeRender.runtime.file(file).body()
					: stripFrontmatter(cache, await this.app.vault.cachedRead(file));
			}

			const surfacePreparation = this.prepareRetainedStructuralOwnerSurface(node, container);
			const surface = surfacePreparation.surface;
			let surfaceAuthorityCommitted = false;
			context.scope.registerDisposer(() => {
				if (!surfaceAuthorityCommitted) surfacePreparation.dispose();
			});
			const prepared = await surface.renderer.prepare({
				ir: structuralIr,
				app: this.app,
				expressionContext: {
					app: this.app,
					file,
					frontmatter: this.app.metadataCache.getFileCache(file)?.frontmatter,
					bodyContent: structuralBodyContent,
					variables: {},
				},
				sourcePath: file.path,
				revisionKey: `${stateKey}::${context.generation}`,
			});

			const readSet = runtimeRender?.freezeReadSet();
			if (runtimeRender) await runtimeRender.settleSynchronousValidation();
			const retainedOwnerIsCurrent = () =>
				ownerIsValid() &&
				surfacePreparation.isCurrent() &&
				(readSet === undefined ||
					(runtimeRender !== null && readSet.isCurrent() && runtimeRender.isSynchronouslyCurrent()));

			if (prepared.status === "failed") {
				surfacePreparation.dispose();
				throw prepared.error instanceof Error ? prepared.error : new Error(String(prepared.error));
			}
			if (prepared.status === "fallback") {
				surfacePreparation.dispose();
			} else {
				const commitOwnerSurface = () => {
					const previous = container.querySelector<HTMLElement>(`.${CUSTOM_VIEW_CLASS}`);
					if (previous && previous !== surface.root) previous.remove();
					this.restoreDisplayOptions(container);
					container.setAttribute("data-cv-id", scopeId);
					if (surface.root.parentElement !== container) container.appendChild(surface.root);
					this.applyViewDisplayOptions(container, matchedConfig);
					container.addClass(HIDE_MARKDOWN_CLASS);
					this.setAppliedState(container, file, stateKey);
				};

				if (prepared.status !== "prepared") {
					if (prepared.status === "unchanged") {
						return {
							isValid: retainedOwnerIsCurrent,
							commit: () => {
								if (!surfacePreparation.commit(this.app, file.path)) {
									throw new Error("Retained structural Canvas owner surface authority changed before adoption");
								}
								surfaceAuthorityCommitted = true;
								commitOwnerSurface();
								if (readSet) this.commitRuntimeDependencies(node, readSet.dependencies());
								this.releaseRetainedOwnerSurface(node);
							},
							dispose: () => surfacePreparation.dispose(),
						};
					}
					surfacePreparation.dispose();
					return { isValid: () => false, commit: () => undefined };
				}

				let committed = false;
				return {
					isValid: () => retainedOwnerIsCurrent() && prepared.isCurrent(),
					commit: () => {
						const result = prepared.commit(retainedOwnerIsCurrent);
						if (result.status !== "committed") {
							throw new Error(`Retained structural Canvas owner commit returned ${result.status}`);
						}
						if (!surfacePreparation.commit(this.app, file.path)) {
							surfacePreparation.dispose();
							throw new Error("Retained structural Canvas owner surface authority changed before adoption");
						}
						surfaceAuthorityCommitted = true;
						commitOwnerSurface();
						if (readSet) this.commitRuntimeDependencies(node, readSet.dependencies());
						this.releaseRetainedOwnerSurface(node);
						committed = true;
					},
					dispose: () => {
						if (!committed) {
							prepared.dispose();
							surfacePreparation.dispose();
						}
					},
				};
			}
		}

		const retainedIr = compileRetainedStaticTemplate(matchedConfig, false);
		if (retainedIr) {
			const surfacePreparation = this.prepareRetainedOwnerSurface(node, container);
			const surface = surfacePreparation.surface;
			let surfaceAuthorityCommitted = false;
			context.scope.registerDisposer(() => {
				if (!surfaceAuthorityCommitted) surfacePreparation.dispose();
			});
			const prepared = await surface.renderer.prepare({
				ir: retainedIr,
				app: this.app,
				expressionContext: {
					app: this.app,
					file,
					frontmatter: this.app.metadataCache.getFileCache(file)?.frontmatter,
					bodyContent: "",
					variables: {},
				},
				sourcePath: file.path,
				revisionKey: `${stateKey}::${context.generation}`,
			});

			const readSet = runtimeRender?.freezeReadSet();
			if (runtimeRender) await runtimeRender.settleSynchronousValidation();
			const retainedOwnerIsCurrent = () =>
				ownerIsValid() &&
				surfacePreparation.isCurrent() &&
				(readSet === undefined ||
					(runtimeRender !== null && readSet.isCurrent() && runtimeRender.isSynchronouslyCurrent()));

			if (prepared.status === "failed") {
				surfacePreparation.dispose();
				throw prepared.error instanceof Error ? prepared.error : new Error(String(prepared.error));
			}
			if (prepared.status === "fallback") {
				surfacePreparation.dispose();
				throw new Error(`Static retained eligibility unexpectedly fell back: ${prepared.code}`);
			}
			const commitOwnerSurface = () => {
				const previous = container.querySelector<HTMLElement>(`.${CUSTOM_VIEW_CLASS}`);
				if (previous && previous !== surface.root) previous.remove();
				this.restoreDisplayOptions(container);
				container.setAttribute("data-cv-id", scopeId);
				if (surface.root.parentElement !== container) container.appendChild(surface.root);
				this.applyViewDisplayOptions(container, matchedConfig);
				container.addClass(HIDE_MARKDOWN_CLASS);
				this.setAppliedState(container, file, stateKey);
			};

			if (prepared.status !== "prepared") {
				if (prepared.status === "unchanged") {
					return {
						isValid: retainedOwnerIsCurrent,
						commit: () => {
							if (!surfacePreparation.commit()) {
								throw new Error("Retained Canvas owner surface authority changed before adoption");
							}
							surfaceAuthorityCommitted = true;
							commitOwnerSurface();
							if (readSet) this.commitRuntimeDependencies(node, readSet.dependencies());
							this.releaseRetainedStructuralOwnerSurface(node);
						},
						dispose: () => surfacePreparation.dispose(),
					};
				}
				surfacePreparation.dispose();
				return { isValid: () => false, commit: () => undefined };
			}

			let committed = false;
			return {
				isValid: () => retainedOwnerIsCurrent() && prepared.isCurrent(),
				commit: () => {
					const result = prepared.commit(retainedOwnerIsCurrent);
					if (result.status !== "committed") {
						throw new Error(`Retained Canvas owner commit returned ${result.status}`);
					}
					if (!surfacePreparation.commit()) {
						surfacePreparation.dispose();
						throw new Error("Retained Canvas owner surface authority changed before adoption");
					}
					surfaceAuthorityCommitted = true;
					commitOwnerSurface();
					if (readSet) this.commitRuntimeDependencies(node, readSet.dependencies());
					this.releaseRetainedStructuralOwnerSurface(node);
					committed = true;
				},
				dispose: () => {
					if (!committed) {
						prepared.dispose();
						surfacePreparation.dispose();
					}
				},
			};
		}
		const staging = container.ownerDocument.win.createDiv() as ScopedOverlayElement;
		staging.addClass(CUSTOM_VIEW_CLASS);
		this.registerOverlayLinkHandlers(staging, file.path, context.scope);

		await renderTemplate(
			this.app,
			matchedConfig.template,
			file,
			staging,
			context.scope,
			false,
			matchedConfig,
			scopeId,
			this.settings.allowJavaScript,
			undefined,
			this.basesProvider,
			runtimeRender?.runtime,
		);

		const readSet = runtimeRender?.freezeReadSet();
		if (runtimeRender) await runtimeRender.settleSynchronousValidation();

		context.scope.registerDisposer(() => {
			staging.__cvScopeObserver?.disconnect();
			staging.__cvScopeObserver = null;
		});

		return {
			isValid: () => ownerIsValid() && (readSet === undefined || (runtimeRender !== null && readSet.isCurrent() && runtimeRender.isSynchronouslyCurrent())),
			commit: () => {
				this.releaseAllRetainedOwnerSurfaces(node);
				container.querySelector(`.${CUSTOM_VIEW_CLASS}`)?.remove();
				this.restoreDisplayOptions(container);
				container.setAttribute("data-cv-id", scopeId);
				container.appendChild(staging);
				this.applyViewDisplayOptions(container, matchedConfig);
				container.addClass(HIDE_MARKDOWN_CLASS);
				this.setAppliedState(container, file, stateKey);
				if (readSet) this.commitRuntimeDependencies(node, readSet.dependencies());
			},
			dispose: () => staging.remove(),
		};
	}

	private async renderCanvasToken(token: CanvasRenderToken<CanvasNode>): Promise<void> {
		if (!token.isCurrent()) return;
		const input = this.buildCanvasRenderInput(token.node, () => token.isCurrent());
		if (!input || !this.canvasControllers) return;

		const controller = this.canvasControllers.getOrCreate(token.node);
		controller.invalidate();
		await controller.render(input, input.stateKey);
	}

	private createCanvasOwnerState(view: CanvasView): CanvasOwnerState {
		const state: CanvasOwnerState = {
			scheduler: new CanvasDirtyScheduler<CanvasNode>(
				(token) => this.renderCanvasToken(token),
				{
					onError: (error, token) => {
						const file = this.getCanvasNodeFile(token.node);
						console.error(
							`[Custom Views] Canvas scheduler failed${file ? ` for ${file.path}` : ""}:`,
							error,
						);
					},
				},
			),
			observer: null,
			root: null,
			nodes: new Map(),
		};
		this.canvasOwners.set(view, state);
		this.ensureCanvasObserver(view, state);
		return state;
	}

	private ensureCanvasObserver(view: CanvasView, state: CanvasOwnerState): void {
		const root = this.getCanvasRoot(view);
		if (state.root === root) return;

		state.observer?.disconnect();
		state.observer = null;
		state.root = root;
		if (!root) return;

		const Observer = root.ownerDocument.defaultView?.MutationObserver ?? MutationObserver;
		state.observer = new Observer(() => {
			if (this.unloaded || this.canvasOwners.get(view) !== state) return;
			this.syncCanvasOwner(view, state);
		});
		state.observer.observe(root, { childList: true, subtree: true });
	}

	private resetCanvasNodeRender(
		state: CanvasOwnerState,
		node: CanvasNode,
		snapshot: CanvasNodeSnapshot,
		restore: boolean,
	): void {
		state.scheduler.releaseNode(node);
		this.releaseAllRetainedOwnerSurfaces(node);
		this.removeRuntimeDataOwner(node);
		this.canvasControllers?.delete(node);
		if (restore && snapshot.container) this.restoreCanvasContainer(snapshot.container);
	}

	private syncCanvasOwner(view: CanvasView, state: CanvasOwnerState): void {
		this.ensureCanvasObserver(view, state);
		const liveNodes = new Set<CanvasNode>();

		view.canvas?.nodes?.forEach((node) => {
			liveNodes.add(node);
			const next: CanvasNodeSnapshot = {
				file: this.getCanvasNodeFile(node),
				container: this.getCanvasPreviewContainer(node),
			};
			const previous = state.nodes.get(node);

			if (!previous) {
				state.nodes.set(node, next);
			} else if (previous.file !== next.file) {
				this.resetCanvasNodeRender(state, node, previous, true);
				state.nodes.set(node, next);
			} else if (previous.container !== next.container) {
				// Preserve the committed retained surface and dependency edges until the
				// replacement container generation commits. Releasing them here would
				// let PREPARE destroy last-known-good owner state.
				state.scheduler.releaseNode(node);
				this.canvasControllers?.get(node)?.invalidate();
				state.nodes.set(node, next);
			}

			if (!this.settings.enabled || !this.settings.workInCanvas) {
				state.scheduler.releaseNode(node);
				this.releaseAllRetainedOwnerSurfaces(node);
				this.removeRuntimeDataOwner(node);
				this.canvasControllers?.delete(node);
				if (next.container) this.restoreCanvasContainer(next.container);
				return;
			}

			if (!next.file || !next.container) return;
			const input = this.buildCanvasRenderInput(node);
			if (!input) return;
			const pendingSameState =
				this.canvasControllers?.get(node)?.currentPendingKey === input.stateKey;
			if (
				!previous ||
				previous.file !== next.file ||
				previous.container !== next.container ||
				(!this.canvasDomIsValid(input) && !pendingSameState)
			) {
				state.scheduler.markDirty(node);
			}
		});

		for (const [node, snapshot] of Array.from(state.nodes.entries())) {
			if (liveNodes.has(node)) continue;
			this.resetCanvasNodeRender(state, node, snapshot, false);
			state.nodes.delete(node);
		}
	}

	private disposeCanvasOwner(view: CanvasView, state: CanvasOwnerState, restore: boolean): void {
		state.observer?.disconnect();
		state.observer = null;
		state.root = null;
		state.scheduler.dispose();
		for (const [node, snapshot] of state.nodes) {
			this.releaseAllRetainedOwnerSurfaces(node);
			this.removeRuntimeDataOwner(node);
			this.canvasControllers?.delete(node);
			if (restore && snapshot.container) this.restoreCanvasContainer(snapshot.container);
		}
		state.nodes.clear();
		this.canvasOwners.delete(view);
	}

	private disposeCanvasOwners(restore: boolean): void {
		for (const [view, state] of Array.from(this.canvasOwners.entries())) {
			this.disposeCanvasOwner(view, state, restore);
		}
	}

	private syncCanvasOwners(): void {
		const liveViews = new Set<CanvasView>();
		this.app.workspace.iterateAllLeaves((leaf: WorkspaceLeaf) => {
			const view = leaf.view;
			if (!isCanvasView(view)) return;
			liveViews.add(view);
			const state = this.canvasOwners.get(view) ?? this.createCanvasOwnerState(view);
			this.syncCanvasOwner(view, state);
		});

		for (const [view, state] of Array.from(this.canvasOwners.entries())) {
			if (!liveViews.has(view)) this.disposeCanvasOwner(view, state, false);
		}
	}

	private markCanvasFileDirty(file: TFile): void {
		if (this.unloaded) return;
		this.syncCanvasOwners();
		for (const state of this.canvasOwners.values()) {
			for (const [node, snapshot] of state.nodes) {
				if (snapshot.file === file && snapshot.container) state.scheduler.markDirty(node);
			}
		}
	}

	private markAllCanvasNodesDirty(): void {
		for (const state of this.canvasOwners.values()) {
			for (const [node, snapshot] of state.nodes) {
				if (snapshot.file && snapshot.container) state.scheduler.markDirty(node);
			}
		}
	}

	/** Compatibility entry point: explicit refresh of all current Canvas nodes. */
	processAllCanvasNodes(): void {
		this.syncCanvasOwners();
		if (!this.settings.enabled || !this.settings.workInCanvas) {
			this.restoreAllCanvasNodes();
			return;
		}
		this.markAllCanvasNodesDirty();
	}

	/** Compatibility entry point: request one current Canvas node render. */
	async processCanvasNode(node: CanvasNode): Promise<void> {
		this.syncCanvasOwners();
		for (const state of this.canvasOwners.values()) {
			if (!state.nodes.has(node)) continue;
			state.scheduler.markDirty(node);
			return;
		}

		await this.renderCanvasToken({ node, generation: 0, isCurrent: () => true });
	}

	private restoreCanvasContainer(container: HTMLElement): void {
		this.restoreDisplayOptions(container);
		container.removeClass(HIDE_MARKDOWN_CLASS);
		container.removeAttribute("data-cv-id");
		this.clearAppliedState(container);
		container.querySelector(`.${CUSTOM_VIEW_CLASS}`)?.remove();
	}

	restoreCanvasNode(node: CanvasNode): void {
		this.releaseAllRetainedOwnerSurfaces(node);
		for (const state of this.canvasOwners.values()) {
			if (!state.nodes.has(node)) continue;
			state.scheduler.releaseNode(node);
			this.removeRuntimeDataOwner(node);
			this.canvasControllers?.delete(node);
		}
		const container = this.getCanvasPreviewContainer(node);
		if (container) this.restoreCanvasContainer(container);
	}

	restoreAllCanvasNodes(): void {
		for (const state of this.canvasOwners.values()) {
			for (const [node, snapshot] of state.nodes) {
				state.scheduler.releaseNode(node);
				this.releaseAllRetainedOwnerSurfaces(node);
				this.removeRuntimeDataOwner(node);
				this.canvasControllers?.delete(node);
				if (snapshot.container) this.restoreCanvasContainer(snapshot.container);
			}
		}
	}

}