import { describe, expect, it } from "vitest";
import { compileFilterPipeline } from "../compiler/filter-pipeline";
import {
	applyCompiledFilterPipeline,
	applyFilterChain,
	type FilterValue,
} from "../filters";

describe("compileFilterPipeline", () => {
	it("compiles empty chains to an empty immutable step list", () => {
		expect(compileFilterPipeline("")).toEqual({ source: "", steps: [] });
		expect(compileFilterPipeline(null)).toEqual({ source: "", steps: [] });
	});

	it("splits simple pipe chains once", () => {
		const compiled = compileFilterPipeline("trim | upper");
		expect(compiled.steps).toEqual([
			{ name: "trim", args: [], source: "trim" },
			{ name: "upper", args: [], source: "upper" },
		]);
	});

	it("does not split pipes inside quoted arguments", () => {
		const compiled = compileFilterPipeline('replace:"a|b","c" | upper');
		expect(compiled.steps).toEqual([
			{ name: "replace", args: ["a|b", "c"], source: 'replace:"a|b","c"' },
			{ name: "upper", args: [], source: "upper" },
		]);
	});

	it("does not split commas inside quoted arguments", () => {
		const compiled = compileFilterPipeline('replace:"a,b","c,d"');
		expect(compiled.steps[0].args).toEqual(["a,b", "c,d"]);
	});

	it("converts numeric arguments using legacy cleanQuote semantics", () => {
		const compiled = compileFilterPipeline("slice:1,3");
		expect(compiled.steps[0].args).toEqual([1, 3]);
	});

	it("supports the legacy parenthesized argument form", () => {
		const compiled = compileFilterPipeline('replace:("old", "new")');
		expect(compiled.steps[0].args).toEqual(["old", "new"]);
	});

	it("preserves empty positional arguments as numeric zero like legacy parsing", () => {
		const compiled = compileFilterPipeline("slice:,2");
		expect(compiled.steps[0].args).toEqual([0, 2]);
	});

	it("keeps unknown filter names in the compiled representation", () => {
		const compiled = compileFilterPipeline("does_not_exist:1");
		expect(compiled.steps[0]).toEqual({
			name: "does_not_exist",
			args: [1],
			source: "does_not_exist:1",
		});
	});

	it("preserves legacy whitespace-before-colon lookup semantics", () => {
		const compiled = compileFilterPipeline("upper :ignored");
		expect(compiled.steps[0].name).toBe("upper ");
		expect(applyCompiledFilterPipeline("hello", compiled)).toBe("hello");
		expect(applyFilterChain("hello", "upper :ignored")).toBe("hello");
	});
});

describe("compiled filter execution parity", () => {
	const cases: Array<{ value: FilterValue; chain: string }> = [
		{ value: "  hello  ", chain: "trim | upper" },
		{ value: "a|b", chain: 'replace:"a|b","x" | upper' },
		{ value: "a,b", chain: 'replace:"a,b","c,d"' },
		{ value: "abcdef", chain: "slice:1,4 | upper" },
		{ value: 123.456, chain: "round:2" },
		{ value: "one,two,one", chain: 'split:"," | unique | join:";"' },
		{ value: "hello", chain: "does_not_exist:1 | upper" },
		{ value: "abcdef", chain: "slice:,2" },
	];

	for (const { value, chain } of cases) {
		it(`matches legacy execution for ${chain}`, () => {
			const compiled = compileFilterPipeline(chain);
			expect(applyCompiledFilterPipeline(value, compiled)).toEqual(applyFilterChain(value, chain));
		});
	}

	it("reuses one compiled pipeline across changing values", () => {
		const compiled = compileFilterPipeline("trim | upper");
		expect(applyCompiledFilterPipeline(" first ", compiled)).toBe("FIRST");
		expect(applyCompiledFilterPipeline(" second ", compiled)).toBe("SECOND");
		expect(compiled.steps).toHaveLength(2);
	});
});
