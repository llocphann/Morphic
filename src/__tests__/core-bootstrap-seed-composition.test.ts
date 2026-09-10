import { TFile, type App } from "obsidian";
import { describe, expect, it } from "vitest";
import { InvalidationEngine } from "../core/invalidation-engine";
import { ReactiveDataCore } from "../core/reactive-data-core";

interface FixtureFile {
	readonly file: TFile;
	readonly cache: { frontmatter: Record<string, unknown>; tags: readonly { tag: string }[]; links: readonly [] };
}

describe("ReactiveDataCore bootstrap composition", () => {
	it("consumes files once while seeding both indexes from one metadata capture per file", () => {
		const fixtures = Array.from({ length: 128 }, (_, index) => fixtureFile(
			`Notes/Group-${index % 8}/File-${index}.md`,
			{ rating: index, kind: index % 2 === 0 ? "even" : "odd" },
		));
		const fixture = fixtureApp(fixtures);
		let iterations = 0;
		const files: Iterable<TFile> = {
			*[Symbol.iterator]() {
				iterations++;
				if (iterations > 1) throw new Error("bootstrap files iterable consumed twice");
				for (const entry of fixtures) yield entry.file;
			},
		};
		let invalidations = 0;
		const core = new ReactiveDataCore(
			fixture.app,
			new InvalidationEngine<string>(() => { invalidations++; }),
		);

		core.bootstrap(files, ["Empty/Deep"]);

		expect(iterations).toBe(1);
		expect(fixture.metadataReads()).toBe(fixtures.length);
		expect(fixture.bodyReads()).toBe(0);
		expect(invalidations).toBe(0);
		expect(core.index.allPaths()).toHaveLength(fixtures.length);
		expect(core.index.folderPaths()).toEqual(["Empty", "Empty/Deep"]);
		expect(core.propertyCatalog.stats()).toEqual({ files: fixtures.length, properties: 2 });
		expect(core.propertyCatalog.inferredType("rating")).toBe("number");
		expect(core.propertyCatalog.inferredType("kind")).toBe("text");
	});

	it("preserves duplicate-path replacement semantics in both bootstrap seeds", () => {
		const first = fixtureFile("Dup.md", { rating: 1, oldOnly: true });
		const second = fixtureFile("Dup.md", { rating: "one", newOnly: ["x"] });
		const fixture = fixtureApp([first, second]);
		const core = new ReactiveDataCore(fixture.app, new InvalidationEngine<string>(() => undefined));

		core.bootstrap([first.file, second.file]);

		expect(core.index.allPaths()).toEqual(["Dup.md"]);
		expect(core.index.get("Dup.md")?.frontmatter).toEqual({ rating: "one", newOnly: ["x"] });
		expect(core.index.propertyNames()).toEqual(["newOnly", "rating"]);
		expect(core.propertyCatalog.stats()).toEqual({ files: 1, properties: 2 });
		expect(core.propertyCatalog.inferredType("rating")).toBe("text");
		expect(core.propertyCatalog.inferredType("newOnly")).toBe("list");
		expect(core.propertyCatalog.inferredType("oldOnly")).toBe("unknown");
		expect(fixture.metadataReads()).toBe(2);
	});

	it("keeps an explicitly empty folder registry authoritative", () => {
		const entry = fixtureFile("Notes/Child.md", { rating: 1 });
		const fixture = fixtureApp([entry]);
		const core = new ReactiveDataCore(fixture.app, new InvalidationEngine<string>(() => undefined));

		core.bootstrap([entry.file], []);

		expect(core.index.allPaths()).toEqual(["Notes/Child.md"]);
		expect(core.index.filesInFolder("Notes")).toEqual(["Notes/Child.md"]);
		expect(core.index.folderPaths()).toEqual([]);
		expect(core.propertyCatalog.inferredType("rating")).toBe("number");
	});
});

function fixtureFile(path: string, frontmatter: Record<string, unknown>): FixtureFile {
	const file = new TFile();
	file.path = path;
	file.name = path.split("/").pop() ?? path;
	file.basename = file.name.replace(/\.md$/, "");
	file.extension = "md";
	const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
	file.parent = folder ? ({ path: folder } as TFile["parent"]) : null;
	file.stat = { ctime: 1, mtime: 2, size: 3 };
	return { file, cache: { frontmatter, tags: [], links: [] } };
}

function fixtureApp(entries: readonly FixtureFile[]): {
	app: App;
	metadataReads(): number;
	bodyReads(): number;
} {
	const cacheByFile = new Map(entries.map(entry => [entry.file, entry.cache]));
	let metadataReads = 0;
	let bodyReads = 0;
	const app = {
		metadataCache: {
			getFileCache(file: TFile) {
				metadataReads++;
				return cacheByFile.get(file) ?? null;
			},
		},
		vault: {
			async cachedRead() {
				bodyReads++;
				return "";
			},
		},
	} as unknown as App;
	return {
		app,
		metadataReads: () => metadataReads,
		bodyReads: () => bodyReads,
	};
}
