import { describe, expect, it } from "vitest";
import { dependencyKey } from "../core/dependencies";
import type { FileMetadataSnapshot } from "../core/file-snapshot";
import { VaultIndex, propertyValueIndexKey } from "../core/vault-index";

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

function sharedValue() {
	const child = { x: 1, label: "same" };
	return { a: child, b: child };
}

function duplicatedValue() {
	return {
		a: { x: 1, label: "same" },
		b: { x: 1, label: "same" },
	};
}

describe("Bot 5 property-value shared-reference compatibility", () => {
	it("treats shared YAML-alias-like references as equal to the same expanded value", () => {
		const shared = sharedValue();
		const duplicated = duplicatedValue();

		expect(propertyValueIndexKey("payload", shared)).toBe(
			propertyValueIndexKey("payload", duplicated),
		);

		const index = new VaultIndex();
		index.upsert(metadata("Notes/A.md", { payload: shared }));
		expect(index.filesWithPropertyValue("payload", duplicated)).toEqual(["Notes/A.md"]);
	});

	it("does not invalidate an unchanged structural value solely because reference sharing changed", () => {
		const index = new VaultIndex();
		const shared = sharedValue();
		const duplicated = duplicatedValue();
		index.upsert(metadata("Notes/A.md", { payload: shared }));

		const changed = new Set(index.upsert(metadata("Notes/A.md", { payload: duplicated })));
		const valueKey = propertyValueIndexKey("payload", duplicated);

		expect(changed.has(dependencyKey.file("Notes/A.md", "frontmatter", "payload"))).toBe(false);
		expect(changed.has(valueKey)).toBe(false);
	});
});
