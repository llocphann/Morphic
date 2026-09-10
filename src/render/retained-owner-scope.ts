import type { RenderScope } from "../core/render-scope";

export interface RetainedDisposable {
	dispose(): void;
}

export interface RetainedOwnerScopeOptions {
	onCleanupError?: (error: unknown) => void;
}

export interface RetainedOwnedHandle<T extends RetainedDisposable> {
	readonly resource: T;
	readonly isDisposed: boolean;
	dispose(): void;
}

type RenderScopeOwner = Pick<RenderScope, "isDisposed" | "registerDisposer">;
type InternalOwnedHandle = RetainedOwnedHandle<RetainedDisposable>;

/**
 * Bridge between one Core V2 RenderScope and Bot 4 retained render resources.
 *
 * The Core owner registers exactly one disposer for this bridge. Any number of
 * retained runtimes/ranges may then be tracked beneath it without adding one
 * RenderScope disposer per island generation or keyed entry.
 */
export class RetainedOwnerScope {
	private readonly handles: InternalOwnedHandle[] = [];
	private readonly onCleanupError?: (error: unknown) => void;
	private disposed = false;

	constructor(
		private readonly owner: RenderScopeOwner,
		options: RetainedOwnerScopeOptions = {},
	) {
		this.onCleanupError = options.onCleanupError;
		owner.registerDisposer(() => this.dispose());
	}

	get isDisposed(): boolean {
		return this.disposed;
	}

	get trackedResourceCount(): number {
		return this.handles.length;
	}

	own<T extends RetainedDisposable>(resource: T): RetainedOwnedHandle<T> {
		let disposed = false;
		let internalHandle: InternalOwnedHandle;

		const handle: RetainedOwnedHandle<T> = {
			resource,
			get isDisposed() {
				return disposed;
			},
			dispose: () => {
				if (disposed) return;
				disposed = true;
				this.removeHandle(internalHandle);
				this.disposeResource(resource);
			},
		};
		internalHandle = handle;

		if (this.disposed || this.owner.isDisposed) {
			handle.dispose();
			return handle;
		}

		this.handles.push(internalHandle);
		return handle;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;

		const handles = this.handles.splice(0).reverse();
		for (const handle of handles) handle.dispose();
	}

	private removeHandle(handle: InternalOwnedHandle): void {
		const index = this.handles.indexOf(handle);
		if (index >= 0) this.handles.splice(index, 1);
	}

	private disposeResource(resource: RetainedDisposable): void {
		try {
			resource.dispose();
		} catch (error) {
			this.reportCleanupError(error);
		}
	}

	private reportCleanupError(error: unknown): void {
		if (!this.onCleanupError) return;
		try {
			this.onCleanupError(error);
		} catch {
			return;
		}
	}
}
