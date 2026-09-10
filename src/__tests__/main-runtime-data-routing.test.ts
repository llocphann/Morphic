import { MarkdownView, TFile, TFolder, type TAbstractFile } from "obsidian";
import { afterEach, describe, expect, it, vi } from "vitest";
import CustomViewsPlugin from "../main";
import { DEFAULT_SETTINGS } from "../settings";
import { RenderController, type RenderTransaction } from "../core";
import type { ViewConfig } from "../types";

interface TestMarkdownInput {
	view: MarkdownView;
	file: TFile;
	matchedConfig: ViewConfig | null;
	mode: "preview" | "source" | "livepreview";
	stateKey: string;
	sourceContent?: string;
}

interface TestPluginInternals {
	unloaded: boolean;
	settingsVersion: number;
	pendingMarkdownRequests: Map<MarkdownView, { file: TFile; timer: number }>;
	markdownControllers: { getOrCreate(owner: MarkdownView): RenderController<TestMarkdownInput> };
	findMatchedConfig(file: TFile): ViewConfig | null;
	queueMarkdownView(view: MarkdownView, file: TFile): void;
	runtimeDataCore: {
		fileRenamed(oldPath: string, file: TFile): readonly unknown[];
		folderTreeRenamed(
			oldPath: string,
			newPath: string,
			files: Iterable<TFile>,
			folderPaths?: Iterable<string>,
		): readonly unknown[];
	} | null;
	forwardRuntimeRename(file: TAbstractFile, oldPath: string): void;
}

interface MutableMarkdownView extends MarkdownView {
	file: TFile | null;
	contentEl: HTMLElement;
	getState(): { mode: string; source: boolean };
}

afterEach(() => {
	vi.useRealTimers();
});

describe("production runtime-data routing", () => {
	it("keeps generic same-state Markdown queue churn as a zero-work skip", async () => {
		vi.useFakeTimers();
		const file = makeFile("Notes/Root.md");
		const view = makeView(file);
		const config = makeConfig();
		const plugin = Object.create(CustomViewsPlugin.prototype) as CustomViewsPlugin;
		plugin.settings = { ...DEFAULT_SETTINGS, enabled: true };
		const internals = plugin as unknown as TestPluginInternals;
		internals.unloaded = false;
		internals.settingsVersion = 0;
		internals.pendingMarkdownRequests = new Map();
		internals.findMatchedConfig = () => config;

		let prepareCount = 0;
		const controller = new RenderController<TestMarkdownInput>(async (input): Promise<RenderTransaction> => {
			prepareCount++;
			return {
				commit: () => {
					let surface = view.contentEl.querySelector<HTMLElement>(".obsidian-custom-view-render");
					if (!surface) {
						surface = view.contentEl.ownerDocument.createElement("div");
						surface.classList.add("obsidian-custom-view-render");
						view.contentEl.appendChild(surface);
					}
					view.contentEl.setAttribute("data-cv-state", input.stateKey);
					view.contentEl.setAttribute("data-cv-file-path", input.file.path);
				},
			};
		});
		internals.markdownControllers = { getOrCreate: () => controller };

		internals.queueMarkdownView(view, file);
		await vi.runAllTimersAsync();
		expect(prepareCount).toBe(1);

		internals.queueMarkdownView(view, file);
		await vi.runAllTimersAsync();
		expect(prepareCount).toBe(1);
	});

	it("forwards file and folder renames through the matching runtime-data primitive", () => {
		const plugin = Object.create(CustomViewsPlugin.prototype) as CustomViewsPlugin;
		const internals = plugin as unknown as TestPluginInternals;
		const fileRenamed = vi.fn((_oldPath: string, _file: TFile) => [] as readonly unknown[]);
		const folderTreeRenamed = vi.fn((
			_oldPath: string,
			_newPath: string,
			_files: Iterable<TFile>,
			_folderPaths?: Iterable<string>,
		) => [] as readonly unknown[]);
		internals.runtimeDataCore = { fileRenamed, folderTreeRenamed };

		const directFile = makeFile("Moved/Direct.md");
		internals.forwardRuntimeRename(directFile, "Old/Direct.md");
		expect(fileRenamed).toHaveBeenCalledWith("Old/Direct.md", directFile);

		const root = makeFolder("Moved");
		const nested = makeFolder("Moved/Nested");
		const markdown = makeFile("Moved/Nested/Target.md");
		const ignored = makeFile("Moved/Nested/Asset.png", "png");
		nested.children = [markdown, ignored];
		root.children = [nested];

		internals.forwardRuntimeRename(root, "Old");
		expect(folderTreeRenamed).toHaveBeenCalledTimes(1);
		const call = folderTreeRenamed.mock.calls[0];
		expect(call[0]).toBe("Old");
		expect(call[1]).toBe("Moved");
		expect(Array.from(call[2])).toEqual([markdown]);
		expect(Array.from(call[3] ?? [])).toEqual(["Moved/Nested"]);
	});
});

function makeFile(path: string, extension = "md"): TFile {
	const file = new TFile();
	file.path = path;
	file.name = path.split("/").pop() ?? path;
	file.basename = file.name.replace(/\.[^.]+$/, "");
	file.extension = extension;
	file.parent = null;
	file.stat = { ctime: 1, mtime: 1, size: 32 };
	return file;
}

function makeFolder(path: string): TFolder {
	const folder = new TFolder();
	folder.path = path;
	folder.name = path.split("/").pop() ?? path;
	folder.children = [];
	folder.parent = null;
	return folder;
}

function makeView(file: TFile): MutableMarkdownView {
	const view = Object.create(MarkdownView.prototype) as MutableMarkdownView;
	view.file = file;
	view.contentEl = document.createElement("div");
	view.getState = () => ({ mode: "preview", source: false });
	return view;
}

function makeConfig(): ViewConfig {
	return {
		id: "plain",
		name: "Plain",
		rules: { type: "group", operator: "AND", conditions: [] },
		template: "{{ title }}",
	};
}
