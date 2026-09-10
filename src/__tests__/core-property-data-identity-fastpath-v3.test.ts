import { describe, expect, it } from "vitest";
import type { FileMetadataSnapshot } from "../core/file-snapshot";
import {
	collectPropertyDataChanges,
	propertyDataDependencyKey,
} from "../core/property-data-dependencies";

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

describe("property-data identity fast path v3", () => {
	it("does not structurally inspect an identical opaque value", () => {
		const opaque = new Proxy({ stable: true }, {
			ownKeys() {
				throw new Error("structural encoder should not inspect identical values");
			},
		});
		const before = metadata("A.md", {
			rating: 9,
			author: "Ada",
			enabled: false,
			optional: undefined,
			payload: opaque,
		});
		const after = metadata("A.md", {
			rating: 9,
			author: "Ada",
			enabled: false,
			optional: undefined,
			payload: opaque,
		});

		expect(collectPropertyDataChanges(before, after)).toEqual([]);
	});

	it("preserves Object.is numeric distinctions and NaN stability", () => {
		expect(collectPropertyDataChanges(
			metadata("A.md", { value: -0 }),
			metadata("A.md", { value: 0 }),
		)).toEqual([propertyDataDependencyKey("value")]);

		expect(collectPropertyDataChanges(
			metadata("A.md", { value: Number.NaN }),
			metadata("A.md", { value: Number.NaN }),
		)).toEqual([]);
	});

	it("keeps file identity changes authoritative before the identity shortcut", () => {
		const shared = { nested: [1, 2, 3] };
		expect(collectPropertyDataChanges(
			metadata("A.md", { payload: shared }),
			metadata("B.md", { payload: shared }),
			{ identityChanged: true },
		)).toEqual([propertyDataDependencyKey("payload")]);
	});
});