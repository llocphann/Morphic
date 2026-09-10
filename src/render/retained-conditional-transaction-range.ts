import type {
	RetainedCommitParticipant,
	RetainedCommitTransaction,
	RetainedCommitTransactionResult,
} from "./retained-commit-transaction";
import type { RetainedKey } from "./keyed-dom-reconciler";
import {
	RetainedKeyedSlotScope,
} from "./scoped-keyed-slot-runtime";
import type {
	RetainedDomRuntimeOptions,
	RetainedStructureBuilder,
} from "./retained-slot-runtime";

export type RetainedConditionalTransactionPreparationStatus =
	| "prepared"
	| "unchanged"
	| "failed"
	| "disposed";

export interface RetainedConditionalTransactionTerminalResult<K extends RetainedKey> {
	readonly status: Exclude<RetainedConditionalTransactionPreparationStatus, "prepared">;
	readonly activeKey: K | null;
	readonly slots: RetainedKeyedSlotScope | null;
	readonly error?: unknown;
}

export interface RetainedPreparedConditionalBranch<K extends RetainedKey> {
	readonly status: "prepared";
	readonly key: K | null;
	readonly slots: RetainedKeyedSlotScope | null;
	isCurrent(): boolean;
	toCommitParticipant(): RetainedCommitParticipant;
	commit(transaction: RetainedCommitTransaction): RetainedCommitTransactionResult;
	dispose(): void;
}

export type RetainedConditionalTransactionPreparationResult<K extends RetainedKey> =
	| RetainedPreparedConditionalBranch<K>
	| RetainedConditionalTransactionTerminalResult<K>;

export interface RetainedConditionalTransactionRangeOptions {
	readonly before?: Node | null;
	readonly label?: string;
	readonly onCleanupError?: (error: unknown) => void;
}

export class RetainedConditionalTransactionRangeError extends Error {
	constructor(
		message: string,
		readonly code:
			| "structure-lost"
			| "invalid-staging"
			| "rollback-failed"
			| "commit-failed",
		readonly cause?: unknown,
	) {
		super(message);
		this.name = "RetainedConditionalTransactionRangeError";
	}
}

type ConditionalParticipantState =
	| "prepared"
	| "applying"
	| "applied"
	| "adopted"
	| "rolled-back"
	| "finalized"
	| "discarded";

/**
 * Anchor-bounded retained conditional region that joins the owner transaction.
 *
 * A branch switch is built entirely off-DOM in its own RetainedKeyedSlotScope.
 * Live nodes move only from `apply()`, reversible branch authority moves only from
 * `adopt()`, and the previous branch scope is disposed only from `finalize()`.
 * This lets `{% if %}` structure participate in the same all-or-rollback barrier
 * as synchronous leaf slots and prepared Markdown/content islands.
 */
export class RetainedConditionalTransactionRange<K extends RetainedKey = RetainedKey> {
	private readonly ownerDocument: Document;
	private readonly regionStart: Comment;
	private readonly regionEnd: Comment;
	private readonly runtimeOptions: RetainedDomRuntimeOptions;
	private disposed = false;
	private poisoned = false;
	private preparationGeneration = 0;
	private commitRevision = 0;
	private committedKey: K | null = null;
	private committedSlots: RetainedKeyedSlotScope | null = null;
	private committedNodes: readonly Node[] = [];

	constructor(
		private readonly parent: HTMLElement,
		options: RetainedConditionalTransactionRangeOptions = {},
	) {
		this.ownerDocument = parent.ownerDocument;
		this.runtimeOptions = { onCleanupError: options.onCleanupError };
		const before = options.before ?? null;
		if (before !== null && before.parentNode !== parent) {
			throw new Error("Conditional transaction insertion point is not a child of its parent");
		}

		const label = options.label ? `:${options.label}` : "";
		const start = this.ownerDocument.createComment(`morphic-if-start${label}`);
		const end = this.ownerDocument.createComment(`morphic-if-end${label}`);
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

	get activeKey(): K | null {
		return this.disposed ? null : this.committedKey;
	}

	get activeSlots(): RetainedKeyedSlotScope | null {
		return this.disposed ? null : this.committedSlots;
	}

	get nodes(): readonly Node[] {
		if (this.disposed) return [];
		return this.snapshotRegionNodes();
	}

	select(
		key: K,
		builder: RetainedStructureBuilder,
	): RetainedConditionalTransactionPreparationResult<K> {
		return this.prepare(key, builder);
	}

	clear(): RetainedConditionalTransactionPreparationResult<K> {
		return this.prepare(null, null);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.preparationGeneration += 1;
		const slots = this.committedSlots;
		this.committedKey = null;
		this.committedSlots = null;
		this.committedNodes = [];
		this.disposeSlots(slots);
	}

	private prepare(
		key: K | null,
		builder: RetainedStructureBuilder | null,
	): RetainedConditionalTransactionPreparationResult<K> {
		if (this.disposed) return this.terminal("disposed");
		if (this.poisoned) return this.terminal("failed", this.poisonedError());

		let baseNodes: Node[];
		try {
			baseNodes = this.snapshotRegionNodes();
			if (!sameNodes(baseNodes, this.committedNodes)) throw this.structureLostError();
		} catch (error) {
			this.poisoned = true;
			return this.terminal("failed", error);
		}

		const generation = ++this.preparationGeneration;
		const baseRevision = this.commitRevision;
		const previousKey = this.committedKey;
		const previousSlots = this.committedSlots;
		if (sameKey(key, previousKey)) {
			return this.terminal("unchanged");
		}

		let nextSlots: RetainedKeyedSlotScope | null = null;
		let stagedNodes: readonly Node[] = [];
		try {
			if (key !== null) {
				if (!builder) {
					throw new RetainedConditionalTransactionRangeError(
						"Conditional branch selection requires a structure builder",
						"invalid-staging",
					);
				}
				nextSlots = new RetainedKeyedSlotScope(this.ownerDocument, this.runtimeOptions);
				stagedNodes = nextSlots.mount(builder, `conditional:${String(key)}`);
				this.assertDetachedOwnedNodes(stagedNodes);
			}
		} catch (error) {
			this.disposeSlots(nextSlots);
			return this.terminal("failed", error);
		}

		const participant = this.createParticipant({
			baseNodes,
			stagedNodes,
			previousKey,
			previousSlots,
			nextKey: key,
			nextSlots,
			generation,
			baseRevision,
		});
		let terminal = false;

		return {
			status: "prepared",
			key,
			slots: nextSlots,
			isCurrent: () => !terminal && participant.isCurrent(),
			toCommitParticipant: () => participant,
			commit: (transaction) => {
				if (terminal) return { status: this.disposed ? "disposed" : "stale" };
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

	private createParticipant(input: {
		readonly baseNodes: readonly Node[];
		readonly stagedNodes: readonly Node[];
		readonly previousKey: K | null;
		readonly previousSlots: RetainedKeyedSlotScope | null;
		readonly nextKey: K | null;
		readonly nextSlots: RetainedKeyedSlotScope | null;
		readonly generation: number;
		readonly baseRevision: number;
	}): RetainedCommitParticipant {
		let state: ConditionalParticipantState = "prepared";
		const {
			baseNodes,
			stagedNodes,
			previousKey,
			previousSlots,
			nextKey,
			nextSlots,
			generation,
			baseRevision,
		} = input;

		return {
			isCurrent: () => {
				if (state === "rolled-back" || state === "finalized" || state === "discarded") return false;
				if (this.disposed || this.poisoned || this.preparationGeneration !== generation) return false;
				try {
					const expectedNodes = state === "prepared" ? baseNodes : stagedNodes;
					if (!sameNodes(this.snapshotRegionNodes(), expectedNodes)) return false;
				} catch {
					return false;
				}

				if (state === "adopted") {
					return this.commitRevision === baseRevision + 1
						&& sameKey(this.committedKey, nextKey)
						&& this.committedSlots === nextSlots;
				}
				return this.commitRevision === baseRevision
					&& sameKey(this.committedKey, previousKey)
					&& this.committedSlots === previousSlots;
			},
			apply: () => {
				if (state !== "prepared") throw this.commitStateError("apply");
				if (!sameNodes(this.snapshotRegionNodes(), baseNodes)) throw this.structureLostError();
				state = "applying";
				this.replaceRegion(stagedNodes);
				state = "applied";
			},
			adopt: () => {
				if (state !== "applied") throw this.commitStateError("adopt");
				if (this.disposed
					|| this.poisoned
					|| this.preparationGeneration !== generation
					|| this.commitRevision !== baseRevision
					|| !sameKey(this.committedKey, previousKey)
					|| this.committedSlots !== previousSlots
					|| !sameNodes(this.snapshotRegionNodes(), stagedNodes)) {
					throw new RetainedConditionalTransactionRangeError(
						"Cannot adopt a stale conditional transaction participant",
						"commit-failed",
					);
				}
				this.committedKey = nextKey;
				this.committedSlots = nextSlots;
				this.committedNodes = stagedNodes;
				this.commitRevision = baseRevision + 1;
				state = "adopted";
			},
			rollback: () => {
				if (state !== "applying" && state !== "applied" && state !== "adopted") return;
				const expectedRevision = state === "adopted" ? baseRevision + 1 : baseRevision;
				if (this.commitRevision > expectedRevision) {
					try {
						this.restoreCommittedAuthority();
					} catch (error) {
						this.poisoned = true;
						throw new RetainedConditionalTransactionRangeError(
							`Conditional newer-authority restore failed: ${errorMessage(error)}`,
							"rollback-failed",
							error,
						);
					}
					state = "rolled-back";
					return;
				}

				if (this.commitRevision !== expectedRevision) {
					this.poisoned = true;
					throw this.rollbackAdvanceError();
				}
				try {
					this.replaceRegion(baseNodes);
				} catch (error) {
					this.poisoned = true;
					throw new RetainedConditionalTransactionRangeError(
						`Conditional rollback failed: ${errorMessage(error)}`,
						"rollback-failed",
						error,
					);
				}
				if (state === "adopted") {
					this.committedKey = previousKey;
					this.committedSlots = previousSlots;
					this.committedNodes = baseNodes;
					this.commitRevision = baseRevision;
				}
				state = "rolled-back";
			},
			finalize: () => {
				if (state !== "adopted") return;
				state = "finalized";
				if (previousSlots !== nextSlots) this.disposeSlots(previousSlots);
			},
			discard: () => {
				if (state === "finalized" || state === "discarded") return;
				if (state === "applying" || state === "applied" || state === "adopted") {
					throw new RetainedConditionalTransactionRangeError(
						"Cannot discard a live conditional participant before rollback",
						"commit-failed",
					);
				}
				state = "discarded";
				if (nextSlots !== this.committedSlots) this.disposeSlots(nextSlots);
			},
		};
	}

	private terminal(
		status: Exclude<RetainedConditionalTransactionPreparationStatus, "prepared">,
		error?: unknown,
	): RetainedConditionalTransactionTerminalResult<K> {
		return {
			status,
			activeKey: this.activeKey,
			slots: this.activeSlots,
			...(error === undefined ? {} : { error }),
		};
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

	private replaceRegion(nodes: readonly Node[]): void {
		this.assertDetachedOrLiveOwnedNodes(nodes);
		this.snapshotRegionNodes();
		let current = this.regionStart.nextSibling;
		while (current && current !== this.regionEnd) {
			const next = current.nextSibling;
			this.parent.removeChild(current);
			current = next;
		}
		for (const node of nodes) this.parent.insertBefore(node, this.regionEnd);
	}

	private restoreCommittedAuthority(): void {
		const live = this.snapshotRegionNodes();
		if (!sameNodes(live, this.committedNodes)) this.replaceRegion(this.committedNodes);
	}

	private assertDetachedOwnedNodes(nodes: readonly Node[]): void {
		const seen = new Set<Node>();
		for (const node of nodes) {
			if (seen.has(node)) {
				throw new RetainedConditionalTransactionRangeError(
					"Conditional staging contains the same Node more than once",
					"invalid-staging",
				);
			}
			seen.add(node);
			if (node.ownerDocument !== this.ownerDocument || node.parentNode !== null) {
				throw new RetainedConditionalTransactionRangeError(
					"Conditional staging nodes must be detached and owned by the range document",
					"invalid-staging",
				);
			}
		}
	}

	private assertDetachedOrLiveOwnedNodes(nodes: readonly Node[]): void {
		for (const node of nodes) {
			if (node.ownerDocument !== this.ownerDocument) {
				throw new RetainedConditionalTransactionRangeError(
					"Conditional transaction node belongs to a different document",
					"invalid-staging",
				);
			}
			if (node.parentNode !== null && node.parentNode !== this.parent) {
				throw new RetainedConditionalTransactionRangeError(
					"Conditional transaction node is owned by another parent",
					"invalid-staging",
				);
			}
		}
	}

	private disposeSlots(slots: RetainedKeyedSlotScope | null): void {
		if (!slots) return;
		try {
			slots.dispose();
		} catch (error) {
			try {
				this.runtimeOptions.onCleanupError?.(error);
			} catch {
				// Diagnostic reporting must not interrupt structural lifecycle cleanup.
			}
		}
	}

	private structureLostError(): RetainedConditionalTransactionRangeError {
		return new RetainedConditionalTransactionRangeError(
			"Retained conditional range anchors are detached or live nodes lost authority",
			"structure-lost",
		);
	}

	private commitStateError(action: string): RetainedConditionalTransactionRangeError {
		return new RetainedConditionalTransactionRangeError(
			`Conditional transaction participant cannot ${action} from its current state`,
			"commit-failed",
		);
	}

	private rollbackAdvanceError(): RetainedConditionalTransactionRangeError {
		return new RetainedConditionalTransactionRangeError(
			"Conditional rollback cannot overwrite a different committed authority",
			"rollback-failed",
		);
	}

	private poisonedError(): RetainedConditionalTransactionRangeError {
		return new RetainedConditionalTransactionRangeError(
			"Retained conditional transaction range is poisoned and requires owner reset",
			"rollback-failed",
		);
	}
}

function sameKey<K extends RetainedKey>(left: K | null, right: K | null): boolean {
	return Object.is(left, right);
}

function sameNodes(left: readonly Node[], right: readonly Node[]): boolean {
	return left.length === right.length && left.every((node, index) => node === right[index]);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
