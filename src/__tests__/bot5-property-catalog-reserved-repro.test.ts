import { describe, expect, it } from "vitest";
import type { FileMetadataSnapshot } from "../core/file-snapshot";
import { IncrementalPropertyCatalog } from "../core/property-catalog";

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
		frontmatter: Object.freeze(frontmatter),
	});
}

describe("property catalog legacy reserved-key compatibility", () => {
	it("excludes position, tags, and aliases from custom property definitions", () => {
		const catalog = new IncrementalPropertyCatalog();
		catalog.upsert(metadata("A.md", {
			position: "frontmatter-internal",
			tags: ["alpha", "beta"],
			aliases: ["Alias A"],
			status: "active",
		}));
		expect(catalog.definitions()).toEqual([{ name: "status", type: "text" }]);
		expect(catalog.inferredType("position")).toBe("unknown");
		expect(catalog.inferredType("tags")).toBe("unknown");
		expect(catalog.inferredType("aliases")).toBe("unknown");
	});
});
