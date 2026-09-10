import { describe, expect, it } from "vitest";
import { DependencyCollector, dependencyKey } from "../core/dependencies";
import type { FileMetadataSnapshot } from "../core/file-snapshot";
import {
	IncrementalPropertyCatalog,
	inferPropertyValueType,
} from "../core/property-catalog";

describe("IncrementalPropertyCatalog", () => {
	it("matches the legacy Settings value inference contract", () => {
		expect(inferPropertyValueType(null)).toBe("unknown");
		expect(inferPropertyValueType(undefined)).toBe("unknown");
		expect(inferPropertyValueType([])).toBe("list");
		expect(inferPropertyValueType(["a"])).toBe("list");
		expect(inferPropertyValueType(0)).toBe("number");
		expect(inferPropertyValueType(false)).toBe("checkbox");
		expect(inferPropertyValueType("2026-08-31")).toBe("date");
		expect(inferPropertyValueType("2026-08-31T10:00:00Z")).toBe("datetime");
		expect(inferPropertyValueType("42")).toBe("text");
		expect(inferPropertyValueType("[[Note]]")).toBe("text");
		expect(inferPropertyValueType({ nested: true })).toBe("text");
	});

	it("uses first concrete bootstrap value and keeps order stable across unrelated updates", () => {
		const catalog = new IncrementalPropertyCatalog();
		catalog.upsert(metadata("A.md", { status: null, rating: 1 }));
		catalog.upsert(metadata("B.md", { status: 7, rating: "mixed" }));
		catalog.upsert(metadata("C.md", { status: "later" }));
		expect(catalog.inferredType("status")).toBe("number");
		expect(catalog.inferredType("rating")).toBe("number");
		const changed = catalog.upsert(metadata("C.md", { status: false }));
		expect(catalog.inferredType("status")).toBe("number");
		expect(changed).not.toContain(dependencyKey.index("property-type", "status"));
	});

	it("invalidates only when the resolved type or property existence changes", () => {
		const catalog = new IncrementalPropertyCatalog();
		catalog.upsert(metadata("A.md", { status: 7, author: "Ada" }));
		catalog.upsert(metadata("B.md", { status: "fallback" }));
		const changed = catalog.upsert(metadata("A.md", { status: null, author: "Grace" }));
		expect(catalog.inferredType("status")).toBe("text");
		expect(changed).toContain(dependencyKey.index("property-type", "status"));
		expect(changed).toContain(dependencyKey.index("property-types"));
		expect(changed).not.toContain(dependencyKey.index("property-type", "author"));
		const removed = catalog.remove("B.md");
		expect(catalog.inferredType("status")).toBe("unknown");
		expect(removed).toContain(dependencyKey.index("property-type", "status"));
	});

	it("preserves inference order across rename and exposes immutable sorted definitions", () => {
		const catalog = new IncrementalPropertyCatalog();
		catalog.upsert(metadata("B.md", { status: 7, zeta: true }));
		catalog.upsert(metadata("C.md", { status: "later", alpha: [] }));
		const before = catalog.definitions();
		expect(before).toEqual([
			{ name: "alpha", type: "list" },
			{ name: "status", type: "number" },
			{ name: "zeta", type: "checkbox" },
		]);
		expect(Object.isFrozen(before)).toBe(true);
		const renamed = catalog.rename("B.md", metadata("A.md", { status: 7, zeta: true }));
		expect(catalog.inferredType("status")).toBe("number");
		expect(renamed).not.toContain(dependencyKey.index("property-type", "status"));
		expect(catalog.definitions()).toBe(before);
	});

	it("records exact per-property and catalogue dependencies", () => {
		const catalog = new IncrementalPropertyCatalog();
		catalog.upsert(metadata("A.md", { status: "active" }));
		const collector = new DependencyCollector();
		catalog.inferredType("status", collector);
		catalog.definitions(collector);
		expect(collector.has(dependencyKey.index("property-type", "status"))).toBe(true);
		expect(collector.has(dependencyKey.index("property-types"))).toBe(true);
	});
});

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
