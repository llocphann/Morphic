import type { RenderScope } from "../core/render-scope";
import {
	RetainedLeafOwnerRegistry,
	type RetainedLeafOwnerLease,
} from "./retained-leaf-owner-registry";
import type { RetainedLeafGenerationCoordinator } from "./retained-leaf-generation-coordinator";
import {
	RetainedRenderScopeHandoff,
	type RetainedRenderScopeHandoffOptions,
	type RetainedScopeHandoffStatus,
} from "./retained-render-scope-handoff";

type RenderScopeOwner = Pick<RenderScope, "isDisposed" | "registerDisposer">;

export type RetainedLeafOwnerScopePreparationStatus =
	| "prepared"
	| "stale"
	| "disposed";

export interface RetainedLeafOwnerScopeTerminalResult {
	readonly status: Exclude<RetainedLeafOwnerScopePreparationStatus, "prepared">;
	readonly generation: number;
}

export interface RetainedPreparedLeafOwnerScope<E> {
	readonly status: "prepared";
	readonly generation: number;
	readonly lease: RetainedLeafOwnerLease<E>;
	readonly coordinator: RetainedLeafGenerationCoordinator<E>;
	isCurrent(): boolean;
	commitAfter(commit: () => void): RetainedScopeHandoffStatus;
}

export type RetainedLeafOwnerScopePreparationResult<E> =
	| RetainedPreparedLeafOwnerScope<E>
	| RetainedLeafOwnerScopeTerminalResult;

export type RetainedLeafOwnerScopeBridgeOptions = RetainedRenderScopeHandoffOptions;

class BridgeLeaseResource<E> {
	private disposed = false;

	constructor(
		readonly lease: RetainedLeafOwnerLease<E>,
		private readonly onDisposed: () => void,
	) {}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		try {
			this.lease.dispose();
		} finally {
			this.onDisposed();
		}
	}
}

interface OwnerScopeEntry<E> {
	readonly lease: RetainedLeafOwnerLease<E>;
	readonly resource: BridgeLeaseResource<E>;
	readonly handoff: RetainedRenderScopeHandoff<BridgeLeaseResource<E>>;
	latestPreparedGeneration: number;
}

/**
 * Composes retained owner leases with RenderScope cleanup transfer.
 *
 * The owner registry keeps one retained leaf coordinator alive across successful
 * generations, while RetainedRenderScopeHandoff moves cleanup authority from the
 * previous committed RenderScope to the next one only after its synchronous live
 * commit succeeds. This bridge keeps those two identities aligned so production
 * wiring cannot accidentally release a replacement coordinator from a stale scope.
 *
 * The bridge exclusively owns the supplied registry lifecycle. The retained root
 * is expected to remain stable while an owner custom surface is live. Root
 * replacement is supported for intentional outer-surface replacement/fallback.
 */
export class RetainedLeafOwnerScopeBridge<Owner extends object, E = unknown> {
	private readonly entries = new Map<Owner, OwnerScopeEntry<E>>();
	private readonly releasingOwners = new Set<Owner>();
	private readonly onCleanupError?: (error: unknown) => void;
	private disposed = false;

	constructor(
		readonly registry: RetainedLeafOwnerRegistry<Owner, E>,
		options: RetainedLeafOwnerScopeBridgeOptions = {},
	) {
		this.onCleanupError = options.onCleanupError;
	}

	get isDisposed(): boolean {
		return this.disposed;
	}

	get size(): number {
		return this.entries.size;
	}

	prepare(
		owner: Owner,
		root: HTMLElement,
		scope: RenderScopeOwner,
		generation: number,
	): RetainedLeafOwnerScopePreparationResult<E> {
		if (this.disposed || this.registry.isDisposed) {
			return { status: "disposed", generation };
		}
		if (this.releasingOwners.has(owner)) {
			return { status: "stale", generation };
		}

		const existing = this.entries.get(owner);
		if (existing && generation <= existing.latestPreparedGeneration) {
			return { status: "stale", generation };
		}
		if (scope.isDisposed) return { status: "stale", generation };

		let lease: RetainedLeafOwnerLease<E>;
		try {
			lease = this.registry.getOrCreateLease(owner, root);
		} catch (error) {
			if (this.disposed || this.registry.isDisposed) {
				return { status: "disposed", generation };
			}
			throw error;
		}

		if (this.disposed || this.registry.isDisposed) {
			return { status: "disposed", generation };
		}
		if (scope.isDisposed) {
			if (!existing || lease !== existing.lease) lease.dispose();
			return { status: "stale", generation };
		}

		if (existing && lease === existing.lease && !existing.handoff.isDisposed) {
			const transfer = existing.handoff.prepareTransfer(scope, generation);
			existing.latestPreparedGeneration = generation;
			return {
				status: "prepared",
				generation,
				lease,
				coordinator: lease.coordinator,
				isCurrent: () =>
					!this.disposed
					&& this.entries.get(owner) === existing
					&& existing.latestPreparedGeneration === generation
					&& !lease.isReleased
					&& !scope.isDisposed
					&& !existing.handoff.isDisposed,
				commitAfter: (commit) => transfer.commitAfter(commit),
			};
		}

		let entry: OwnerScopeEntry<E> | null = null;
		const resource = new BridgeLeaseResource(lease, () => {
			if (entry && this.entries.get(owner) === entry) this.entries.delete(owner);
		});
		let handoff: RetainedRenderScopeHandoff<BridgeLeaseResource<E>>;
		try {
			handoff = new RetainedRenderScopeHandoff(
				resource,
				scope,
				generation,
				{ onCleanupError: this.onCleanupError },
			);
		} catch (error) {
			if (existing) {
				this.entries.delete(owner);
				existing.handoff.dispose();
			}
			throw error;
		}

		if (handoff.isDisposed || lease.isReleased || scope.isDisposed) {
			if (existing) {
				this.entries.delete(owner);
				existing.handoff.dispose();
			}
			return { status: "stale", generation };
		}

		entry = {
			lease,
			resource,
			handoff,
			latestPreparedGeneration: generation,
		};
		if (existing) existing.handoff.dispose();
		this.entries.set(owner, entry);

		let terminal = false;
		const initialEntry = entry;
		return {
			status: "prepared",
			generation,
			lease,
			coordinator: lease.coordinator,
			isCurrent: () => !terminal
				&& this.initialBindingIsCurrent(owner, initialEntry, scope, generation),
			commitAfter: (commit) => {
				if (terminal) return "stale";
				if (this.disposed || handoff.isDisposed || lease.isReleased) {
					terminal = true;
					return "disposed";
				}
				if (!this.initialBindingIsCurrent(owner, initialEntry, scope, generation)) {
					terminal = true;
					return "stale";
				}

				commit();

				// A newer same-root generation may have been prepared reentrantly by the
				// live commit. Preparation is not authority: this successful generation
				// still owns cleanup until the newer generation also commits.
				terminal = true;
				if (this.disposed || handoff.isDisposed || lease.isReleased) return "disposed";
				if (this.entries.get(owner) !== initialEntry || scope.isDisposed) return "stale";
				return "transferred";
			},
		};
	}

	release(owner: Owner): void {
		if (this.releasingOwners.has(owner)) return;
		this.releasingOwners.add(owner);
		try {
			const entry = this.entries.get(owner);
			if (entry) this.entries.delete(owner);

			// Keep same-owner preparation blocked for the full release transaction.
			// Registry release invalidates authority before coordinator cleanup, while
			// the bridge barrier prevents cleanup callbacks from recreating ownership
			// before explicit release has returned.
			this.registry.release(owner);
			entry?.handoff.dispose();
		} finally {
			this.releasingOwners.delete(owner);
		}
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		const entries = [...this.entries.values()];
		this.entries.clear();

		// Registry teardown invalidates every lease before coordinator cleanup.
		// Handoff disposal afterward can therefore never release a replacement.
		this.registry.dispose();
		for (const entry of entries) entry.handoff.dispose();
	}

	private initialBindingIsCurrent(
		owner: Owner,
		entry: OwnerScopeEntry<E>,
		scope: RenderScopeOwner,
		generation: number,
	): boolean {
		return !this.disposed
			&& !this.registry.isDisposed
			&& this.entries.get(owner) === entry
			&& entry.latestPreparedGeneration === generation
			&& !entry.lease.isReleased
			&& !entry.handoff.isDisposed
			&& !scope.isDisposed;
	}
}
