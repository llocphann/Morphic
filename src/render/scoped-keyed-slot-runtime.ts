import {
	RetainedDomRuntime,
	type ExplicitRawHtml,
	type RetainedAsyncPatchResult,
	type RetainedDomRuntimeOptions,
	type RetainedIslandPreparationResult,
	type RetainedIslandRenderer,
	type RetainedScalar,
	type RetainedStructureBuilder,
	type RetainedStructureContext,
	type RetainedSyncPatchStatus,
} from "./retained-slot-runtime";
import {
	RetainedKeyedRange,
	type RetainedKey,
	type RetainedKeyedCreateNodes,
	type RetainedKeyedEntry,
	type RetainedKeyedRangeOptions,
	type RetainedKeyedReconcileResult,
} from "./keyed-dom-reconciler";

/**
 * One typed-slot namespace owned by exactly one keyed structural entry.
 *
 * The scope mounts through the already-tested RetainedDomRuntime into a detached
 * host, then detaches the mounted top-level nodes for insertion by
 * RetainedKeyedRange. Binding targets keep their object identity after the nodes
 * move into the live keyed region, so text/attribute/raw/Markdown/content patches
 * continue to address the exact retained targets without adding a wrapper node.
 */
export class RetainedKeyedSlotScope {
	private readonly host: HTMLElement;
	private readonly runtime: RetainedDomRuntime;
	private mountedRoots: readonly Node[] | null = null;
	private disposed = false;

	constructor(
		readonly ownerDocument: Document,
		options: RetainedDomRuntimeOptions = {},
	) {
		this.host = ownerDocument.win.createDiv();
		this.runtime = new RetainedDomRuntime(this.host, options);
	}

	get slotCount(): number {
		return this.runtime.slotCount;
	}

	get isMounted(): boolean {
		return this.mountedRoots !== null;
	}

	get isDisposed(): boolean {
		return this.disposed;
	}

	/**
	 * Builds one immutable static structure for this keyed entry and returns its
	 * now-detached top-level nodes. Each compiler slot id is unique only within
	 * this scope, so separate loop entries may reuse the same ids safely.
	 */
	mount(
		builder: RetainedStructureBuilder,
		structureKey = "keyed-entry",
	): readonly Node[] {
		this.assertAlive();
		if (this.mountedRoots !== null) {
			throw new Error("Retained keyed slot scope structure is already mounted");
		}

		const registeredTargets = new Set<Node>();
		const status = this.runtime.mountStructure(structureKey, (context) => {
			builder(this.trackTargets(context, registeredTargets));
			for (const target of registeredTargets) {
				if (!context.fragment.contains(target)) {
					throw new Error("Retained keyed slot target is not part of its mounted structure");
				}
			}
		});
		if (status !== "mounted") {
			throw new Error(`Unexpected keyed slot mount status: ${status}`);
		}

		const roots = Array.from(this.host.childNodes);
		this.host.replaceChildren();
		this.mountedRoots = roots;
		return roots;
	}

	/** Ensures mounted slot DOM was actually claimed by the keyed entry content. */
	assertClaimedBy(contentRoots: readonly Node[]): void {
		this.assertAlive();
		if (this.mountedRoots === null) return;

		for (const mountedRoot of this.mountedRoots) {
			const claimed = contentRoots.some((contentRoot) =>
				contentRoot === mountedRoot || contentRoot.contains(mountedRoot));
			if (!claimed) {
				throw new Error("Retained keyed slot structure is not owned by its keyed entry");
			}
		}
	}

	patchText(id: string, value: RetainedScalar): RetainedSyncPatchStatus {
		return this.runtime.patchText(id, value);
	}

	patchAttribute(id: string, value: RetainedScalar): RetainedSyncPatchStatus {
		return this.runtime.patchAttribute(id, value);
	}

	patchRawHtml(id: string, value: ExplicitRawHtml): RetainedSyncPatchStatus {
		return this.runtime.patchRawHtml(id, value);
	}

	prepareMarkdown(
		id: string,
		renderKey: string,
		renderer: RetainedIslandRenderer,
	): Promise<RetainedIslandPreparationResult> {
		return this.runtime.prepareMarkdown(id, renderKey, renderer);
	}

	prepareContent(
		id: string,
		renderKey: string,
		renderer: RetainedIslandRenderer,
	): Promise<RetainedIslandPreparationResult> {
		return this.runtime.prepareContent(id, renderKey, renderer);
	}

	patchMarkdown(
		id: string,
		renderKey: string,
		renderer: RetainedIslandRenderer,
	): Promise<RetainedAsyncPatchResult> {
		return this.runtime.patchMarkdown(id, renderKey, renderer);
	}

	patchContent(
		id: string,
		renderKey: string,
		renderer: RetainedIslandRenderer,
	): Promise<RetainedAsyncPatchResult> {
		return this.runtime.patchContent(id, renderKey, renderer);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.runtime.dispose();
		this.mountedRoots = null;
	}

	private assertAlive(): void {
		if (this.disposed) throw new Error("Retained keyed slot scope is disposed");
	}

	private trackTargets(
		context: RetainedStructureContext,
		targets: Set<Node>,
	): RetainedStructureContext {
		return {
			ownerDocument: context.ownerDocument,
			fragment: context.fragment,
			textSlot: (id, initialValue) => {
				const node = context.textSlot(id, initialValue);
				targets.add(node);
				return node;
			},
			attributeSlot: (id, element, attribute) => {
				context.attributeSlot(id, element, attribute);
				targets.add(element);
			},
			rawHtmlSlot: (id, element) => {
				context.rawHtmlSlot(id, element);
				targets.add(element);
			},
			markdownSlot: (id, element) => {
				context.markdownSlot(id, element);
				targets.add(element);
			},
			contentSlot: (id, element) => {
				context.contentSlot(id, element);
				targets.add(element);
			},
		};
	}
}

export interface RetainedScopedKeyedEntry<K extends RetainedKey>
	extends RetainedKeyedEntry<K> {
	readonly slots: RetainedKeyedSlotScope;
}

export interface RetainedScopedKeyedCreateContext<K extends RetainedKey> {
	readonly key: K;
	readonly index: number;
	readonly ownerDocument: Document;
	readonly slots: RetainedKeyedSlotScope;
}

export type RetainedScopedKeyedCreateNodes<K extends RetainedKey> = (
	context: RetainedScopedKeyedCreateContext<K>,
) => ReturnType<RetainedKeyedCreateNodes<K>>;

export interface RetainedScopedKeyedReconcileResult<K extends RetainedKey>
	extends Omit<RetainedKeyedReconcileResult<K>, "entries"> {
	readonly entries: readonly RetainedScopedKeyedEntry<K>[];
}

/**
 * Keyed structural range with one collision-free typed-slot namespace per key.
 *
 * This class composes the generic RetainedKeyedRange rather than modifying it,
 * keeping structural reconciliation and slot patching as independently testable
 * primitives. Entry resources own their slot scope, so removal/disposal also
 * invalidates any pending Markdown/content island generation.
 */
export class RetainedScopedKeyedRange<K extends RetainedKey = RetainedKey> {
	private readonly range: RetainedKeyedRange<K>;
	private readonly scopes = new Map<K, RetainedKeyedSlotScope>();
	private readonly options: RetainedDomRuntimeOptions;

	constructor(
		parent: HTMLElement,
		options: RetainedKeyedRangeOptions = {},
	) {
		this.range = new RetainedKeyedRange(parent, options);
		this.options = { onCleanupError: options.onCleanupError };
	}

	get size(): number {
		return this.range.size;
	}

	get keys(): readonly K[] {
		return this.range.keys;
	}

	get isDisposed(): boolean {
		return this.range.isDisposed;
	}

	entry(key: K): RetainedScopedKeyedEntry<K> | undefined {
		const entry = this.range.entry(key);
		if (!entry) return undefined;
		return this.attachScope(entry);
	}

	nodesFor(key: K): readonly Node[] {
		return this.range.nodesFor(key);
	}

	reconcile(
		keys: readonly K[],
		createNodes: RetainedScopedKeyedCreateNodes<K>,
	): RetainedScopedKeyedReconcileResult<K> {
		const stagedScopes = new Map<K, RetainedKeyedSlotScope>();
		const result = this.range.reconcile(keys, ({ key, index, ownerDocument, resources }) => {
			const slots = new RetainedKeyedSlotScope(ownerDocument, this.options);
			resources.register(() => slots.dispose());
			stagedScopes.set(key, slots);

			const value = createNodes({ key, index, ownerDocument, slots });
			const content = normalizeNodes(value);
			slots.assertClaimedBy(content);
			return value;
		});

		for (const key of result.createdKeys) {
			const scope = stagedScopes.get(key);
			if (!scope) throw new Error(`Missing scoped slot runtime for keyed entry: ${String(key)}`);
			this.scopes.set(key, scope);
		}
		for (const key of result.removedKeys) this.scopes.delete(key);

		return {
			...result,
			entries: result.entries.map((entry) => this.attachScope(entry)),
		};
	}

	dispose(): void {
		this.range.dispose();
		this.scopes.clear();
	}

	private attachScope(entry: RetainedKeyedEntry<K>): RetainedScopedKeyedEntry<K> {
		const slots = this.scopes.get(entry.key);
		if (!slots) throw new Error(`Missing scoped slot runtime for keyed entry: ${String(entry.key)}`);
		return { ...entry, slots };
	}
}

function normalizeNodes(value: Node | readonly Node[] | null | undefined): Node[] {
	if (value === null || value === undefined) return [];
	if (Array.isArray(value)) return Array.from(value as readonly Node[]);
	return [value as Node];
}
