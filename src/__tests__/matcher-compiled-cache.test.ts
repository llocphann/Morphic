import type { App, TFile } from "obsidian";
import { beforeEach, describe, expect, it } from "vitest";
import { checkRules, clearCompiledRuleCache } from "../matcher";
import type { Filter, FilterGroup } from "../types";

function createFile(name: string): TFile {
	const basename = name.replace(/\.md$/, "");
	return {
		name,
		basename,
		path: name,
		extension: "md",
		parent: { path: "" },
		stat: { ctime: 1, mtime: 2, size: 3 },
	// eslint-disable-next-line obsidianmd/no-tfile-tfolder-cast
	} as unknown as TFile;
}

function createNameRule(value: string): FilterGroup {
	return {
		type: "group",
		operator: "AND",
		conditions: [{
			type: "filter",
			field: "file.name",
			operator: "is",
			value,
		}],
	};
}

describe("compiled matcher compatibility cache", () => {
	const app = {} as App;

	beforeEach(() => {
		clearCompiledRuleCache();
	});

	it("reuses compiled rule semantics across dynamic file inputs", () => {
		const group = createNameRule("alpha.md");

		expect(checkRules(app, group, createFile("alpha.md"))).toBe(true);
		expect(checkRules(app, group, createFile("beta.md"))).toBe(false);
	});

	it("recompiles when a filter is mutated in place", () => {
		const group = createNameRule("alpha.md");
		const filter = group.conditions[0] as Filter;
		const file = createFile("alpha.md");

		expect(checkRules(app, group, file)).toBe(true);
		filter.value = "beta.md";
		expect(checkRules(app, group, file)).toBe(false);
	});

	it("recompiles when group structure changes in place", () => {
		const group = createNameRule("alpha.md");
		const file = createFile("alpha.md");

		expect(checkRules(app, group, file)).toBe(true);
		group.conditions.push({
			type: "filter",
			field: "file.extension",
			operator: "is",
			value: "txt",
		});
		expect(checkRules(app, group, file)).toBe(false);
	});
});
