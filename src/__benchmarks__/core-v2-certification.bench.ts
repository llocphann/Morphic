import { bench, describe } from "vitest";
import {
	InvalidationEngine,
	RenderController,
	dependencyKey,
	type RenderTransaction,
} from "../core";
import {
	BOT3_P6_P7_CERT_WORKLOAD,
	buildDependencyOwnerPlans,
} from "../__tests__/support/bot3-p6-p7-cert-workloads";

/**
 * Core V2 certification microbenchmarks.
 *
 * These workloads mirror the deterministic P6/P7 correctness harness so wall-
 * clock measurements exercise the same owner counts, dependency fan-out and
 * navigation pressure that release tests assert. They are subsystem evidence,
 * not an end-to-end Obsidian speed claim and not a substitute for the required
 * apples-to-apples 0.3.2 qualification run inside Obsidian/Electron.
 */

describe("Core V2 dependency graph certification", () => {
	bench("64 owners: commit, replace, targeted invalidate, remove", () => {
		const engine = new InvalidationEngine<string>(() => undefined, {
			revisionCompactionSlack: 4,
		});
		const plans = buildDependencyOwnerPlans();

		for (const plan of plans) engine.commitDependencies(plan.owner, plan.initial);
		for (const plan of plans) engine.commitDependencies(plan.owner, plan.replacement);
		for (let shard = 0; shard < BOT3_P6_P7_CERT_WORKLOAD.dependencyShards; shard++) {
			engine.invalidate(dependencyKey.index("tag", `cert-shard-${shard}`));
		}
		for (const plan of plans) engine.remove(plan.owner);
	});

	bench("160 transient revisions: invalidate and compact around live owners", () => {
		const engine = new InvalidationEngine<string>(() => undefined, {
			revisionCompactionSlack: 4,
		});
		const plans = buildDependencyOwnerPlans();
		for (const plan of plans) engine.commitDependencies(plan.owner, plan.initial);

		for (let index = 0; index < BOT3_P6_P7_CERT_WORKLOAD.transientRevisionKeys; index++) {
			engine.invalidate(dependencyKey.file(`Certification/Transient-${index}.md`, "metadata"));
		}

		for (const plan of plans) engine.remove(plan.owner);
	});
});

describe("Core V2 render ownership certification", () => {
	bench("48 sequential owner generations commit and dispose", async () => {
		const controller = new RenderController<string>((_input, context): RenderTransaction => {
			context.scope.registerDisposer(() => undefined);
			return {
				commit() {
					// The benchmark measures generation/scope ownership overhead. DOM and
					// Obsidian renderer costs belong to end-to-end qualification.
				},
			};
		});

		for (let generation = 1; generation <= BOT3_P6_P7_CERT_WORKLOAD.navigationCommits; generation++) {
			const stateKey = `generation-${generation}`;
			await controller.render(stateKey, stateKey);
		}
		controller.dispose();
	});
});
