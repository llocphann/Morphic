import { TFile, TFolder, type TAbstractFile } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import CustomViewsPlugin from "../main";

interface TestPluginInternals {
	runtimeDataCore: {
		bootstrap(files: Iterable<TFile>, folderPaths?: Iterable<string>): void;
		fileCreated(file: TFile): readonly unknown[];
		folderCreated(path: string): readonly unknown[];
		fileDeleted(path: string): readonly unknown[];
		folderTreeDeleted(path: string): readonly unknown[];
	} | null;
	initializeRuntimeDataCore(): void;
	forwardRuntimeCreate(file: TAbstractFile): void;
	forwardRuntimeDelete(file: TAbstractFile): void;
}

function folder(path: string, children: TAbstractFile[] = []): TFolder {
	const value = new TFolder();
	value.path = path;
	value.name = path.split("/").pop() ?? path;
	value.children = children;
	return value;
}

function file(path: string): TFile {
	const value = new TFile();
	value.path = path;
	value.name = path.split("/").pop() ?? path;
	value.basename = value.name.replace(/\.md$/, "");
	value.extension = "md";
	return value;
}

describe("Settings data production lifecycle routing", () => {
	it("bootstraps the shared runtime index with empty and nested folder paths", () => {
		const note = file("Notes/A.md");
		const nested = folder("Notes/Nested");
		const empty = folder("Empty");
		const notes = folder("Notes", [note, nested]);
		const root = folder("", [notes, empty]);
		const bootstrap = vi.fn();
		const plugin = Object.create(CustomViewsPlugin.prototype) as CustomViewsPlugin;
		Object.defineProperty(plugin, "app", {
			configurable: true,
			value: { vault: { getMarkdownFiles: () => [note], getRoot: () => root } },
		});
		const internals = plugin as unknown as TestPluginInternals;
		internals.runtimeDataCore = {
			bootstrap,
			fileCreated: vi.fn(() => []),
			folderCreated: vi.fn(() => []),
			fileDeleted: vi.fn(() => []),
			folderTreeDeleted: vi.fn(() => []),
		};

		internals.initializeRuntimeDataCore();
		expect(bootstrap).toHaveBeenCalledTimes(1);
		const call = bootstrap.mock.calls[0];
		expect(Array.from(call[0])).toEqual([note]);
		expect(Array.from(call[1] ?? [])).toEqual(["Notes", "Notes/Nested", "Empty"]);
	});

	it("forwards folder create/delete separately from file lifecycle events", () => {
		const plugin = Object.create(CustomViewsPlugin.prototype) as CustomViewsPlugin;
		const fileCreated = vi.fn(() => [] as readonly unknown[]);
		const folderCreated = vi.fn(() => [] as readonly unknown[]);
		const fileDeleted = vi.fn(() => [] as readonly unknown[]);
		const folderTreeDeleted = vi.fn(() => [] as readonly unknown[]);
		const internals = plugin as unknown as TestPluginInternals;
		internals.runtimeDataCore = { bootstrap: vi.fn(), fileCreated, folderCreated, fileDeleted, folderTreeDeleted };
		const note = file("Notes/A.md");
		const directory = folder("Notes/Nested");

		internals.forwardRuntimeCreate(note);
		internals.forwardRuntimeCreate(directory);
		internals.forwardRuntimeDelete(note);
		internals.forwardRuntimeDelete(directory);

		expect(fileCreated).toHaveBeenCalledWith(note);
		expect(folderCreated).toHaveBeenCalledWith("Notes/Nested");
		expect(fileDeleted).toHaveBeenCalledWith("Notes/A.md");
		expect(folderTreeDeleted).toHaveBeenCalledWith("Notes/Nested");
	});
});
