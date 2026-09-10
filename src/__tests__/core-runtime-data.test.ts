import { TFile, type App } from "obsidian";
import { describe, expect, it } from "vitest";
import { dependencyKey } from "../core/dependencies";
import { InvalidationEngine } from "../core/invalidation-engine";
import { ReactiveDataCore } from "../core/reactive-data-core";

describe("Morphic runtime linked-file data", () => {
	it("tracks runtime resolution plus the exact linked property without reading body text", () => {
		const fixture = createRuntimeFixture();
		const invalidation = new InvalidationEngine<string>(() => undefined);
		const core = new ReactiveDataCore(fixture.app, invalidation);
		core.bootstrap([fixture.fileA, fixture.fileB]);
		fixture.resolveTo(fixture.fileB);

		const session = core.beginRuntimeRender();
		expect(session.linkedProperty("person", fixture.fileA.path, "author")).toBe("Ada");
		expect(session.linkedProperty("person", fixture.fileA.path, "author")).toBe("Ada");
		expect(fixture.resolveCount()).toBe(1);
		expect(fixture.readCount()).toBe(0);

		const dependencies = session.dependencies();
		expect(dependencies.has(dependencyKey.index("files"))).toBe(true);
		expect(dependencies.has(dependencyKey.file(fixture.fileB.path, "exists"))).toBe(true);
		expect(dependencies.has(
			dependencyKey.file(fixture.fileB.path, "frontmatter", "author"),
		)).toBe(true);
		expect(dependencies.has(dependencyKey.file(fixture.fileB.path, "content"))).toBe(false);
	});

	it("invalidates an unresolved runtime target when the vault file set changes", () => {
		const fixture = createRuntimeFixture();
		const invalidated: string[] = [];
		const invalidation = new InvalidationEngine<string>(owner => invalidated.push(owner));
		const core = new ReactiveDataCore(fixture.app, invalidation);
		core.bootstrap([fixture.fileA]);
		fixture.resolveTo(null);

		const first = core.beginRuntimeRender();
		expect(first.resolveFile("person", fixture.fileA.path)).toBeNull();
		invalidation.commitDependencies("owner", first.dependencies());

		fixture.resolveTo(fixture.fileB);
		expect(core.fileCreated(fixture.fileB)).toEqual(["owner"]);
		expect(invalidated).toEqual(["owner"]);

		const second = core.beginRuntimeRender();
		expect(second.linkedProperty("person", fixture.fileA.path, "author")).toBe("Ada");
	});

	it("invalidates a resolved runtime target when that file is deleted", () => {
		const fixture = createRuntimeFixture();
		const invalidated: string[] = [];
		const invalidation = new InvalidationEngine<string>(owner => invalidated.push(owner));
		const core = new ReactiveDataCore(fixture.app, invalidation);
		core.bootstrap([fixture.fileA, fixture.fileB]);
		fixture.resolveTo(fixture.fileB);

		const session = core.beginRuntimeRender();
		expect(session.linkedProperty("person", fixture.fileA.path, "author")).toBe("Ada");
		invalidation.commitDependencies("owner", session.dependencies());

		expect(core.fileDeleted(fixture.fileB.path)).toEqual(["owner"]);
		expect(invalidated).toEqual(["owner"]);
	});

	it("replaces stale runtime target edges after a dynamic target changes", () => {
		const fixture = createRuntimeFixture();
		const invalidated: string[] = [];
		const invalidation = new InvalidationEngine<string>(owner => invalidated.push(owner));
		const core = new ReactiveDataCore(fixture.app, invalidation);
		core.bootstrap([fixture.fileA, fixture.fileB]);

		fixture.resolveTo(fixture.fileB);
		const first = core.beginRuntimeRender();
		expect(first.linkedProperty("person", fixture.fileA.path, "author")).toBe("Ada");
		invalidation.commitDependencies("owner", first.dependencies());

		fixture.resolveTo(fixture.fileC);
		expect(core.fileCreated(fixture.fileC)).toEqual(["owner"]);

		const second = core.beginRuntimeRender();
		expect(second.linkedProperty("person", fixture.fileA.path, "author")).toBe("Grace");
		invalidation.commitDependencies("owner", second.dependencies());
		invalidated.length = 0;

		fixture.setFrontmatter(fixture.fileB, { author: "Changed B" });
		expect(core.fileMetadataRefreshed(fixture.fileB)).toEqual([]);
		expect(invalidated).toEqual([]);

		fixture.setFrontmatter(fixture.fileC, { author: "Changed C" });
		expect(core.fileMetadataRefreshed(fixture.fileC)).toEqual(["owner"]);
		expect(invalidated).toEqual(["owner"]);
	});

	it("keeps linked body reads explicit and deduplicated across runtime owners", async () => {
		const fixture = createRuntimeFixture();
		const invalidation = new InvalidationEngine<string>(() => undefined);
		const core = new ReactiveDataCore(fixture.app, invalidation);
		core.bootstrap([fixture.fileA, fixture.fileB]);
		fixture.resolveTo(fixture.fileB);

		const first = core.beginRuntimeRender().linkedBody("person", fixture.fileA.path);
		const second = core.beginRuntimeRender().linkedBody("person", fixture.fileA.path);
		expect(await Promise.all([first, second])).toEqual(["B body", "B body"]);
		expect(fixture.readCount()).toBe(1);
	});
});

function createRuntimeFixture(): {
	app: App;
	fileA: TFile;
	fileB: TFile;
	fileC: TFile;
	resolveTo(file: TFile | null): void;
	resolveCount(): number;
	readCount(): number;
	setFrontmatter(file: TFile, value: Record<string, unknown>): void;
} {
	const fileA = createFile("Notes/A.md");
	const fileB = createFile("People/B.md");
	const fileC = createFile("People/C.md");
	const frontmatter = new Map<string, Record<string, unknown>>([
		[fileA.path, { person: "[[People/B]]" }],
		[fileB.path, { author: "Ada" }],
		[fileC.path, { author: "Grace" }],
	]);
	const content = new Map<string, string>([
		[fileA.path, "A body"],
		[fileB.path, "---\nauthor: Ada\n---\nB body"],
		[fileC.path, "---\nauthor: Grace\n---\nC body"],
	]);

	let resolved: TFile | null = null;
	let resolves = 0;
	let reads = 0;
	const app = {
		metadataCache: {
			getFirstLinkpathDest() {
				resolves++;
				return resolved;
			},
			getFileCache(file: TFile) {
				return {
					frontmatter: frontmatter.get(file.path) ?? {},
					tags: [],
					links: [],
				};
			},
		},
		vault: {
			async cachedRead(file: TFile) {
				reads++;
				return content.get(file.path) ?? "";
			},
		},
	} as unknown as App;

	return {
		app,
		fileA,
		fileB,
		fileC,
		resolveTo: file => { resolved = file; },
		resolveCount: () => resolves,
		readCount: () => reads,
		setFrontmatter: (file, value) => { frontmatter.set(file.path, value); },
	};
}

function createFile(path: string): TFile {
	const file = new TFile();
	file.path = path;
	file.name = path.split("/").pop() ?? path;
	file.basename = file.name.replace(/\.md$/, "");
	file.extension = "md";
	file.parent = null;
	file.stat = { ctime: 1, mtime: 1, size: 32 };
	return file;
}
