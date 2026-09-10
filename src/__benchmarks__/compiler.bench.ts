import { bench, describe, vi } from "vitest";
import { TFile } from "obsidian";
import type { App } from "obsidian";
import {
	compileExpression,
	compileFilterPipeline,
	compileRuleGroup,
	compileTemplate,
	evaluateCompiledExpression,
} from "../compiler";
import { evaluateExpression, type ExprContext } from "../expression";
import {
	applyCompiledFilterPipeline,
	applyFilterChain,
} from "../filters";
import { checkRules } from "../matcher";
import type { FilterGroup } from "../types";

/**
 * Compiler microbenchmarks.
 *
 * These cases are intentionally subsystem-level and MUST NOT be used as an
 * end-to-end Morphic speed claim. Release qualification owns independent
 * benchmark validation, environment capture, percentile reporting, and
 * apples-to-apples gates against the legacy release.
 */

function makeFile(overrides: Partial<TFile> = {}): TFile {
	const file = new TFile();
	Object.assign(file, {
		name: "test.md",
		basename: "test",
		path: "folder/test.md",
		extension: "md",
		stat: { size: 2048, ctime: 1_000_000, mtime: 2_000_000 },
		vault: {},
		...overrides,
	});
	return file;
}

function makeContext(): ExprContext {
	const file = makeFile();
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
		frontmatter: {
			rating: 9,
			title: "  Morphic Compiler  ",
			status: "active",
			category: "research",
			priority: "high",
			cast: ["Ada", "Grace", "Linus"],
		},
		bodyContent: "Body",
		variables: {},
	};
}

const COMPLEX_EXPRESSION = 'if(rating > 8 && status == "active", title.upper(), "fallback") | trim';
const context = makeContext();
const compiledExpression = compileExpression(COMPLEX_EXPRESSION);

const N_EXPRESSION_SOURCES = Array.from(
	{ length: 64 },
	(_, index) => `rating + ${index} > ${index} && status == "active"`,
);
const N_COMPILED_EXPRESSIONS = N_EXPRESSION_SOURCES.map((source) => compileExpression(source));

const FILTER_CHAIN = 'trim | replace:"Compiler","Core" | upper | slice:0,24';
const compiledFilter = compileFilterPipeline(FILTER_CHAIN);

const LOOP_TEMPLATE = [
	"{% set threshold = 8 %}",
	"{% for actor in cast %}",
	"{% if actor.rating > threshold %}",
	'<a href="{{actor.url}}">{{actor.name | upper}}</a>',
	"{% endif %}",
	"{% endfor %}",
].join("");
const LOOP_EXPRESSION_SOURCE = 'actor.rating > 8 && actor.name.upper()';
const compiledLoopExpression = compileExpression(LOOP_EXPRESSION_SOURCE);
const LOOP_CONTEXTS: ExprContext[] = Array.from({ length: 64 }, (_, index) => ({
	...context,
	variables: {
		actor: {
			name: `Actor ${index}`,
			rating: index % 11,
		},
	},
}));

const MATCHER_GROUP: FilterGroup = {
	type: "group",
	operator: "AND",
	conditions: [
		{ type: "filter", field: "status", operator: "is", value: "active" },
		{ type: "filter", field: "category", operator: "contains", value: "research" },
		{
			type: "group",
			operator: "OR",
			conditions: [
				{ type: "filter", field: "priority", operator: "is", value: "high" },
				{ type: "filter", field: "priority", operator: "is", value: "urgent" },
			],
		},
	],
};
const matcherFile = makeFile();
const matcherFrontmatter = {
	status: "active",
	category: "research-notes",
	priority: "high",
};
const matcherApp = context.app;
const compiledMatcher = compileRuleGroup(MATCHER_GROUP);

const linkedFile = makeFile({
	name: "Author.md",
	basename: "Author",
	path: "People/Author.md",
});
const crossFileContext: ExprContext = {
	...makeContext(),
	app: {
		metadataCache: {
			getFirstLinkpathDest: vi.fn().mockReturnValue(linkedFile),
			getFileCache: vi.fn().mockReturnValue({
				frontmatter: { rating: 10 },
				tags: [],
				links: [],
			}),
		},
		vault: {
			cachedRead: vi.fn().mockResolvedValue("---\nrating: 10\n---\nAuthor body"),
		},
	} as unknown as App,
};
const CROSS_FILE_SOURCE = 'file("People/Author").basename';
const compiledCrossFile = compileExpression(CROSS_FILE_SOURCE);

describe("compiler cold paths", () => {
	bench("expression: compile cold", () => {
		compileExpression(COMPLEX_EXPRESSION);
	});

	bench("filter pipeline: compile cold", () => {
		compileFilterPipeline(FILTER_CHAIN);
	});

	bench("template IR: compile cold with loop/if/set/filter", () => {
		compileTemplate(LOOP_TEMPLATE);
	});

	bench("matcher: compile cold nested group", () => {
		compileRuleGroup(MATCHER_GROUP);
	});

	bench("64 expressions: compile cold", () => {
		for (const source of N_EXPRESSION_SOURCES) compileExpression(source);
	});
});

describe("expression warm vs legacy parse+evaluate", () => {
	bench("legacy: parse + evaluate", async () => {
		await evaluateExpression(COMPLEX_EXPRESSION, context);
	});

	bench("compiled: warm evaluate", async () => {
		await evaluateCompiledExpression(compiledExpression, context);
	});

	bench("legacy: 64 parse + evaluate", async () => {
		for (const source of N_EXPRESSION_SOURCES) {
			await evaluateExpression(source, context);
		}
	});

	bench("compiled: 64 warm evaluate", async () => {
		for (const compiled of N_COMPILED_EXPRESSIONS) {
			await evaluateCompiledExpression(compiled, context);
		}
	});
});

describe("loop expression warm execution", () => {
	bench("legacy: 64 loop-item parse + evaluate", async () => {
		for (const loopContext of LOOP_CONTEXTS) {
			await evaluateExpression(LOOP_EXPRESSION_SOURCE, loopContext);
		}
	});

	bench("compiled: 64 loop-item warm evaluate", async () => {
		for (const loopContext of LOOP_CONTEXTS) {
			await evaluateCompiledExpression(compiledLoopExpression, loopContext);
		}
	});
});

describe("filter warm execution", () => {
	bench("legacy: parse + execute filter chain", () => {
		applyFilterChain("  Morphic Compiler  ", FILTER_CHAIN);
	});

	bench("compiled: execute pre-parsed filter chain", () => {
		applyCompiledFilterPipeline("  Morphic Compiler  ", compiledFilter);
	});
});

describe("matcher warm execution", () => {
	bench("production facade: cached checkRules", () => {
		checkRules(matcherApp, MATCHER_GROUP, matcherFile, matcherFrontmatter);
	});

	bench("compiled: direct reusable matcher", () => {
		compiledMatcher.matches(matcherApp, matcherFile, matcherFrontmatter);
	});
});

describe("cross-file expression warm execution", () => {
	bench("legacy: parse + evaluate cross-file", async () => {
		await evaluateExpression(CROSS_FILE_SOURCE, crossFileContext);
	});

	bench("compiled: warm evaluate cross-file", async () => {
		await evaluateCompiledExpression(compiledCrossFile, crossFileContext);
	});
});
