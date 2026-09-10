import { describe, expect, it } from "vitest";
import mainSource from "../main.ts?raw";
import {
	collectBaseQueryDependencies,
	dependencyKey,
	TimeDependencyPolicy,
} from "../core";

describe("Bot 5 production Bases wall-clock freshness", () => {
	it("derives exact now/today dependencies and exact next semantic boundaries", () => {
		const dependencies = collectBaseQueryDependencies({
			filters: {
				and: ["now() >= today()", "note.status == 'open'"],
			},
		});
		expect(dependencies).toContain(dependencyKey.time("now"));
		expect(dependencies).toContain(dependencyKey.time("today"));

		const minute = new TimeDependencyPolicy({ nowResolutionMs: 60_000 });
		const at = new Date(2026, 8, 1, 12, 34, 45, 123).getTime();
		expect(minute.nextBoundary("now", at)).toBe(
			new Date(2026, 8, 1, 12, 35, 0, 0).getTime(),
		);
		expect(minute.nextBoundary("today", at)).toBe(
			new Date(2026, 8, 2, 0, 0, 0, 0).getTime(),
		);
	});

	it("wires the existing time-dependency policy into production instead of leaving time keys eventless", () => {
		// The Core policy intentionally owns no timer. Production must consume it and
		// schedule only the next semantic boundary while a committed owner depends on
		// time:now/time:today. This sentinel is intentionally narrow: it does not
		// prescribe helper names, but it prevents the static dependency vocabulary
		// from remaining disconnected from the production lifecycle.
		expect(mainSource).toContain("TimeDependencyPolicy");
		expect(mainSource).toContain("nextBoundary(");
		expect(mainSource).not.toContain("setInterval(");
	});
});
