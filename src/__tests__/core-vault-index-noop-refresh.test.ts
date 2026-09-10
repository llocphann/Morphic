import { describe, expect, it } from "vitest";
import { dependencyKey } from "../core/dependencies";
import type { FileMetadataSnapshot } from "../core/file-snapshot";
import { propertyValueIndexKey, VaultIndex } from "../core/vault-index";

interface VaultIndexInternals {
	readonly byFolder: Map<string, Set<string>>;
	readonly byTag: Map<string, Set<string>>;
	readonly byProperty: Map<string, Set<string>>;
	readonly byPropertyValue: Map<string, Set<string>>;
	readonly suggestionValuesByProperty: Map<string, Map<string, Set<string>>>;
}

describe("VaultIndex semantic no-op refresh", () => {
	it("keeps membership structures untouched for fresh-but-equivalent metadata", () => {
		const index = new VaultIndex();
		const initial = snapshot({
			tags: ["#alpha", "#beta"],
			links: ["Target", "Other"],
			embeds: ["Old.png"],
			frontmatter: {
				status: "active",
				topics: ["one", "two"],
				nested: { score: 1 },
			},
		});
		index.upsert(initial);

		const internals = index as unknown as VaultIndexInternals;
		const folderSet = internals.byFolder.get("Notes");
		const tagSet = internals.byTag.get("#alpha");
		const propertySet = internals.byProperty.get("status");
		const propertyValueSet = internals.byPropertyValue.get(
			propertyValueIndexKey("topics", ["one", "two"]),
		);
		const suggestionSet = internals.suggestionValuesByProperty.get("topics")?.get("one");
		expect(folderSet).toBeDefined();
		expect(tagSet).toBeDefined();
		expect(propertySet).toBeDefined();
		expect(propertyValueSet).toBeDefined();
		expect(suggestionSet).toBeDefined();

		const freshEquivalent = snapshot({
			tags: ["#alpha", "#beta"],
			links: ["Target", "Other"],
			// Embeds are not VaultIndex-owned. The exact embed dependency layer must
			// still see the newest snapshot even when every indexed field is equal.
			embeds: ["New.png"],
			frontmatter: {
				status: "active",
				topics: ["one", "two"],
				nested: { score: 1 },
			},
		});

		expect(index.upsert(freshEquivalent)).toEqual([]);
		expect(index.get("Notes/A.md")).toBe(freshEquivalent);
		expect(index.get("Notes/A.md")?.embeds).toEqual(["New.png"]);
		expect(internals.byFolder.get("Notes")).toBe(folderSet);
		expect(internals.byTag.get("#alpha")).toBe(tagSet);
		expect(internals.byProperty.get("status")).toBe(propertySet);
		expect(internals.byPropertyValue.get(propertyValueIndexKey("topics", ["one", "two"]))).toBe(propertyValueSet);
		expect(internals.suggestionValuesByProperty.get("topics")?.get("one")).toBe(suggestionSet);
	});

	it("does not collapse own-property presence changes into a no-op", () => {
		const index = new VaultIndex();
		index.upsert(snapshot({ frontmatter: {} }));

		const changed = new Set(index.upsert(snapshot({ frontmatter: { optional: undefined } })));

		expect(changed).toContain(dependencyKey.index("property", "optional"));
		expect(changed).toContain(dependencyKey.index("properties"));
		expect(index.filesWithProperty("optional")).toEqual(["Notes/A.md"]);
	});

	it("preserves ordered tag and link observability", () => {
		const index = new VaultIndex();
		index.upsert(snapshot({
			tags: ["#alpha", "#beta"],
			links: ["A", "B"],
		}));

		const changed = new Set(index.upsert(snapshot({
			tags: ["#beta", "#alpha"],
			links: ["B", "A"],
		})));

		expect(changed).toContain(dependencyKey.file("Notes/A.md", "tags"));
		expect(changed).toContain(dependencyKey.file("Notes/A.md", "links"));
		expect(changed).toContain(dependencyKey.file("Notes/A.md", "metadata"));
	});
});

function snapshot(overrides: Partial<FileMetadataSnapshot> = {}): FileMetadataSnapshot {
	const {
		tags = [],
		links = [],
		embeds = [],
		frontmatter = {},
		...scalarOverrides
	} = overrides;
	return Object.freeze({
		path: "Notes/A.md",
		name: "A.md",
		basename: "A",
		extension: "md",
		folder: "Notes",
		size: 100,
		ctime: 1,
		mtime: 2,
		...scalarOverrides,
		tags: Object.freeze([...tags]),
		links: Object.freeze([...links]),
		embeds: Object.freeze([...embeds]),
		frontmatter: freezeValue(frontmatter) as Readonly<Record<string, unknown>>,
	});
}

function freezeValue(value: unknown): unknown {
	if (Array.isArray(value)) return Object.freeze(value.map(item => freezeValue(item)));
	if (value !== null && typeof value === "object") {
		const result: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
			result[key] = freezeValue(item);
		}
		return Object.freeze(result);
	}
	return value;
}
