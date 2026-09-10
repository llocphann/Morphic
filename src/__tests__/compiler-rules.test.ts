import { describe, expect, it, vi } from "vitest";
import type { App, FrontMatterCache, TFile } from "obsidian";
import { compileRuleGroup } from "../compiler/rule-compiler";
import { checkRules } from "../matcher";
import type { Filter, FilterGroup } from "../types";

interface MockFileOptions {
	name?: string;
	basename?: string;
	path?: string;
	extension?: string;
	parentPath?: string;
	ctime?: number;
	mtime?: number;
	size?: number;
}

function mockFile(options: MockFileOptions = {}): TFile {
	return {
		name: options.name ?? "note.md",
		basename: options.basename ?? "note",
		path: options.path ?? "notes/note.md",
		extension: options.extension ?? "md",
		parent: { path: options.parentPath ?? "notes" },
		stat: {
			ctime: options.ctime ?? Date.parse("2026-08-15T12:00:00Z"),
			mtime: options.mtime ?? Date.parse("2026-08-20T12:00:00Z"),
			size: options.size ?? 100,
		},
	// eslint-disable-next-line obsidianmd/no-tfile-tfolder-cast
	} as unknown as TFile;
}

interface MockAppOptions {
	bodyTags?: Array<{ tag: string }>;
	bodyLinks?: Array<{ link: string }>;
	linkDestMap?: Record<string, { path: string } | null>;
}

function mockApp(options: MockAppOptions = {}) {
	const getFileCache = vi.fn(() => ({
		tags: options.bodyTags ?? [],
		links: options.bodyLinks ?? [],
	}));
	const getFirstLinkpathDest = vi.fn((linkpath: string) => {
		if (!options.linkDestMap) return null;
		return linkpath in options.linkDestMap ? options.linkDestMap[linkpath] : null;
	});
	const app = {
		metadataCache: {
			getFileCache,
			getFirstLinkpathDest,
		},
	} as unknown as App;
	return { app, getFileCache, getFirstLinkpathDest };
}

function filter(field: string, operator: Filter["operator"], value?: string): Filter {
	return { type: "filter", field, operator, value };
}

function andGroup(...conditions: (Filter | FilterGroup)[]): FilterGroup {
	return { type: "group", operator: "AND", conditions };
}

function orGroup(...conditions: (Filter | FilterGroup)[]): FilterGroup {
	return { type: "group", operator: "OR", conditions };
}

function norGroup(...conditions: (Filter | FilterGroup)[]): FilterGroup {
	return { type: "group", operator: "NOR", conditions };
}

function expectParity(
	group: FilterGroup,
	app: App,
	file: TFile,
	frontmatter?: FrontMatterCache,
): void {
	const compiled = compileRuleGroup(group);
	expect(compiled.matches(app, file, frontmatter)).toBe(checkRules(app, group, file, frontmatter));
}

describe("compiled rule matcher parity", () => {
	it("matches nested AND/OR/NOR semantics", () => {
		const group = orGroup(
			andGroup(
				filter("file.basename", "is", "note"),
				filter("file.extension", "is", "md"),
			),
			norGroup(
				filter("status", "is", "archived"),
				filter("priority", "is", "low"),
			),
		);
		const { app } = mockApp();
		expectParity(group, app, mockFile(), { status: "active", priority: "high" });
	});

	it("matches scalar comma-list operators", () => {
		const { app } = mockApp();
		const file = mockFile();
		const frontmatter = { title: "alpha beta gamma" } as FrontMatterCache;
		for (const rule of [
			filter("title", "contains any of", "delta, beta"),
			filter("title", "does not contain any of", "delta, epsilon"),
			filter("title", "contains all of", "alpha, gamma"),
			filter("title", "does not contain all of", "alpha, delta"),
			filter("title", "starts with", "alpha"),
			filter("title", "does not end with", "delta"),
		]) {
			expectParity(andGroup(rule), app, file, frontmatter);
		}
	});

	it("matches array operators including exact-set behavior", () => {
		const { app } = mockApp();
		const file = mockFile();
		const frontmatter = { aliases: ["Alpha", "Beta"] } as FrontMatterCache;
		for (const rule of [
			filter("aliases", "is", "Alpha"),
			filter("aliases", "is not", "Gamma"),
			filter("aliases", "is exactly", "Beta, Alpha"),
			filter("aliases", "is not exactly", "Alpha"),
			filter("aliases", "contains any of", "et, zz"),
			filter("aliases", "contains all of", "Al, Bet"),
		]) {
			expectParity(andGroup(rule), app, file, frontmatter);
		}
	});

	it("matches folder, tag, and property special operators", () => {
		const { app } = mockApp({ bodyTags: [{ tag: "#project/morphic" }] });
		const file = mockFile({ parentPath: "projects/morphic/core" });
		const frontmatter = { status: "active", tags: ["release"] } as FrontMatterCache;
		const group = andGroup(
			filter("file", "in folder", "/projects/morphic/"),
			filter("file", "has tag", "project, other"),
			filter("file", "has property", "status"),
			filter("file", "does not have property", "missing"),
		);
		expectParity(group, app, file, frontmatter);
	});

	it("matches body and frontmatter outgoing-link rules", () => {
		const { app } = mockApp({
			bodyLinks: [{ link: "Target" }],
			linkDestMap: {
				Target: { path: "refs/Target.md" },
				Other: { path: "refs/Other.md" },
			},
		});
		const file = mockFile();
		const frontmatter = { related: "[[Other|Alias]]" } as FrontMatterCache;
		const group = andGroup(
			filter("file", "links to", "Target"),
			filter("file links", "contains", "refs/Other"),
		);
		expectParity(group, app, file, frontmatter);
	});

	it("matches date operators using legacy date-only semantics", () => {
		const { app } = mockApp();
		const file = mockFile({ mtime: Date.parse("2026-08-20T23:59:59Z") });
		for (const rule of [
			filter("file.mtime", "on", "2026-08-20T01:00:00Z"),
			filter("file.mtime", "not on", "2026-08-21"),
			filter("file.mtime", "before", "2026-08-21"),
			filter("file.mtime", "on or after", "2026-08-20"),
		]) {
			expectParity(andGroup(rule), app, file);
		}
	});

	it("can reuse one compiled matcher across many files", () => {
		const compiled = compileRuleGroup(andGroup(
			filter("file.extension", "is", "md"),
			filter("status", "is", "active"),
		));
		const { app } = mockApp();
		expect(compiled.matches(app, mockFile(), { status: "active" })).toBe(true);
		expect(compiled.matches(app, mockFile({ extension: "txt" }), { status: "active" })).toBe(false);
		expect(compiled.matches(app, mockFile(), { status: "archived" })).toBe(false);
	});
});

describe("compiled rule matcher hot-path behavior", () => {
	it("short-circuits an AND group before link resolution", () => {
		const { app, getFirstLinkpathDest } = mockApp({
			bodyLinks: [{ link: "Target" }],
			linkDestMap: { Target: { path: "Target.md" } },
		});
		const compiled = compileRuleGroup(andGroup(
			filter("file.extension", "is", "txt"),
			filter("file", "links to", "Target"),
		));
		expect(compiled.matches(app, mockFile())).toBe(false);
		expect(getFirstLinkpathDest).not.toHaveBeenCalled();
	});

	it("memoizes tag metadata within one evaluation", () => {
		const { app, getFileCache } = mockApp({ bodyTags: [{ tag: "#project/morphic" }] });
		const compiled = compileRuleGroup(andGroup(
			filter("file", "has tag", "project"),
			filter("file tags", "contains", "morphic"),
		));
		expect(compiled.matches(app, mockFile())).toBe(true);
		expect(getFileCache).toHaveBeenCalledTimes(1);
	});

	it("memoizes outgoing-link resolution within one evaluation", () => {
		const { app, getFileCache, getFirstLinkpathDest } = mockApp({
			bodyLinks: [{ link: "Target" }],
			linkDestMap: { Target: { path: "refs/Target.md" } },
		});
		const compiled = compileRuleGroup(andGroup(
			filter("file", "links to", "Target"),
			filter("file links", "contains", "refs/Target"),
		));
		expect(compiled.matches(app, mockFile())).toBe(true);
		expect(getFileCache).toHaveBeenCalledTimes(1);
		// One target-resolution call plus one body-link-resolution call; the second
		// rule reuses the already-resolved outgoing-link list.
		expect(getFirstLinkpathDest).toHaveBeenCalledTimes(2);
	});
});

describe("compiled rule dependency hints", () => {
	it("collects conservative matcher dependencies for invalidation", () => {
		const compiled = compileRuleGroup(andGroup(
			filter("status", "is", "active"),
			filter("file", "has property", "rating"),
			filter("file", "has tag", "project"),
			filter("file", "links to", "Target"),
			filter("file.mtime", "after", "2026-08-01"),
		));
		expect(compiled.dependencies).toEqual({
			frontmatterFields: ["rating", "status", "tags"],
			staticLinkTargets: ["Target"],
			usesAllFrontmatterForLinks: true,
			usesFileIdentity: false,
			usesFilePath: true,
			usesFileStats: true,
			usesOutgoingLinks: true,
			usesTags: true,
		});
	});
});
