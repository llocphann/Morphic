import { Component } from "obsidian";

/**
 * Lifetime owner for one prepared/committed render.
 * Every resource created by a render should belong to this scope.
 */
export class RenderScope extends Component {
	private readonly abortController = new AbortController();
	private readonly disposers = new Set<() => void>();
	private disposed = false;

	get signal(): AbortSignal {
		return this.abortController.signal;
	}

	get isDisposed(): boolean {
		return this.disposed;
	}

	registerDisposer(disposer: () => void): () => void {
		if (this.disposed) {
			disposer();
			return disposer;
		}
		this.disposers.add(disposer);
		return disposer;
	}

	registerObserver<T extends MutationObserver>(observer: T): T {
		this.registerDisposer(() => observer.disconnect());
		return observer;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.abortController.abort();

		for (const disposer of Array.from(this.disposers)) {
			try {
				disposer();
			} catch {
				// Cleanup must remain best-effort so one broken resource cannot
				// prevent the rest of the render scope from being released.
			}
		}
		this.disposers.clear();
		this.unload();
	}
}
