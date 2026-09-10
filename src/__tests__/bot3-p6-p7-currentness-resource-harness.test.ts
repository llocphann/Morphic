import { describe, expect, it } from "vitest";
import { dependencyKey } from "../core/dependencies";
import { RevisionTrackingDependencyCollector } from "../core/dependency-read-set";
import { InvalidationEngine } from "../core/invalidation-engine";
import { RenderController, type RenderTransaction } from "../core/render-controller";
import {
	BOT3_P6_P7_CERT_WORKLOAD,
	buildCertificationTrace,
	buildDependencyOwnerPlans,
} from "./support/bot3-p6-p7-cert-workloads";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("Bot 3 P6/P7 currentness and resource certification harness", () => {
	it("rejects stale provisional read sets before adoption, then fans out only to committed current owners", () => {
		const invalidated: string[] = [];
		const engine = new InvalidationEngine<string>((owner) => invalidated.push(owner));
		const plans = buildDependencyOwnerPlans();
		const preparations = plans.map((plan) => {
			const collector = new RevisionTrackingDependencyCollector(engine.revisions);
			collector.trackMany(plan.initial);
			return { plan, readSet: collector.readSet() };
		});

		const staleShard = dependencyKey.index("tag", "cert-shard-0");
		expect(engine.invalidate(staleShard)).toEqual([]);
		expect(invalidated).toEqual([]);

		const stale = preparations.filter(({ readSet }) => !readSet.isCurrent());
		const current = preparations.filter(({ readSet }) => readSet.isCurrent());
		expect(stale.map(({ plan }) => plan.owner)).toEqual(
			plans.filter((_, index) => index % BOT3_P6_P7_CERT_WORKLOAD.dependencyShards === 0)
				.map((plan) => plan.owner),
		);
		expect(current).toHaveLength(
			BOT3_P6_P7_CERT_WORKLOAD.dependencyOwners -
				BOT3_P6_P7_CERT_WORKLOAD.dependencyOwners / BOT3_P6_P7_CERT_WORKLOAD.dependencyShards,
		);

		// Model the production pre-commit gate: only still-current frozen read sets
		// become reverse-index authority. The stale provisional shard never appears.
		for (const { plan, readSet } of current) engine.commitReadSet(plan.owner, readSet);
		expect(engine.index.affected(staleShard)).toEqual([]);
		expect(engine.index.stats()).toEqual({
			owners: current.length,
			dependencyKeys:
				1 + (BOT3_P6_P7_CERT_WORKLOAD.dependencyShards - 1) + current.length,
			edges: current.length * 3,
		});

		const activeShard = dependencyKey.index("tag", "cert-shard-1");
		const expectedAffected = plans
			.filter((_, index) => index % BOT3_P6_P7_CERT_WORKLOAD.dependencyShards === 1)
			.map((plan) => plan.owner);
		expect(engine.invalidate(activeShard)).toEqual(expectedAffected);
		expect(invalidated).toEqual(expectedAffected);
	});

	it("keeps dependency fan-out bounded across full owner replacement and removal", () => {
		const invalidated: string[] = [];
		const engine = new InvalidationEngine<string>((owner) => invalidated.push(owner), {
			revisionCompactionSlack: 4,
		});
		const plans = buildDependencyOwnerPlans();

		for (const plan of plans) engine.commitDependencies(plan.owner, plan.initial);
		expect(engine.index.stats()).toEqual({
			owners: BOT3_P6_P7_CERT_WORKLOAD.dependencyOwners,
			dependencyKeys:
				1 + BOT3_P6_P7_CERT_WORKLOAD.dependencyShards + BOT3_P6_P7_CERT_WORKLOAD.dependencyOwners,
			edges: BOT3_P6_P7_CERT_WORKLOAD.dependencyOwners * 3,
		});

		for (const plan of plans) engine.commitDependencies(plan.owner, plan.replacement);
		for (const plan of plans) {
			expect(engine.index.affected(plan.oldUnique)).toEqual([]);
			expect(engine.index.affected(plan.newUnique)).toEqual([plan.owner]);
		}

		const transientKeys = Array.from(
			{ length: BOT3_P6_P7_CERT_WORKLOAD.transientRevisionKeys },
			(_, index) => dependencyKey.file(`Certification/Transient-${index}.md`, "metadata"),
		);
		for (const key of transientKeys) engine.invalidate(key);
		expect(engine.revisions.trackedKeyCount()).toBeLessThanOrEqual(
			engine.index.dependencyKeyCount() + 4,
		);
		expect(invalidated).toEqual([]);

		const midpoint = BOT3_P6_P7_CERT_WORKLOAD.dependencyOwners / 2;
		for (let index = 0; index < midpoint; index++) engine.remove(plans[index].owner);
		expect(engine.index.stats()).toEqual({
			owners: midpoint,
			dependencyKeys: 1 + BOT3_P6_P7_CERT_WORKLOAD.dependencyShards + midpoint,
			edges: midpoint * 3,
		});

		for (let index = midpoint; index < plans.length; index++) engine.remove(plans[index].owner);
		expect(engine.index.stats()).toEqual({ owners: 0, dependencyKeys: 0, edges: 0 });
		expect(engine.revisions.trackedKeyCount()).toBeLessThanOrEqual(4);
	});

	it("keeps exactly one committed owner resource alive across a long navigation trace", async () => {
		const disposeCount = new Map<string, number>();
		const pending = deferred<RenderTransaction>();
		const controller = new RenderController<string>((input, context) => {
			context.scope.registerDisposer(() => {
				disposeCount.set(input, (disposeCount.get(input) ?? 0) + 1);
			});
			if (input === "stale-candidate") return pending.promise;
			return { commit() { /* resource authority is represented by the active scope */ } };
		});

		for (let generation = 1; generation <= BOT3_P6_P7_CERT_WORKLOAD.navigationCommits; generation++) {
			const key = `generation-${generation}`;
			expect((await controller.render(key, key)).status).toBe("committed");
			if (generation > 1) {
				expect(disposeCount.get(`generation-${generation - 1}`)).toBe(1);
			}
			expect(disposeCount.get(key)).toBeUndefined();
		}

		const stale = controller.render("stale-candidate", "stale-candidate");
		const newest = controller.render("authoritative-final", "authoritative-final");
		expect((await newest).status).toBe("committed");
		expect(disposeCount.get("stale-candidate")).toBe(1);
		expect(disposeCount.get(`generation-${BOT3_P6_P7_CERT_WORKLOAD.navigationCommits}`)).toBe(1);

		pending.resolve({ commit() { throw new Error("stale candidate must never commit"); } });
		expect((await stale).status).toBe("stale");
		expect(disposeCount.get("stale-candidate")).toBe(1);
		expect(disposeCount.get("authoritative-final")).toBeUndefined();

		controller.dispose();
		expect(disposeCount.get("authoritative-final")).toBe(1);
		for (const count of disposeCount.values()) expect(count).toBe(1);
	});

	it("locks a deterministic operation trace for later wall-clock and memory runners", () => {
		const first = buildCertificationTrace();
		const second = buildCertificationTrace();
		expect(second).toEqual(first);
		expect(first.filter((operation) => operation.kind === "snapshot-read")).toHaveLength(
			BOT3_P6_P7_CERT_WORKLOAD.snapshotPaths * 2,
		);
		expect(first.filter((operation) => operation.kind === "snapshot-clear")).toHaveLength(
			BOT3_P6_P7_CERT_WORKLOAD.snapshotPaths / 4,
		);
		expect(first.filter((operation) => operation.kind === "navigate")).toHaveLength(
			BOT3_P6_P7_CERT_WORKLOAD.navigationCommits,
		);
		expect(first.filter((operation) => operation.kind === "canvas-dirty")).toHaveLength(
			BOT3_P6_P7_CERT_WORKLOAD.canvasNodes * BOT3_P6_P7_CERT_WORKLOAD.canvasBurstSize,
		);
	});
});
