import { RetainedLeafGenerationCoordinator } from "./retained-leaf-generation-coordinator";

export interface RetainedLeafOwnerRegistryOptions<E> {
	createCoordinator?: (root: HTMLElement) => RetainedLeafGenerationCoordinator<E>;
	onCleanupError?: (error: unknown) => void;
}

export interface RetainedLeafOwnerLease<E> {
	readonly root: HTMLElement;
	readonly coordinator: RetainedLeafGenerationCoordinator<E>;
	readonly isReleased: boolean;
	dispose(): void;
}

export class RetainedLeafOwnerRegistryError extends Error {
	constructor(
		message: string,
		readonly code:
			| "disposed"
			| "root-owned"
			| "reentrant-create"
			| "owner-released"
			| "factory-disposed",
	) {
		super(message);
		this.name = "RetainedLeafOwnerRegistryError";
	}
}

class RegistryOwnerLease<E> implements RetainedLeafOwnerLease<E> {
	private released = false;

	constructor(
		readonly root: HTMLElement,
		readonly coordinator: RetainedLeafGenerationCoordinator<E>,
		private readonly releaseCurrent: () => void,
	) {}

	get isReleased(): boolean {
		return this.released;
	}

	dispose(): void {
		if (this.released) return;
		this.releaseCurrent();
	}

	invalidate(): void {
		this.released = true;
	}
}

interface OwnerEntry<E> {
	readonly root: HTMLElement;
	readonly coordinator: RetainedLeafGenerationCoordinator<E>;
	readonly lease: RegistryOwnerLease<E>;
}

/**
 * Long-lived owner registry for retained leaf generation coordinators.
 *
 * The registry deliberately owns only owner/root lifetime. RenderScope transfer
 * remains the responsibility of RetainedRenderScopeHandoff, and final generation
 * authority remains inside RetainedLeafGenerationCoordinator. This keeps one
 * retained coordinator alive across successful render generations without moving
 * it to plugin-global lifetime.
 *
 * `getOrCreateLease()` exposes one stable disposable identity for the current
 * owner/root entry. A lease only releases the exact entry that created it; once a
 * root/coordinator is replaced, the previous lease is invalidated before teardown
 * so disposal of an older RenderScope cannot release the replacement coordinator.
 */
export class RetainedLeafOwnerRegistry<Owner extends object, E = unknown> {
	private readonly entries = new Map<Owner, OwnerEntry<E>>();
	private readonly rootOwners = new WeakMap<HTMLElement, Owner>();
	private readonly creatingOwners = new Set<Owner>();
	private readonly creatingRoots = new WeakSet<HTMLElement>();
	private readonly ownerReleaseRevisions = new WeakMap<Owner, number>();
	private readonly createCoordinator: (root: HTMLElement) => RetainedLeafGenerationCoordinator<E>;
	private readonly onCleanupError?: (error: unknown) => void;
	private disposed = false;

	constructor(options: RetainedLeafOwnerRegistryOptions<E> = {}) {
		this.createCoordinator = options.createCoordinator
			?? ((root) => new RetainedLeafGenerationCoordinator<E>(root));
		this.onCleanupError = options.onCleanupError;
	}

	get isDisposed(): boolean {
		return this.disposed;
	}

	get size(): number {
		return this.entries.size;
	}

	get(owner: Owner): RetainedLeafGenerationCoordinator<E> | null {
		return this.entries.get(owner)?.coordinator ?? null;
	}

	rootFor(owner: Owner): HTMLElement | null {
		return this.entries.get(owner)?.root ?? null;
	}

	owners(): IterableIterator<Owner> {
		return this.entries.keys();
	}

	getOrCreateLease(owner: Owner, root: HTMLElement): RetainedLeafOwnerLease<E> {
		const coordinator = this.getOrCreate(owner, root);
		const entry = this.entries.get(owner);
		if (!entry || entry.coordinator !== coordinator || entry.root !== root) {
			throw this.error("Retained leaf owner lease lost its registry entry", "owner-released");
		}
		return entry.lease;
	}

	getOrCreate(owner: Owner, root: HTMLElement): RetainedLeafGenerationCoordinator<E> {
		if (this.disposed) throw this.error("Retained leaf owner registry is disposed", "disposed");

		const existing = this.entries.get(owner);
		if (existing?.root === root && !existing.coordinator.isDisposed) {
			return existing.coordinator;
		}

		const claimedOwner = this.rootOwners.get(root);
		if (claimedOwner && claimedOwner !== owner) {
			throw this.error("Retained leaf root is already owned by another owner", "root-owned");
		}
		if (this.creatingOwners.has(owner) || this.creatingRoots.has(root)) {
			throw this.error("Retained leaf coordinator creation is reentrant", "reentrant-create");
		}

		const releaseRevision = this.releaseRevision(owner);
		this.creatingOwners.add(owner);
		this.creatingRoots.add(root);
		let coordinator: RetainedLeafGenerationCoordinator<E> | null = null;
		try {
			if (existing) this.dropEntry(owner, existing);
			if (this.disposed) {
				throw this.error("Retained leaf owner registry was disposed during replacement", "disposed");
			}
			if (this.releaseRevision(owner) !== releaseRevision) {
				throw this.error("Retained leaf owner was released during coordinator replacement", "owner-released");
			}

			coordinator = this.createCoordinator(root);
			if (this.disposed) {
				this.disposeCoordinator(coordinator);
				throw this.error("Retained leaf owner registry was disposed during creation", "disposed");
			}
			if (this.releaseRevision(owner) !== releaseRevision) {
				this.disposeCoordinator(coordinator);
				throw this.error("Retained leaf owner was released during coordinator creation", "owner-released");
			}
			if (coordinator.isDisposed) {
				throw this.error("Retained leaf coordinator factory returned a disposed coordinator", "factory-disposed");
			}

			let entry!: OwnerEntry<E>;
			const lease = new RegistryOwnerLease(root, coordinator, () => this.releaseEntry(owner, entry));
			entry = { root, coordinator, lease };
			this.entries.set(owner, entry);
			this.rootOwners.set(root, owner);
			return coordinator;
		} catch (error) {
			if (coordinator && !coordinator.isDisposed && !this.entries.has(owner)) {
				this.disposeCoordinator(coordinator);
			}
			throw error;
		} finally {
			this.creatingOwners.delete(owner);
			this.creatingRoots.delete(root);
		}
	}

	release(owner: Owner): void {
		this.ownerReleaseRevisions.set(owner, this.releaseRevision(owner) + 1);
		const entry = this.entries.get(owner);
		if (!entry) return;
		this.dropEntry(owner, entry);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		const entries = [...this.entries.entries()];
		this.entries.clear();
		for (const [owner, entry] of entries) {
			this.rootOwners.delete(entry.root);
			entry.lease.invalidate();
			this.ownerReleaseRevisions.set(owner, this.releaseRevision(owner) + 1);
			this.disposeCoordinator(entry.coordinator);
		}
	}

	private releaseEntry(owner: Owner, entry: OwnerEntry<E>): void {
		if (entry.lease.isReleased) return;
		if (this.entries.get(owner) !== entry) {
			entry.lease.invalidate();
			return;
		}
		this.ownerReleaseRevisions.set(owner, this.releaseRevision(owner) + 1);
		this.dropEntry(owner, entry);
	}

	private dropEntry(owner: Owner, entry: OwnerEntry<E>): void {
		if (this.entries.get(owner) === entry) this.entries.delete(owner);
		if (this.rootOwners.get(entry.root) === owner) this.rootOwners.delete(entry.root);
		entry.lease.invalidate();
		this.disposeCoordinator(entry.coordinator);
	}

	private releaseRevision(owner: Owner): number {
		return this.ownerReleaseRevisions.get(owner) ?? 0;
	}

	private disposeCoordinator(coordinator: RetainedLeafGenerationCoordinator<E>): void {
		try {
			coordinator.dispose();
		} catch (error) {
			this.reportCleanupError(error);
		}
	}

	private reportCleanupError(error: unknown): void {
		if (!this.onCleanupError) return;
		try {
			this.onCleanupError(error);
		} catch {
			// Cleanup reporting is diagnostic only and must not stop owner teardown.
		}
	}

	private error(
		message: string,
		code: RetainedLeafOwnerRegistryError["code"],
	): RetainedLeafOwnerRegistryError {
		return new RetainedLeafOwnerRegistryError(message, code);
	}
}
