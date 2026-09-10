export type ConnectedEditableStatus =
	| "attached"
	| "unchanged"
	| "restored"
	| "failed"
	| "disposed";

export interface ConnectedEditableResult {
	readonly status: ConnectedEditableStatus;
	readonly error?: unknown;
}

export interface ConnectedEditableHostOptions {
	/** Enable editor-specific extensions before the first custom placement. */
	activate?: () => void;
	/** Remove editor-specific extensions after the editor returns to its native origin. */
	deactivate?: () => void;
	/** Request layout measurement after a successful move. */
	requestMeasure?: () => void;
	/** Cleanup/measurement errors are reported without hiding lifecycle state. */
	onCleanupError?: (error: unknown) => void;
}

/**
 * Owns the connected-DOM placement of one live editor node.
 *
 * This primitive deliberately never moves the live node into detached staging.
 * A retained template may build a future placeholder off-DOM, but callers must
 * use `placeAfterCommit()` so the editor is parked at its native connected
 * origin while the static tree commits and is only moved after the placeholder
 * becomes connected.
 */
export class ConnectedEditableHost {
	private readonly ownerDocument: Document;
	private readonly activate?: () => void;
	private readonly deactivate?: () => void;
	private readonly requestMeasure?: () => void;
	private readonly onCleanupError?: (error: unknown) => void;
	private originAnchor: Comment | null = null;
	private currentTarget: HTMLElement | null = null;
	private active = false;
	private disposed = false;

	constructor(
		private readonly liveNode: HTMLElement,
		options: ConnectedEditableHostOptions = {},
	) {
		this.ownerDocument = liveNode.ownerDocument;
		this.activate = options.activate;
		this.deactivate = options.deactivate;
		this.requestMeasure = options.requestMeasure;
		this.onCleanupError = options.onCleanupError;
	}

	get isDisposed(): boolean {
		return this.disposed;
	}

	get isActive(): boolean {
		return this.active;
	}

	get attachedTarget(): HTMLElement | null {
		return this.currentTarget;
	}

	/** Attach directly to an already-connected placeholder. */
	attach(target: HTMLElement): ConnectedEditableResult {
		if (this.disposed) return { status: "disposed" };
		if (this.currentTarget === target && this.liveNode.parentNode === target) {
			return { status: "unchanged" };
		}

		const validationError = this.validateTarget(target, true);
		if (validationError) return { status: "failed", error: validationError };

		const previousTarget = this.getConnectedCurrentTarget();
		const wasActive = this.active;
		try {
			this.ensureOriginAnchor();
			if (!this.active) {
				this.activate?.();
				this.active = true;
			}
			target.appendChild(this.liveNode);
			this.currentTarget = target;
			this.safeRequestMeasure();
			return { status: "attached" };
		} catch (error) {
			this.rollbackPlacement(previousTarget, wasActive);
			return { status: "failed", error };
		}
	}

	/**
	 * Place the live editor into a placeholder that is currently detached but
	 * will be connected by one synchronous static-tree commit.
	 *
	 * The editor is first restored to its native connected origin. The commit
	 * callback then runs with no live editor inside detached/stale custom DOM.
	 * Only after the callback returns successfully and the target is connected
	 * is the editor moved into the new placeholder.
	 */
	placeAfterCommit(target: HTMLElement, commit: () => void): ConnectedEditableResult {
		if (this.disposed) return { status: "disposed" };

		const validationError = this.validateTarget(target, false);
		if (validationError) return { status: "failed", error: validationError };

		const previousTarget = this.getConnectedCurrentTarget();
		const wasActive = this.active;
		try {
			this.ensureOriginAnchor();
			this.moveToOrigin();
			if (!this.active) {
				this.activate?.();
				this.active = true;
			}

			commit();
			if (!target.isConnected) {
				throw new Error("Connected editable commit did not connect its target");
			}
			target.appendChild(this.liveNode);
			this.currentTarget = target;
			this.safeRequestMeasure();
			return { status: "attached" };
		} catch (error) {
			this.rollbackPlacement(previousTarget, wasActive);
			return { status: "failed", error };
		}
	}

	/** Return the editor to its exact native anchor and disable custom extensions. */
	restore(): ConnectedEditableResult {
		if (this.disposed) return { status: "disposed" };
		if (!this.originAnchor && !this.currentTarget && !this.active) {
			return { status: "unchanged" };
		}

		try {
			this.moveToOrigin();
		} catch (error) {
			return { status: "failed", error };
		}

		this.deactivateIfNeeded();
		this.removeOriginAnchor();
		this.safeRequestMeasure();
		return { status: "restored" };
	}

	dispose(): void {
		if (this.disposed) return;
		const result = this.restore();
		if (result.status === "failed") {
			if (result.error !== undefined) this.onCleanupError?.(result.error);
			// The native MarkdownView may already be tearing down. Even when its
			// origin anchor is gone, owner disposal must not retain CM6 extensions
			// or an anchor reference beyond this host's lifetime.
			this.deactivateIfNeeded();
			this.removeOriginAnchor();
		}
		this.disposed = true;
	}

	private validateTarget(target: HTMLElement, requireConnected: boolean): Error | null {
		if (target.ownerDocument !== this.ownerDocument) {
			return new Error("Connected editable target belongs to a different ownerDocument");
		}
		if (target === this.liveNode || this.liveNode.contains(target)) {
			return new Error("Connected editable target cannot be the live node or its descendant");
		}
		if (requireConnected && !target.isConnected) {
			return new Error("Connected editable target must already be connected");
		}
		return null;
	}

	private ensureOriginAnchor(): void {
		if (this.originAnchor) return;
		const parent = this.liveNode.parentNode;
		if (!parent || !this.liveNode.isConnected) {
			throw new Error("Connected editable live node must have a connected native origin");
		}

		const anchor = this.ownerDocument.createComment("morphic-editable-origin");
		parent.insertBefore(anchor, this.liveNode);
		this.originAnchor = anchor;
	}

	private moveToOrigin(): void {
		const anchor = this.originAnchor;
		if (!anchor) return;
		const parent = anchor.parentNode;
		if (!parent || !anchor.isConnected) {
			throw new Error("Connected editable native origin is no longer connected");
		}

		parent.insertBefore(this.liveNode, anchor.nextSibling);
		this.currentTarget = null;
	}

	private getConnectedCurrentTarget(): HTMLElement | null {
		const target = this.currentTarget;
		return target && target.isConnected ? target : null;
	}

	private rollbackPlacement(previousTarget: HTMLElement | null, wasActive: boolean): void {
		let restoredPrevious = false;
		if (previousTarget?.isConnected) {
			try {
				previousTarget.appendChild(this.liveNode);
				this.currentTarget = previousTarget;
				restoredPrevious = true;
			} catch (error) {
				this.onCleanupError?.(error);
			}
		}

		if (!restoredPrevious) {
			try {
				this.moveToOrigin();
			} catch (error) {
				this.onCleanupError?.(error);
			}
		}

		if (!wasActive) {
			this.deactivateIfNeeded();
			if (!restoredPrevious) this.removeOriginAnchor();
		}
		this.safeRequestMeasure();
	}

	private deactivateIfNeeded(): void {
		if (!this.active) return;
		try {
			this.deactivate?.();
		} catch (error) {
			this.onCleanupError?.(error);
		} finally {
			this.active = false;
		}
	}

	private removeOriginAnchor(): void {
		this.originAnchor?.remove();
		this.originAnchor = null;
		if (!this.active) this.currentTarget = null;
	}

	private safeRequestMeasure(): void {
		try {
			this.requestMeasure?.();
		} catch (error) {
			this.onCleanupError?.(error);
		}
	}
}
