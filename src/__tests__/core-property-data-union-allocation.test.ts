import { describe, expect, it, vi } from "vitest";
import type { FileMetadataSnapshot } from "../core/file-snapshot";
import {
	collectPropertyDataChanges,
	propertyDataDependencyKey,
} from "../core/property-data-dependencies";

describe("property-data direct key traversal", () => {
	it("avoids Object.keys on fresh semantic no-op frontmatter", () => {
		const shared = Object.freeze({ stable: true });
		const before = metadata("A.md", ownRecord({
			status: "active",
			rating: 9,
			optional: undefined,
			payload: shared,
		}));
		const after = metadata("A.md", ownRecord({
			status: "active",
			rating: 9,
			optional: undefined,
			payload: shared,
		}));

		const keys = vi.spyOn(Object, "keys");
		const changed = collectPropertyDataChanges(before, after);
		const keyCalls = keys.mock.calls.length;
		keys.mockRestore();

		expect(changed).toEqual([]);
		expect(keyCalls).toBe(0);
	});

	it("preserves canonical previous-first then next-only output order", () => {
		const before = metadata("A.md", specialRecord([
			["z", 1],
			["a", true],
			["__proto__", "old"],
		]));
		const after = metadata("A.md", specialRecord([
			["z", 2],
			["b", false],
			["__proto__", "new"],
		]));

		expect(collectPropertyDataChanges(before, after)).toEqual([
			propertyDataDependencyKey("z"),
			propertyDataDependencyKey("a"),
			propertyDataDependencyKey("__proto__"),
			propertyDataDependencyKey("b"),
		]);
	});

	it("ignores inherited enumerable keys while identity changes mark every own union member", () => {
		const beforeFrontmatter = Object.create({ inherited: "old" }) as Record<string, unknown>;
		beforeFrontmatter.author = "Ada";
		Object.defineProperty(beforeFrontmatter, "constructor", {
			value: "first",
			enumerable: true,
			writable: true,
			configurable: true,
		});
		const afterFrontmatter = Object.create({ inherited: "new" }) as Record<string, unknown>;
		afterFrontmatter.author = "Ada";
		afterFrontmatter.rating = 9;
		Object.defineProperty(afterFrontmatter, "constructor", {
			value: "first",
			enumerable: true,
			writable: true,
			configurable: true,
		});

		expect(collectPropertyDataChanges(
			metadata("A.md", beforeFrontmatter),
			metadata("B.md", afterFrontmatter),
			{ identityChanged: true },
		)).toEqual([
			propertyDataDependencyKey("author"),
			propertyDataDependencyKey("constructor"),
			propertyDataDependencyKey("rating"),
		]);
	});
});

function ownRecord(values: Record<string, unknown>): Record<string, unknown> {
	return { ...values };
}

function specialRecord(entries: readonly (readonly [string, unknown])[]): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const [key, value] of entries) {
		Object.defineProperty(result, key, {
			value,
			enumerable: true,
			writable: true,
			configurable: true,
		});
	}
	return result;
}

function metadata(path: string, frontmatter: Record<string, unknown>): FileMetadataSnapshot {
	const name = path.split("/").pop() ?? path;
	return Object.freeze({
		path,
		name,
		basename: name.replace(/\.md$/, ""),
		extension: "md",
		folder: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "",
		size: 1,
		ctime: 1,
		mtime: 1,
		tags: Object.freeze([]),
		links: Object.freeze([]),
		embeds: Object.freeze([]),
		frontmatter: Object.freeze(frontmatter),
	});
}
