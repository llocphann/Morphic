import { describe, expect, it, vi } from "vitest";
import { dependencyKey } from "../core/dependencies";
import type { FileMetadataSnapshot } from "../core/file-snapshot";
import {
	IncrementalPropertyCatalog,
	type PropertyValueType,
} from "../core/property-catalog";

interface CatalogInternals {
	readonly files: Map<string, {
		readonly order: number;
		readonly values: Readonly<Record<string, PropertyValueType>>;
	}>;
	readonly members: Map<string, Map<string, unknown>>;
	capture(properties: Iterable<string>): Map<string, PropertyValueType | undefined>;
	addMemberships(path: string, order: number, values: Readonly<Record<string, PropertyValueType>>): void;
	removeMemberships(path: string, values: Readonly<Record<string, PropertyValueType>>): void;
}

describe("IncrementalPropertyCatalog semantic no-op refresh", () => {
	it("preserves membership and definition identities when inferred property types are unchanged", () => {
		const catalog = new IncrementalPropertyCatalog();
		catalog.upsert(metadata("A.md", {
			status: "active",
			rating: 1,
			tags: ["old"],
			aliases: ["Old"],
			position: { start: 1 },
		}));

		const internals = catalog as unknown as CatalogInternals;
		const fileEntry = internals.files.get("A.md");
		const statusMembers = internals.members.get("status");
		const ratingMembers = internals.members.get("rating");
		const definitions = catalog.definitions();
		const capture = vi.spyOn(internals, "capture");
		const removeMemberships = vi.spyOn(internals, "removeMemberships");
		const addMemberships = vi.spyOn(internals, "addMemberships");

		const changed = catalog.upsert(metadata("A.md", {
			rating: 2,
			status: "closed",
			tags: ["new"],
			aliases: ["New"],
			position: { start: 999 },
		}));

		expect(changed).toEqual([]);
		expect(capture).not.toHaveBeenCalled();
		expect(removeMemberships).not.toHaveBeenCalled();
		expect(addMemberships).not.toHaveBeenCalled();
		expect(internals.files.get("A.md")).toBe(fileEntry);
		expect(internals.members.get("status")).toBe(statusMembers);
		expect(internals.members.get("rating")).toBe(ratingMembers);
		expect(catalog.definitions()).toBe(definitions);
		expect(catalog.inferredType("status")).toBe("text");
		expect(catalog.inferredType("rating")).toBe("number");
	});

	it("does not collapse property presence or inferred type changes into the no-op path", () => {
		const catalog = new IncrementalPropertyCatalog();
		catalog.upsert(metadata("A.md", { status: "active", optional: undefined }));
		const internals = catalog as unknown as CatalogInternals;
		const removeMemberships = vi.spyOn(internals, "removeMemberships");
		const addMemberships = vi.spyOn(internals, "addMemberships");

		const typeChanged = catalog.upsert(metadata("A.md", { status: 7, optional: undefined }));
		expect(typeChanged).toContain(dependencyKey.index("property-type", "status"));
		expect(typeChanged).toContain(dependencyKey.index("property-types"));
		expect(catalog.inferredType("status")).toBe("number");
		expect(removeMemberships).toHaveBeenCalledTimes(1);
		expect(addMemberships).toHaveBeenCalledTimes(1);

		removeMemberships.mockClear();
		addMemberships.mockClear();
		const presenceChanged = catalog.upsert(metadata("A.md", { status: 7 }));
		expect(presenceChanged).toContain(dependencyKey.index("property-type", "optional"));
		expect(presenceChanged).toContain(dependencyKey.index("property-types"));
		expect(catalog.inferredType("optional")).toBe("unknown");
		expect(removeMemberships).toHaveBeenCalledTimes(1);
		expect(addMemberships).toHaveBeenCalledTimes(1);
	});

	it("keeps first-concrete inference order stable across repeated same-type refreshes", () => {
		const catalog = new IncrementalPropertyCatalog();
		catalog.upsert(metadata("A.md", { status: null }));
		catalog.upsert(metadata("B.md", { status: 1 }));
		catalog.upsert(metadata("C.md", { status: "later" }));

		for (let i = 0; i < 100; i++) {
			expect(catalog.upsert(metadata("A.md", { status: undefined }))).toEqual([]);
			expect(catalog.upsert(metadata("B.md", { status: i + 2 }))).toEqual([]);
		}

		expect(catalog.inferredType("status")).toBe("number");
		catalog.remove("B.md");
		expect(catalog.inferredType("status")).toBe("text");
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
		embeds: Object.freeze([]),
		frontmatter: Object.freeze(frontmatter),
	});
}
