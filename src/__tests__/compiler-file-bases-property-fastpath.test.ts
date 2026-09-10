import { describe, expect, it, vi } from "vitest";
import type { App, TFile } from "obsidian";
import { evaluateExpression, type ExprContext, type ExprValue } from "../expression";
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

function makeContext(
	overrides: Partial<ExprContext> = {},
	getFileCache = vi.fn().mockReturnValue(null),
): ExprContext {
	return {
		app: {
			metadataCache: {
				getFirstLinkpathDest: vi.fn().mockReturnValue(null),
				getFileCache,
			},
			vault: { cachedRead: vi.fn().mockResolvedValue("") },
		} as unknown as App,
		file: makeMockFile(),
		frontmatter: {},
		bodyContent: "Body",
		variables: {},
		...overrides,
	};
}

const bases = [
	{
		source: { name: "SourceAlias" },
		key: "KeyAlias",
		name: "NameAlias",
		marker: "first",
	},
] as unknown as NonNullable<ExprContext["bases"]>;

async function expectParity(source: string, overrides: Partial<ExprContext>): Promise<void> {
	const expected = await evaluateExpression(source, makeContext(overrides));
	const actual = await evaluateCompiledExpression(compileExpression(source), makeContext(overrides));
	expect(actual).toEqual(expected);
}

describe("compiled current-file Bases property fast path", () => {
	it("matches legacy aliases for file.bases and file.baseViews", async () => {
		for (const source of [
			"file.bases.SourceAlias.marker",
			"file.bases.KeyAlias.marker",
			"file.baseViews.NameAlias.marker",
			"file.bases.length",
		]) {
			await expectParity(source, { bases });
		}
	});

	it("preserves variables and frontmatter shadowing of the file identifier", async () => {
		const variableFile = { bases: "variable-bases" } as unknown as ExprValue;
		await expectParity("file.bases", {
			bases,
			variables: { file: variableFile },
		});

		await expectParity("file.baseViews", {
			bases,
			frontmatter: { file: { baseViews: "frontmatter-views" } },
		});
	});

	it("keeps legacy file-property fallback when Bases context is absent", async () => {
		const getFileCache = vi.fn().mockReturnValue({
			frontmatter: { bases: "frontmatter-bases" },
		});
		const source = "file.bases";
		const expected = await evaluateExpression(source, makeContext({}, getFileCache));
		const actual = await evaluateCompiledExpression(compileExpression(source), makeContext({}, getFileCache));
		expect(actual).toEqual(expected);
		expect(actual).toBe("frontmatter-bases");
	});

	it("does not construct the rich self-file wrapper when Bases context is available", async () => {
		const getFileCache = vi.fn(() => {
			throw new Error("rich self-file construction");
		});
		const input = Object.freeze([...bases]) as NonNullable<ExprContext["bases"]>;
		const result = await evaluateCompiledExpression(
			compileExpression("file.bases.SourceAlias.marker"),
			makeContext({ bases: input }, getFileCache),
		);

		expect(result).toBe("first");
		expect(getFileCache).not.toHaveBeenCalled();
		expect(Object.isFrozen(input)).toBe(true);
		expect(input).toHaveLength(1);
	});
});
