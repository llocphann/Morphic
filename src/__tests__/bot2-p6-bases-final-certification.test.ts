import { Component, TFile } from "obsidian";
import type { App } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import {
	compileExpression,
	evaluateCompiledExpression,
} from "../compiler";
import type { BasesDataProvider, TemplateBases } from "../bases/types";
import { type ExprContext, type ExprValue } from "../expression";
import { renderTemplate } from "../renderer";

function makeFile(path = "Dashboards/Current.md"): TFile {
	const file = new TFile();
	const name = path.slice(path.lastIndexOf("/") + 1);
	Object.assign(file, {
		name,
		basename: name.replace(/\.md$/i, ""),
		path,
		extension: "md",
		parent: { path: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "" },
		stat: { size: 10, ctime: 100, mtime: 200 },
	});
	return file;
}

function makeBases(): TemplateBases {
	return [{
		key: "KeyAlias",
		name: "NameAlias",
		type: "table",
		index: 0,
		source: {
			kind: "code-block",
			index: 0,
			line: 1,
			name: "SourceAlias",
		},
		columns: [],
		rows: [],
		rowCount: 2,
	}];
}

function makeApp(options: {
	currentFile?: TFile;
	currentFrontmatter?: Record<string, unknown>;
	linkedFile?: TFile;
	linkedFrontmatter?: Record<string, unknown>;
} = {}): App {
	const currentFile = options.currentFile ?? makeFile();
	const linkedFile = options.linkedFile ?? makeFile("People/Linked.md");
	return {
		metadataCache: {
			getFileCache: vi.fn((file: TFile) => {
				if (file.path === currentFile.path) {
					return { frontmatter: options.currentFrontmatter ?? {} };
				}
				if (file.path === linkedFile.path) {
					return { frontmatter: options.linkedFrontmatter ?? {} };
				}
				return null;
			}),
			getFirstLinkpathDest: vi.fn((target: string) => target === "Linked" ? linkedFile : null),
		},
		vault: {
			cachedRead: vi.fn(async () => ""),
		},
	} as unknown as App;
}

function makeContext(options: {
	frontmatter?: Record<string, unknown>;
	variables?: Record<string, ExprValue>;
	bases?: NonNullable<ExprContext["bases"]>;
	linkedFrontmatter?: Record<string, unknown>;
} = {}): ExprContext {
	const file = makeFile();
	return {
		app: makeApp({
			currentFile: file,
			currentFrontmatter: options.frontmatter,
			linkedFrontmatter: options.linkedFrontmatter,
		}),
		file,
		frontmatter: options.frontmatter ?? {},
		bodyContent: "Current body",
		variables: options.variables ?? {},
		...(options.bases ? { bases: options.bases } : {}),
	};
}

function asExpressionBases(bases: TemplateBases): NonNullable<ExprContext["bases"]> {
	return bases;
}

async function compiled(source: string, context: ExprContext): Promise<ExprValue> {
	return evaluateCompiledExpression(compileExpression(source), context);
}

const BASE_SOURCE = [
	"```base",
	"views:",
	"  - type: table",
	"    name: Rows",
	"```",
].join("\n");

describe("Bot 2 P6 final Bases certification preparation", () => {
	it("binds one production provider result to bare and current-file Bases aliases", async () => {
		const file = makeFile();
		const app = makeApp({ currentFile: file });
		const container = window.document.createElement("div");
		const bases = makeBases();
		const input = Object.freeze([...bases]) as unknown as TemplateBases;
		const getEmbeddedBases = vi.fn().mockResolvedValue(input);
		const provider: BasesDataProvider = { getEmbeddedBases };

		await renderTemplate(
			app,
			[
				"<span>{{bases.SourceAlias.rowCount}}</span>",
				"<span>{{baseViews.KeyAlias.name}}</span>",
				"<span>{{file.bases.NameAlias.rowCount}}</span>",
				"<span>{{file.baseViews.SourceAlias.name}}</span>",
			].join("|"),
			file,
			container,
			new Component(),
			false,
			undefined,
			undefined,
			false,
			BASE_SOURCE,
			provider,
		);

		expect(container.textContent).toBe("2|NameAlias|2|NameAlias");
		expect(getEmbeddedBases).toHaveBeenCalledOnce();
		expect(getEmbeddedBases.mock.calls[0][0]).toMatchObject({
			file,
			sourceContent: BASE_SOURCE,
			ownerDocument: container.ownerDocument,
		});
		expect(Object.prototype.hasOwnProperty.call(input, "SourceAlias")).toBe(false);
		expect(Object.isFrozen(input)).toBe(true);
	});

	it("preserves variables then frontmatter then built-in precedence", async () => {
		const bases = asExpressionBases(makeBases());
		const context = makeContext({
			bases,
			variables: { bases: "variable-bases" },
			frontmatter: {
				bases: "frontmatter-bases",
				baseViews: "frontmatter-views",
			},
		});

		expect(await compiled("bases", context)).toBe("variable-bases");
		expect(await compiled("baseViews", context)).toBe("frontmatter-views");
		expect(await compiled("file.bases.SourceAlias.rowCount", context)).toBe(2);
		expect(await compiled("file.baseViews.KeyAlias.name", context)).toBe("NameAlias");

		const variableFile = makeContext({
			bases,
			variables: { file: { bases: "variable-file-bases" } },
		});
		expect(await compiled("file.bases", variableFile)).toBe("variable-file-bases");

		const frontmatterFile = makeContext({
			bases,
			frontmatter: { file: { baseViews: "frontmatter-file-views" } },
		});
		expect(await compiled("file.baseViews", frontmatterFile)).toBe("frontmatter-file-views");
	});

	it("keeps missing Bases context on the legacy/frontmatter fallback path", async () => {
		const context = makeContext({
			frontmatter: {
				bases: "frontmatter-bases",
				baseViews: "frontmatter-views",
			},
		});

		expect(await compiled("bases", context)).toBe("frontmatter-bases");
		expect(await compiled("baseViews", context)).toBe("frontmatter-views");
		expect(await compiled("file.bases", context)).toBe("frontmatter-bases");
		expect(await compiled("file.baseViews", context)).toBe("frontmatter-views");
	});

	it("does not leak current-file Bases into linked-file wrappers", async () => {
		const bases = asExpressionBases(makeBases());
		const context = makeContext({
			bases,
			linkedFrontmatter: {
				bases: "linked-frontmatter-bases",
				baseViews: "linked-frontmatter-views",
			},
		});

		expect(await compiled("file.bases.SourceAlias.rowCount", context)).toBe(2);
		expect(await compiled('file("Linked").bases', context)).toBe("linked-frontmatter-bases");
		expect(await compiled('file("Linked").baseViews', context)).toBe("linked-frontmatter-views");
		expect(context.app.metadataCache.getFirstLinkpathDest).toHaveBeenCalledWith("Linked", context.file.path);
	});

	it("materializes empty built-in Bases in production when no Base source exists", async () => {
		const file = makeFile();
		const app = makeApp({
			currentFile: file,
			currentFrontmatter: {
				bases: "frontmatter-bases",
				baseViews: "frontmatter-views",
			},
		});
		const container = window.document.createElement("div");
		const getEmbeddedBases = vi.fn().mockResolvedValue(makeBases());
		const provider: BasesDataProvider = { getEmbeddedBases };

		await renderTemplate(
			app,
			"<p>{{bases}}|{{baseViews}}</p>",
			file,
			container,
			new Component(),
			false,
			undefined,
			undefined,
			false,
			"# No embedded Base source",
			provider,
		);

		expect(container.textContent).toBe("|");
		expect(getEmbeddedBases).not.toHaveBeenCalled();
	});
});
