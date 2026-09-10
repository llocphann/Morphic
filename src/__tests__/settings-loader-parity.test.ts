import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../settings";
import { loadValidatedSettings } from "../settings-loader";

const validRules = {
	type: "group" as const,
	operator: "AND" as const,
	conditions: [{ type: "filter" as const, field: "rating", operator: ">=" as never, value: "4" }],
};

describe("settings recovery parity", () => {
	it("returns defaults without recovery metadata when no persisted data exists", () => {
		const result = loadValidatedSettings(null);
		expect(result.recovered).toBe(false);
		expect(result.settings).toEqual(DEFAULT_SETTINGS);
	});

	it("accepts numeric rules and Custom Views 0.4-compatible optional view fields", () => {
		const data = {
			enabled: true,
			workInLivePreview: true,
			workInCanvas: false,
			editableContent: true,
			allowJavaScript: false,
			views: [{
				id: "books",
				name: "Books",
				rules: {
					...validRules,
					conditions: [{ type: "filter", field: "rating", operator: "≥", value: "4" }],
				},
				basesFilters: { and: ['note["type"] == "book"'] },
				template: "<h1>{{file.basename}}</h1>",
				showNavigationBar: false,
			}],
		};

		const result = loadValidatedSettings(data);
		expect(result.recovered).toBe(false);
		expect(result.settings.views).toHaveLength(1);
		expect(result.settings.views[0].basesFilters).toEqual(data.views[0].basesFilters);
		expect(result.settings.views[0].showNavigationBar).toBe(false);
	});

	it("quarantines malformed or duplicate views instead of turning them into match-all views", () => {
		const good = {
			id: "safe",
			name: "Safe",
			rules: { type: "group", operator: "AND", conditions: [] },
			template: "ok",
		};
		const malformed = {
			id: "broken",
			name: "Broken",
			rules: { type: "group", operator: "AND", conditions: [{ type: "filter", field: "rating", operator: "???" }] },
			template: "must not match",
		};
		const source = {
			...DEFAULT_SETTINGS,
			views: [good, malformed, { ...good, name: "Duplicate" }],
		};

		const result = loadValidatedSettings(source);
		expect(result.recovered).toBe(true);
		expect(result.settings.views.map(view => view.id)).toEqual(["safe"]);
		expect((result.settings).recoveryData).toEqual(source);
	});

	it("preserves unknown top-level data for forward compatibility", () => {
		const result = loadValidatedSettings({
			...DEFAULT_SETTINGS,
			futureFlag: { enabled: true },
		});

		expect((result.settings as unknown as Record<string, unknown>).futureFlag).toEqual({ enabled: true });
	});
});
