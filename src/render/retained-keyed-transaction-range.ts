import type {
	RetainedCommitParticipant,
	RetainedCommitTransaction,
	RetainedCommitTransactionResult,
} from "./retained-commit-transaction";
import type { RetainedKey } from "./keyed-dom-reconciler";
import { RetainedKeyedSlotScope } from "./scoped-keyed-slot-runtime";
import type { RetainedDomRuntimeOptions } from "./retained-slot-runtime";

export type RetainedKeyedTransactionPreparationStatus =
	| "prepared"
	| "unchanged"
	| "failed"
	| "disposed";

export interface RetainedKeyedTransactionEntry<K extends RetainedKey> {
	readonly key: K;
	readonly start: Comment;
	readonly end: Comment;
	readonly slots: RetainedKeyedSlotScope;
}

export interface RetainedKeyedTransactionCreateContext<K extends RetainedKey> {
	readonly key: K;
	readonly index: number;
	readonly ownerDocument: Document;
	readonly slots: RetainedKeyedSlotScope;
}

export type RetainedKeyedTransactionCreateNodes<K extends RetainedKey> = (
	context: RetainedKeyedTransactionCreateContext<K>,
) => Node | readonly Node[] | null | undefined;

export interface RetainedKeyedTransactionTerminalResult<K extends RetainedKey> {
	readonly status: Exclude<RetainedKeyedTransactionPreparationStatus, "prepared">;
	readonly entries: readonly RetainedKeyedTransactionEntry<K>[];
	readonly error?: unknown;
}

export interface RetainedPreparedKeyedTransaction<K extends RetainedKey> {
	readonly status: "prepared";
	readonly entries: readonly RetainedKeyedTransactionEntry<K>[];
	readonly createdKeys: readonly K[];
	readonly removedKeys: readonly K[];
	isCurrent(): boolean;
	toCommitParticipant(): RetainedCommitParticipant;
	commit(transaction: RetainedCommitTransaction): RetainedCommitTransactionResult;
	dispose(): void;
}

export type RetainedKeyedTransactionPreparationResult<K extends RetainedKey> =
	| RetainedPreparedKeyedTransaction<K>
	| RetainedKeyedTransactionTerminalResult<K>;

export interface RetainedKeyedTransactionRangeOptions extends RetainedDomRuntimeOptions {
	readonly before?: Node | null;
	readonly label?: string;
}

export class RetainedKeyedTransactionRangeError extends Error {
	constructor(
		message: string,
		readonly code:
			| "duplicate-key"
			| "structure-lost"
			| "invalid-staging"
			| "rollback-failed"
			| "commit-failed",
		readonly cause?: unknown,
	) {
		super(message);
		this.name = "RetainedKeyedTransactionRangeError";
	}
}

interface KeyedTransactionEntry<K extends RetainedKey>
	extends RetainedKeyedTransactionEntry<K> {
	readonly stagedContent: readonly Node[];
}

type KeyedParticipantState =
	| "prepared"
	| "applying"
	| "applied"
	| "adopted"
	| "rolled-back"
	| "finalized"
	| "discarded";

/**
 * Transactional keyed structural range for retained `{% for %}`-like work.
 *
 * New keys are built completely detached in `parent.ownerDocument`, each with a
 * collision-free typed-slot scope. Survivor entry ranges are moved by exact Node
 * identity. Removed scopes remain alive through `apply()`/`adopt()` and become a
 * cleanup debt disposed only after the owner transaction passes its final
 * currentness barrier. Rollback restores exact previous entry ranges/order.
 */
export class RetainedKeyedTransactionRange<K extends RetainedKey = RetainedKey> {
	private readonly ownerDocument: Document;
	private readonly regionStart: Comment;
	private readonly regionEnd: Comment;
	private readonly runtimeOptions: RetainedDomRuntimeOptions;
	private entries = new Map<K, KeyedTransactionEntry<K>>();
	private order: K[] = [];
	private retiredEntries = new Set<KeyedTransactionEntry<K>>();
	private disposed = false;
	private poisoned = false;
	private preparationGeneration = 0;
	private commitRevision = 0;
	private nextEntryId = 1;

	constructor(
		private readonly parent: HTMLElement,
		options: RetainedKeyedTransactionRangeOptions = {},
	) {
		this.ownerDocument = parent.ownerDocument;
		this.runtimeOptions = { onCleanupError: options.onCleanupError };
		const before = options.before ?? null;
		if (before !== null && before.parentNode !== parent) {
			throw new Error("Keyed transaction insertion point is not a child of its parent");
		}

		const label = options.label ? `:${options.label}` : "";
		const start = this.ownerDocument.createComment(`morphic-for-start${label}`);
		const end = this.ownerDocument.createComment(`morphic-for-end${label}`);
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

	get isDisposed(): boolean {
		return this.disposed;
	}

	get isPoisoned(): boolean {
		return this.poisoned;
	}

	get size(): number {
		return this.disposed ? 0 : this.entries.size;
	}

	get keys(): readonly K[] {
		return this.disposed ? [] : [...this.order];
	}

	entry(key: K): RetainedKeyedTransactionEntry<K> | undefined {
		if (this.disposed) return undefined;
		return this.entries.get(key);
	}

	nodesFor(key: K): readonly Node[] {
		if (this.disposed) return [];
		const entry = this.entries.get(key);
		if (!entry) return [];
		return this.snapshotEntryRange(entry).slice(1, -1);
	}

	prepare(
		keys: readonly K[],
		createNodes: RetainedKeyedTransactionCreateNodes<K>,
	): RetainedKeyedTransactionPreparationResult<K> {
		if (this.disposed) return this.terminal("disposed");
		if (this.poisoned) return this.terminal("failed", this.poisonedError());

		const generation = ++this.preparationGeneration;
		try {
			this.assertUniqueKeys(keys);
			this.assertProjectedIntegrity(this.order, this.entries);
		} catch (error) {
			if (error instanceof RetainedKeyedTransactionRangeError
				&& error.code === "structure-lost") {
				this.poisoned = true;
			}
			return this.terminal("failed", error);
		}

		const baseRevision = this.commitRevision;
		const previousEntries = this.entries;
		const previousOrder = this.order;
		const previousRetiredEntries = this.retiredEntries;
		if (sameOrder(keys, previousOrder)) return this.terminal("unchanged");

		const baseRegionNodes = this.snapshotRegionNodes();
		const staged = new Map<K, KeyedTransactionEntry<K>>();
		const allStagedNodes = new Set<Node>();
		try {
			for (let index = 0; index < keys.length; index++) {
				const key = keys[index];
				if (previousEntries.has(key)) continue;

				const slots = new RetainedKeyedSlotScope(this.ownerDocument, this.runtimeOptions);
				const entryId = this.nextEntryId++;
				const entry: KeyedTransactionEntry<K> = {
					key,
					start: this.ownerDocument.createComment(`morphic-for-entry-start:${entryId}`),
					end: this.ownerDocument.createComment(`morphic-for-entry-end:${entryId}`),
					slots,
					stagedContent: [],
				};
				staged.set(key, entry);

				const content = normalizeDetachedNodes(createNodes({
					key,
					index,
					ownerDocument: this.ownerDocument,
					slots,
				}));
				this.assertDetachedOwnedNodes(content, allStagedNodes);
				slots.assertClaimedBy(content);
				staged.set(key, { ...entry, stagedContent: content });
			}
		} catch (error) {
			this.disposeEntries(staged.values());
			return this.terminal("failed", error);
		}

		try {
			// User builders may close over arbitrary code. A staging callback that
			// mutated the live range invalidates retained authority before commit.
			this.assertProjectedIntegrity(previousOrder, previousEntries);
		} catch (error) {
			this.disposeEntries(staged.values());
			this.poisoned = true;
			return this.terminal("failed", error);
		}

		const nextEntries = new Map<K, KeyedTransactionEntry<K>>();
		for (const key of keys) {
			const entry = previousEntries.get(key) ?? staged.get(key);
			if (!entry) {
				this.disposeEntries(staged.values());
				return this.terminal("failed", new RetainedKeyedTransactionRangeError(
					"Missing staged keyed transaction entry",
					"invalid-staging",
				));
			}
			nextEntries.set(key, entry);
		}
		const nextOrder = [...keys];
		const removedEntries: KeyedTransactionEntry<K>[] = [];
		const removedKeys: K[] = [];
		for (const key of previousOrder) {
			if (nextEntries.has(key)) continue;
			const entry = previousEntries.get(key);
			if (!entry) continue;
			removedEntries.push(entry);
			removedKeys.push(key);
		}
		const createdKeys = keys.filter((key) => staged.has(key));
		const nextRetiredEntries = new Set(previousRetiredEntries);
		for (const entry of removedEntries) nextRetiredEntries.add(entry);

		const participant = this.createParticipant({
			baseRegionNodes,
			previousEntries,
			previousOrder,
			previousRetiredEntries,
			nextEntries,
			nextOrder,
			nextRetiredEntries,
			stagedEntries: [...staged.values()],
			removedEntries,
			generation,
			baseRevision,
		});
		let terminal = false;

		return {
			status: "prepared",
			entries: nextOrder.map((key) => nextEntries.get(key)!),
			createdKeys,
			removedKeys,
			isCurrent: () => !terminal && participant.isCurrent(),
			toCommitParticipant: () => participant,
			commit: (transaction) => {
				if (terminal) return { status: this.disposed ? "disposed" : "stale" };
				if (this.disposed) {
					terminal = true;
					participant.discard();
					return { status: "disposed" };
				}
				const result = transaction.commit([participant]);
				terminal = true;
				return result;
			},
			dispose: () => {
				if (terminal) return;
				terminal = true;
				participant.discard();
			},
		};
	}

	clear(): RetainedKeyedTransactionPreparationResult<K> {
		return this.prepare([], () => null);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.preparationGeneration += 1;
		const owned = new Set<KeyedTransactionEntry<K>>([
			...this.entries.values(),
			...this.retiredEntries,
		]);
		this.entries = new Map();
		this.order = [];
		this.retiredEntries = new Set();
		this.disposeEntries(owned);
	}

	private createParticipant(input: {
		readonly baseRegionNodes: readonly Node[];
		readonly previousEntries: Map<K, KeyedTransactionEntry<K>>;
		readonly previousOrder: K[];
		readonly previousRetiredEntries: Set<KeyedTransactionEntry<K>>;
		readonly nextEntries: Map<K, KeyedTransactionEntry<K>>;
		readonly nextOrder: K[];
		readonly nextRetiredEntries: Set<KeyedTransactionEntry<K>>;
		readonly stagedEntries: readonly KeyedTransactionEntry<K>[];
		readonly removedEntries: readonly KeyedTransactionEntry<K>[];
		readonly generation: number;
		readonly baseRevision: number;
	}): RetainedCommitParticipant {
		let state: KeyedParticipantState = "prepared";
		const {
			baseRegionNodes,
			previousEntries,
			previousOrder,
			previousRetiredEntries,
			nextEntries,
			nextOrder,
			nextRetiredEntries,
			stagedEntries,
			generation,
			baseRevision,
		} = input;

		return {
			isCurrent: () => {
				if (state === "rolled-back" || state === "finalized" || state === "discarded") return false;
				if (this.disposed || this.poisoned || this.preparationGeneration !== generation) return false;
				try {
					if (state === "prepared") {
						this.assertProjectedIntegrity(previousOrder, previousEntries);
					} else {
						this.assertProjectedIntegrity(nextOrder, nextEntries);
					}
				} catch {
					return false;
				}

				if (state === "adopted") {
					return this.commitRevision === baseRevision + 1
						&& this.entries === nextEntries
						&& this.order === nextOrder
						&& this.retiredEntries === nextRetiredEntries;
				}
				return this.commitRevision === baseRevision
					&& this.entries === previousEntries
					&& this.order === previousOrder
					&& this.retiredEntries === previousRetiredEntries;
			},
			apply: () => {
				if (state !== "prepared") throw this.commitStateError("apply");
				this.assertProjectedIntegrity(previousOrder, previousEntries);
				state = "applying";
				this.applyProjection(nextOrder, previousEntries, nextEntries);
				state = "applied";
			},
			adopt: () => {
				if (state !== "applied") throw this.commitStateError("adopt");
				if (this.disposed
					|| this.poisoned
					|| this.preparationGeneration !== generation
					|| this.commitRevision !== baseRevision
					|| this.entries !== previousEntries
					|| this.order !== previousOrder
					|| this.retiredEntries !== previousRetiredEntries) {
					throw this.commitStateError("adopt stale work");
				}
				this.assertProjectedIntegrity(nextOrder, nextEntries);
				this.entries = nextEntries;
				this.order = nextOrder;
				this.retiredEntries = nextRetiredEntries;
				this.commitRevision = baseRevision + 1;
				state = "adopted";
			},
			rollback: () => {
				if (state !== "applying" && state !== "applied" && state !== "adopted") return;
				const expectedRevision = state === "adopted" ? baseRevision + 1 : baseRevision;
				if (this.commitRevision > expectedRevision) {
					try {
						this.assertProjectedIntegrity(this.order, this.entries);
					} catch (error) {
						this.poisoned = true;
						throw this.rollbackError("Keyed newer-authority validation failed", error);
					}
					state = "rolled-back";
					return;
				}
				if (this.commitRevision !== expectedRevision) {
					this.poisoned = true;
					throw this.rollbackError("Keyed rollback cannot overwrite a different committed revision");
				}
				if (state !== "applying") {
					try {
						this.assertProjectedIntegrity(nextOrder, nextEntries);
					} catch (error) {
						this.poisoned = true;
						throw this.rollbackError("Keyed rollback lost live mutation authority", error);
					}
				}
				try {
					this.replaceRegion(baseRegionNodes);
					this.assertProjectedIntegrity(previousOrder, previousEntries);
				} catch (error) {
					this.poisoned = true;
					throw this.rollbackError("Keyed rollback failed", error);
				}
				if (state === "adopted") {
					this.entries = previousEntries;
					this.order = previousOrder;
					this.retiredEntries = previousRetiredEntries;
					this.commitRevision = baseRevision;
				}
				state = "rolled-back";
			},
			finalize: () => {
				if (state !== "adopted") return;
				state = "finalized";
				this.disposeEntries(nextRetiredEntries);
				if (this.retiredEntries === nextRetiredEntries) this.retiredEntries = new Set();
			},
			discard: () => {
				if (state === "finalized" || state === "discarded") return;
				if (state === "applying" || state === "applied" || state === "adopted") {
					throw new RetainedKeyedTransactionRangeError(
						"Cannot discard live keyed transaction work before rollback",
						"commit-failed",
					);
				}
				state = "discarded";
				this.disposeUnownedStagedEntries(stagedEntries);
			},
		};
	}

	private applyProjection(
		nextOrder: readonly K[],
		previousEntries: Map<K, KeyedTransactionEntry<K>>,
		nextEntries: Map<K, KeyedTransactionEntry<K>>,
	): void {
		for (const key of nextOrder) {
			const existing = previousEntries.get(key);
			if (existing) {
				for (const node of this.snapshotEntryRange(existing)) {
					this.parent.insertBefore(node, this.regionEnd);
				}
				continue;
			}

			const created = nextEntries.get(key);
			if (!created) throw this.commitStateError("insert missing keyed entry");
			this.parent.insertBefore(created.start, this.regionEnd);
			for (const node of created.stagedContent) this.parent.insertBefore(node, this.regionEnd);
			this.parent.insertBefore(created.end, this.regionEnd);
		}

		for (const [key, entry] of previousEntries) {
			if (nextEntries.has(key)) continue;
			for (const node of this.snapshotEntryRange(entry)) this.parent.removeChild(node);
		}
		this.assertProjectedIntegrity(nextOrder, nextEntries);
	}

	private terminal(
		status: Exclude<RetainedKeyedTransactionPreparationStatus, "prepared">,
		error?: unknown,
	): RetainedKeyedTransactionTerminalResult<K> {
		return {
			status,
			entries: this.disposed ? [] : this.order.map((key) => this.entries.get(key)!),
			...(error === undefined ? {} : { error }),
		};
	}

	private assertUniqueKeys(keys: readonly K[]): void {
		const seen = new Set<K>();
		for (const key of keys) {
			if (seen.has(key)) {
				throw new RetainedKeyedTransactionRangeError(
					"Duplicate retained keyed transaction key",
					"duplicate-key",
				);
			}
			seen.add(key);
		}
	}

	private assertProjectedIntegrity(
		order: readonly K[],
		entries: Map<K, KeyedTransactionEntry<K>>,
	): void {
		if (this.regionStart.parentNode !== this.parent || this.regionEnd.parentNode !== this.parent) {
			throw this.structureLostError();
		}
		let cursor = this.regionStart.nextSibling;
		for (const key of order) {
			const entry = entries.get(key);
			if (!entry || cursor !== entry.start) throw this.structureLostError();
			const range = this.snapshotEntryRange(entry);
			cursor = range[range.length - 1].nextSibling;
		}
		if (cursor !== this.regionEnd) throw this.structureLostError();
	}

	private snapshotRegionNodes(): Node[] {
		if (this.regionStart.parentNode !== this.parent || this.regionEnd.parentNode !== this.parent) {
			throw this.structureLostError();
		}
		const nodes: Node[] = [];
		let current = this.regionStart.nextSibling;
		while (current && current !== this.regionEnd) {
			nodes.push(current);
			current = current.nextSibling;
		}
		if (current !== this.regionEnd) throw this.structureLostError();
		return nodes;
	}

	private snapshotEntryRange(entry: KeyedTransactionEntry<K>): Node[] {
		if (entry.start.parentNode !== this.parent || entry.end.parentNode !== this.parent) {
			throw this.structureLostError();
		}
		const nodes: Node[] = [];
		let current: Node | null = entry.start;
		while (current) {
			nodes.push(current);
			if (current === entry.end) return nodes;
			if (current === this.regionEnd) break;
			current = current.nextSibling;
		}
		throw this.structureLostError();
	}

	private replaceRegion(nodes: readonly Node[]): void {
		for (const node of nodes) {
			if (node.ownerDocument !== this.ownerDocument
				|| (node.parentNode !== null && node.parentNode !== this.parent)) {
				throw new RetainedKeyedTransactionRangeError(
					"Keyed transaction rollback node has invalid ownership",
					"invalid-staging",
				);
			}
		}
		this.snapshotRegionNodes();
		let current = this.regionStart.nextSibling;
		while (current && current !== this.regionEnd) {
			const next = current.nextSibling;
			this.parent.removeChild(current);
			current = next;
		}
		for (const node of nodes) this.parent.insertBefore(node, this.regionEnd);
	}

	private assertDetachedOwnedNodes(nodes: readonly Node[], allStagedNodes: Set<Node>): void {
		for (const node of nodes) {
			if (allStagedNodes.has(node)) {
				throw new RetainedKeyedTransactionRangeError(
					"Keyed transaction entries returned the same staged node more than once",
					"invalid-staging",
				);
			}
			allStagedNodes.add(node);
			if (node.ownerDocument !== this.ownerDocument || node.parentNode !== null) {
				throw new RetainedKeyedTransactionRangeError(
					"Keyed transaction staging nodes must be detached and owned by the range document",
					"invalid-staging",
				);
			}
			if (!isSupportedContentNode(node)) {
				throw new RetainedKeyedTransactionRangeError(
					"Keyed transaction staging returned an unsupported node type",
					"invalid-staging",
				);
			}
		}
	}

	private disposeUnownedStagedEntries(entries: readonly KeyedTransactionEntry<K>[]): void {
		const currentlyOwned = new Set<KeyedTransactionEntry<K>>([
			...this.entries.values(),
			...this.retiredEntries,
		]);
		this.disposeEntries(entries.filter((entry) => !currentlyOwned.has(entry)));
	}

	private disposeEntries(entries: Iterable<KeyedTransactionEntry<K>>): void {
		for (const entry of new Set(entries)) {
			try {
				entry.slots.dispose();
			} catch (error) {
				try {
					this.runtimeOptions.onCleanupError?.(error);
				} catch {
					// Diagnostic reporting must not interrupt retained resource cleanup.
				}
			}
		}
	}

	private structureLostError(): RetainedKeyedTransactionRangeError {
		return new RetainedKeyedTransactionRangeError(
			"Retained keyed transaction range lost structural authority",
			"structure-lost",
		);
	}

	private commitStateError(action: string): RetainedKeyedTransactionRangeError {
		return new RetainedKeyedTransactionRangeError(
			`Keyed transaction participant cannot ${action} from its current state`,
			"commit-failed",
		);
	}

	private rollbackError(message: string, cause?: unknown): RetainedKeyedTransactionRangeError {
		return new RetainedKeyedTransactionRangeError(message, "rollback-failed", cause);
	}

	private poisonedError(): RetainedKeyedTransactionRangeError {
		return new RetainedKeyedTransactionRangeError(
			"Retained keyed transaction range is poisoned and requires owner reset",
			"rollback-failed",
		);
	}
}

function normalizeDetachedNodes(
	value: Node | readonly Node[] | null | undefined,
): Node[] {
	if (value === null || value === undefined) return [];
	const input = Array.isArray(value) ? Array.from(value as readonly Node[]) : [value as Node];
	const nodes: Node[] = [];
	for (const node of input) {
		if (node.nodeType === 11) {
			const children = Array.from(node.childNodes);
			for (const child of children) node.removeChild(child);
			nodes.push(...children);
			continue;
		}
		nodes.push(node);
	}
	return nodes;
}

function sameOrder<K extends RetainedKey>(left: readonly K[], right: readonly K[]): boolean {
	if (left.length !== right.length) return false;
	return left.every((key, index) => sameKey(key, right[index]));
}

function sameKey<K extends RetainedKey>(left: K, right: K): boolean {
	return left === right
		|| (typeof left === "number" && typeof right === "number" && Number.isNaN(left) && Number.isNaN(right));
}

function isSupportedContentNode(node: Node): boolean {
	return node.nodeType === 1 || node.nodeType === 3 || node.nodeType === 8;
}
