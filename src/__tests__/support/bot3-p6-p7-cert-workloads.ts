import { dependencyKey, type DependencyKey } from "../../core/dependencies";

export const BOT3_P6_P7_CERT_WORKLOAD = Object.freeze({
	dependencyOwners: 64,
	dependencyShards: 8,
	navigationCommits: 48,
	canvasNodes: 48,
	canvasBurstSize: 4,
	snapshotPaths: 32,
	snapshotMetadataCacheLimit: 12,
	snapshotBodyCacheLimit: 8,
	transientRevisionKeys: 160,
});

export interface DependencyOwnerPlan {
	readonly owner: string;
	readonly initial: readonly DependencyKey[];
	readonly replacement: readonly DependencyKey[];
	readonly oldUnique: DependencyKey;
	readonly newUnique: DependencyKey;
}

export function buildDependencyOwnerPlans(): readonly DependencyOwnerPlan[] {
	const result: DependencyOwnerPlan[] = [];
	for (let index = 0; index < BOT3_P6_P7_CERT_WORKLOAD.dependencyOwners; index++) {
		const shard = dependencyKey.index("tag", `cert-shard-${index % BOT3_P6_P7_CERT_WORKLOAD.dependencyShards}`);
		const oldUnique = dependencyKey.file(`Certification/Owner-${index}.md`, "metadata");
		const newUnique = dependencyKey.file(`Certification/Owner-${index}.md`, "content");
		result.push(Object.freeze({
			owner: `owner-${index}`,
			initial: Object.freeze([dependencyKey.settings(), shard, oldUnique]),
			replacement: Object.freeze([dependencyKey.settings(), shard, newUnique]),
			oldUnique,
			newUnique,
		}));
	}
	return Object.freeze(result);
}

export type CertificationTraceOperation =
	| Readonly<{ kind: "snapshot-read"; path: string; revision: number }>
	| Readonly<{ kind: "snapshot-clear"; path: string }>
	| Readonly<{ kind: "navigate"; owner: string; generation: number }>
	| Readonly<{ kind: "canvas-dirty"; node: string; generation: number }>;

/**
 * Stable, synthetic operation trace shared by correctness tests now and later
 * wall-clock/memory runners after the P5 production authority gate closes.
 * This function deliberately contains no clock reads, randomness, or heap probes.
 */
export function buildCertificationTrace(): readonly CertificationTraceOperation[] {
	const trace: CertificationTraceOperation[] = [];
	for (let index = 0; index < BOT3_P6_P7_CERT_WORKLOAD.snapshotPaths; index++) {
		const path = `Certification/Snapshot-${index}.md`;
		trace.push(Object.freeze({ kind: "snapshot-read", path, revision: 1 }));
		if (index % 4 === 0) trace.push(Object.freeze({ kind: "snapshot-clear", path }));
		trace.push(Object.freeze({ kind: "snapshot-read", path, revision: 2 }));
	}
	for (let generation = 1; generation <= BOT3_P6_P7_CERT_WORKLOAD.navigationCommits; generation++) {
		trace.push(Object.freeze({ kind: "navigate", owner: `pane-${generation % 4}`, generation }));
	}
	for (let node = 0; node < BOT3_P6_P7_CERT_WORKLOAD.canvasNodes; node++) {
		for (let generation = 1; generation <= BOT3_P6_P7_CERT_WORKLOAD.canvasBurstSize; generation++) {
			trace.push(Object.freeze({ kind: "canvas-dirty", node: `canvas-${node}`, generation }));
		}
	}
	return Object.freeze(trace);
}
