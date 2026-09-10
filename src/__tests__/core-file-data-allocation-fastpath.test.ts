import { describe, expect, it, vi } from "vitest";
import { dependencyKey } from "../core/dependencies";
import {
	collectExactFileDataChanges,
	collectFileDataChanges,
	fileDataDependencyKey,
} from "../core/file-data-dependencies";
import type { FileMetadataSnapshot } from "../core/file-snapshot";

describe("file-data invalidation allocation fast paths", () => {
	it("preserves canonical create/delete order and fresh-array ownership", () => {
		const snapshot = metadata({ rating: 9 });
		const fields = [
			"name",
			"basename",
			"path",
			"folder",
			"extension",
			"size",
			"ctime",
			"mtime",
			"tags",
			"links",
			"embeds",
			"backlinks",
		] as const;
		const expected = fields.map(fileDataDependencyKey);
		const created = collectFileDataChanges(undefined, snapshot);
		const createdAgain = collectFileDataChanges(undefined, snapshot);
		const deleted = collectFileDataChanges(snapshot, undefined);

		expect(created).toEqual(expected);
		expect(deleted).toEqual(expected);
		expect(created).not.toBe(createdAgain);
		expect(created).not.toBe(deleted);
		expect(Object.isFrozen(created)).toBe(false);
		expect(Object.isFrozen(deleted)).toBe(false);
	});

	it("keeps stored-field order and appends backlinks exactly once", () => {
		const previous = metadata({}, {
			path: "Notes/A.md",
			tags: Object.freeze(["#old"]),
			links: Object.freeze(["Old"]),
			embeds: Object.freeze(["Old.png"]),
		});
		const next = metadata({}, {
			path: "Archive/B.md",
			name: "B.md",
			basename: "B",
			folder: "Archive",
			tags: Object.freeze(["#new"]),
			links: Object.freeze(["New"]),
			embeds: Object.freeze(["New.png"]),
		});

		expect(collectFileDataChanges(previous, next)).toEqual([
			fileDataDependencyKey("name"),
			fileDataDependencyKey("basename"),
			fileDataDependencyKey("path"),
			fileDataDependencyKey("folder"),
			fileDataDependencyKey("tags"),
			fileDataDependencyKey("links"),
			fileDataDependencyKey("embeds"),
			fileDataDependencyKey("backlinks"),
		]);
	});

	it("deduplicates broad metadata when embeds and property presence change together", () => {
		const previous = metadata({ rating: 9 }, {
			embeds: Object.freeze(["Cover.png"]),
		});
		const next = metadata({ rating: 9, optional: undefined }, {
			embeds: Object.freeze(["Trailer.mp4"]),
		});

		expect(collectExactFileDataChanges(previous, next)).toEqual([
			dependencyKey.file("Notes/A.md", "embeds"),
			dependencyKey.file("Notes/A.md", "metadata"),
		]);
	});

	it("checks own property presence without Object.keys allocation", () => {
		const inherited = { inheritedOnly: true };
		const left = Object.create(inherited) as Record<string, unknown>;
		const right = Object.create(inherited) as Record<string, unknown>;
		defineOwn(left, "__proto__", "before");
		defineOwn(right, "__proto__", "before");
		defineOwn(left, "constructor", 1);
		defineOwn(right, "constructor", 1);
		defineOwn(left, "toString", undefined);
		defineOwn(right, "toString", undefined);
		defineOwn(right, "added", undefined);

		const previous = metadata(Object.freeze(left));
		const next = metadata(Object.freeze(right));
		const keysSpy = vi.spyOn(Object, "keys");
		const changed = collectExactFileDataChanges(previous, next);
		const keyCalls = keysSpy.mock.calls.length;
		keysSpy.mockRestore();

		expect(keyCalls).toBe(0);
		expect(changed).toEqual([
			dependencyKey.file("Notes/A.md", "metadata"),
		]);
	});
});

function metadata(
	frontmatter: Readonly<Record<string, unknown>>,
	overrides: Partial<FileMetadataSnapshot> = {},
): FileMetadataSnapshot {
	return Object.freeze({
		path: "Notes/A.md",
		name: "A.md",
		basename: "A",
		extension: "md",
		folder: "Notes",
		size: 10,
		ctime: 1,
		mtime: 2,
		tags: Object.freeze([]),
		links: Object.freeze([]),
		embeds: Object.freeze([]),
		frontmatter,
		...overrides,
	});
}

function defineOwn(target: Record<string, unknown>, key: string, value: unknown): void {
	Object.defineProperty(target, key, {
		value,
		enumerable: true,
		configurable: true,
		writable: true,
	});
}
