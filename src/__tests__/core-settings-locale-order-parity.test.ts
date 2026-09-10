import { afterEach, describe, expect, it, vi } from "vitest";
import type { IncrementalPropertyCatalog } from "../core/property-catalog";
import { VaultSettingsDataSource } from "../core/settings-data-source";
import type { RevisionedVaultQueryCache } from "../core/vault-query-cache";

describe("VaultSettingsDataSource legacy file/folder parity", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("uses the same localeCompare ordering as FileSuggest and FolderSuggest", () => {
		const paths = Object.freeze(["Zulu.md", "alpha.md", "Éclair.md"]);
		const folders = Object.freeze(["Zulu", "alpha", "Éclair"]);
		const queries = {
			allPaths: () => paths,
			folderPaths: () => folders,
		} as unknown as RevisionedVaultQueryCache;
		const source = new VaultSettingsDataSource(
			queries,
			{} as IncrementalPropertyCatalog,
		);
		const nativeLocaleCompare = String.prototype.localeCompare;
		const localeCompareSpy = vi.spyOn(String.prototype, "localeCompare");

		const fileValues = source.files();
		expect(localeCompareSpy).toHaveBeenCalled();
		expect(fileValues).toEqual(
			paths
				.map(path => path.replace(/\.md$/, ""))
				.sort((left, right) => nativeLocaleCompare.call(left, right)),
		);

		localeCompareSpy.mockClear();
		const folderValues = source.folders();
		expect(localeCompareSpy).toHaveBeenCalled();
		expect(folderValues).toEqual(
			["/", ...folders].sort((left, right) => nativeLocaleCompare.call(left, right)),
		);
	});

	it("keeps the FileSuggest universe markdown-only if the shared index contains other TFiles", () => {
		const paths = Object.freeze([
			"Notes/Zulu.md",
			"Assets/logo.png",
			"Boards/Plan.canvas",
			"Notes/alpha.md",
		]);
		const queries = {
			allPaths: () => paths,
		} as unknown as RevisionedVaultQueryCache;
		const source = new VaultSettingsDataSource(
			queries,
			{} as IncrementalPropertyCatalog,
		);
		const nativeLocaleCompare = String.prototype.localeCompare;

		expect(source.files()).toEqual(
			["Notes/Zulu", "Notes/alpha"].sort((left, right) => nativeLocaleCompare.call(left, right)),
		);
	});

	it("retains transformed result identity without repeated locale sorting", () => {
		const paths = Object.freeze(["Zulu.md", "alpha.md"]);
		const folders = Object.freeze(["Zulu", "alpha"]);
		const queries = {
			allPaths: () => paths,
			folderPaths: () => folders,
		} as unknown as RevisionedVaultQueryCache;
		const source = new VaultSettingsDataSource(
			queries,
			{} as IncrementalPropertyCatalog,
		);
		const localeCompareSpy = vi.spyOn(String.prototype, "localeCompare");

		const firstFiles = source.files();
		const firstFolders = source.folders();
		expect(localeCompareSpy).toHaveBeenCalled();

		localeCompareSpy.mockClear();
		expect(source.files()).toBe(firstFiles);
		expect(source.folders()).toBe(firstFolders);
		expect(localeCompareSpy).not.toHaveBeenCalled();
	});
});
