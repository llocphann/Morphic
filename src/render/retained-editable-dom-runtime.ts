import {
	ConnectedEditableHost,
	type ConnectedEditableHostOptions,
	type ConnectedEditableResult,
} from "./connected-editable-host";
import {
	RetainedDomRuntime,
	type RetainedDomRuntimeOptions,
	type RetainedStructureContext,
} from "./retained-slot-runtime";

export type RetainedEditableMountStatus = "mounted" | "reused" | "failed" | "disposed";

export interface RetainedEditableMountResult {
	readonly status: RetainedEditableMountStatus;
	readonly error?: unknown;
}

export interface RetainedEditableDomRuntimeOptions {
	readonly retained?: RetainedDomRuntimeOptions;
	readonly editable?: ConnectedEditableHostOptions;
	readonly createPlaceholder?: (ownerDocument: Document) => HTMLElement;
}

export interface RetainedEditableStructureContext extends RetainedStructureContext {
	readonly editablePlaceholder: HTMLElement;
}

export type RetainedEditableStructureBuilder = (
	context: RetainedEditableStructureContext,
) => void;

/**
 * Composite retained runtime for one editable MarkdownView content placement.
 *
 * `RetainedDomRuntime` still owns detached static-tree construction and typed
 * slot lifetimes. `ConnectedEditableHost` still owns the live editor node. This
 * coordinator only defines the commit ordering between them:
 *
 * 1. create the future editable placeholder off-DOM;
 * 2. park the live editor at its native connected origin;
 * 3. synchronously mount the retained static tree;
 * 4. attach the editor only after the future placeholder is connected.
 *
 * The two underlying primitives are composed rather than modified so their
 * already-validated generation/resource semantics remain independent.
 */
export class RetainedEditableDomRuntime {
	readonly retained: RetainedDomRuntime;
	readonly editable: ConnectedEditableHost;

	private readonly createPlaceholder: (ownerDocument: Document) => HTMLElement;
	private currentPlaceholder: HTMLElement | null = null;
	private disposed = false;

	constructor(
		private readonly root: HTMLElement,
		private readonly liveNode: HTMLElement,
		options: RetainedEditableDomRuntimeOptions = {},
	) {
		if (root.ownerDocument !== liveNode.ownerDocument) {
			throw new Error("Retained editable root and live node must share an ownerDocument");
		}
		if (root === liveNode || root.contains(liveNode) || liveNode.contains(root)) {
			throw new Error("Retained editable root and live node must be separate DOM subtrees");
		}

		this.createPlaceholder = options.createPlaceholder ?? ((ownerDocument) => ownerDocument.createElement("div"));
		this.retained = new RetainedDomRuntime(root, options.retained);
		this.editable = new ConnectedEditableHost(liveNode, options.editable);
	}

	get isDisposed(): boolean {
		return this.disposed;
	}

	get currentStructureKey(): string | null {
		return this.retained.currentStructureKey;
	}

	get editablePlaceholder(): HTMLElement | null {
		return this.currentPlaceholder;
	}

	mountStructure(
		structureKey: string,
		builder: RetainedEditableStructureBuilder,
	): RetainedEditableMountResult {
		if (this.disposed || this.editable.isDisposed) return { status: "disposed" };

		if (this.retained.currentStructureKey === structureKey) {
			const placeholder = this.currentPlaceholder;
			if (!this.isLivePlaceholder(placeholder)) {
				return {
					status: "failed",
					error: new Error("Retained editable placeholder is no longer connected to its root"),
				};
			}

			return mapReusePlacement(this.editable.attach(placeholder));
		}

		if (!this.root.isConnected) {
			return {
				status: "failed",
				error: new Error("Retained editable root must be connected before structure commit"),
			};
		}

		let placeholder: HTMLElement;
		try {
			placeholder = this.createPlaceholder(this.root.ownerDocument);
		} catch (error) {
			return { status: "failed", error };
		}

		const placeholderError = this.validateFreshPlaceholder(placeholder);
		if (placeholderError) return { status: "failed", error: placeholderError };

		const previousPlaceholder = this.currentPlaceholder;
		const destructiveIslandTargets: HTMLElement[] = [];
		const placement = this.editable.placeAfterCommit(placeholder, () => {
			const mountStatus = this.retained.mountStructure(structureKey, (context) => {
				builder(this.wrapContext(context, placeholder, destructiveIslandTargets));
				this.assertEditableStructure(context, placeholder, destructiveIslandTargets);
			});

			if (mountStatus === "disposed") {
				throw new Error("Retained editable structure runtime was disposed during commit");
			}
			if (mountStatus !== "mounted") {
				throw new Error(`Unexpected retained editable mount status: ${mountStatus}`);
			}
		});

		if (this.retained.currentStructureKey === structureKey && this.isLivePlaceholder(placeholder)) {
			// Keep the committed target even if the final editor append itself failed.
			// A later same-key call may safely retry attachment without rebuilding the
			// retained tree.
			this.currentPlaceholder = placeholder;
		} else if (this.retained.currentStructureKey !== structureKey) {
			this.currentPlaceholder = previousPlaceholder;
		}

		if (placement.status === "disposed") return { status: "disposed" };
		if (placement.status === "failed") return { status: "failed", error: placement.error };
		return { status: "mounted" };
	}

	restoreEditable(): ConnectedEditableResult {
		if (this.disposed) return { status: "disposed" };
		return this.editable.restore();
	}

	dispose(): void {
		if (this.disposed) return;
		// Restore/deactivate the live editor before retained island resources are
		// released. Owner teardown may remove the retained root immediately after.
		this.editable.dispose();
		this.retained.dispose();
		this.currentPlaceholder = null;
		this.disposed = true;
	}

	private validateFreshPlaceholder(placeholder: HTMLElement): Error | null {
		if (placeholder.ownerDocument !== this.root.ownerDocument) {
			return new Error("Retained editable placeholder belongs to a different ownerDocument");
		}
		if (placeholder.isConnected || placeholder.parentNode) {
			return new Error("Retained editable placeholder factory must return a detached rootless element");
		}
		return null;
	}

	private isLivePlaceholder(placeholder: HTMLElement | null): placeholder is HTMLElement {
		return !!placeholder && placeholder.isConnected && this.root.contains(placeholder);
	}

	private wrapContext(
		context: RetainedStructureContext,
		placeholder: HTMLElement,
		destructiveIslandTargets: HTMLElement[],
	): RetainedEditableStructureContext {
		return {
			...context,
			editablePlaceholder: placeholder,
			rawHtmlSlot: (id, element) => {
				destructiveIslandTargets.push(element);
				context.rawHtmlSlot(id, element);
			},
			markdownSlot: (id, element) => {
				destructiveIslandTargets.push(element);
				context.markdownSlot(id, element);
			},
			contentSlot: (id, element) => {
				destructiveIslandTargets.push(element);
				context.contentSlot(id, element);
			},
		};
	}

	private assertEditableStructure(
		context: RetainedStructureContext,
		placeholder: HTMLElement,
		destructiveIslandTargets: readonly HTMLElement[],
	): void {
		if (!context.fragment.contains(placeholder)) {
			throw new Error("Retained editable builder must place its editablePlaceholder in the staged fragment");
		}

		for (const target of destructiveIslandTargets) {
			if (!context.fragment.contains(target)) {
				throw new Error("Retained editable destructive island target must belong to the staged fragment");
			}
			if (target === placeholder || target.contains(placeholder)) {
				throw new Error("Retained editable placeholder cannot be inside a replace-children island target");
			}
		}
	}
}

function mapReusePlacement(result: ConnectedEditableResult): RetainedEditableMountResult {
	if (result.status === "disposed") return { status: "disposed" };
	if (result.status === "failed") return { status: "failed", error: result.error };
	return { status: "reused" };
}
