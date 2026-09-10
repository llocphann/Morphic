export interface CanvasRenderToken<TNode extends object> {
	readonly node: TNode;
	readonly generation: number;
	isCurrent(): boolean;
}

export type CanvasNodeRenderer<TNode extends object> = (
	token: CanvasRenderToken<TNode>,
) => void | Promise<void>;

export type CanvasRenderErrorHandler<TNode extends object> = (
	error: unknown,
	token: CanvasRenderToken<TNode>,
) => void;

export interface CanvasDirtySchedulerOptions<TNode extends object> {
	/** Queue one unit of scheduler work. Defaults to a microtask for burst coalescing. */
	schedule?: (run: () => void) => void;
	/** Receives renderer failures without creating unhandled rejections or retry loops. */
	onError?: CanvasRenderErrorHandler<TNode>;
}

interface CanvasNodeState {
	requestedGeneration: number;
	running: boolean;
	scheduled: boolean;
}

/**
 * Event-driven dirty scheduler for Canvas node owners.
 *
 * No work occurs until a node is explicitly marked dirty. Synchronous bursts
 * coalesce, at most one renderer invocation is active per node, newer dirtiness
 * invalidates older generation tokens immediately, and released nodes are not
 * strongly retained by the scheduler. Re-adding the same node object while an
 * older renderer is still settling reuses its retired state so the newer render
 * cannot overlap the older invocation.
 *
 * The renderer must check token.isCurrent() immediately before commit.
 */
export class CanvasDirtyScheduler<TNode extends object> {
	private readonly states = new Map<TNode, CanvasNodeState>();
	/**
	 * Released state is weakly retained only to serialize a rapid re-add of the
	 * exact same owner object with an invocation that is still settling.
	 */
	private readonly retiredStates = new WeakMap<TNode, CanvasNodeState>();
	private readonly scheduleWork: (run: () => void) => void;
	private readonly onError?: CanvasRenderErrorHandler<TNode>;
	private disposed = false;

	constructor(
		private readonly renderNode: CanvasNodeRenderer<TNode>,
		options: CanvasDirtySchedulerOptions<TNode> = {},
	) {
		// Do not store native queueMicrotask directly and later invoke it as
		// this.scheduleWork(...). Chromium brand-checks its receiver and throws
		// `TypeError: Illegal invocation` when a native function is rebound as an
		// object method. The wrapper preserves direct-call semantics while keeping
		// the injectable scheduling seam used by tests and certification harnesses.
		this.scheduleWork = options.schedule ?? ((run) => {
			queueMicrotask(run);
		});
		this.onError = options.onError;
	}

	get trackedNodeCount(): number {
		return this.states.size;
	}

	markDirty(node: TNode): number {
		if (this.disposed) return 0;

		let state = this.states.get(node);
		if (!state) {
			state = this.retiredStates.get(node);
			if (state) {
				this.retiredStates.delete(node);
			} else {
				state = {
					requestedGeneration: 0,
					running: false,
					scheduled: false,
				};
			}
			this.states.set(node, state);
		}

		state.requestedGeneration += 1;
		this.scheduleNode(node, state);
		return state.requestedGeneration;
	}

	releaseNode(node: TNode): void {
		const state = this.states.get(node);
		if (!state) return;

		this.states.delete(node);
		this.retiredStates.set(node, state);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.states.clear();
	}

	private scheduleNode(node: TNode, state: CanvasNodeState): void {
		if (this.disposed || state.running || state.scheduled) return;
		if (this.states.get(node) !== state) return;

		state.scheduled = true;
		this.scheduleWork(() => {
			state.scheduled = false;
			if (this.disposed || this.states.get(node) !== state || state.running) return;
			void this.runNode(node, state);
		});
	}

	private async runNode(node: TNode, state: CanvasNodeState): Promise<void> {
		if (this.disposed || state.running || this.states.get(node) !== state) return;

		state.running = true;
		const generation = state.requestedGeneration;
		const token: CanvasRenderToken<TNode> = {
			node,
			generation,
			isCurrent: () =>
				!this.disposed &&
				this.states.get(node) === state &&
				state.requestedGeneration === generation,
		};

		try {
			await this.renderNode(token);
		} catch (error) {
			this.onError?.(error, token);
		} finally {
			state.running = false;
			if (
				!this.disposed &&
				this.states.get(node) === state &&
				state.requestedGeneration !== generation
			) {
				this.scheduleNode(node, state);
			}
		}
	}
}
