import type { App } from "obsidian";
import { TFile } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import type { FileMetadataSnapshot } from "../core/file-snapshot";
import { InvalidationEngine } from "../core/invalidation-engine";
import { ReactiveDataCore } from "../core/reactive-data-core";
import { VaultIndex } from "../core/vault-index";

describe("VaultIndex bootstrap seeding", () => {
	it("matches sequential upsert across paths, folders, tags and property indexes", () => {
		const snapshots = Array.from({ length: 512 }, (_, index) =>
			snapshot(
			`Area-${index % 11}/Nested-${index % 7}/Note-${index}.md`,
			index,
		),
		);
		const reference = sequential(snapshots);
		const seeded = new VaultIndex();

		seeded.bootstrap(snapshots);

		expect(seeded.allPaths()).toEqual(reference.allPaths());
		expect(seeded.folderPaths()).toEqual(reference.folderPaths());
		expect(seeded.allTags()).toEqual(reference.allTags());
		expect(seeded.propertyNames()).toEqual(reference.propertyNames());
		for (const folder of ["Area-0", "Area-0/Nested-0", "Area-5/Nested-3"]) {
			expect(seeded.filesInFolder(folder)).toEqual(reference.filesInFolder(folder));
		}
		for (const tag of ["#shared", "#bucket/0", "#bucket/3"]) {
			expect(seeded.filesWithTag(tag)).toEqual(reference.filesWithTag(tag));
		}
		for (const property of ["rating", "status", "mixed", "__proto__", "constructor"]) {
			expect(seeded.filesWithProperty(property)).toEqual(reference.filesWithProperty(property));
			expect(seeded.propertySuggestionValues(property)).toEqual(reference.propertySuggestionValues(property));
		}
		for (const value of [0, 3, 7]) {
			expect(seeded.filesWithPropertyValue("rating", value)).toEqual(
				reference.filesWithPropertyValue("rating", value),
			);
		}
	});

	it("preserves duplicate-path replacement semantics by falling back to incremental upsert", () => {
		const snapshots = [
			snapshot("Old/Nested/A.md", 1, { status: "first", value: ["a", "b"] }),
			snapshot("Other/B.md", 2, { status: "other", value: 2 }),
			snapshot("New/Nested/A.md", 3, { status: "different-path", value: 3 }),
			snapshot("Old/Nested/A.md", 4, { status: "replacement", value: { nested: true } }),
		];
		const reference = sequential(snapshots);
		const seeded = new VaultIndex();

		seeded.bootstrap(snapshots);

		expect(seeded.allPaths()).toEqual(reference.allPaths());
		expect(seeded.folderPaths()).toEqual(reference.folderPaths());
		expect(seeded.allTags()).toEqual(reference.allTags());
		expect(seeded.propertyNames()).toEqual(reference.propertyNames());
		expect(seeded.filesWithProperty("status")).toEqual(reference.filesWithProperty("status"));
		expect(seeded.filesWithPropertyValue("status", "replacement")).toEqual(
			reference.filesWithPropertyValue("status", "replacement"),
		);
		expect(seeded.filesWithPropertyValue("value", { nested: true })).toEqual(
			reference.filesWithPropertyValue("value", { nested: true }),
		);
	});

	it("keeps explicit folder registries authoritative while ancestor-closing them", () => {
		const snapshots = [snapshot("Discovered/Nested/A.md", 1)];
		const seeded = new VaultIndex();
		const reference = sequential(snapshots);
		reference.replaceFolders(["Discovered/Nested", "Empty/Deep"]);

		seeded.bootstrap(snapshots, ["Discovered/Nested", "Empty/Deep"]);
		expect(seeded.folderPaths()).toEqual(reference.folderPaths());
		expect(seeded.folderPaths()).toEqual([
			"Discovered",
			"Discovered/Nested",
			"Empty",
			"Empty/Deep",
		]);

		seeded.bootstrap(snapshots, []);
		expect(seeded.folderPaths()).toEqual([]);
	});

	it("ReactiveDataCore bootstrap captures metadata once per file with zero invalidation and body I/O", () => {
		const files = Array.from({ length: 256 }, (_, index) => tfile(`Vault/Note-${index}.md`, index));
		const getFileCache = vi.fn((file: TFile) => ({
			frontmatter: { rating: Number(file.basename.replace("Note-", "")) % 9, status: "ready" },
			tags: [],
			links: [],
			embeds: [],
		}));
		const cachedRead = vi.fn(async () => {
			throw new Error("bootstrap must not read note bodies");
		});
		const app = {
			metadataCache: { getFileCache },
			vault: { cachedRead },
		} as unknown as App;
		const invalidated: string[] = [];
		const core = new ReactiveDataCore(app, new InvalidationEngine<string>(owner => invalidated.push(owner)));

		core.bootstrap(files, ["Vault", "Empty"]);

		expect(getFileCache).toHaveBeenCalledTimes(files.length);
		expect(cachedRead).not.toHaveBeenCalled();
		expect(invalidated).toEqual([]);
		expect(core.index.allPaths()).toHaveLength(files.length);
		expect(core.index.folderPaths()).toEqual(["Empty", "Vault"]);
		expect(core.propertyCatalog.stats().files).toBe(files.length);
	});
});

function sequential(snapshots: readonly FileMetadataSnapshot[]): VaultIndex {
	const index = new VaultIndex();
	for (const value of snapshots) index.upsert(value);
	return index;
}

function snapshot(
	path: string,
	index: number,
	extra: Record<string, unknown> = {},
): FileMetadataSnapshot {
	const name = path.split("/").pop() ?? path;
	const frontmatter = Object.create(null) as Record<string, unknown>;
	frontmatter.rating = index % 9;
	frontmatter.status = index % 2 === 0 ? "ready" : "draft";
	frontmatter.mixed = index % 5 === 0 ? [index, `v-${index}`] : `v-${index % 13}`;
	frontmatter["__proto__"] = index % 3 === 0 ? "proto" : null;
	frontmatter["constructor"] = index % 4 === 0 ? index : "ctor";
	for (const [key, value] of Object.entries(extra)) frontmatter[key] = value;
	return Object.freeze({
		path,
		name,
		basename: name.replace(/\.md$/, ""),
		extension: "md",
		folder: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "",
		size: index + 10,
		ctime: index,
		mtime: index + 1,
		tags: Object.freeze(["#shared", `#bucket/${index % 5}`]),
		links: Object.freeze([]),
		embeds: Object.freeze([]),
		frontmatter: Object.freeze(frontmatter),
	});
}

function tfile(path: string, index: number): TFile {
	const file = new TFile();
	const name = path.split("/").pop() ?? path;
	file.path = path;
	file.name = name;
	file.basename = name.replace(/\.md$/, "");
	file.extension = "md";
	file.parent = null;
	file.stat = { ctime: index, mtime: index + 1, size: index + 10 };
	return file;
}
