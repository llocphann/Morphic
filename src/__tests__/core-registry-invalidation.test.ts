import { describe, expect, it, vi } from "vitest";
import { RenderControllerRegistry } from "../core/controller-registry";
import { InvalidationEngine } from "../core/invalidation-engine";
import type { RenderTransaction } from "../core/render-controller";

interface Owner { id: string }

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

describe("Morphic controller registry", () => {
	it("creates independent controllers for independent view owners", async () => {
		const registry = new RenderControllerRegistry<Owner, string>(() => async (input) => ({
			commit() { void input; },
		}));
		const left = { id: "left" };
		const right = { id: "right" };

		const leftController = registry.getOrCreate(left);
		const rightController = registry.getOrCreate(right);
		expect(leftController).not.toBe(rightController);
		expect(registry.size).toBe(2);
		expect(Array.from(registry.owners())).toEqual([left, right]);

		registry.delete(left);
		expect(registry.size).toBe(1);
		expect(Array.from(registry.owners())).toEqual([right]);
		expect((await leftController.render("x", "x")).status).toBe("disposed");
	});

	it("lets two panes for the same file render independently", async () => {
		const commits: string[] = [];
		const leftDeferred = deferred<RenderTransaction>();
		const left = { id: "left" };
		const right = { id: "right" };
		const registry = new RenderControllerRegistry<Owner, string>((owner) => async () => {
			if (owner === left) return leftDeferred.promise;
			return { commit: () => { commits.push(owner.id); } };
		});

		const leftController = registry.getOrCreate(left);
		const rightController = registry.getOrCreate(right);
		const leftRender = leftController.render("same-file.md", "same-file.md::view");
		const rightRender = rightController.render("same-file.md", "same-file.md::view");

		expect((await rightRender).status).toBe("committed");
		expect(commits).toEqual(["right"]);
		expect(leftController.currentPendingKey).toBe("same-file.md::view");

		leftDeferred.resolve({ commit: () => { commits.push("left"); } });
		expect((await leftRender).status).toBe("committed");
		expect(commits).toEqual(["right", "left"]);
	});
});

describe("Morphic invalidation engine", () => {
	it("invalidates only owners that depend on a changed key", () => {
		const invalidate = vi.fn();
		const engine = new InvalidationEngine<Owner>(invalidate);
		const left = { id: "left" };
		const right = { id: "right" };
		engine.commitDependencies(left, ["file:A:frontmatter:rating"]);
		engine.commitDependencies(right, ["file:B:frontmatter:rating"]);

		const affected = engine.invalidate("file:A:frontmatter:rating");
		expect(affected).toEqual([left]);
		expect(invalidate).toHaveBeenCalledTimes(1);
		expect(invalidate).toHaveBeenCalledWith(left);
	});

	it("updates the dependency fingerprint when a dependency changes", () => {
		const engine = new InvalidationEngine<Owner>(() => undefined);
		const owner = { id: "view" };
		engine.commitDependencies(owner, ["a", "b"]);
		const before = engine.fingerprint(owner);
		engine.invalidate("b");
		const after = engine.fingerprint(owner);
		expect(after).not.toBe(before);
	});

	it("bounds transient revision churn while preserving active dependency state", () => {
		const invalidate = vi.fn();
		const engine = new InvalidationEngine<Owner>(invalidate, { revisionCompactionSlack: 2 });
		const owner = { id: "active" };
		engine.commitDependencies(owner, ["active-key"]);
		const fingerprintBefore = engine.fingerprint(owner);

		for (let index = 0; index < 32; index++) {
			engine.invalidate(`transient:${index}`);
		}

		expect(engine.fingerprint(owner)).toBe(fingerprintBefore);
		expect(engine.revisions.stats().trackedKeys).toBeLessThanOrEqual(3);
		expect(invalidate).not.toHaveBeenCalled();

		expect(engine.invalidate("active-key")).toEqual([owner]);
		expect(invalidate).toHaveBeenCalledTimes(1);
		expect(invalidate).toHaveBeenCalledWith(owner);
		expect(engine.fingerprint(owner)).not.toBe(fingerprintBefore);
	});
});
