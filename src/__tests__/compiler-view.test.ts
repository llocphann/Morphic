import { describe, expect, it } from "vitest";
import { compileView } from "../compiler/view-compiler";
import type { FilterGroup, ViewConfig } from "../types";

function makeView(overrides: Partial<ViewConfig> = {}): ViewConfig {
	return {
		id: "view-1",
		name: "Example",
		rules: {
			type: "group",
			operator: "AND",
			conditions: [
				{ type: "filter", field: "status", operator: "is", value: "active" },
			],
		},
		template: "<p>{{title}}</p>",
		...overrides,
	};
}

describe("compileView", () => {
	it("assembles template and matcher into one immutable handoff shape", () => {
		const compiled = compileView(makeView(), 7);
		expect(compiled.viewId).toBe("view-1");
		expect(compiled.configRevision).toBe(7);
		expect(compiled.template.nodes.some((node) => node.kind === "text-slot")).toBe(true);
		expect(compiled.matcher.source.conditions).toHaveLength(1);
		expect(compiled.matcherId).toMatch(/^rules-fnv1a-[0-9a-f]{8}$/);
	});

	it("exposes template and matcher dependency hints together", () => {
		const compiled = compileView(makeView({
			template: "{{title}} {{file.basename}}",
		}), "settings-12");
		expect(compiled.dependencyHints.template.candidateSelfProperties).toEqual(["title"]);
		expect(compiled.dependencyHints.template.usesSelfMetadata).toBe(true);
		expect(compiled.dependencyHints.matcher.frontmatterFields).toEqual(["status"]);
	});

	it("produces stable matcher ids for semantically identical object key ordering", () => {
		const firstRules: FilterGroup = {
			type: "group",
			operator: "AND",
			conditions: [{ type: "filter", field: "rating", operator: "is", value: "5" }],
		};
		const secondRules = {
			conditions: [{ value: "5", operator: "is", field: "rating", type: "filter" }],
			operator: "AND",
			type: "group",
		} as FilterGroup;
		const first = compileView(makeView({ rules: firstRules }), 1);
		const second = compileView(makeView({ rules: secondRules }), 1);
		expect(first.matcherId).toBe(second.matcherId);
	});

	it("changes matcher identity when rule configuration changes", () => {
		const first = compileView(makeView(), 1);
		const changed = compileView(makeView({
			rules: {
				type: "group",
				operator: "AND",
				conditions: [
					{ type: "filter", field: "status", operator: "is", value: "archived" },
				],
			},
		}), 2);
		expect(first.matcherId).not.toBe(changed.matcherId);
	});

	it("keeps config revision explicit instead of inferring lifecycle ownership", () => {
		const config = makeView();
		const first = compileView(config, "rev-a");
		const second = compileView(config, "rev-b");
		expect(first.template.sourceHash).toBe(second.template.sourceHash);
		expect(first.matcherId).toBe(second.matcherId);
		expect(first.configRevision).not.toBe(second.configRevision);
	});
});
