import {
	RetainedResourceScope,
	type RetainedDomRuntimeOptions,
} from "./retained-slot-runtime";

export type RetainedKey = string | number;
export type RetainedKeyedReconcileStatus = "patched" | "unchanged" | "disposed";

export interface RetainedKeyedRangeOptions extends RetainedDomRuntimeOptions {
	/** Insert the region immediately before this existing child; defaults to parent end. */
	readonly before?: Node | null;
	/** Optional comment-anchor label used only for DOM diagnostics. */
	readonly label?: string;
}

export interface RetainedKeyedEntry<K extends RetainedKey> {
	readonly key: K;
	readonly start: Comment;
	readonly end: Comment;
	readonly resources: RetainedResourceScope;
}

export interface RetainedKeyedCreateContext<K extends RetainedKey> {
	readonly key: K;
	readonly index: number;
	readonly ownerDocument: Document;
	readonly resources: RetainedResourceScope;
}

export type RetainedKeyedCreateNodes<K extends RetainedKey> = (
	context: RetainedKeyedCreateContext<K>,
) => Node | readonly Node[] | null | undefined;

export interface RetainedKeyedReconcileResult<K extends RetainedKey> {
	readonly status: RetainedKeyedReconcileStatus;
	readonly entries: readonly RetainedKeyedEntry<K>[];
	readonly createdKeys: readonly K[];
	readonly removedKeys: readonly K[];
}

interface StagedEntry<K extends RetainedKey> {
	readonly entry: RetainedKeyedEntry<K>;
	readonly content: readonly Node[];
}

/**
 * Semantically neutral keyed structural region for retained `{% if %}` / `{% for %}`.
 *
 * The region and every keyed item are delimited by comment anchors rather than
 * wrapper elements. Static siblings outside the region are never replaced.
 * Existing keyed ranges are synchronously moved by node identity; new ranges are
 * built fully detached before any live mutation. No user callback or await runs
 * during the commit phase.
 */
export class RetainedKeyedRange<K extends RetainedKey = RetainedKey> {
	private readonly ownerDocument: Document;
	private readonly onCleanupError?: (error: unknown) => void;
	private readonly regionStart: Comment;
	private readonly regionEnd: Comment;
	private entries = new Map<K, RetainedKeyedEntry<K>>();
	private order: K[] = [];
	private disposed = false;

	constructor(
		private readonly parent: HTMLElement,
		options: RetainedKeyedRangeOptions = {},
	) {
		this.ownerDocument = parent.ownerDocument;
		this.onCleanupError = options.onCleanupError;
		const before = options.before ?? null;
		if (before !== null && before.parentNode !== parent) {
			throw new Error("Keyed region insertion point is not a child of its parent");
		}

		const label = options.label ? `:${options.label}` : "";
		const start = this.ownerDocument.createComment(`morphic-region-start${label}`);
		const end = this.ownerDocument.createComment(`morphic-region-end${label}`);
		try {
			parent.insertBefore(start, before);
			parent.insertBefore(end, before);
		} catch (error) {
			if (start.parentNode === parent) parent.removeChild(start);
			if (end.parentNode === parent) parent.removeChild(end);
			throw error;
		}
		this.regionStart = start;
		this.regionEnd = end;
	}

	get size(): number {
		return this.entries.size;
	}

	get keys(): readonly K[] {
		return [...this.order];
	}

	get isDisposed(): boolean {
		return this.disposed;
	}

	entry(key: K): RetainedKeyedEntry<K> | undefined {
		return this.entries.get(key);
	}

	/** Returns the current live content between the entry's comment anchors. */
	nodesFor(key: K): readonly Node[] {
		const entry = this.entries.get(key);
		if (!entry) return [];
		return this.snapshotEntryRange(entry).slice(1, -1);
	}

	reconcile(
		keys: readonly K[],
		createNodes: RetainedKeyedCreateNodes<K>,
	): RetainedKeyedReconcileResult<K> {
		if (this.disposed) {
			return {
				status: "disposed",
				entries: [],
				createdKeys: [],
				removedKeys: [],
			};
		}

		this.assertUniqueKeys(keys);
		const originalRegionNodes = this.assertLiveIntegrity();
		if (this.sameOrder(keys)) {
			return {
				status: "unchanged",
				entries: this.orderedEntries(),
				createdKeys: [],
				removedKeys: [],
			};
		}

		const staged = new Map<K, StagedEntry<K>>();
		const allStagedNodes = new Set<Node>();
		try {
			for (let index = 0; index < keys.length; index++) {
				const key = keys[index];
				if (this.entries.has(key)) continue;

				const resources = new RetainedResourceScope(this.onCleanupError);
				const entry: RetainedKeyedEntry<K> = {
					key,
					start: this.ownerDocument.createComment(`morphic-key-start:${String(key)}`),
					end: this.ownerDocument.createComment(`morphic-key-end:${String(key)}`),
					resources,
				};
				staged.set(key, { entry, content: [] });

				const content = normalizeNodes(createNodes({
					key,
					index,
					ownerDocument: this.ownerDocument,
					resources,
				}));
				this.assertDetachedOwnedNodes(content, allStagedNodes);
				staged.set(key, { entry, content });
			}

			// A create callback may close over arbitrary code. Detect structural region
			// mutation before commit so the reconciler never builds on corrupted anchors.
			this.assertLiveIntegrity();
		} catch (error) {
			this.disposeStaged(staged);
			throw error;
		}

		const nextEntries = new Map<K, RetainedKeyedEntry<K>>();
		const removedKeys: K[] = [];
		for (const key of keys) {
			const entry = this.entries.get(key) ?? staged.get(key)?.entry;
			if (!entry) {
				this.disposeStaged(staged);
				throw new Error(`Missing staged keyed entry: ${String(key)}`);
			}
			nextEntries.set(key, entry);
		}
		for (const key of this.order) {
			if (!nextEntries.has(key)) removedKeys.push(key);
		}

		try {
			// Move desired ranges to the end of this region in desired order. Existing
			// nodes retain identity; new content enters the live DOM only here.
			for (const key of keys) {
				const existing = this.entries.get(key);
				if (existing) {
					for (const node of this.snapshotEntryRange(existing)) {
						this.parent.insertBefore(node, this.regionEnd);
					}
					continue;
				}

				const created = staged.get(key);
				if (!created) throw new Error(`Missing staged keyed entry: ${String(key)}`);
				this.parent.insertBefore(created.entry.start, this.regionEnd);
				for (const node of created.content) this.parent.insertBefore(node, this.regionEnd);
				this.parent.insertBefore(created.entry.end, this.regionEnd);
			}

			for (const key of removedKeys) {
				const entry = this.entries.get(key);
				if (!entry) continue;
				for (const node of this.snapshotEntryRange(entry)) this.parent.removeChild(node);
			}

			this.assertProjectedIntegrity(keys, nextEntries);
		} catch (error) {
			this.rollbackRegion(originalRegionNodes);
			this.disposeStaged(staged);
			throw error;
		}

		for (const key of removedKeys) this.entries.get(key)?.resources.dispose();

		const createdKeys = keys.filter((key) => staged.has(key));
		this.entries = nextEntries;
		this.order = [...keys];

		return {
			status: "patched",
			entries: this.orderedEntries(),
			createdKeys,
			removedKeys,
		};
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const entry of this.entries.values()) entry.resources.dispose();
		this.entries.clear();
		this.order = [];
	}

	private orderedEntries(): readonly RetainedKeyedEntry<K>[] {
		return this.order
			.map((key) => this.entries.get(key))
			.filter((entry): entry is RetainedKeyedEntry<K> => !!entry);
	}

	private sameOrder(keys: readonly K[]): boolean {
		if (keys.length !== this.order.length) return false;
		for (let index = 0; index < keys.length; index++) {
			if (!sameKey(keys[index], this.order[index])) return false;
		}
		return true;
	}

	private assertUniqueKeys(keys: readonly K[]): void {
		const seen = new Set<K>();
		for (const key of keys) {
			if (seen.has(key)) throw new Error(`Duplicate retained key: ${String(key)}`);
			seen.add(key);
		}
	}

	private assertDetachedOwnedNodes(nodes: readonly Node[], allStagedNodes: Set<Node>): void {
		for (const node of nodes) {
			if (allStagedNodes.has(node)) {
				throw new Error("Keyed entries returned the same staged node more than once");
			}
			allStagedNodes.add(node);

			if (node.ownerDocument !== this.ownerDocument) {
				throw new Error("Keyed entry node belongs to a different document");
			}
			if (node.parentNode !== null) {
				throw new Error("Keyed entry nodes must be detached before reconciliation");
			}
			if (!isSupportedContentNode(node)) {
				throw new Error(`Unsupported keyed entry node type: ${node.nodeType}`);
			}
		}
	}

	/** Validates the currently committed entry partition and returns region content. */
	private assertLiveIntegrity(): Node[] {
		const regionNodes = this.snapshotRegionNodes();
		this.assertProjectedIntegrity(this.order, this.entries);
		return regionNodes;
	}

	private assertProjectedIntegrity(
		order: readonly K[],
		entries: Map<K, RetainedKeyedEntry<K>>,
	): void {
		let cursor = this.regionStart.nextSibling;
		for (const key of order) {
			const entry = entries.get(key);
			if (!entry) throw new Error(`Retained keyed entry is missing: ${String(key)}`);
			if (cursor !== entry.start) {
				throw new Error(`Retained keyed region order is corrupted at key: ${String(key)}`);
			}
			const entryNodes = this.snapshotEntryRange(entry);
			cursor = entryNodes[entryNodes.length - 1].nextSibling;
		}
		if (cursor !== this.regionEnd) throw new Error("Retained keyed region contains unowned nodes");
	}

	private snapshotRegionNodes(): Node[] {
		if (this.regionStart.parentNode !== this.parent || this.regionEnd.parentNode !== this.parent) {
			throw new Error("Retained keyed region anchors are detached");
		}

		const nodes: Node[] = [];
		let current = this.regionStart.nextSibling;
		while (current && current !== this.regionEnd) {
			nodes.push(current);
			current = current.nextSibling;
		}
		if (current !== this.regionEnd) throw new Error("Retained keyed region anchors are out of order");
		return nodes;
	}

	private snapshotEntryRange(entry: RetainedKeyedEntry<K>): Node[] {
		if (entry.start.parentNode !== this.parent || entry.end.parentNode !== this.parent) {
			throw new Error(`Retained keyed range is detached: ${String(entry.key)}`);
		}

		const nodes: Node[] = [];
		let current: Node | null = entry.start;
		while (current) {
			nodes.push(current);
			if (current === entry.end) return nodes;
			if (current === this.regionEnd) break;
			current = current.nextSibling;
		}
		throw new Error(`Retained keyed range is corrupted: ${String(entry.key)}`);
	}

	/** Best-effort synchronous rollback using the original region node identities. */
	private rollbackRegion(originalNodes: readonly Node[]): void {
		try {
			if (this.regionStart.parentNode !== this.parent || this.regionEnd.parentNode !== this.parent) return;
			let current = this.regionStart.nextSibling;
			while (current && current !== this.regionEnd) {
				const next = current.nextSibling;
				this.parent.removeChild(current);
				current = next;
			}
			for (const node of originalNodes) this.parent.insertBefore(node, this.regionEnd);
		} catch (rollbackError) {
			this.onCleanupError?.(rollbackError);
		}
	}

	private disposeStaged(staged: Map<K, StagedEntry<K>>): void {
		for (const created of staged.values()) created.entry.resources.dispose();
		staged.clear();
	}
}

function normalizeNodes(value: Node | readonly Node[] | null | undefined): Node[] {
	if (value === null || value === undefined) return [];
	if (isNodeArray(value)) return Array.from(value);
	return [value];
}

function isNodeArray(value: Node | readonly Node[]): value is readonly Node[] {
	return Array.isArray(value);
}

function sameKey<K extends RetainedKey>(left: K, right: K): boolean {
	return left === right
		|| (typeof left === "number" && typeof right === "number" && Number.isNaN(left) && Number.isNaN(right));
}

function isSupportedContentNode(node: Node): boolean {
	return node.nodeType === 1
		|| node.nodeType === 3
		|| node.nodeType === 8
		|| node.nodeType === 11;
}
