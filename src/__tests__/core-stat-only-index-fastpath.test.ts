import type { App, CachedMetadata } from "obsidian";
import { TFile } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { dependencyKey } from "../core/dependencies";
import { fileDataDependencyKey } from "../core/file-data-dependencies";
import type { FileMetadataSnapshot } from "../core/file-snapshot";
import { InvalidationEngine } from "../core/invalidation-engine";
import { ReactiveDataCore } from "../core/reactive-data-core";
import { VaultIndex, propertyValueIndexKey } from "../core/vault-index";

describe("VaultIndex stat-only update fast path", () => {
	it("updates only exact stat/metadata keys without rebuilding memberships", () => {
		const index = new VaultIndex();
		const original = snapshot();
		index.upsert(original);

		const internals = index as unknown as MembershipInternals;
		const removeMemberships = vi.spyOn(internals, "removeMemberships");
		const addMemberships = vi.spyOn(internals, "addMemberships");
		const captureCoarseState = vi.spyOn(internals, "captureCoarseState");
		const next = Object.freeze({
			...original,
			size: 42,
			mtime: 9,
		});

		expect(new Set(index.upsert(next))).toEqual(new Set([
			dependencyKey.file(original.path, "stat", "size"),
			dependencyKey.file(original.path, "stat", "mtime"),
			dependencyKey.file(original.path, "metadata"),
		]));
		expect(removeMemberships).not.toHaveBeenCalled();
		expect(addMemberships).not.toHaveBeenCalled();
		expect(captureCoarseState).not.toHaveBeenCalled();
		expect(index.filesInFolder("Notes")).toEqual([original.path]);
		expect(index.filesWithTag("#work")).toEqual([original.path]);
		expect(index.filesWithProperty("status")).toEqual([original.path]);
		expect(index.filesWithPropertyValue("status", "open")).toEqual([original.path]);
		expect(index.get(original.path)?.size).toBe(42);
		expect(index.get(original.path)?.mtime).toBe(9);
	});

	it("falls back to full semantic diff when non-stat snapshot data changes", () => {
		const index = new VaultIndex();
		const original = snapshot();
		index.upsert(original);
		const next = Object.freeze({
			...original,
			size: 42,
			frontmatter: Object.freeze({ status: "closed" }),
		});

		const changed = new Set(index.upsert(next));
		expect(changed).toContain(dependencyKey.file(original.path, "stat", "size"));
		expect(changed).toContain(dependencyKey.file(original.path, "frontmatter", "status"));
		expect(changed).toContain(dependencyKey.file(original.path, "metadata"));
		expect(changed).toContain(propertyValueIndexKey("status", "open"));
		expect(changed).toContain(propertyValueIndexKey("status", "closed"));
		expect(index.filesWithPropertyValue("status", "open")).toEqual([]);
		expect(index.filesWithPropertyValue("status", "closed")).toEqual([original.path]);
	});

	it("uses fast paths from fileContentModified through duplicate metadata refresh", () => {
		const file = tfile();
		let metadataReads = 0;
		const metadata: CachedMetadata = {
			frontmatter: { status: "open" },
			tags: [{ tag: "#work", position: position() }],
			links: [],
		};
		const app = {
			metadataCache: {
				getFileCache: () => {
					metadataReads++;
					return metadata;
				},
			},
			vault: {
				cachedRead: async () => "body",
			},
		} as unknown as App;
		const invalidated: string[] = [];
		const invalidation = new InvalidationEngine<string>(owner => invalidated.push(owner));
		const core = new ReactiveDataCore(app, invalidation);
		core.bootstrap([file]);

		const internals = core.index as unknown as MembershipInternals;
		const removeMemberships = vi.spyOn(internals, "removeMemberships");
		const addMemberships = vi.spyOn(internals, "addMemberships");
		const captureCoarseState = vi.spyOn(internals, "captureCoarseState");
		const exactSize = dependencyKey.file(file.path, "stat", "size");
		const exactMtime = dependencyKey.file(file.path, "stat", "mtime");
		const broadMetadata = dependencyKey.file(file.path, "metadata");
		const coarseSize = fileDataDependencyKey("size");
		const coarseMtime = fileDataDependencyKey("mtime");
		const content = dependencyKey.file(file.path, "content");
		invalidation.commitDependencies("exact-size", [exactSize]);
		invalidation.commitDependencies("exact-mtime", [exactMtime]);
		invalidation.commitDependencies("metadata", [broadMetadata]);
		invalidation.commitDependencies("coarse-size", [coarseSize]);
		invalidation.commitDependencies("coarse-mtime", [coarseMtime]);
		invalidation.commitDependencies("content", [content]);

		const metadataReadsAfterBootstrap = metadataReads;
		file.stat = { ...file.stat, size: 42, mtime: 9 };
		expect(new Set(core.fileContentModified(file))).toEqual(new Set([
			"exact-size",
			"exact-mtime",
			"metadata",
			"coarse-size",
			"coarse-mtime",
			"content",
		]));
		expect(removeMemberships).not.toHaveBeenCalled();
		expect(addMemberships).not.toHaveBeenCalled();
		expect(captureCoarseState).not.toHaveBeenCalled();
		expect(metadataReads).toBe(metadataReadsAfterBootstrap);
		expect(core.index.get(file.path)?.size).toBe(42);
		expect(core.index.get(file.path)?.mtime).toBe(9);

		invalidated.length = 0;
		removeMemberships.mockClear();
		addMemberships.mockClear();
		captureCoarseState.mockClear();
		expect(core.fileMetadataRefreshed(file)).toEqual([]);
		expect(invalidated).toEqual([]);
		expect(removeMemberships).not.toHaveBeenCalled();
		expect(addMemberships).not.toHaveBeenCalled();
		expect(captureCoarseState).not.toHaveBeenCalled();
	});
});

interface MembershipInternals {
	removeMemberships(snapshot: FileMetadataSnapshot): void;
	addMemberships(snapshot: FileMetadataSnapshot): void;
	captureCoarseState(
		previous: FileMetadataSnapshot | undefined,
		next: FileMetadataSnapshot | undefined,
	): unknown;
}

function snapshot(): FileMetadataSnapshot {
	return Object.freeze({
		path: "Notes/A.md",
		name: "A.md",
		basename: "A",
		extension: "md",
		folder: "Notes",
		size: 10,
		ctime: 1,
		mtime: 2,
		tags: Object.freeze(["#work"]),
		links: Object.freeze([]),
		embeds: Object.freeze([]),
		frontmatter: Object.freeze({ status: "open" }),
	});
}

function tfile(): TFile {
	const file = new TFile();
	file.path = "Notes/A.md";
	file.name = "A.md";
	file.basename = "A";
	file.extension = "md";
	file.parent = null;
	file.stat = { ctime: 1, mtime: 2, size: 10 };
	return file;
}

function position() {
	return {
		start: { line: 0, col: 0, offset: 0 },
		end: { line: 0, col: 5, offset: 5 },
	};
}
