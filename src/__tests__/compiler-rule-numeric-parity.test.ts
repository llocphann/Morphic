import { describe, expect, it, vi } from "vitest";
import type { App, TFile } from "obsidian";
import { compileRuleGroup } from "../compiler/rule-compiler";
import type { FilterGroup, FilterOperator } from "../types";

function makeMockFile(): TFile {
	return {
		name: "test.md",
		basename: "test",
		path: "folder/test.md",
		extension: "md",
		parent: { path: "folder" },
		stat: { size: 1234, ctime: 1000000, mtime: 2000000 },
		vault: {},
		// eslint-disable-next-line obsidianmd/no-tfile-tfolder-cast
	} as unknown as TFile;
}

function makeMockApp(): App {
	return {
		metadataCache: {
			getFirstLinkpathDest: vi.fn().mockReturnValue(null),
			getFileCache: vi.fn().mockReturnValue(null),
		},
	} as unknown as App;
}

function matches(
	field: string,
	operator: FilterOperator,
	value: string,
	frontmatter: Record<string, unknown> = {},
): boolean {
	const group: FilterGroup = {
		type: "group",
		operator: "AND",
		conditions: [{ type: "filter", field, operator, value }],
	};
	return compileRuleGroup(group).matches(
		makeMockApp(),
		makeMockFile(),
		frontmatter,
	);
}

describe("compiled numeric rule parity", () => {
	it("supports all numeric comparison symbols exposed by the settings UI", () => {
		const frontmatter = { rating: 10 };

		expect(matches("rating", "=", "10", frontmatter)).toBe(true);
		expect(matches("rating", "≠", "9", frontmatter)).toBe(true);
		expect(matches("rating", "<", "11", frontmatter)).toBe(true);
		expect(matches("rating", "≤", "10", frontmatter)).toBe(true);
		expect(matches("rating", ">", "9", frontmatter)).toBe(true);
		expect(matches("rating", "≥", "10", frontmatter)).toBe(true);
	});

	it("accepts finite numeric strings with the same semantics as Custom Views 0.4", () => {
		expect(matches("rating", ">", "10", { rating: "10.5" })).toBe(true);
		expect(matches("rating", "=", "-2.25", { rating: "-2.25" })).toBe(true);
	});

	it("rejects blank, boolean, array, and non-finite operands instead of coercing them", () => {
		expect(matches("rating", "=", "0", { rating: "" })).toBe(false);
		expect(matches("rating", "=", "0", { rating: "   " })).toBe(false);
		expect(matches("rating", "=", "1", { rating: true })).toBe(false);
		expect(matches("rating", "=", "10", { rating: ["10"] })).toBe(false);
		expect(matches("rating", ">", "0", { rating: "Infinity" })).toBe(false);
		expect(matches("rating", "=", "", { rating: 0 })).toBe(false);
		expect(matches("rating", "=", "not-a-number", { rating: 0 })).toBe(false);
	});

	it("applies numeric comparisons to built-in numeric file fields", () => {
		expect(matches("file.size", "=", "1234")).toBe(true);
		expect(matches("file.size", ">", "1200")).toBe(true);
		expect(matches("file.size", "<", "1200")).toBe(false);
	});
});
