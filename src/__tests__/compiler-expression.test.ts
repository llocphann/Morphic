import { describe, expect, it, vi } from "vitest";
import type { App, TFile } from "obsidian";
import { evaluateExpression, type ExprContext } from "../expression";
import {
	compileExpression,
	evaluateCompiledExpression,
} from "../compiler";

function makeMockFile(overrides: Partial<TFile> = {}): TFile {
	return {
		name: "test.md",
		basename: "test",
		path: "folder/test.md",
		extension: "md",
		stat: { size: 1234, ctime: 1000000, mtime: 2000000 },
		vault: {},
		...overrides,
		// eslint-disable-next-line obsidianmd/no-tfile-tfolder-cast
	} as unknown as TFile;
}

function makeContext(overrides: Partial<ExprContext> = {}): ExprContext {
	const file = makeMockFile();
	return {
		app: {
			metadataCache: {
				getFirstLinkpathDest: vi.fn().mockReturnValue(null),
				getFileCache: vi.fn().mockReturnValue(null),
			},
			vault: {
				cachedRead: vi.fn().mockResolvedValue(""),
			},
		} as unknown as App,
		file,
		frontmatter: {},
		bodyContent: "Body",
		variables: {},
		...overrides,
	};
}

describe("compiled expression evaluation", () => {
	it("reuses one compiled AST across changing render contexts", async () => {
		const compiled = compileExpression('if(rating > 8, title.upper(), "OK")');

		const highRating = makeContext({
			frontmatter: { rating: 9, title: "hello" },
		});
		const lowRating = makeContext({
			frontmatter: { rating: 3, title: "ignored" },
		});

		expect(await evaluateCompiledExpression(compiled, highRating)).toBe("HELLO");
		expect(await evaluateCompiledExpression(compiled, lowRating)).toBe("OK");
	});

	it("reads built-in file identity without materializing file metadata", async () => {
		const ctx = makeContext();
		const getFileCache = ctx.app.metadataCache.getFileCache as ReturnType<typeof vi.fn>;

		expect(await evaluateCompiledExpression(compileExpression("file.name"), ctx)).toBe("test.md");
		expect(await evaluateCompiledExpression(compileExpression("file.basename"), ctx)).toBe("test");
		expect(await evaluateCompiledExpression(compileExpression("file.path"), ctx)).toBe("folder/test.md");
		expect(await evaluateCompiledExpression(compileExpression("file.folder"), ctx)).toBe("folder");
		expect(await evaluateCompiledExpression(compileExpression("file.ext"), ctx)).toBe("md");
		expect(getFileCache).not.toHaveBeenCalled();
	});

	it("preserves frontmatter file shadowing instead of taking the identity fast path", async () => {
		const ctx = makeContext({
			frontmatter: { file: { name: "shadowed.md" } },
		});

		expect(await evaluateCompiledExpression(compileExpression("file.name"), ctx)).toBe("shadowed.md");
	});

	it("short-circuits && without resolving the skipped file branch", async () => {
		const ctx = makeContext();
		const resolver = ctx.app.metadataCache.getFirstLinkpathDest as ReturnType<typeof vi.fn>;
		const compiled = compileExpression('false && file("Skipped")');

		expect(await evaluateCompiledExpression(compiled, ctx)).toBe(false);
		expect(resolver).not.toHaveBeenCalled();
	});

	it("short-circuits || without resolving the skipped file branch", async () => {
		const ctx = makeContext();
		const resolver = ctx.app.metadataCache.getFirstLinkpathDest as ReturnType<typeof vi.fn>;
		const compiled = compileExpression('true || file("Skipped")');

		expect(await evaluateCompiledExpression(compiled, ctx)).toBe(true);
		expect(resolver).not.toHaveBeenCalled();
	});

	it("preserves short-circuiting inside a larger arithmetic expression", async () => {
		const ctx = makeContext();
		const resolver = ctx.app.metadataCache.getFirstLinkpathDest as ReturnType<typeof vi.fn>;
		const compiled = compileExpression('1 + (false && file("Skipped"))');

		expect(await evaluateCompiledExpression(compiled, ctx)).toBe(1);
		expect(resolver).not.toHaveBeenCalled();
	});

	it("if() evaluates only the selected true branch", async () => {
		const ctx = makeContext();
		const resolver = ctx.app.metadataCache.getFirstLinkpathDest as ReturnType<typeof vi.fn>;
		const compiled = compileExpression('if(true, "yes", file("Skipped"))');

		expect(await evaluateCompiledExpression(compiled, ctx)).toBe("yes");
		expect(resolver).not.toHaveBeenCalled();
	});

	it("if() evaluates only the selected false branch", async () => {
		const ctx = makeContext();
		const resolver = ctx.app.metadataCache.getFirstLinkpathDest as ReturnType<typeof vi.fn>;
		const compiled = compileExpression('if(false, file("Skipped"), "no")');

		expect(await evaluateCompiledExpression(compiled, ctx)).toBe("no");
		expect(resolver).not.toHaveBeenCalled();
	});

	it("evaluates a selected async branch exactly once", async () => {
		const ctx = makeContext();
		const resolver = ctx.app.metadataCache.getFirstLinkpathDest as ReturnType<typeof vi.fn>;
		const compiled = compileExpression('if(true, file("Selected"), "no")');

		expect(await evaluateCompiledExpression(compiled, ctx)).toBe(null);
		expect(resolver).toHaveBeenCalledTimes(1);
		expect(resolver).toHaveBeenCalledWith("Selected", "folder/test.md");
	});

	it("precompiles trailing legacy pipe filters for warm reuse", async () => {
		const ctx = makeContext({ frontmatter: { title: "  hello  " } });
		const compiled = compileExpression("title | trim | upper");

		expect(compiled.pipeFilters).toBe("trim | upper");
		expect(compiled.filterPipeline?.steps).toEqual([
			{ name: "trim", args: [], source: "trim" },
			{ name: "upper", args: [], source: "upper" },
		]);
		expect(await evaluateCompiledExpression(compiled, ctx)).toBe("HELLO");
		expect(await evaluateCompiledExpression(compiled, ctx)).toBe("HELLO");
	});

	it("executes the compiled filter representation rather than reparsing pipeFilters", async () => {
		const ctx = makeContext({ frontmatter: { title: " hello " } });
		const compiled = compileExpression("title | trim | upper");
		const compatibilityView = compiled as CompiledExpressionMutableForTest;
		compatibilityView.pipeFilters = "does_not_exist";

		expect(await evaluateCompiledExpression(compiled, ctx)).toBe("HELLO");
	});
});

interface CompiledExpressionMutableForTest {
	pipeFilters: string | null;
}

describe("compiled pure operator differential parity", () => {
	const expressions = [
		"1 + 2 * 3",
		'"a" + 2',
		"true + 2",
		'"12.5x" - 2',
		"10 / 0",
		"10 % 0",
		"2 ** 3",
		"[1, 2] == [1, 2]",
		"[1, 2] != [1, 3]",
		'link("A") == "[[A]]"',
		'date("2026-08-31") == "2026-08-31"',
		'/a/i == "/a/i"',
		"file.name",
		"file.basename",
		"file.path",
		"file.folder",
		"file.ext",
		"3 < 4",
		"4 >= 4",
		"![]",
		'-"12.5x"',
	];

	for (const source of expressions) {
		it(`matches legacy coercion for ${source}`, async () => {
			const legacyContext = makeContext();
			const compiledContext = makeContext();
			const expected = await evaluateExpression(source, legacyContext);
			const actual = await evaluateCompiledExpression(compileExpression(source), compiledContext);
			expect(actual).toEqual(expected);
		});
	}
});

describe("compiled expression dependency hints", () => {
	it("classifies self property and static linked-file metadata dependencies", () => {
		const compiled = compileExpression('rating > 8 && file("Author").name');

		expect(compiled.dependencyHints).toEqual({
			candidateSelfProperties: ["rating"],
			usesSelfMetadata: false,
			usesSelfContent: false,
			staticLinkedFileTargets: ["Author"],
			usesDynamicLinkedFile: false,
			usesLinkedMetadata: true,
			usesLinkedContent: false,
			usesBases: false,
			volatility: [],
		});
	});

	it("marks dynamic linked-file content conservatively", () => {
		const compiled = compileExpression("file(target).content()");

		expect(compiled.dependencyHints.candidateSelfProperties).toEqual(["target"]);
		expect(compiled.dependencyHints.usesDynamicLinkedFile).toBe(true);
		expect(compiled.dependencyHints.usesLinkedMetadata).toBe(true);
		expect(compiled.dependencyHints.usesLinkedContent).toBe(true);
	});

	it("classifies self content, self metadata, and Bases dependencies", () => {
		const compiled = compileExpression("content + basename + length(bases)");

		expect(compiled.dependencyHints.usesSelfContent).toBe(true);
		expect(compiled.dependencyHints.usesSelfMetadata).toBe(true);
		expect(compiled.dependencyHints.usesBases).toBe(true);
	});

	it("classifies file.content as body content rather than a frontmatter property", () => {
		const compiled = compileExpression("file.content");

		expect(compiled.dependencyHints.candidateSelfProperties).toEqual([]);
		expect(compiled.dependencyHints.usesSelfContent).toBe(true);
		expect(compiled.dependencyHints.usesSelfMetadata).toBe(false);
	});

	it("classifies direct file metadata without adding a generic file dependency", () => {
		const compiled = compileExpression("file.basename");

		expect(compiled.dependencyHints.candidateSelfProperties).toEqual([]);
		expect(compiled.dependencyHints.usesSelfMetadata).toBe(true);
		expect(compiled.dependencyHints.usesSelfContent).toBe(false);
	});

	it("classifies file.bases as a Bases dependency", () => {
		const compiled = compileExpression("file.bases");

		expect(compiled.dependencyHints.usesBases).toBe(true);
		expect(compiled.dependencyHints.usesSelfMetadata).toBe(false);
	});

	it("classifies file.content() method form as content-only", () => {
		const compiled = compileExpression("file.content()");

		expect(compiled.dependencyHints.usesSelfContent).toBe(true);
		expect(compiled.dependencyHints.usesSelfMetadata).toBe(false);
	});

	it("classifies volatile functions", () => {
		const compiled = compileExpression(
			'today().format("YYYY") + now().format("HH") + random()',
		);

		expect(compiled.dependencyHints.volatility).toEqual(["now", "random", "today"]);
	});
});
