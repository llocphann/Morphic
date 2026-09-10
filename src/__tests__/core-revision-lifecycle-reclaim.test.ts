import { describe, expect, it, vi } from "vitest";
import { InvalidationEngine } from "../core/invalidation-engine";

describe("revision reclamation on owner lifecycle", () => {
	it("reclaims orphaned revisions immediately after final owner removal", () => {
		const invalidate = vi.fn();
		const engine = new InvalidationEngine<string>(invalidate, {
			revisionCompactionSlack: 0,
		});

		engine.commitDependencies("owner", ["owned-key"]);
		engine.invalidate("owned-key");
		const previousRevision = engine.revisions.current("owned-key");
		expect(engine.revisions.stats()).toEqual({ trackedKeys: 1 });

		invalidate.mockClear();
		engine.remove("owner");

		expect(engine.index.stats()).toEqual({ owners: 0, dependencyKeys: 0, edges: 0 });
		expect(engine.revisions.stats()).toEqual({ trackedKeys: 0 });
		expect(engine.revisions.current("owned-key")).toBeGreaterThan(previousRevision);
		expect(invalidate).not.toHaveBeenCalled();
	});

	it("reclaims only abandoned revisions after dependency replacement", () => {
		const invalidate = vi.fn();
		const engine = new InvalidationEngine<string>(invalidate, {
			revisionCompactionSlack: 0,
		});

		engine.commitDependencies("owner", ["old-key", "kept-key"]);
		engine.invalidateMany(["old-key", "kept-key"]);
		const oldRevision = engine.revisions.current("old-key");
		const keptRevision = engine.revisions.current("kept-key");
		const keptFingerprint = engine.revisions.fingerprint(["kept-key"]);

		invalidate.mockClear();
		engine.commitDependencies("owner", ["kept-key"]);

		expect(engine.revisions.stats()).toEqual({ trackedKeys: 1 });
		expect(engine.revisions.current("old-key")).toBeGreaterThan(oldRevision);
		expect(engine.revisions.current("kept-key")).toBe(keptRevision);
		expect(engine.revisions.fingerprint(["kept-key"])).toBe(keptFingerprint);
		expect(engine.index.dependenciesOf("owner")).toEqual(new Set(["kept-key"]));
		expect(invalidate).not.toHaveBeenCalled();
	});

	it("stays bounded during repeated replace/remove lifecycle churn without data events", () => {
		const invalidate = vi.fn();
		const engine = new InvalidationEngine<string>(invalidate, {
			revisionCompactionSlack: 4,
		});

		for (let index = 0; index < 200; index++) {
			const transient = `transient-${index}`;
			engine.commitDependencies("owner", ["kept", transient]);
			engine.invalidate(transient);
			invalidate.mockClear();
			engine.commitDependencies("owner", ["kept"]);
		}

		expect(engine.revisions.stats().trackedKeys).toBeLessThanOrEqual(5);
		expect(engine.index.dependenciesOf("owner")).toEqual(new Set(["kept"]));
		expect(invalidate).not.toHaveBeenCalled();

		engine.remove("owner");
		expect(engine.revisions.stats().trackedKeys).toBeLessThanOrEqual(4);
	});
});
