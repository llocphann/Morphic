import { MarkdownView, TFile } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import CustomViewsPlugin from "../main";
import { DEFAULT_SETTINGS } from "../settings";

interface TestPluginInternals {
	settingsVersion: number;
	runtimeDataCore: { settingsChanged(): readonly unknown[] } | null;
	basesProvider: { invalidateAll(): void };
	markdownControllers: { invalidate(owner: MarkdownView): void };
	prepareScriptEngine(): void;
	queueMarkdownView(view: MarkdownView, file: TFile): void;
	syncCanvasOwners(): void;
	markAllCanvasNodesDirty(): void;
	restoreAllCanvasNodes(): void;
}

function makeFile(path: string): TFile {
	const file = new TFile();
	file.path = path;
	file.extension = "md";
	return file;
}

function makeView(file: TFile): MarkdownView {
	const view = Object.create(MarkdownView.prototype) as MarkdownView;
	Object.assign(view, {
		file,
		contentEl: document.createElement("div"),
	});
	return view;
}

describe("production Bases invalidation ownership", () => {
	it("keeps only explicit settings refresh as the global Bases barrier", () => {
		const plugin = Object.create(CustomViewsPlugin.prototype) as CustomViewsPlugin;
		plugin.settings = {
			...DEFAULT_SETTINGS,
			enabled: true,
			workInCanvas: false,
		};
		const firstFile = makeFile("Bases.md");
		const secondFile = makeFile("Plain.md");
		const firstView = makeView(firstFile);
		const secondView = makeView(secondFile);
		const leaves = [{ view: firstView }, { view: secondView }];
		Object.defineProperty(plugin, "app", {
			configurable: true,
			value: {
				workspace: {
					iterateAllLeaves(callback: (leaf: { view: MarkdownView }) => void) {
						for (const leaf of leaves) callback(leaf);
					},
			},
			},
		});

		const settingsChanged = vi.fn(() => [] as readonly unknown[]);
		const invalidateAll = vi.fn();
		const invalidate = vi.fn();
		const queueMarkdownView = vi.fn();
		const prepareScriptEngine = vi.fn();
		const syncCanvasOwners = vi.fn();
		const markAllCanvasNodesDirty = vi.fn();
		const restoreAllCanvasNodes = vi.fn();
		const internals = plugin as unknown as TestPluginInternals;
		internals.settingsVersion = 0;
		internals.runtimeDataCore = { settingsChanged };
		internals.basesProvider = { invalidateAll };
		internals.markdownControllers = { invalidate };
		internals.queueMarkdownView = queueMarkdownView;
		internals.prepareScriptEngine = prepareScriptEngine;
		internals.syncCanvasOwners = syncCanvasOwners;
		internals.markAllCanvasNodesDirty = markAllCanvasNodesDirty;
		internals.restoreAllCanvasNodes = restoreAllCanvasNodes;

		plugin.refreshAllViews();

		expect(internals.settingsVersion).toBe(1);
		expect(settingsChanged).toHaveBeenCalledTimes(1);
		expect(invalidateAll).toHaveBeenCalledTimes(1);
		expect(prepareScriptEngine).toHaveBeenCalledTimes(1);
		expect(invalidate).toHaveBeenCalledTimes(2);
		expect(queueMarkdownView).toHaveBeenCalledTimes(2);
		expect(queueMarkdownView).toHaveBeenCalledWith(firstView, firstFile);
		expect(queueMarkdownView).toHaveBeenCalledWith(secondView, secondFile);
		expect(syncCanvasOwners).toHaveBeenCalledTimes(1);
		expect(markAllCanvasNodesDirty).not.toHaveBeenCalled();
		expect(restoreAllCanvasNodes).toHaveBeenCalledTimes(1);
		expect("invalidateBasesData" in CustomViewsPlugin.prototype).toBe(false);
	});
});
