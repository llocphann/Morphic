import { describe, expect, it } from "vitest";
import { compileRetainedSimpleStructuralTemplate } from "../render/retained-production-simple-structural-owner";
import type { ViewConfig } from "../types";

function config(id: string, template: string): ViewConfig {
	return {
		id,
		name: id,
		rules: { type: "group", operator: "AND", conditions: [] },
		template,
	};
}

describe("retained simple structural owner self-content eligibility", () => {
	it("keeps sync conditional self-content on legacy authority", () => {
		const view = config(
			"sync-if-self-content",
			"<article>{% if content %}<span>On</span>{% else %}<span>Off</span>{% endif %}<b>Tail</b></article>",
		);

		expect(compileRetainedSimpleStructuralTemplate(view, false)).toBeNull();
	});

	it("keeps sync loop self-content on legacy authority", () => {
		const view = config(
			"sync-for-self-content",
			"<article>{% for item in content %}<span>{{ item }}</span>{% endfor %}<b>Tail</b></article>",
		);

		expect(compileRetainedSimpleStructuralTemplate(view, false)).toBeNull();
	});

	it("admits self-content only through a capability-supported mixed conditional", () => {
		const view = config(
			"mixed-if-self-content",
			"<article>{% if show %}<span>{{ title | markdown }}</span>{{ content }}{% else %}<b>Off</b>{% endif %}<footer>Tail</footer></article>",
		);

		const ir = compileRetainedSimpleStructuralTemplate(view, false);
		expect(ir).not.toBeNull();
		expect(ir?.dependencyHints.usesSelfContent).toBe(true);
	});

	it("keeps implicit linked metadata conditions on legacy runtime authority", () => {
		const view = config(
			"implicit-linked-condition",
			"<article>{% if friend.status %}<span>On</span>{% else %}<span>Off</span>{% endif %}</article>",
		);

		expect(compileRetainedSimpleStructuralTemplate(view, false)).toBeNull();
	});
});
