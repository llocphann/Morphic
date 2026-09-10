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
	return {
		app: {
			metadataCache: {
				getFirstLinkpathDest: vi.fn().mockReturnValue(null),
				getFileCache: vi.fn().mockReturnValue(null),
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
		view: "cards",
	},
] as unknown as NonNullable<ExprContext["bases"]>;

async function expectDifferentialParity(source: string, overrides: Partial<ExprContext> = {}): Promise<void> {
	const expected = await evaluateExpression(source, makeContext(overrides));
	const actual = await evaluateCompiledExpression(compileExpression(source), makeContext(overrides));
	expect(actual).toEqual(expected);
}

describe("compiled Bases leaf fast path on canonical", () => {
	it("matches legacy collection aliases for bases and baseViews", async () => {
		for (const source of [
			"bases.SourceAlias.name",
			"bases.KeyAlias.name",
			"baseViews.NameAlias.name",
			"bases.length",
		]) {
			await expectDifferentialParity(source, { bases });
		}
	});

	it("preserves variables and frontmatter shadowing before Bases built-ins", async () => {
		const overrides: Partial<ExprContext> = {
			bases,
			variables: { bases: "variable-bases" },
			frontmatter: {
				bases: "frontmatter-bases",
				baseViews: "frontmatter-views",
			},
		};

		expect(await evaluateCompiledExpression(compileExpression("bases"), makeContext(overrides)))
			.toBe("variable-bases");
		expect(await evaluateCompiledExpression(compileExpression("baseViews"), makeContext(overrides)))
			.toBe("frontmatter-views");
	});

	it("builds a fresh lookup collection without mutating ctx.bases", async () => {
		const input = [...bases] as NonNullable<ExprContext["bases"]>;
		expect(Object.prototype.hasOwnProperty.call(input, "SourceAlias")).toBe(false);

		expect(await evaluateCompiledExpression(
			compileExpression("bases.SourceAlias.name"),
			makeContext({ bases: input }),
		)).toBe("NameAlias");

		expect(Object.prototype.hasOwnProperty.call(input, "SourceAlias")).toBe(false);
	});

	it("does not re-enter the legacy evaluator for an unshadowed Bases identifier", async () => {
		let hasChecks = 0;
		const variables = new Proxy<Record<string, never>>({}, {
			has: () => {
				hasChecks++;
				if (hasChecks > 1) throw new Error("legacy evaluator re-entry");
				return false;
			},
		});

		const result = await evaluateCompiledExpression(
			compileExpression("bases"),
			makeContext({ bases, variables }),
		);

		expect(Array.isArray(result)).toBe(true);
		expect(hasChecks).toBe(1);
	});
});
