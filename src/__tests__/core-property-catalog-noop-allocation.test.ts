import { describe, expect, it, vi } from "vitest";
import { dependencyKey } from "../core/dependencies";
import type { FileMetadataSnapshot } from "../core/file-snapshot";
import { IncrementalPropertyCatalog } from "../core/property-catalog";

describe("IncrementalPropertyCatalog allocation-free no-op probe", () => {
	it("avoids type-map materialization for fresh frontmatter with unchanged inferred types", () => {
		const catalog = new IncrementalPropertyCatalog();
		catalog.upsert(metadata("A.md", {
			status: "active",
			rating: 1,
			tags: ["old"],
			aliases: ["Old"],
			position: { start: 1 },
		}));
		const definitions = catalog.definitions();
		const refresh = metadata("A.md", {
			status: "closed",
			rating: 2,
			tags: ["new"],
			aliases: ["New"],
			position: { start: 999 },
		});

		const entries = vi.spyOn(Object, "entries");
		const changed = catalog.upsert(refresh);
		const entryCalls = entries.mock.calls.length;
		entries.mockRestore();

		expect(changed).toEqual([]);
		expect(entryCalls).toBe(0);
		expect(catalog.definitions()).toBe(definitions);
		expect(catalog.inferredType("status")).toBe("text");
		expect(catalog.inferredType("rating")).toBe("number");
	});

	it("keeps prototype-shaped own keys on the no-allocation path", () => {
		const catalog = new IncrementalPropertyCatalog();
		catalog.upsert(metadata("A.md", specialFrontmatter("alpha")));
		const refresh = metadata("A.md", specialFrontmatter("bravo"));

		const entries = vi.spyOn(Object, "entries");
		const changed = catalog.upsert(refresh);
		const entryCalls = entries.mock.calls.length;
		entries.mockRestore();

		expect(changed).toEqual([]);
		expect(entryCalls).toBe(0);
		expect(catalog.inferredType("__proto__")).toBe("text");
		expect(catalog.inferredType("constructor")).toBe("text");
		expect(catalog.inferredType("toString")).toBe("text");
		expect(catalog.inferredType("tags")).toBe("unknown");
		expect(catalog.inferredType("aliases")).toBe("unknown");
		expect(catalog.inferredType("position")).toBe("unknown");
	});

	it("materializes the normal update path for real type or property-presence changes", () => {
		const catalog = new IncrementalPropertyCatalog();
		catalog.upsert(metadata("A.md", { status: "active", optional: undefined }));
		const refresh = metadata("A.md", { status: 7 });

		const entries = vi.spyOn(Object, "entries");
		const changed = catalog.upsert(refresh);
		const entryCalls = entries.mock.calls.length;
		entries.mockRestore();

		expect(entryCalls).toBeGreaterThan(0);
		expect(changed).toContain(dependencyKey.index("property-type", "status"));
		expect(changed).toContain(dependencyKey.index("property-type", "optional"));
		expect(changed).toContain(dependencyKey.index("property-types"));
		expect(catalog.inferredType("status")).toBe("number");
		expect(catalog.inferredType("optional")).toBe("unknown");
	});
});

function specialFrontmatter(value: string): Record<string, unknown> {
	const frontmatter: Record<string, unknown> = {
		constructor: value,
		toString: value,
		tags: [value],
		aliases: [value],
		position: { start: value.length },
	};
	Object.defineProperty(frontmatter, "__proto__", {
		value,
		enumerable: true,
		writable: true,
		configurable: true,
	});
	return frontmatter;
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
