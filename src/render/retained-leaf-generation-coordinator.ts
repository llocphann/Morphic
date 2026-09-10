import {
	RetainedCommitTransaction,
	type RetainedCommitParticipant,
	type RetainedCommitTransactionResult,
} from "./retained-commit-transaction";
import {
	RetainedDetachedGenerationHost,
	type RetainedDetachedGenerationHostOptions,
	type RetainedPreparedGeneration,
} from "./retained-detached-generation-host";
import {
	RetainedLeafTemplateTransactionSurface,
	type RetainedLeafAsyncRequest,
	type RetainedPreparedLeafTemplateUpdate,
} from "./retained-leaf-template-transaction";
import type { RetainedDomRuntime, RetainedScalar } from "./retained-slot-runtime";
import {
	RetainedTemplateDomPlan,
	type RetainedTemplateIrLike,
} from "./retained-template-dom-plan";

export type RetainedLeafOwnerGenerationMode = "replace" | "patch";

export type RetainedLeafOwnerGenerationStatus =
	| "prepared"
	| "unchanged"
	| "stale"
	| "failed"
	| "disposed";

export interface RetainedLeafOwnerGenerationTerminalResult {
	readonly status: Exclude<RetainedLeafOwnerGenerationStatus, "prepared">;
	readonly error?: unknown;
}

export interface RetainedPreparedLeafOwnerGeneration {
	readonly status: "prepared";
	readonly mode: RetainedLeafOwnerGenerationMode;
	readonly structureKey: string;
	isCurrent(): boolean;
	commit(isOwnerCurrent: () => boolean): RetainedCommitTransactionResult;
	dispose(): void;
}

export type RetainedLeafOwnerGenerationPreparationResult =
	| RetainedPreparedLeafOwnerGeneration
	| RetainedLeafOwnerGenerationTerminalResult;

interface ActiveLeafGeneration<E> {
	readonly structureKey: string;
	readonly runtime: RetainedDomRuntime;
	readonly surface: RetainedLeafTemplateTransactionSurface<E>;
}

type MetadataParticipantState =
	| "prepared"
	| "applied"
	| "adopted"
	| "rolled-back"
	| "finalized"
	| "discarded";

/**
 * Owner-level coordinator for the retained leaf-only TemplateIR path.
 *
 * Structure changes are initialized completely on a detached runtime, including
 * awaited Markdown/content islands, then exposed as one final live transaction.
 * Same-structure generations reuse the active retained runtime and commit sync
 * leaves + async islands atomically without rebuilding static DOM.
 *
 * The caller supplies only the final owner-currentness predicate at commit time;
 * coordinator generation currentness is composed into that same synchronous
 * transaction so reentrant newer preparations stale/rollback older live work.
 */
export class RetainedLeafGenerationCoordinator<E = unknown> {
	private readonly host: RetainedDetachedGenerationHost;
	private active: ActiveLeafGeneration<E> | null = null;
	private generation = 0;
	private disposed = false;

	constructor(
		root: HTMLElement,
		options: RetainedDetachedGenerationHostOptions = {},
	) {
		this.host = new RetainedDetachedGenerationHost(root, options);
	}

	get isDisposed(): boolean {
		return this.disposed;
	}

	get currentStructureKey(): string | null {
		return this.active?.structureKey ?? null;
	}

	get activeRuntime(): RetainedDomRuntime | null {
		return this.active?.runtime ?? null;
	}

	async prepare(
		ir: RetainedTemplateIrLike<E>,
		values: ReadonlyMap<string, RetainedScalar>,
		islands: ReadonlyMap<string, RetainedLeafAsyncRequest>,
	): Promise<RetainedLeafOwnerGenerationPreparationResult> {
		if (this.disposed) return { status: "disposed" };

		let structureKey: string;
		try {
			structureKey = new RetainedTemplateDomPlan(ir).structureKey;
		} catch (error) {
			return { status: "failed", error };
		}

		const generation = ++this.generation;
		if (this.active?.structureKey === structureKey) {
			return this.preparePatchGeneration(generation, ir, values, islands);
		}
		return this.prepareReplacementGeneration(generation, ir, values, islands);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.generation += 1;
		this.active = null;
		this.host.dispose();
	}

	private async preparePatchGeneration(
		generation: number,
		ir: RetainedTemplateIrLike<E>,
		values: ReadonlyMap<string, RetainedScalar>,
		islands: ReadonlyMap<string, RetainedLeafAsyncRequest>,
	): Promise<RetainedLeafOwnerGenerationPreparationResult> {
		const active = this.active;
		if (!active) return { status: "failed", error: this.ownershipLostError() };

		// Same-key host reuse intentionally supersedes any pending replacement that
		// targeted a different structure before this newer owner generation arrived.
		const reused = this.host.prepareInitializedStructure(active.structureKey, () => {
			throw new Error("Active retained leaf generation unexpectedly required initialization");
		});
		if (reused.status === "disposed") return { status: "disposed" };
		if (reused.status !== "reused" || reused.runtime !== active.runtime) {
			return { status: "failed", error: this.ownershipLostError() };
		}

		// A matching structure key is the authority boundary for leaf reuse. The
		// incoming IR was independently validated above; the active surface retains
		// the bindings/value snapshot that own this exact structure identity.
		void ir;
		const prepared = await active.surface.prepareUpdate(values, islands);
		if (!this.isGenerationCurrent(generation)) {
			if (prepared.status === "prepared") prepared.dispose();
			return { status: "stale" };
		}

		if (prepared.status !== "prepared") return prepared;
		return this.createPatchHandle(generation, active.structureKey, prepared);
	}

	private async prepareReplacementGeneration(
		generation: number,
		ir: RetainedTemplateIrLike<E>,
		values: ReadonlyMap<string, RetainedScalar>,
		islands: ReadonlyMap<string, RetainedLeafAsyncRequest>,
	): Promise<RetainedLeafOwnerGenerationPreparationResult> {
		let nextSurface: RetainedLeafTemplateTransactionSurface<E> | null = null;
		const plan = new RetainedTemplateDomPlan(ir);
		const staged = this.host.prepareInitializedStructure(plan.structureKey, (runtime) => {
			const surface = new RetainedLeafTemplateTransactionSurface(runtime, ir);
			const initialized = surface.initialize(values);
			if (initialized.status !== "mounted") {
				throw normalizeError(
					initialized.error ?? new Error(
						`Detached retained leaf initialization returned ${initialized.status}`,
					),
				);
			}
			nextSurface = surface;
		});

		if (staged.status === "disposed") return { status: "disposed" };
		if (staged.status === "failed") return staged;
		if (staged.status === "reused") {
			return { status: "failed", error: this.ownershipLostError() };
		}
		if (!nextSurface) {
			staged.dispose();
			return { status: "failed", error: new Error("Detached retained leaf surface was not initialized") };
		}

		const surface = nextSurface as RetainedLeafTemplateTransactionSurface<E>;
		const detachedUpdate = await surface.prepareUpdate(values, islands);
		if (!this.isGenerationCurrent(generation) || !staged.isCurrent()) {
			if (detachedUpdate.status === "prepared") detachedUpdate.dispose();
			staged.dispose();
			return { status: "stale" };
		}

		if (detachedUpdate.status === "failed") {
			staged.dispose();
			return detachedUpdate;
		}
		if (detachedUpdate.status === "disposed") {
			staged.dispose();
			return detachedUpdate;
		}
		if (detachedUpdate.status === "stale") {
			staged.dispose();
			return detachedUpdate;
		}

		if (detachedUpdate.status === "prepared") {
			const detachedCommit = detachedUpdate.commit(new RetainedCommitTransaction(
				() => this.isGenerationCurrent(generation) && staged.isCurrent(),
			));
			if (detachedCommit.status !== "committed") {
				staged.dispose();
				return this.mapCommitFailure(detachedCommit);
			}
		}

		if (!this.isGenerationCurrent(generation) || !staged.isCurrent()) {
			staged.dispose();
			return { status: "stale" };
		}
		return this.createReplacementHandle(generation, staged, surface);
	}

	private createPatchHandle(
		generation: number,
		structureKey: string,
		prepared: RetainedPreparedLeafTemplateUpdate,
	): RetainedPreparedLeafOwnerGeneration {
		let terminal = false;
		return {
			status: "prepared",
			mode: "patch",
			structureKey,
			isCurrent: () => !terminal && this.isGenerationCurrent(generation) && prepared.isCurrent(),
			commit: (isOwnerCurrent) => {
				if (terminal) return { status: "stale" };
				if (!this.isGenerationCurrent(generation) || !prepared.isCurrent()) {
					terminal = true;
					prepared.dispose();
					return { status: this.disposed ? "disposed" : "stale" };
				}
				const transaction = new RetainedCommitTransaction(
					() => this.isGenerationCurrent(generation) && isOwnerCurrent(),
				);
				const result = prepared.commit(transaction);
				terminal = true;
				return result;
			},
			dispose: () => {
				if (terminal) return;
				terminal = true;
				prepared.dispose();
			},
		};
	}

	private createReplacementHandle(
		generation: number,
		staged: RetainedPreparedGeneration,
		surface: RetainedLeafTemplateTransactionSurface<E>,
	): RetainedPreparedLeafOwnerGeneration {
		let terminal = false;
		const metadata = this.createMetadataParticipant(generation, staged, surface);
		return {
			status: "prepared",
			mode: "replace",
			structureKey: staged.structureKey,
			isCurrent: () => !terminal
				&& this.isGenerationCurrent(generation)
				&& staged.isCurrent(),
			commit: (isOwnerCurrent) => {
				if (terminal) return { status: "stale" };
				const transaction = new RetainedCommitTransaction(
					() => this.isGenerationCurrent(generation) && isOwnerCurrent(),
				);
				const result = transaction.commit([
					staged.toCommitParticipant(),
					metadata,
				]);
				terminal = true;
				return result;
			},
			dispose: () => {
				if (terminal) return;
				terminal = true;
				metadata.discard();
				staged.dispose();
			},
		};
	}

	private createMetadataParticipant(
		generation: number,
		staged: RetainedPreparedGeneration,
		surface: RetainedLeafTemplateTransactionSurface<E>,
	): RetainedCommitParticipant {
		let state: MetadataParticipantState = "prepared";
		let previous: ActiveLeafGeneration<E> | null = null;
		const next: ActiveLeafGeneration<E> = {
			structureKey: staged.structureKey,
			runtime: staged.runtime,
			surface,
		};

		return {
			isCurrent: () => {
				if (state === "rolled-back" || state === "finalized" || state === "discarded") {
					return false;
				}
				if (!this.isGenerationCurrent(generation) || !staged.isCurrent()) return false;
				if (state === "adopted") return this.active === next;
				return true;
			},
			apply: () => {
				if (state !== "prepared") throw new Error("Retained leaf metadata is not prepared");
				state = "applied";
			},
			adopt: () => {
				if (state !== "applied") throw new Error("Retained leaf metadata is not ready to adopt");
				if (this.host.activeRuntime !== staged.runtime) {
					throw new Error("Detached retained runtime was not adopted before leaf metadata");
				}
				previous = this.active;
				this.active = next;
				state = "adopted";
			},
			rollback: () => {
				if (state !== "applied" && state !== "adopted") return;
				if (state === "adopted" && this.active === next) this.active = previous;
				state = "rolled-back";
			},
			finalize: () => {
				if (state !== "adopted") return;
				previous = null;
				state = "finalized";
			},
			discard: () => {
				if (state === "finalized" || state === "discarded") return;
				state = "discarded";
			},
		};
	}

	private isGenerationCurrent(generation: number): boolean {
		return !this.disposed && generation === this.generation;
	}

	private mapCommitFailure(
		result: RetainedCommitTransactionResult,
	): RetainedLeafOwnerGenerationTerminalResult {
		if (result.status === "disposed") return { status: "disposed" };
		if (result.status === "stale") return { status: "stale" };
		return {
			status: "failed",
			error: result.error ?? result.rollbackErrors?.[0] ?? result.cleanupErrors?.[0]
				?? new Error(`Detached retained leaf commit returned ${result.status}`),
		};
	}

	private ownershipLostError(): Error {
		return new Error("Retained leaf coordinator ownership no longer matches the detached generation host");
	}
}

function normalizeError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
