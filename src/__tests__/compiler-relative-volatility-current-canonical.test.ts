import { describe, expect, it } from "vitest";
import {
	classifyCompiledExpression,
	classifyTemplateDependencies,
	compileExpression,
	compileTemplate,
} from "../compiler";

describe("compiled relative() volatility on current canonical", () => {
	it("marks date(...).relative() as now-volatile in raw expression hints", () => {
		const compiled = compileExpression('date("2026-01-01").relative()');

		expect(compiled.dependencyHints.volatility).toEqual(["now"]);
		expect(classifyCompiledExpression(compiled)).toEqual({
			dependencyClasses: ["now"],
			purity: "volatile",
		});
	});

	it("conservatively marks relative() volatile when the receiver type is runtime-dynamic", () => {
		const compiled = compileExpression("value.relative()");

		expect(compiled.dependencyHints.volatility).toEqual(["now"]);
		expect(classifyCompiledExpression(compiled)).toEqual({
			dependencyClasses: ["metadata-dependent", "now"],
			purity: "volatile",
		});
	});

	it("propagates relative() volatility through aggregate template hints", () => {
		const template = compileTemplate('{{date("2026-01-01").relative()}}');

		expect(template.dependencyHints.volatility).toEqual(["now"]);
		expect(classifyTemplateDependencies(template)).toEqual({
			dependencyClasses: ["now"],
			purity: "volatile",
		});
	});
});
