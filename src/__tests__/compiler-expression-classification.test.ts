import { describe, expect, it } from "vitest";
import {
	classifyCompiledExpression,
	classifyCompiledViewDependencies,
	classifyExpressionDependencies,
	classifyRuleDependencies,
	classifyTemplateDependencies,
	compileExpression,
	compileRuleGroup,
	compileTemplate,
	compileView,
} from "../compiler";
import type { FilterGroup, ViewConfig } from "../types";

function emptyRules(): FilterGroup {
	return {
		type: "group",
		operator: "AND",
		conditions: [],
	};
}

function makeView(overrides: Partial<ViewConfig> = {}): ViewConfig {
	return {
		id: "view-classification",
		name: "Classification",
		rules: emptyRules(),
		template: "<p>Static</p>",
		...overrides,
	};
}

describe("compiled expression dependency classification", () => {
	it("classifies literal-only expressions as static", () => {
		expect(classifyCompiledExpression(compileExpression("1 + 2"))).toEqual({
			dependencyClasses: ["static"],
			purity: "static",
		});
	});

	it("groups self properties and file metadata into the metadata revision domain", () => {
		const classification = classifyCompiledExpression(compileExpression("rating + file.basename"));
		expect(classification).toEqual({
			dependencyClasses: ["metadata-dependent"],
			purity: "context-dependent",
		});
	});

	it("keeps self content distinct from metadata", () => {
		expect(classifyCompiledExpression(compileExpression("content"))).toEqual({
			dependencyClasses: ["content-dependent"],
			purity: "context-dependent",
		});
	});

	it("classifies static linked-file access without marking the target unknown", () => {
		const classification = classifyCompiledExpression(
			compileExpression('file("People/Ada").rating'),
		);
		expect(classification).toEqual({
			dependencyClasses: ["linked-file-dependent"],
			purity: "context-dependent",
		});
	});

	it("marks dynamic linked-file targets as runtime-unknown as well as linked", () => {
		const classification = classifyCompiledExpression(compileExpression("file(target).rating"));
		expect(classification).toEqual({
			dependencyClasses: [
				"metadata-dependent",
				"linked-file-dependent",
				"unknown-runtime-dynamic",
			],
			purity: "unknown",
		});
	});

	it("classifies Bases separately", () => {
		expect(classifyCompiledExpression(compileExpression("file.bases"))).toEqual({
			dependencyClasses: ["bases-dependent"],
			purity: "context-dependent",
		});
	});

	it("preserves deterministic volatility ordering and marks volatile purity", () => {
		const classification = classifyCompiledExpression(
			compileExpression("today() == today() || now() == now() || random() > 0"),
		);
		expect(classification).toEqual({
			dependencyClasses: ["today", "now", "random"],
			purity: "volatile",
		});
	});

	it("lets the view/compiler caller add settings and unknown runtime domains", () => {
		const hints = compileExpression("1").dependencyHints;
		expect(classifyExpressionDependencies(hints, { settingsDependent: true })).toEqual({
			dependencyClasses: ["settings-dependent"],
			purity: "context-dependent",
		});
		expect(classifyExpressionDependencies(hints, { unknownRuntimeDynamic: true })).toEqual({
			dependencyClasses: ["unknown-runtime-dynamic"],
			purity: "unknown",
		});
	});
});

describe("TemplateIR dependency classification", () => {
	it("classifies aggregate template hints without reparsing individual expressions", () => {
		const template = compileTemplate(
			"{% if status == 'active' %}{{file('People/Ada').rating}}{% endif %}{{content}}{{today()}}",
		);

		expect(classifyTemplateDependencies(template)).toEqual({
			dependencyClasses: [
				"metadata-dependent",
				"content-dependent",
				"linked-file-dependent",
				"today",
			],
			purity: "volatile",
		});
	});

	it("keeps static-only templates in the static class", () => {
		const template = compileTemplate("<p>Static</p>");
		expect(classifyTemplateDependencies(template)).toEqual({
			dependencyClasses: ["static"],
			purity: "static",
		});
	});
});

describe("compiled matcher dependency classification", () => {
	it("keeps an empty matcher static", () => {
		const matcher = compileRuleGroup(emptyRules());
		expect(classifyRuleDependencies(matcher.dependencies)).toEqual({
			dependencyClasses: ["static"],
			purity: "static",
		});
	});

	it("maps frontmatter/file matcher inputs to the metadata domain", () => {
		const matcher = compileRuleGroup({
			type: "group",
			operator: "AND",
			conditions: [
				{ type: "filter", field: "status", operator: "is", value: "active" },
				{ type: "filter", field: "file.mtime", operator: "after", value: "2026-01-01" },
			],
		});
		expect(classifyRuleDependencies(matcher.dependencies)).toEqual({
			dependencyClasses: ["metadata-dependent"],
			purity: "context-dependent",
		});
	});

	it("treats named link-resolution targets as linked-file dependencies", () => {
		const matcher = compileRuleGroup({
			type: "group",
			operator: "AND",
			conditions: [
				{ type: "filter", field: "file", operator: "links to", value: "People/Ada" },
			],
		});
		expect(classifyRuleDependencies(matcher.dependencies)).toEqual({
			dependencyClasses: ["metadata-dependent", "linked-file-dependent"],
			purity: "context-dependent",
		});
	});

	it("keeps generic outgoing-link matching in the linked-file revision domain", () => {
		const matcher = compileRuleGroup({
			type: "group",
			operator: "AND",
			conditions: [
				{ type: "filter", field: "file links", operator: "contains", value: "Ada" },
			],
		});
		expect(matcher.dependencies.staticLinkTargets).toEqual([]);
		expect(matcher.dependencies.usesOutgoingLinks).toBe(true);
		expect(classifyRuleDependencies(matcher.dependencies)).toEqual({
			dependencyClasses: ["metadata-dependent", "linked-file-dependent"],
			purity: "context-dependent",
		});
	});
});

describe("CompiledView dependency classification", () => {
	it("combines template and matcher domains and includes config/settings by default", () => {
		const compiled = compileView(makeView({
			template: "{{content}} {{today()}}",
			rules: {
				type: "group",
				operator: "AND",
				conditions: [
					{ type: "filter", field: "status", operator: "is", value: "active" },
				],
			},
		}), "config-1");

		expect(classifyCompiledViewDependencies(compiled)).toEqual({
			dependencyClasses: [
				"metadata-dependent",
				"content-dependent",
				"settings-dependent",
				"today",
			],
			purity: "volatile",
		});
	});

	it("allows external immutable config identity to own settings revision", () => {
		const compiled = compileView(makeView(), "immutable-config");
		expect(classifyCompiledViewDependencies(compiled)).toEqual({
			dependencyClasses: ["settings-dependent"],
			purity: "context-dependent",
		});
		expect(classifyCompiledViewDependencies(compiled, { settingsDependent: false })).toEqual({
			dependencyClasses: ["static"],
			purity: "static",
		});
	});

	it("preserves unknown-runtime safety from dynamic linked template targets", () => {
		const compiled = compileView(makeView({
			template: "{{file(target).rating}}",
		}), "config-dynamic");
		expect(classifyCompiledViewDependencies(compiled)).toEqual({
			dependencyClasses: [
				"metadata-dependent",
				"linked-file-dependent",
				"settings-dependent",
				"unknown-runtime-dynamic",
			],
			purity: "unknown",
		});
	});
});
