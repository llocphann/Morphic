import type {
	RetainedCommitParticipant,
	RetainedCommitTransaction,
	RetainedCommitTransactionResult,
} from "./retained-commit-transaction";
import type { ExplicitRawHtml } from "./retained-slot-runtime";

export type RetainedRawHtmlTransactionPreparationStatus =
	| "prepared"
	| "unchanged"
	| "failed"
	| "disposed";

export interface RetainedRawHtmlTransactionTerminalResult {
	readonly status: Exclude<RetainedRawHtmlTransactionPreparationStatus, "prepared">;
	readonly error?: unknown;
}

export interface RetainedPreparedRawHtmlPatch {
	readonly status: "prepared";
	isCurrent(): boolean;
	toCommitParticipant(): RetainedCommitParticipant;
	commit(transaction: RetainedCommitTransaction): RetainedCommitTransactionResult;
	dispose(): void;
}

export type RetainedRawHtmlTransactionPreparationResult =
	| RetainedPreparedRawHtmlPatch
	| RetainedRawHtmlTransactionTerminalResult;

export interface RetainedRawHtmlTransactionRangeOptions {
	/** Insert the raw-HTML region immediately before this existing child. */
	readonly before?: Node | null;
	/** Optional fixed diagnostic label. Never pass raw source here. */
	readonly label?: string;
}

export class RetainedRawHtmlTransactionRangeError extends Error {
	constructor(
		message: string,
		readonly code:
			| "structure-lost"
			| "invalid-staging"
			| "rollback-failed"
			| "commit-failed",
	) {
		super(message);
		this.name = "RetainedRawHtmlTransactionRangeError";
	}
}

type RawParticipantState =
	| "prepared"
	| "applying"
	| "applied"
	| "adopted"
	| "rolled-back"
	| "finalized"
	| "discarded";

/**
 * Anchor-bounded explicit raw-HTML range that can join a retained owner commit.
 *
 * Parsing and node import happen during `prepare()` while every node is detached.
 * Live mutation happens only through the returned commit participant. The
 * participant keeps the exact previous Node objects until the transaction's
 * reversible adoption barrier completes, so a later participant failure restores
 * the last-known-good raw range without reparsing or cloning old DOM.
 */
export class RetainedRawHtmlTransactionRange {
	private readonly ownerDocument: Document;
	private readonly regionStart: Comment;
	private readonly regionEnd: Comment;
	private disposed = false;
	private poisoned = false;
	private committedHtml: string | null = null;
	private committedNodes: readonly Node[] = [];
	private preparationGeneration = 0;
	private commitRevision = 0;

	constructor(
		private readonly parent: HTMLElement,
		options: RetainedRawHtmlTransactionRangeOptions = {},
	) {
		this.ownerDocument = parent.ownerDocument;
		const before = options.before ?? null;
		if (before !== null && before.parentNode !== parent) {
			throw new Error("Raw HTML transaction insertion point is not a child of its parent");
		}

		const label = options.label ? `:${options.label}` : "";
		const start = this.ownerDocument.createComment(`morphic-raw-start${label}`);
		const end = this.ownerDocument.createComment(`morphic-raw-end${label}`);
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

	get currentHtml(): string | null {
		return this.disposed ? null : this.committedHtml;
	}

	/** Current unwrapped live content, excluding Morphic's two fixed anchors. */
	get nodes(): readonly Node[] {
		if (this.disposed) return [];
		return this.snapshotRegionNodes();
	}

	/** Prepare explicit raw HTML, or pass `null` to prepare a range clear. */
	prepare(
		value: ExplicitRawHtml | null,
	): RetainedRawHtmlTransactionPreparationResult {
		if (this.disposed) return { status: "disposed" };
		if (this.poisoned) return { status: "failed", error: this.poisonedError() };

		let baseNodes: Node[];
		try {
			baseNodes = this.snapshotRegionNodes();
		} catch (error) {
			this.poisoned = true;
			return { status: "failed", error };
		}

		// Every valid prepare request is a new generation, even when it resolves to
		// the currently committed value. This prevents an older prepared different
		// value from committing after the owner has already requested "stay as-is".
		const generation = ++this.preparationGeneration;
		const baseRevision = this.commitRevision;
		const previousHtml = this.committedHtml;
		const nextHtml = value?.html ?? null;
		if (nextHtml === previousHtml) return { status: "unchanged" };

		let stagedNodes: Node[];
		try {
			stagedNodes = nextHtml === null
				? []
				: parseExplicitRawHtmlRange(this.ownerDocument, nextHtml);
			this.assertDetachedOwnedNodes(stagedNodes);
		} catch (error) {
			return { status: "failed", error };
		}

		const participant = this.createParticipant({
			baseNodes,
			stagedNodes,
			previousHtml,
			nextHtml,
			generation,
			baseRevision,
		});
		let terminal = false;

		return {
			status: "prepared",
			isCurrent: () => !terminal && participant.isCurrent(),
			toCommitParticipant: () => participant,
			commit: (transaction) => {
				if (terminal) return { status: "stale" };
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

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.preparationGeneration += 1;
		this.committedHtml = null;
		this.committedNodes = [];
	}

	private createParticipant(input: {
		readonly baseNodes: readonly Node[];
		readonly stagedNodes: readonly Node[];
		readonly previousHtml: string | null;
		readonly nextHtml: string | null;
		readonly generation: number;
		readonly baseRevision: number;
	}): RetainedCommitParticipant {
		let state: RawParticipantState = "prepared";
		const { baseNodes, stagedNodes, previousHtml, nextHtml, generation, baseRevision } = input;

		return {
			isCurrent: () => {
				if (state === "finalized" || state === "discarded" || state === "rolled-back") {
					return false;
				}
				if (this.disposed || this.poisoned) return false;
				if (this.preparationGeneration !== generation) return false;

				try {
					const expectedNodes = state === "prepared" ? baseNodes : stagedNodes;
					if (!sameNodes(this.snapshotRegionNodes(), expectedNodes)) return false;
				} catch {
					return false;
				}

				if (state === "adopted") {
					return this.commitRevision === baseRevision + 1
						&& this.committedHtml === nextHtml;
				}
				return this.commitRevision === baseRevision
					&& this.committedHtml === previousHtml;
			},
			apply: () => {
				if (state !== "prepared") {
					throw new RetainedRawHtmlTransactionRangeError(
						"Raw HTML transaction participant is not prepared",
						"commit-failed",
					);
				}
				if (!sameNodes(this.snapshotRegionNodes(), baseNodes)) {
					throw this.structureLostError();
				}
				state = "applying";
				this.replaceRegion(stagedNodes);
				state = "applied";
			},
			adopt: () => {
				if (state !== "applied") {
					throw new RetainedRawHtmlTransactionRangeError(
						"Raw HTML transaction participant is not ready to adopt",
						"commit-failed",
					);
				}
				if (this.disposed
					|| this.poisoned
					|| this.preparationGeneration !== generation
					|| this.commitRevision !== baseRevision
					|| this.committedHtml !== previousHtml
					|| !sameNodes(this.snapshotRegionNodes(), stagedNodes)) {
					throw new RetainedRawHtmlTransactionRangeError(
						"Cannot adopt a stale raw HTML transaction participant",
						"commit-failed",
					);
				}
				this.committedHtml = nextHtml;
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
						throw new RetainedRawHtmlTransactionRangeError(
							`Raw HTML newer-authority restore failed: ${errorMessage(error)}`,
							"rollback-failed",
						);
					}
					state = "rolled-back";
					return;
				}

				if (this.commitRevision !== expectedRevision
					|| (state === "adopted"
						? this.committedHtml !== nextHtml
						: this.committedHtml !== previousHtml)) {
					this.poisoned = true;
					throw this.rollbackAdvanceError();
				}

				try {
					this.replaceRegion(baseNodes);
				} catch (error) {
					this.poisoned = true;
					throw new RetainedRawHtmlTransactionRangeError(
						`Raw HTML rollback failed: ${errorMessage(error)}`,
						"rollback-failed",
					);
				}

				if (state === "adopted") {
					this.committedHtml = previousHtml;
					this.committedNodes = baseNodes;
					this.commitRevision = baseRevision;
				}
				state = "rolled-back";
			},
			finalize: () => {
				if (state !== "adopted") return;
				state = "finalized";
			},
			discard: () => {
				if (state === "finalized" || state === "discarded") return;
				if (state === "applying" || state === "applied" || state === "adopted") {
					throw new RetainedRawHtmlTransactionRangeError(
						"Cannot discard a live raw HTML transaction participant before rollback",
						"commit-failed",
					);
				}
				state = "discarded";
			},
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

	private restoreCommittedAuthority(): void {
		const current = this.snapshotRegionNodes();
		if (sameNodes(current, this.committedNodes)) return;
		this.replaceRegion(this.committedNodes);
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

	private assertDetachedOwnedNodes(nodes: readonly Node[]): void {
		const seen = new Set<Node>();
		for (const node of nodes) {
			if (seen.has(node)) {
				throw new RetainedRawHtmlTransactionRangeError(
					"Raw HTML staging contains the same Node more than once",
					"invalid-staging",
				);
			}
			seen.add(node);
			if (node.ownerDocument !== this.ownerDocument || node.parentNode !== null) {
				throw new RetainedRawHtmlTransactionRangeError(
					"Raw HTML staging nodes must be detached and owned by the range document",
					"invalid-staging",
				);
			}
		}
	}

	private assertDetachedOrLiveOwnedNodes(nodes: readonly Node[]): void {
		for (const node of nodes) {
			if (node.ownerDocument !== this.ownerDocument) {
				throw new RetainedRawHtmlTransactionRangeError(
					"Raw HTML transaction node belongs to a different document",
					"invalid-staging",
				);
			}
			if (node.parentNode !== null && node.parentNode !== this.parent) {
				throw new RetainedRawHtmlTransactionRangeError(
					"Raw HTML transaction node is owned by another parent",
					"invalid-staging",
				);
			}
		}
	}

	private structureLostError(): RetainedRawHtmlTransactionRangeError {
		return new RetainedRawHtmlTransactionRangeError(
			"Retained raw HTML range anchors are detached or out of order",
			"structure-lost",
		);
	}

	private rollbackAdvanceError(): RetainedRawHtmlTransactionRangeError {
		return new RetainedRawHtmlTransactionRangeError(
			"Raw HTML rollback cannot overwrite a newer committed revision",
			"rollback-failed",
		);
	}

	private poisonedError(): RetainedRawHtmlTransactionRangeError {
		return new RetainedRawHtmlTransactionRangeError(
			"Retained raw HTML range is poisoned and requires owner reset",
			"rollback-failed",
		);
	}
}

function parseExplicitRawHtmlRange(ownerDocument: Document, html: string): Node[] {
	const Parser = ownerDocument.defaultView?.DOMParser ?? DOMParser;
	const parsed = new Parser().parseFromString(html, "text/html");
	return [...Array.from(parsed.head.childNodes), ...Array.from(parsed.body.childNodes)]
		.map((node) => ownerDocument.importNode(node, true));
}

function sameNodes(left: readonly Node[], right: readonly Node[]): boolean {
	if (left.length !== right.length) return false;
	for (let index = 0; index < left.length; index++) {
		if (left[index] !== right[index]) return false;
	}
	return true;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
