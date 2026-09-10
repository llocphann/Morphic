import { describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import CustomViewsPlugin from "../main";
import { FilterBuilder } from "../settings";
import {
	FileSuggest,
	FolderSuggest,
	FrontmatterValueSuggest,
	PropertySuggest,
	TagSuggest,
} from "../suggests";
import type { VaultSettingsDataSource } from "../core";
import type { FilterGroup } from "../types";

function values(items: readonly { value: string }[]): string[] {
	return items.map(item => item.value);
}

function createSource(): VaultSettingsDataSource {
	return {
		files: vi.fn(() => Object.freeze(["Alpha", "Notes/Beta"])),
		folders: vi.fn(() => Object.freeze(["/", "Archive", "Notes"])),
		tags: vi.fn(() => Object.freeze(["alpha", "project"])),
		properties: vi.fn(() => Object.freeze(["aliases", "position", "rating", "status", "tags"])),
		propertyDefinitions: vi.fn(() => Object.freeze([
			Object.freeze({ name: "aliases", type: "list" as const }),
			Object.freeze({ name: "position", type: "text" as const }),
			Object.freeze({ name: "rating", type: "number" as const }),
			Object.freeze({ name: "status", type: "text" as const }),
			Object.freeze({ name: "tags", type: "list" as const }),
		])),
		propertyValues: vi.fn((name: string) => Object.freeze(name === "status" ? ["active", "queued"] : ["[[People/Ada|Ada]]"])),
		clear: vi.fn(),
	} as unknown as VaultSettingsDataSource;
}

function createNoScanApp(): { app: App; scan: ReturnType<typeof vi.fn> } {
	const scan = vi.fn(() => { throw new Error("whole-vault scan must not run"); });
	return {
		app: {
			vault: { getMarkdownFiles: scan, getRoot: scan },
			metadataCache: { getFileCache: scan },
		} as unknown as App,
		scan,
	};
}

describe("Settings incremental production consumers", () => {
	it("serves every inline suggest universe from VaultSettingsDataSource without vault scans", () => {
		const source = createSource();
		const { app, scan } = createNoScanApp();
		const input = document.createElement("input");

		expect(values(new FileSuggest(app, input, source).getSuggestions(""))).toEqual(["Alpha", "Notes/Beta"]);
		expect(values(new FolderSuggest(app, input, source).getSuggestions(""))).toEqual(["/", "Archive", "Notes"]);
		expect(values(new TagSuggest(app, input, source).getSuggestions(""))).toEqual(["alpha", "project"]);
		expect(values(new PropertySuggest(app, input, source).getSuggestions(""))).toEqual(["aliases", "rating", "status", "tags"]);
		expect(values(new FrontmatterValueSuggest(app, input, "status", source).getSuggestions(""))).toEqual(["active", "queued"]);
		expect(scan).not.toHaveBeenCalled();
	});

	it("builds filter properties from the incremental catalogue with assigned-type precedence", () => {
		const source = createSource();
		const scan = vi.fn(() => { throw new Error("whole-vault scan must not run"); });
		const plugin = {
			app: {
				vault: { getMarkdownFiles: scan },
				metadataTypeManager: {
					getAssignedType: (name: string) => name === "rating" ? "text" : undefined,
				},
			},
			getSettingsDataSource: () => source,
		} as unknown as CustomViewsPlugin;
		const root: FilterGroup = { type: "group", operator: "AND", conditions: [] };
		const builder = new FilterBuilder(plugin, root, () => undefined, () => undefined);

		expect(builder.availableProperties.map(property => property.key)).toEqual([
			"file", "file.name", "file.path", "file.folder", "file.ctime", "file.mtime", "file.size",
			"file links", "file tags", "aliases", "rating", "status",
		]);
		expect(builder.availableProperties.find(property => property.key === "rating")?.type).toBe("text");
		expect(scan).not.toHaveBeenCalled();
	});
});
