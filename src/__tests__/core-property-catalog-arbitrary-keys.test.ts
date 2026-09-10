import { describe, expect, it } from "vitest";
import type { FileMetadataSnapshot } from "../core/file-snapshot";
import { IncrementalPropertyCatalog } from "../core/property-catalog";

function metadata(frontmatter: Record<string, unknown>): FileMetadataSnapshot {
	return Object.freeze({
		path: "Special.md",
		name: "Special.md",
		basename: "Special",
		extension: "md",
		folder: "",
		size: 1,
		ctime: 1,
		mtime: 1,
		tags: Object.freeze([]),
		links: Object.freeze([]),
		embeds: Object.freeze([]),
		frontmatter: Object.freeze(frontmatter),
	});
}

function arbitraryFrontmatter(protoValue: string, constructorValue: number, toStringValue: boolean): Record<string, unknown> {
	const value: Record<string, unknown> = {};
	Object.defineProperty(value, "__proto__", {
		value: protoValue,
		enumerable: true,
		configurable: true,
	});
	Object.defineProperty(value, "constructor", {
		value: constructorValue,
		enumerable: true,
		configurable: true,
	});
	Object.defineProperty(value, "toString", {
		value: toStringValue,
		enumerable: true,
		configurable: true,
	});
	return value;
}

describe("IncrementalPropertyCatalog arbitrary own property names", () => {
	it("preserves prototype-shaped own keys through insert and semantic no-op refresh", () => {
		const catalog = new IncrementalPropertyCatalog();
		const first = arbitraryFrontmatter("alpha", 1, true);

		expect(Object.prototype.hasOwnProperty.call(first, "__proto__")).toBe(true);
		expect(catalog.upsert(metadata(first))).toEqual(expect.arrayContaining([
			"index:property-type:__proto__",
			"index:property-type:constructor",
			"index:property-type:toString",
			"index:property-types",
		]));
		expect(catalog.inferredType("__proto__")).toBe("text");
		expect(catalog.inferredType("constructor")).toBe("number");
		expect(catalog.inferredType("toString")).toBe("checkbox");

		const definitions = catalog.definitions();
		expect(definitions.map(definition => definition.name)).toEqual([
			"__proto__",
			"constructor",
			"toString",
		]);

		const second = arbitraryFrontmatter("beta", 2, false);
		expect(catalog.upsert(metadata(second))).toEqual([]);
		expect(catalog.definitions()).toBe(definitions);
		expect(catalog.inferredType("__proto__")).toBe("text");
		expect(catalog.inferredType("constructor")).toBe("number");
		expect(catalog.inferredType("toString")).toBe("checkbox");
	});
});
