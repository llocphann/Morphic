import type {
	RetainedCommitParticipant,
	RetainedCommitTransaction,
	RetainedCommitTransactionResult,
} from "./retained-commit-transaction";
import type { RetainedKey } from "./keyed-dom-reconciler";
import type { RetainedKeyedSlotScope } from "./scoped-keyed-slot-runtime";
import type {
	RetainedIslandPreparationResult,
	RetainedIslandRenderer,
	RetainedPreparedIslandPatch,
} from "./retained-slot-runtime";

export type RetainedKeyedPreparedIslandKind = "markdown" | "content";

export interface RetainedKeyedPreparedIslandRequest<K extends RetainedKey = RetainedKey> {
	readonly key: K;
	readonly slots: RetainedKeyedSlotScope;
	readonly kind: RetainedKeyedPreparedIslandKind;
	readonly slotId: string;
	readonly renderKey: string;
	readonly renderer: RetainedIslandRenderer;
}

export interface RetainedKeyedPreparedIslandBatchOptions {
	readonly onCleanupError?: (error: unknown) => void;
}

export type RetainedKeyedPreparedIslandBatchTerminalStatus =
	| "unchanged"
	| "stale"
	| "failed"
	| "disposed";

export interface RetainedKeyedPreparedIslandBatchTerminalResult {
	readonly status: RetainedKeyedPreparedIslandBatchTerminalStatus;
	readonly requestCount: number;
	readonly error?: unknown;
}

export interface RetainedKeyedPreparedIslandClaim {
	readonly participantCount: number;
	isCurrent(): boolean;
	toCommitParticipants(): readonly RetainedCommitParticipant[];
	dispose(): void;
}

export type RetainedKeyedPreparedIslandClaimResult =
	| {
		readonly status: "claimed";
		readonly claim: RetainedKeyedPreparedIslandClaim;
	}
	| {
		readonly status: "stale" | "failed" | "disposed";
		readonly error?: unknown;
	};

export interface RetainedPreparedKeyedIslandBatch {
	readonly status: "prepared";
	readonly requestCount: number;
	readonly participantCount: number;
	isCurrent(): boolean;
	claimParticipants(): RetainedKeyedPreparedIslandClaimResult;
	commit(transaction: RetainedCommitTransaction): RetainedCommitTransactionResult;
	dispose(): void;
}

export type RetainedKeyedPreparedIslandBatchResult =
	| RetainedPreparedKeyedIslandBatch
	| RetainedKeyedPreparedIslandBatchTerminalResult;

interface PreparedRequest<K extends RetainedKey> {
	readonly request: RetainedKeyedPreparedIslandRequest<K>;
	readonly result: RetainedIslandPreparationResult;
}

interface ActiveOwnedPreparation {
	readonly generation: number;
	dispose(): void;
}

/**
 * Transactional batch coordinator for Markdown/content islands owned by keyed
 * retained entries.
 *
 * The coordinator deliberately does not evaluate loop expressions or decide
 * production eligibility. Callers first create/retain keyed entry structures,
 * then provide one request per async slot. Every renderer runs against detached
 * staging owned by the entry's RetainedKeyedSlotScope. A successful batch can
 * either commit directly through one RetainedCommitTransaction or transfer its
 * participants to an outer owner transaction together with keyed structure and
 * synchronous slot participants.
 *
 * Correctness contract:
 * - duplicate requests for the same scoped slot fail before rendering;
 * - every scope must belong to this batch ownerDocument;
 * - a newer batch generation supersedes and disposes older unclaimed staging;
 * - claimed work becomes the outer transaction's cleanup responsibility;
 * - one failed/stale/disposed preparation discards every prepared sibling;
 * - live DOM/resource ownership changes only through RetainedCommitTransaction;
 * - rollback preserves each island's exact previous Node/resource identity.
 */
export class RetainedKeyedPreparedIslandBatch<K extends RetainedKey = RetainedKey> {
	private readonly onCleanupError?: (error: unknown) => void;
	private generation = 0;
	private disposed = false;
	private activeOwned: ActiveOwnedPreparation | null = null;

	constructor(
		private readonly ownerDocument: Document,
		options: RetainedKeyedPreparedIslandBatchOptions = {},
	) {
		this.onCleanupError = options.onCleanupError;
	}

	get isDisposed(): boolean {
		return this.disposed;
	}

	async prepare(
		requests: readonly RetainedKeyedPreparedIslandRequest<K>[],
	): Promise<RetainedKeyedPreparedIslandBatchResult> {
		if (this.disposed) return this.terminal("disposed", requests.length);

		this.cancelActiveOwned();
		const generation = ++this.generation;
		const validationError = this.validateRequests(requests);
		if (validationError) return this.terminal("failed", requests.length, validationError);
		if (requests.length === 0) return this.terminal("unchanged", 0);

		const prepared = await Promise.all(requests.map((request) =>
			this.prepareRequest(request, generation)));

		if (!this.isGenerationCurrent(generation)) {
			this.disposePreparedResults(prepared);
			return this.terminal(this.disposed ? "disposed" : "stale", requests.length);
		}

		const failure = prepared.find((item) => item.result.status === "failed");
		if (failure && failure.result.status === "failed") {
			this.disposePreparedResults(prepared);
			return this.terminal("failed", requests.length, failure.result.error);
		}
		if (prepared.some((item) => item.result.status === "disposed")) {
			this.disposePreparedResults(prepared);
			return this.terminal("disposed", requests.length);
		}
		if (prepared.some((item) => item.result.status === "stale")) {
			this.disposePreparedResults(prepared);
			return this.terminal("stale", requests.length);
		}

		const patches = prepared.flatMap((item): RetainedPreparedIslandPatch[] =>
			item.result.status === "prepared" ? [item.result] : []);
		if (patches.length === 0) return this.terminal("unchanged", requests.length);

		return this.createPrepared(requests.length, patches, generation);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.generation += 1;
		this.cancelActiveOwned();
	}

	private async prepareRequest(
		request: RetainedKeyedPreparedIslandRequest<K>,
		generation: number,
	): Promise<PreparedRequest<K>> {
		if (!this.isGenerationCurrent(generation)) {
			return {
				request,
				result: { status: this.disposed ? "disposed" : "stale" },
			};
		}

		const renderer: RetainedIslandRenderer = async (context) => {
			await request.renderer({
				...context,
				isCurrent: () => this.isGenerationCurrent(generation) && context.isCurrent(),
			});
		};

		try {
			const result = request.kind === "markdown"
				? await request.slots.prepareMarkdown(request.slotId, request.renderKey, renderer)
				: await request.slots.prepareContent(request.slotId, request.renderKey, renderer);
			return { request, result };
		} catch (error) {
			return { request, result: { status: "failed", error } };
		}
	}

	private createPrepared(
		requestCount: number,
		patches: readonly RetainedPreparedIslandPatch[],
		generation: number,
	): RetainedPreparedKeyedIslandBatch {
		type Ownership = "owned" | "claimed" | "terminal";
		let ownership: Ownership = "owned";
		const frozenPatches = Object.freeze([...patches]);
		const patchesCurrent = () => this.isGenerationCurrent(generation)
			&& frozenPatches.every((patch) => patch.isCurrent());
		const disposePatches = () => {
			for (const patch of frozenPatches) this.runCleanup(() => patch.dispose());
		};
		const clearActive = () => {
			if (this.activeOwned?.generation === generation) this.activeOwned = null;
		};

		const claimOwned = (): RetainedKeyedPreparedIslandClaimResult => {
			if (ownership !== "owned") return { status: "stale" };
			if (!patchesCurrent()) {
				ownership = "terminal";
				clearActive();
				disposePatches();
				return { status: this.disposed ? "disposed" : "stale" };
			}

			const participants: RetainedCommitParticipant[] = [];
			try {
				for (const patch of frozenPatches) {
					participants.push(patch.toCommitParticipant());
					if (!this.isGenerationCurrent(generation)) {
						ownership = "terminal";
						clearActive();
						this.discardParticipants(participants);
						for (const pending of frozenPatches.slice(participants.length)) {
							this.runCleanup(() => pending.dispose());
						}
						return { status: this.disposed ? "disposed" : "stale" };
					}
				}
			} catch (error) {
				ownership = "terminal";
				clearActive();
				this.discardParticipants(participants);
				for (const pending of frozenPatches.slice(participants.length)) {
					this.runCleanup(() => pending.dispose());
				}
				return { status: "failed", error };
			}

			if (!patchesCurrent()) {
				ownership = "terminal";
				clearActive();
				this.discardParticipants(participants);
				return { status: this.disposed ? "disposed" : "stale" };
			}

			ownership = "claimed";
			clearActive();
			const frozenParticipants = Object.freeze([...participants]);
			let terminal = false;
			return {
				status: "claimed",
				claim: {
					participantCount: frozenParticipants.length,
					isCurrent: () => !terminal
						&& this.isGenerationCurrent(generation)
						&& frozenParticipants.every((participant) => participant.isCurrent()),
					toCommitParticipants: () => frozenParticipants,
					dispose: () => {
						if (terminal) return;
						terminal = true;
						this.discardParticipants(frozenParticipants);
					},
				},
			};
		};

		const result: RetainedPreparedKeyedIslandBatch = {
			status: "prepared",
			requestCount,
			participantCount: frozenPatches.length,
			isCurrent: () => ownership === "owned" && patchesCurrent(),
			claimParticipants: claimOwned,
			commit: (transaction) => {
				const claimed = claimOwned();
				if (claimed.status !== "claimed") {
					return {
						status: claimed.status,
						...(claimed.error === undefined ? {} : { error: claimed.error }),
					};
				}
				const committed = transaction.commit(claimed.claim.toCommitParticipants());
				claimed.claim.dispose();
				return committed;
			},
			dispose: () => {
				if (ownership !== "owned") return;
				ownership = "terminal";
				clearActive();
				disposePatches();
			},
		};

		this.activeOwned = { generation, dispose: () => result.dispose() };
		return result;
	}

	private validateRequests(
		requests: readonly RetainedKeyedPreparedIslandRequest<K>[],
	): Error | null {
		const seen = new Map<RetainedKeyedSlotScope, Set<string>>();
		for (const request of requests) {
			if (request.slots.ownerDocument !== this.ownerDocument) {
				return new Error(
					`Retained keyed island ${String(request.key)}:${request.slotId} belongs to a foreign ownerDocument`,
				);
			}
			let slotIds = seen.get(request.slots);
			if (!slotIds) {
				slotIds = new Set();
				seen.set(request.slots, slotIds);
			}
			if (slotIds.has(request.slotId)) {
				return new Error(
					`Duplicate retained keyed island request for ${String(request.key)}:${request.slotId}`,
				);
			}
			slotIds.add(request.slotId);
		}
		return null;
	}

	private isGenerationCurrent(generation: number): boolean {
		return !this.disposed && generation === this.generation;
	}

	private cancelActiveOwned(): void {
		const active = this.activeOwned;
		if (!active) return;
		this.activeOwned = null;
		active.dispose();
	}

	private disposePreparedResults(results: readonly PreparedRequest<K>[]): void {
		for (const item of results) {
			const result = item.result;
			if (result.status === "prepared") {
				this.runCleanup(() => result.dispose());
			}
		}
	}

	private discardParticipants(participants: readonly RetainedCommitParticipant[]): void {
		for (const participant of participants) {
			this.runCleanup(() => participant.discard());
		}
	}

	private runCleanup(cleanup: () => void): void {
		try {
			cleanup();
		} catch (error) {
			if (!this.onCleanupError) return;
			try {
				this.onCleanupError(error);
			} catch {
				// Diagnostic reporters cannot interrupt batch teardown.
			}
		}
	}

	private terminal(
		status: RetainedKeyedPreparedIslandBatchTerminalStatus,
		requestCount: number,
		error?: unknown,
	): RetainedKeyedPreparedIslandBatchTerminalResult {
		return {
			status,
			requestCount,
			...(error === undefined ? {} : { error }),
		};
	}
}
