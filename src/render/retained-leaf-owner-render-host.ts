import type { RenderScope } from "../core/render-scope";
import type { RetainedCommitTransactionResult } from "./retained-commit-transaction";
import type {
	RetainedLeafOwnerGenerationMode,
	RetainedLeafOwnerGenerationPreparationResult,
	RetainedPreparedLeafOwnerGeneration,
} from "./retained-leaf-generation-coordinator";
import {
	RetainedLeafOwnerRegistry,
	type RetainedLeafOwnerRegistryOptions,
} from "./retained-leaf-owner-registry";
import {
	RetainedLeafOwnerScopeBridge,
	type RetainedPreparedLeafOwnerScope,
} from "./retained-leaf-owner-scope-bridge";
import type { RetainedLeafAsyncRequest } from "./retained-leaf-template-transaction";
import type { RetainedScalar } from "./retained-slot-runtime";
import type { RetainedTemplateIrLike } from "./retained-template-dom-plan";

type RenderScopeOwner = Pick<RenderScope, "isDisposed" | "registerDisposer">;

export type RetainedLeafOwnerRenderMode = RetainedLeafOwnerGenerationMode | "handoff";

export type RetainedLeafOwnerRenderPreparationStatus =
	| "prepared"
	| "stale"
	| "failed"
	| "disposed";

export interface RetainedLeafOwnerRenderTerminalResult {
	readonly status: Exclude<RetainedLeafOwnerRenderPreparationStatus, "prepared">;
	readonly generation: number;
	readonly error?: unknown;
}

export type RetainedLeafOwnerRenderCommitResult =
	| RetainedCommitTransactionResult
	| { readonly status: "unchanged" };

export interface RetainedPreparedLeafOwnerRender {
	readonly status: "prepared";
	readonly generation: number;
	readonly mode: RetainedLeafOwnerRenderMode;
	readonly structureKey: string;
	isCurrent(): boolean;
	commit(): RetainedLeafOwnerRenderCommitResult;
	dispose(): void;
}

export type RetainedLeafOwnerRenderPreparationResult =
	| RetainedPreparedLeafOwnerRender
	| RetainedLeafOwnerRenderTerminalResult;

export interface RetainedLeafOwnerRenderHostOptions<E> {
	createCoordinator?: RetainedLeafOwnerRegistryOptions<E>["createCoordinator"];
	onCleanupError?: (error: unknown) => void;
}

export class RetainedLeafOwnerRenderHostError extends Error {
	constructor(
		message: string,
		readonly code: "scope-handoff-lost" | "unexpected-commit-throw",
		readonly cause?: unknown,
	) {
		super(message);
		this.name = "RetainedLeafOwnerRenderHostError";
	}
}

class LeafCommitRejected extends Error {
	constructor(readonly result: RetainedCommitTransactionResult) {
		super(`Retained leaf owner commit returned ${result.status}`);
		this.name = "LeafCommitRejected";
	}
}

/**
 * Production-adjacent retained leaf owner orchestration.
 *
 * This host deliberately stops one layer before `main.ts`: it owns the retained
 * owner registry + RenderScope bridge, prepares leaf generations through the
 * retained coordinator, and exposes one terminal commit handle whose successful
 * path includes both the live retained transaction and cleanup-authority handoff.
 *
 * A coordinator-level `unchanged` result is still returned as a prepared
 * `handoff` generation. That no-DOM generation must transfer retained cleanup
 * ownership to the new RenderScope before the previous committed scope is torn
 * down; treating it as an ordinary early return would destroy retained state.
 */
export class RetainedLeafOwnerRenderHost<Owner extends object, E = unknown> {
	readonly registry: RetainedLeafOwnerRegistry<Owner, E>;
	readonly bridge: RetainedLeafOwnerScopeBridge<Owner, E>;

	constructor(options: RetainedLeafOwnerRenderHostOptions<E> = {}) {
		this.registry = new RetainedLeafOwnerRegistry<Owner, E>({
			createCoordinator: options.createCoordinator,
			onCleanupError: options.onCleanupError,
		});
		this.bridge = new RetainedLeafOwnerScopeBridge(this.registry, {
			onCleanupError: options.onCleanupError,
		});
	}

	get isDisposed(): boolean {
		return this.bridge.isDisposed;
	}

	get size(): number {
		return this.bridge.size;
	}

	async prepare(
		owner: Owner,
		root: HTMLElement,
		scope: RenderScopeOwner,
		generation: number,
		ir: RetainedTemplateIrLike<E>,
		values: ReadonlyMap<string, RetainedScalar>,
		islands: ReadonlyMap<string, RetainedLeafAsyncRequest>,
	): Promise<RetainedLeafOwnerRenderPreparationResult> {
		let binding: RetainedPreparedLeafOwnerScope<E>;
		try {
			const scoped = this.bridge.prepare(owner, root, scope, generation);
			if (scoped.status !== "prepared") return scoped;
			binding = scoped;
		} catch (error) {
			return { status: "failed", generation, error };
		}

		let leaf: RetainedLeafOwnerGenerationPreparationResult;
		try {
			leaf = await binding.coordinator.prepare(ir, values, islands);
		} catch (error) {
			return { status: "failed", generation, error };
		}

		if (!binding.isCurrent()) {
			if (leaf.status === "prepared") leaf.dispose();
			return { status: this.deadStatus(binding), generation };
		}

		if (leaf.status !== "prepared") {
			switch (leaf.status) {
				case "failed":
					return { status: "failed", generation, error: leaf.error };
				case "stale":
					return { status: "stale", generation };
				case "disposed":
					return { status: "disposed", generation };
				case "unchanged": {
					const structureKey = binding.coordinator.currentStructureKey;
					if (structureKey === null) {
						return {
							status: "failed",
							generation,
							error: new Error("Retained leaf owner reported unchanged without an active structure"),
						};
					}
					return this.preparedHandle(binding, generation, "handoff", structureKey, null);
				}
			}
		}

		return this.preparedHandle(
			binding,
			generation,
			leaf.mode,
			leaf.structureKey,
			leaf,
		);
	}

	release(owner: Owner): void {
		this.bridge.release(owner);
	}

	dispose(): void {
		this.bridge.dispose();
	}

	private preparedHandle(
		binding: RetainedPreparedLeafOwnerScope<E>,
		generation: number,
		mode: RetainedLeafOwnerRenderMode,
		structureKey: string,
		leaf: RetainedPreparedLeafOwnerGeneration | null,
	): RetainedPreparedLeafOwnerRender {
		let terminal = false;
		return {
			status: "prepared",
			generation,
			mode,
			structureKey,
			isCurrent: () => !terminal
				&& binding.isCurrent()
				&& (leaf?.isCurrent() ?? true),
			commit: () => {
				if (terminal) return { status: this.deadStatus(binding) };
				if (!binding.isCurrent() || (leaf && !leaf.isCurrent())) {
					terminal = true;
					leaf?.dispose();
					return { status: this.deadStatus(binding) };
				}

				let callbackEntered = false;
				const commitState: { result: RetainedCommitTransactionResult | null } = {
					result: null,
				};
				let handoff: ReturnType<RetainedPreparedLeafOwnerScope<E>["commitAfter"]>;
				try {
					handoff = binding.commitAfter(() => {
						callbackEntered = true;
						if (!leaf) return;
						commitState.result = leaf.commit(() => binding.isCurrent());
						if (commitState.result.status !== "committed") {
							throw new LeafCommitRejected(commitState.result);
						}
					});
				} catch (error) {
					terminal = true;
					if (error instanceof LeafCommitRejected) return error.result;
					if (!callbackEntered) {
						leaf?.dispose();
						return {
							status: "failed",
							error: new RetainedLeafOwnerRenderHostError(
								"Retained owner scope handoff failed before live commit",
								"unexpected-commit-throw",
								error,
							),
						};
					}
					return {
						status: "poisoned",
						error: new RetainedLeafOwnerRenderHostError(
							"Retained owner live commit threw outside the transactional result contract",
							"unexpected-commit-throw",
							error,
						),
					};
				}

				terminal = true;
				const leafResult = commitState.result;
				if (handoff === "transferred") {
					return leafResult ?? { status: "unchanged" };
				}

				if (leafResult?.status === "committed") {
					return {
						status: "poisoned",
						error: new RetainedLeafOwnerRenderHostError(
							`Retained live commit succeeded but cleanup handoff returned ${handoff}`,
							"scope-handoff-lost",
						),
					};
				}

				leaf?.dispose();
				return { status: handoff };
			},
			dispose: () => {
				if (terminal) return;
				terminal = true;
				leaf?.dispose();
			},
		};
	}

	private deadStatus(binding: RetainedPreparedLeafOwnerScope<E>): "stale" | "disposed" {
		return this.isDisposed
			|| this.registry.isDisposed
			|| binding.lease.isReleased
			|| binding.coordinator.isDisposed
			? "disposed"
			: "stale";
	}
}
