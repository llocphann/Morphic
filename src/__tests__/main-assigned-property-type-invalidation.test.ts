import type { App } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import {
	InvalidationEngine,
	allPropertyDataDependencyKey,
	dependencyKey,
	propertyDataDependencyKey,
} from "../core";
import { registerAssignedPropertyTypeInvalidation } from "../assigned-property-type-invalidation";

type PropertyTypeChangedCallback = (propertyName: string) => void;

describe("production assigned property-type invalidation", () => {
	it("invalidates exact and broad property-data owners without touching membership-only owners", () => {
		let changedCallback: PropertyTypeChangedCallback | undefined;
		const metadataTypeManager = {
			on: vi.fn((event: string, callback: PropertyTypeChangedCallback) => {
				expect(event).toBe("changed");
				changedCallback = callback;
			}),
			off: vi.fn(),
		};
		const app = { metadataTypeManager };
		const cleanups: Array<() => void> = [];
		const lifecycle = {
			register(callback: () => void) {
				cleanups.push(callback);
			},
		};

		const invalidated: string[] = [];
		const invalidation = new InvalidationEngine<string>((owner) => invalidated.push(owner));
		invalidation.commitDependencies("exact", [propertyDataDependencyKey("due-date")]);
		invalidation.commitDependencies("broad", [allPropertyDataDependencyKey()]);
		invalidation.commitDependencies("membership", [dependencyKey.index("property", "due-date")]);
		invalidation.commitDependencies("unrelated", [propertyDataDependencyKey("other")]);

		registerAssignedPropertyTypeInvalidation(
			lifecycle,
			app as unknown as App,
			invalidation,
		);

		expect(metadataTypeManager.on).toHaveBeenCalledTimes(1);
		expect(changedCallback).toBeTypeOf("function");
		expect(cleanups).toHaveLength(1);

		changedCallback?.("due-date");
		expect(invalidated).toEqual(["exact", "broad"]);

		changedCallback?.("");
		expect(invalidated).toEqual(["exact", "broad"]);

		cleanups[0]();
		expect(metadataTypeManager.off).toHaveBeenCalledTimes(1);
		expect(metadataTypeManager.off).toHaveBeenCalledWith("changed", changedCallback);
	});

	it("fails closed when Obsidian does not expose metadataTypeManager", () => {
		const register = vi.fn();
		const invalidation = new InvalidationEngine<string>(() => undefined);

		expect(() => {
			registerAssignedPropertyTypeInvalidation(
				{ register },
				{} as App,
				invalidation,
			);
		}).not.toThrow();
		expect(register).not.toHaveBeenCalled();
	});
});
