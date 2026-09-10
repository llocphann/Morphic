import { describe, expect, it } from "vitest";
import { dependencyKey } from "../core/dependencies";
import type { FileMetadataSnapshot } from "../core/file-snapshot";
import { VaultIndex, propertyValueIndexKey } from "../core/vault-index";

const delimiterValue = { a: "x,b:string:y" };
const splitValue = { a: "x", b: "y" };

describe("VaultIndex structured property-value key correctness", () => {
	it("does not alias distinct structured frontmatter values that contain serialization delimiters", () => {
		expect(propertyValueIndexKey("payload", delimiterValue)).not.toBe(
			propertyValueIndexKey("payload", splitValue),
		);

		const index = new VaultIndex();
		index.upsert(metadata("Notes/A.md", { payload: delimiterValue }));
		index.upsert(metadata("Notes/B.md", { payload: splitValue }));

		expect(index.filesWithPropertyValue("payload", delimiterValue)).toEqual(["Notes/A.md"]);
		expect(index.filesWithPropertyValue("payload", splitValue)).toEqual(["Notes/B.md"]);
	});

	it("invalidates a property when its structured value changes across the former collision pair", () => {
		const index = new VaultIndex();
		index.upsert(metadata("Notes/A.md", { payload: delimiterValue }));

		const changed = new Set(index.upsert(metadata("Notes/A.md", { payload: splitValue })));

		expect(changed.has(dependencyKey.file("Notes/A.md", "frontmatter", "payload"))).toBe(true);
		expect(changed.has(propertyValueIndexKey("payload", delimiterValue))).toBe(true);
		expect(changed.has(propertyValueIndexKey("payload", splitValue))).toBe(true);
	});

	it("keeps object key order canonical without aliasing strings, arrays, or nested objects", () => {
		expect(propertyValueIndexKey("payload", { b: 2, a: 1 })).toBe(
			propertyValueIndexKey("payload", { a: 1, b: 2 }),
		);
		expect(propertyValueIndexKey("payload", ["a,b", "c"])).not.toBe(
			propertyValueIndexKey("payload", ["a", "b,c"]),
		);
		expect(propertyValueIndexKey("payload", { a: { b: "c:d" } })).not.toBe(
			propertyValueIndexKey("payload", { "a:{b": "c:d}" }),
		);
	});
});

function metadata(path: string, frontmatter: Record<string, unknown>): FileMetadataSnapshot {
	const name = path.slice(path.lastIndexOf("/") + 1);
	return {
		path,
		name,
		basename: name.replace(/\.md$/, ""),
		extension: "md",
		folder: path.slice(0, path.lastIndexOf("/")),
		size: 1,
		ctime: 1,
		mtime: 1,
		tags: [],
		links: [],
		frontmatter,
	};
}
