import { describe, expect, it } from "vitest";
import { compileExpression, compileTemplate } from "../compiler";

describe("compiler dependency scope", () => {
	it("keeps value loop and index as ordinary top-level frontmatter candidates", () => {
		const compiled = compileExpression("value + loop + index");
		expect(compiled.dependencyHints.candidateSelfProperties).toEqual([
			"index",
			"loop",
			"value",
		]);
	});

	it("filters only real legacy loop locals inside for bodies", () => {
		const template = compileTemplate(
			"{% for item in items %}{{item}} {{loop.index}} {{index}}{% endfor %}",
		);
		expect(template.dependencyHints.candidateSelfProperties).toEqual([
			"index",
			"items",
		]);
	});

	it("filters set variables without hiding same-named ordinary properties elsewhere", () => {
		const template = compileTemplate(
			"{% set value = rating %}{{value}} {{index}}",
		);
		expect(template.dependencyHints.candidateSelfProperties).toEqual([
			"index",
			"rating",
		]);
	});
});