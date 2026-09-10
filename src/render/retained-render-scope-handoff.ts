import type { RenderScope } from "../core/render-scope";
import type { RetainedDisposable } from "./retained-owner-scope";

export type RetainedScopeHandoffStatus = "transferred" | "stale" | "disposed";

export interface RetainedRenderScopeHandoffOptions {
	onCleanupError?: (error: unknown) => void;
}

export interface RetainedScopeTransfer {
	readonly generation: number;
	commitAfter(commit: () => void): RetainedScopeHandoffStatus;
}

type RenderScopeOwner = Pick<RenderScope, "isDisposed" | "registerDisposer">;

interface ScopeToken {
	readonly generation: number;
	alive: boolean;
}

/**
 * Transfers cleanup ownership of one retained resource between successful
 * RenderController generations without tying the resource to every generation.
 *
 * The currently committed RenderScope owns the resource. A pending generation
 * receives only a candidate token; disposing a stale/failed pending scope cannot
 * dispose the retained resource. `commitAfter()` runs the caller's synchronous
 * live-DOM commit first and promotes the candidate only if that commit succeeds.
 * RenderController can then dispose the previous active scope without tearing
 * down retained DOM/resources that must survive the successful refresh.
 */
export class RetainedRenderScopeHandoff<T extends RetainedDisposable> {
	private readonly onCleanupError?: (error: unknown) => void;
	private activeToken: ScopeToken | null = null;
	private activeGeneration: number;
	private latestPreparedGeneration: number;
	private disposed = false;

	constructor(
		readonly resource: T,
		owner: RenderScopeOwner,
		generation: number,
		options: RetainedRenderScopeHandoffOptions = {},
	) {
		this.onCleanupError = options.onCleanupError;
		this.activeGeneration = generation;
		this.latestPreparedGeneration = generation;

		const token: ScopeToken = { generation, alive: true };
		this.activeToken = token;
		try {
			owner.registerDisposer(() => this.releaseToken(token));
		} catch (error) {
			this.activeToken = null;
			this.disposed = true;
			this.disposeResource();
			throw error;
		}

		// RenderScope invokes late registrations immediately, but keeping this
		// explicit makes the structural owner contract safe for equivalent owners.
		if (owner.isDisposed && token.alive) this.releaseToken(token);
	}

	get isDisposed(): boolean {
		return this.disposed;
	}

	get currentGeneration(): number | null {
		return this.disposed ? null : this.activeGeneration;
	}

	/**
	 * Prepare a cleanup-ownership transfer for a newer render generation.
	 *
	 * Preparing is side-effect free for the retained resource itself: the current
	 * committed scope remains its owner until `commitAfter()` returns transferred.
	 */
	prepareTransfer(owner: RenderScopeOwner, generation: number): RetainedScopeTransfer {
		if (this.disposed) return this.deadTransfer(generation, "disposed");
		if (generation <= this.latestPreparedGeneration) {
			return this.deadTransfer(generation, "stale");
		}

		this.latestPreparedGeneration = generation;
		const token: ScopeToken = { generation, alive: !owner.isDisposed };
		if (token.alive) {
			try {
				owner.registerDisposer(() => this.releaseToken(token));
			} catch (error) {
				token.alive = false;
				throw error;
			}
			if (owner.isDisposed && token.alive) this.releaseToken(token);
		}

		return {
			generation,
			commitAfter: (commit) => this.commitPrepared(owner, token, commit),
		};
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.activeToken = null;
		this.disposeResource();
	}

	private commitPrepared(
		owner: RenderScopeOwner,
		token: ScopeToken,
		commit: () => void,
	): RetainedScopeHandoffStatus {
		if (this.disposed) return "disposed";
		if (!token.alive
			|| owner.isDisposed
			|| token.generation !== this.latestPreparedGeneration
			|| token.generation <= this.activeGeneration) {
			return "stale";
		}

		// Deliberately execute every potentially throwing live mutation before the
		// ownership switch. If commit throws, the previous active scope still owns
		// the retained resource and disposal of this pending scope is a no-op.
		commit();

		if (this.disposed) return "disposed";
		if (!token.alive
			|| owner.isDisposed
			|| token.generation <= this.activeGeneration) {
			return "stale";
		}

		// A newer generation may have been prepared reentrantly by the live commit.
		// Preparation is non-authoritative: once this generation has successfully
		// mutated the live surface it must own cleanup until a newer generation also
		// commits. Otherwise disposal of the previous scope could tear down the
		// retained resource backing the surface that just committed.
		this.activeToken = token;
		this.activeGeneration = token.generation;
		return "transferred";
	}

	private deadTransfer(
		generation: number,
		status: Exclude<RetainedScopeHandoffStatus, "transferred">,
	): RetainedScopeTransfer {
		return {
			generation,
			commitAfter: () => status,
		};
	}

	private releaseToken(token: ScopeToken): void {
		if (!token.alive) return;
		token.alive = false;
		if (!this.disposed && this.activeToken === token) this.dispose();
	}

	private disposeResource(): void {
		try {
			this.resource.dispose();
		} catch (error) {
			this.reportCleanupError(error);
		}
	}

	private reportCleanupError(error: unknown): void {
		if (!this.onCleanupError) return;
		try {
			this.onCleanupError(error);
		} catch {
			// Cleanup reporting is diagnostic only and must never escape teardown.
		}
	}
}
