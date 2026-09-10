import { describe, expect, it } from "vitest";
import type { FileMetadataSnapshot } from "../core/file-snapshot";
import { IncrementalPropertyCatalog } from "../core/property-catalog";

describe("IncrementalPropertyCatalog bootstrap fast path", () => {
	it("matches sequential upsert inference without rescanning prior members", () => {
		const snapshots = [
			snapshot("A.md", {
				rating: null,
				author: "Ada",
				joined: undefined,
				tags: ["reserved"],
				aliases: ["reserved"],
			}),
			snapshot("B.md", {
				rating: 9,
				author: 10,
				joined: "2026-09-01",
				active: true,
			}),
			snapshot("C.md", {
				rating: "later text must not replace first concrete number",
				joined: "2026-09-01T12:00:00",
				items: [1, 2],
			}),
		];

		const reference = sequential(snapshots);
		const fast = new IncrementalPropertyCatalog();
		fast.bootstrap(snapshots);

		expect(fast.definitions()).toEqual(reference.definitions());
		expect(fast.stats()).toEqual(reference.stats());
		for (const property of ["rating", "author", "joined", "active", "items", "tags", "aliases"]) {
			expect(fast.inferredType(property)).toBe(reference.inferredType(property));
		}
		expect(fast.inferredType("rating")).toBe("number");
		expect(fast.inferredType("author")).toBe("text");
		expect(fast.inferredType("joined")).toBe("date");
		expect(fast.inferredType("tags")).toBe("unknown");
		expect(fast.inferredType("aliases")).toBe("unknown");
	});

	it("falls back to normal replacement semantics for duplicate bootstrap paths", () => {
		const snapshots = [
			snapshot("A.md", { score: 1, owner: null }),
			snapshot("B.md", { score: "later", owner: "Grace" }),
			snapshot("A.md", { score: null, owner: 7, extra: true }),
			snapshot("C.md", { score: 3, owner: "later still" }),
		];

		const reference = sequential(snapshots);
		const fast = new IncrementalPropertyCatalog();
		fast.bootstrap(snapshots);

		expect(fast.definitions()).toEqual(reference.definitions());
		expect(fast.stats()).toEqual(reference.stats());
		expect(fast.inferredType("score")).toBe(reference.inferredType("score"));
		expect(fast.inferredType("owner")).toBe(reference.inferredType("owner"));
		expect(fast.inferredType("extra")).toBe(reference.inferredType("extra"));
	});

	it("preserves incremental update/remove behavior after bootstrap", () => {
		const initial = [
			snapshot("A.md", { kind: null, priority: 1 }),
			snapshot("B.md", { kind: "note", priority: 2 }),
			snapshot("C.md", { kind: "later", flag: true }),
		];
		const reference = sequential(initial);
		const fast = new IncrementalPropertyCatalog();
		fast.bootstrap(initial);

		const updatedA = snapshot("A.md", { kind: 42, priority: 1, added: "x" });
		expect(fast.upsert(updatedA)).toEqual(reference.upsert(updatedA));
		expect(fast.definitions()).toEqual(reference.definitions());

		expect(fast.remove("B.md")).toEqual(reference.remove("B.md"));
		expect(fast.definitions()).toEqual(reference.definitions());

		const renamedC = snapshot("Renamed/C.md", { kind: "later", flag: false });
		expect(fast.rename("C.md", renamedC)).toEqual(reference.rename("C.md", renamedC));
		expect(fast.definitions()).toEqual(reference.definitions());
		expect(fast.stats()).toEqual(reference.stats());
	});
});

function sequential(snapshots: readonly FileMetadataSnapshot[]): IncrementalPropertyCatalog {
	const catalog = new IncrementalPropertyCatalog();
	for (const value of snapshots) catalog.upsert(value);
	return catalog;
}

function snapshot(path: string, frontmatter: Record<string, unknown>): FileMetadataSnapshot {
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
		frontmatter: Object.freeze({ ...frontmatter }),
	});
}
