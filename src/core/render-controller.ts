import { RenderScope } from "./render-scope";

export interface RenderTransaction {
	/** Optional synchronous owner/state validation immediately before commit. */
	isValid?(): boolean;
	/** Commit must be synchronous: all async work belongs in prepare(). */
	commit(): void;
	/** Releases staging DOM/data that was never committed. */
	dispose?(): void;
}

export interface RenderPreparationContext {
	generation: number;
	signal: AbortSignal;
	scope: RenderScope;
}

export type RenderPreparer<Input> = (
	input: Input,
	context: RenderPreparationContext,
) => RenderTransaction | Promise<RenderTransaction>;

export type RenderResult =
	| { status: "committed"; generation: number }
	| { status: "skipped"; generation: number }
	| { status: "stale"; generation: number }
	| { status: "disposed"; generation: number };

/**
 * Per-leaf/per-node render scheduler.
 *
 * Async preparation happens off the live surface. Only the newest generation
 * is allowed to synchronously commit. This prevents a slow prior navigation
 * from overwriting a newer render.
 */
export class RenderController<Input> {
	private generation = 0;
	private committedKey: string | null = null;
	private pendingKey: string | null = null;
	private dirty = true;
	private disposed = false;
	private activeScope: RenderScope | null = null;
	private pendingScope: RenderScope | null = null;

	constructor(private readonly prepare: RenderPreparer<Input>) {}

	get currentGeneration(): number {
		return this.generation;
	}

	get lastCommittedKey(): string | null {
		return this.committedKey;
	}

	get currentPendingKey(): string | null {
		return this.pendingKey;
	}

	invalidate(): void {
		this.dirty = true;
	}

	cancelPending(): void {
		this.generation++;
		this.pendingScope?.dispose();
		this.pendingScope = null;
		this.pendingKey = null;
	}

	/**
	 * Releases the currently committed render resources without disposing this
	 * owner/controller. Used when navigation synchronously restores Obsidian's
	 * native surface before the next Morphic generation has committed.
	 */
	releaseCommitted(): void {
		if (this.disposed) return;
		this.activeScope?.dispose();
		this.activeScope = null;
		this.committedKey = null;
		this.dirty = true;
	}

	async render(input: Input, key: string): Promise<RenderResult> {
		if (this.disposed) {
			return { status: "disposed", generation: this.generation };
		}

		if (!this.dirty && this.committedKey === key && !this.pendingScope) {
			return { status: "skipped", generation: this.generation };
		}

		const generation = ++this.generation;
		this.pendingScope?.dispose();

		const scope = new RenderScope();
		scope.load();
		this.pendingScope = scope;
		this.pendingKey = key;

		let transaction: RenderTransaction;
		try {
			transaction = await this.prepare(input, {
				generation,
				signal: scope.signal,
				scope,
			});
		} catch (error) {
			const stale = !this.isCurrent(generation, scope);
			if (this.pendingScope === scope) {
				this.pendingScope = null;
				this.pendingKey = null;
			}
			scope.dispose();
			if (stale || isAbortError(error)) {
				return { status: "stale", generation };
			}
			throw error;
		}

		if (!this.isCurrent(generation, scope) || transaction.isValid?.() === false) {
			if (this.pendingScope === scope) {
				this.pendingScope = null;
				this.pendingKey = null;
			}
			transaction.dispose?.();
			scope.dispose();
			return { status: "stale", generation };
		}

		try {
			transaction.commit();
		} catch (error) {
			if (this.pendingScope === scope) {
				this.pendingScope = null;
				this.pendingKey = null;
			}
			transaction.dispose?.();
			scope.dispose();
			throw error;
		}

		const previousScope = this.activeScope;
		this.activeScope = scope;
		this.pendingScope = null;
		this.pendingKey = null;
		this.committedKey = key;
		this.dirty = false;
		previousScope?.dispose();

		return { status: "committed", generation };
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.generation++;
		this.pendingScope?.dispose();
		this.pendingScope = null;
		this.pendingKey = null;
		this.activeScope?.dispose();
		this.activeScope = null;
		this.committedKey = null;
	}

	private isCurrent(generation: number, scope: RenderScope): boolean {
		return !this.disposed &&
			generation === this.generation &&
			this.pendingScope === scope &&
			!scope.signal.aborted;
	}
}

function isAbortError(error: unknown): boolean {
	return error instanceof DOMException && error.name === "AbortError";
}
