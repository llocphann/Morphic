import type { RenderScope } from "../core/render-scope";
import {
	RetainedLeafOwnerRenderHost,
	type RetainedLeafOwnerRenderCommitResult,
	type RetainedLeafOwnerRenderHostOptions,
	type RetainedLeafOwnerRenderPreparationResult,
	type RetainedPreparedLeafOwnerRender,
} from "./retained-leaf-owner-render-host";
import type { RetainedLeafAsyncRequest } from "./retained-leaf-template-transaction";
import type { RetainedScalar } from "./retained-slot-runtime";
import type { RetainedTemplateIrLike } from "./retained-template-dom-plan";

type RenderScopeOwner = Pick<RenderScope, "isDisposed" | "registerDisposer">;
type OwnerReleasePhase = "cleanup" | "terminal";

export interface RetainedOwnerLinkBinding {
	readonly currentSourcePath: string;
	readonly isDisposed: boolean;
	updateSourcePath(sourcePath: string): void;
	dispose(): void;
}

export interface RetainedLeafOwnerRenderHostPort<Owner extends object, E> {
	readonly isDisposed: boolean;
	prepare(
		owner: Owner,
		root: HTMLElement,
		scope: RenderScopeOwner,
		generation: number,
		ir: RetainedTemplateIrLike<E>,
		values: ReadonlyMap<string, RetainedScalar>,
		islands: ReadonlyMap<string, RetainedLeafAsyncRequest>,
	): Promise<RetainedLeafOwnerRenderPreparationResult>;
	release(owner: Owner): void;
	dispose(): void;
}

export interface RetainedLeafOwnerLinkHostOptions<Owner extends object, E> {
	readonly createLinkBinding: (
		root: HTMLElement,
		sourcePath: string,
	) => RetainedOwnerLinkBinding;
	readonly renderHost?: RetainedLeafOwnerRenderHostPort<Owner, E>;
	readonly renderHostOptions?: RetainedLeafOwnerRenderHostOptions<E>;
	readonly onCleanupError?: (error: unknown) => void;
}

export class RetainedLeafOwnerLinkHostError extends Error {
	constructor(
		message: string,
		readonly code: "binding-create-failed" | "binding-update-failed",
		readonly cause?: unknown,
	) {
		super(message);
		this.name = "RetainedLeafOwnerLinkHostError";
	}
}

interface LinkEntry {
	readonly root: HTMLElement;
	readonly binding: RetainedOwnerLinkBinding;
	committedGeneration: number;
}

/**
 * Owner-lifetime link-source companion for RetainedLeafOwnerRenderHost.
 *
 * Link listeners are created only after the first successful retained owner
 * commit, so failed/stale preparation cannot make native/last-known-good DOM use
 * an uncommitted source path. Later source-path changes are applied synchronously
 * after a terminal `committed`/`unchanged` result. The committed-generation fence
 * prevents an older commit tail from overwriting a newer source path when cleanup
 * finalization reenters and commits a newer owner generation before the older
 * `commit()` call returns.
 *
 * This class owns binding lifetime per retained owner, not per RenderScope. Bot 1
 * can therefore keep relative-link source context aligned with the retained owner
 * without registering the listeners in every generation scope.
 */
export class RetainedLeafOwnerLinkHost<Owner extends object, E = unknown> {
	readonly renderHost: RetainedLeafOwnerRenderHostPort<Owner, E>;

	private readonly entries = new Map<Owner, LinkEntry>();
	private readonly ownerReleasePhases = new Map<Owner, OwnerReleasePhase>();
	private readonly createLinkBinding: RetainedLeafOwnerLinkHostOptions<Owner, E>["createLinkBinding"];
	private readonly onCleanupError?: (error: unknown) => void;
	private disposed = false;

	constructor(options: RetainedLeafOwnerLinkHostOptions<Owner, E>) {
		this.createLinkBinding = (root, sourcePath) => options.createLinkBinding(root, sourcePath);
		this.onCleanupError = options.onCleanupError;
		this.renderHost = options.renderHost
			?? new RetainedLeafOwnerRenderHost<Owner, E>(options.renderHostOptions);
	}

	get isDisposed(): boolean {
		return this.disposed;
	}

	get size(): number {
		return this.entries.size;
	}

	bindingFor(owner: Owner): RetainedOwnerLinkBinding | null {
		return this.entries.get(owner)?.binding ?? null;
	}

	async prepare(
		owner: Owner,
		root: HTMLElement,
		scope: RenderScopeOwner,
		generation: number,
		sourcePath: string,
		ir: RetainedTemplateIrLike<E>,
		values: ReadonlyMap<string, RetainedScalar>,
		islands: ReadonlyMap<string, RetainedLeafAsyncRequest>,
	): Promise<RetainedLeafOwnerRenderPreparationResult> {
		if (this.disposed) return { status: "disposed", generation };

		let prepared: RetainedLeafOwnerRenderPreparationResult;
		try {
			prepared = await this.renderHost.prepare(
				owner,
				root,
				scope,
				generation,
				ir,
				values,
				islands,
			);
		} catch (error) {
			return { status: "failed", generation, error };
		}
		if (prepared.status !== "prepared") return prepared;
		return this.wrapPrepared(owner, root, generation, sourcePath, prepared);
	}

	release(owner: Owner): void {
		if (this.ownerReleasePhases.has(owner)) return;
		this.ownerReleasePhases.set(owner, "cleanup");
		try {
			this.disposeOwnerBinding(owner);
			this.ownerReleasePhases.set(owner, "terminal");
			this.renderHost.release(owner);
		} finally {
			this.ownerReleasePhases.set(owner, "terminal");
			this.disposeOwnerBinding(owner);
			this.ownerReleasePhases.delete(owner);
		}
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		const entries = [...this.entries.values()];
		this.entries.clear();
		for (const entry of entries) this.disposeBinding(entry.binding);
		this.renderHost.dispose();
	}

	private wrapPrepared(
		owner: Owner,
		root: HTMLElement,
		generation: number,
		sourcePath: string,
		prepared: RetainedPreparedLeafOwnerRender,
	): RetainedPreparedLeafOwnerRender {
		let terminal = false;
		return {
			status: "prepared",
			generation: prepared.generation,
			mode: prepared.mode,
			structureKey: prepared.structureKey,
			isCurrent: () => !terminal && !this.disposed && prepared.isCurrent(),
			commit: () => {
				if (terminal) return { status: this.deadStatus() };
				if (this.disposed || !prepared.isCurrent()) {
					terminal = true;
					prepared.dispose();
					return { status: this.deadStatus() };
				}

				const result = prepared.commit();
				terminal = true;
				if (result.status !== "committed" && result.status !== "unchanged") return result;
				return this.commitSourcePath(owner, root, generation, sourcePath, result);
			},
			dispose: () => {
				if (terminal) return;
				terminal = true;
				prepared.dispose();
			},
		};
	}

	private commitSourcePath(
		owner: Owner,
		root: HTMLElement,
		generation: number,
		sourcePath: string,
		result: RetainedLeafOwnerRenderCommitResult,
	): RetainedLeafOwnerRenderCommitResult {
		if (this.ownerReleasePhases.get(owner) === "terminal") return { status: "disposed" };
		if (this.disposed || this.renderHost.isDisposed) return result;

		const existing = this.entries.get(owner);
		if (existing && generation < existing.committedGeneration) {
			return result;
		}
		if (existing && generation === existing.committedGeneration) {
			if (existing.root === root && existing.binding.currentSourcePath === sourcePath) {
				return result;
			}
			return this.poisoned(
				"Retained link source generation collided with different committed metadata",
				"binding-update-failed",
			);
		}

		if (existing?.root === root) {
			const binding = existing.binding;
			if (binding.isDisposed) {
				return this.poisoned(
					"Retained owner link binding was disposed before source commit",
					"binding-update-failed",
				);
			}
			const previous = binding.currentSourcePath;
			try {
				binding.updateSourcePath(sourcePath);
				if (binding.isDisposed || binding.currentSourcePath !== sourcePath) {
					throw new Error("Retained owner link binding did not accept the committed source path");
				}
			} catch (error) {
				if (!binding.isDisposed && binding.currentSourcePath !== previous) {
					try {
						binding.updateSourcePath(previous);
					} catch (rollbackError) {
						this.reportCleanupError(rollbackError);
					}
				}
				return this.poisoned(
					"Retained owner link source update failed after live commit",
					"binding-update-failed",
					error,
				);
			}
			existing.committedGeneration = generation;
			return result;
		}

		let nextBinding: RetainedOwnerLinkBinding;
		try {
			nextBinding = this.createLinkBinding(root, sourcePath);
			if (nextBinding.isDisposed || nextBinding.currentSourcePath !== sourcePath) {
				throw new Error("Retained owner link binding factory returned an invalid binding");
			}
		} catch (error) {
			return this.poisoned(
				"Retained owner link binding creation failed after live commit",
				"binding-create-failed",
				error,
			);
		}

		this.entries.set(owner, { root, binding: nextBinding, committedGeneration: generation });
		if (existing) this.disposeBinding(existing.binding);
		return result;
	}

	private poisoned(
		message: string,
		code: RetainedLeafOwnerLinkHostError["code"],
		cause?: unknown,
	): RetainedLeafOwnerRenderCommitResult {
		return {
			status: "poisoned",
			error: new RetainedLeafOwnerLinkHostError(message, code, cause),
		};
	}

	private deadStatus(): "stale" | "disposed" {
		return this.disposed || this.renderHost.isDisposed ? "disposed" : "stale";
	}

	private disposeOwnerBinding(owner: Owner): void {
		const entry = this.entries.get(owner);
		if (!entry) return;
		this.entries.delete(owner);
		this.disposeBinding(entry.binding);
	}

	private disposeBinding(binding: RetainedOwnerLinkBinding): void {
		try {
			binding.dispose();
		} catch (error) {
			this.reportCleanupError(error);
		}
	}

	private reportCleanupError(error: unknown): void {
		if (!this.onCleanupError) return;
		try {
			this.onCleanupError(error);
		} catch {
			// Diagnostic reporting must not interrupt retained owner teardown.
		}
	}
}
