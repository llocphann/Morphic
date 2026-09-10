import { TFile, type App } from "obsidian";
import { describe, expect, it } from "vitest";
import { DependencyCollector, RevisionStore, dependencyKey } from "../core/dependencies";
import { FileSnapshotStore, captureFileMetadata } from "../core/file-snapshot";
import {
	collectPropertyDataChanges,
	propertyDataDependencyKey,
} from "../core/property-data-dependencies";
import { VaultIndex } from "../core/vault-index";

function file(path: string): TFile {
	const value = new TFile();
	value.path = path;
	value.name = path.split("/").pop() ?? path;
	value.basename = value.name.replace(/\.md$/, "");
	value.extension = "md";
	value.parent = null;
	value.stat = { ctime: 1, mtime: 2, size: 3 };
	return value;
}

function specialRecord(protoValue: unknown): Record<string, unknown> {
	const value: Record<string, unknown> = {};
	Object.defineProperty(value, "__proto__", {
		value: protoValue,
		enumerable: true,
		configurable: true,
		writable: true,
	});
	Object.defineProperty(value, "constructor", {
		value: 42,
		enumerable: true,
		configurable: true,
		writable: true,
	});
	Object.defineProperty(value, "toString", {
		value: "frontmatter-toString",
		enumerable: true,
		configurable: true,
		writable: true,
	});
	return value;
}

describe("frontmatter snapshot prototype-shaped own keys", () => {
	it("preserves own __proto__/constructor/toString while retaining ordinary Object prototype", () => {
		const target = file("Special.md");
		const nested = specialRecord("nested-proto");
		nested.position = { start: 2 };
		const frontmatter = specialRecord("root-proto");
		frontmatter.position = { start: 1 };
		frontmatter.nested = nested;
		const app = {
			metadataCache: {
				getFileCache: () => ({ frontmatter, tags: [], links: [] }),
			},
			vault: {
				cachedRead: async () => "",
			},
		} as unknown as App;

		const snapshot = captureFileMetadata(app, target);
		expect(Object.getPrototypeOf(snapshot.frontmatter)).toBe(Object.prototype);
		expect(Object.prototype.hasOwnProperty.call(snapshot.frontmatter, "__proto__")).toBe(true);
		expect(Object.prototype.hasOwnProperty.call(snapshot.frontmatter, "position")).toBe(false);
		expect(snapshot.frontmatter.__proto__).toBe("root-proto");
		expect(snapshot.frontmatter.constructor).toBe(42);
		expect(snapshot.frontmatter.toString).toBe("frontmatter-toString");
		expect(Object.isFrozen(snapshot.frontmatter)).toBe(true);

		const clonedNested = snapshot.frontmatter.nested as Readonly<Record<string, unknown>>;
		expect(Object.getPrototypeOf(clonedNested)).toBe(Object.prototype);
		expect(Object.prototype.hasOwnProperty.call(clonedNested, "__proto__")).toBe(true);
		expect(Object.prototype.hasOwnProperty.call(clonedNested, "position")).toBe(false);
		expect(clonedNested.__proto__).toBe("nested-proto");
		expect(Object.isFrozen(clonedNested)).toBe(true);
	});

	it("tracks exact prototype-shaped frontmatter reads without widening or body I/O", () => {
		const target = file("Special.md");
		const frontmatter = specialRecord("root-proto");
		let bodyReads = 0;
		const app = {
			metadataCache: {
				getFileCache: () => ({ frontmatter, tags: [], links: [] }),
			},
			vault: {
				cachedRead: async () => {
					bodyReads++;
					return "body";
				},
			},
		} as unknown as App;
		const collector = new DependencyCollector();
		const store = new FileSnapshotStore(app, new RevisionStore());
		const tracked = store.beginRender(collector).file(target);

		expect(tracked.property("__proto__")).toBe("root-proto");
		expect(tracked.property("constructor")).toBe(42);
		expect(tracked.property("toString")).toBe("frontmatter-toString");
		expect(collector.snapshot()).toEqual(new Set([
			dependencyKey.file(target.path, "frontmatter", "__proto__"),
			dependencyKey.file(target.path, "frontmatter", "constructor"),
			dependencyKey.file(target.path, "frontmatter", "toString"),
		]));
		expect(bodyReads).toBe(0);
	});

	it("preserves inherited fallback for missing keys on ordinary snapshot objects", () => {
		const target = file("Ordinary.md");
		const app = {
			metadataCache: {
				getFileCache: () => ({ frontmatter: { rating: 9 }, tags: [], links: [] }),
			},
			vault: {
				cachedRead: async () => "",
			},
		} as unknown as App;
		const collector = new DependencyCollector();
		const store = new FileSnapshotStore(app, new RevisionStore());
		const tracked = store.beginRender(collector).file(target);

		expect(tracked.property("toString")).toBe(Object.prototype.toString);
		expect(collector.snapshot()).toEqual(new Set([
			dependencyKey.file(target.path, "frontmatter", "toString"),
		]));
	});

	it("round-trips __proto__ through VaultIndex and property-data diffing without body I/O", () => {
		const target = file("Special.md");
		let frontmatter = specialRecord("root-proto");
		let bodyReads = 0;
		const app = {
			metadataCache: {
				getFileCache: () => ({ frontmatter, tags: [], links: [] }),
			},
			vault: {
				cachedRead: async () => {
					bodyReads++;
					return "body";
				},
			},
		} as unknown as App;

		const index = new VaultIndex();
		const previous = captureFileMetadata(app, target);
		index.upsert(previous);
		expect(index.propertyNames()).toContain("__proto__");
		expect(index.filesWithProperty("__proto__")).toEqual([target.path]);
		expect(index.filesWithPropertyValue("__proto__", "root-proto")).toEqual([target.path]);

		frontmatter = specialRecord("next-proto");
		const next = captureFileMetadata(app, target);
		expect(collectPropertyDataChanges(previous, next)).toEqual([
			propertyDataDependencyKey("__proto__"),
		]);
		index.upsert(next);
		expect(index.filesWithPropertyValue("__proto__", "root-proto")).toEqual([]);
		expect(index.filesWithPropertyValue("__proto__", "next-proto")).toEqual([target.path]);
		expect(bodyReads).toBe(0);
	});
});
