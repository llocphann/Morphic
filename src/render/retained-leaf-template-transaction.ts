import {
	RetainedCommitTransaction,
	type RetainedCommitParticipant,
	type RetainedCommitTransactionResult,
} from "./retained-commit-transaction";
import {
	RetainedDomRuntime,
	type RetainedIslandPreparationResult,
	type RetainedIslandRenderer,
	type RetainedPreparedIslandPatch,
	type RetainedScalar,
	type RetainedStructureContext,
	type RetainedSyncPatchStatus,
} from "./retained-slot-runtime";
import {
	RetainedTemplateDomPlan,
	type RetainedTemplateIrLike,
} from "./retained-template-dom-plan";

export interface RetainedLeafAsyncRequest {
	readonly renderKey: string;
	readonly renderer: RetainedIslandRenderer;
}

export type RetainedLeafTemplateInitializeStatus =
	| "mounted"
	| "unchanged"
	| "failed"
	| "disposed";

export interface RetainedLeafTemplateInitializeResult {
	readonly status: RetainedLeafTemplateInitializeStatus;
	readonly error?: unknown;
}

export type RetainedLeafTemplatePreparationStatus =
	| "prepared"
	| "unchanged"
	| "stale"
	| "failed"
	| "disposed";

export interface RetainedLeafTemplatePreparationTerminalResult {
	readonly status: Exclude<RetainedLeafTemplatePreparationStatus, "prepared">;
	readonly error?: unknown;
}

export interface RetainedLeafTemplateParticipantClaim {
	readonly participantCount: number;
	isCurrent(): boolean;
	toCommitParticipants(): readonly RetainedCommitParticipant[];
	dispose(): void;
}

export type RetainedLeafTemplateParticipantClaimResult =
	| { readonly status: "claimed"; readonly claim: RetainedLeafTemplateParticipantClaim }
	| { readonly status: "stale" };

export interface RetainedPreparedLeafTemplateUpdate {
	readonly status: "prepared";
	readonly participantCount: number;
	isCurrent(): boolean;
	claimParticipants(): RetainedLeafTemplateParticipantClaimResult;
	commit(transaction: RetainedCommitTransaction): RetainedCommitTransactionResult;
	dispose(): void;
}

export type RetainedLeafTemplatePreparationResult =
	| RetainedPreparedLeafTemplateUpdate
	| RetainedLeafTemplatePreparationTerminalResult;

export class RetainedLeafTemplateTransactionError extends Error {
	constructor(
		message: string,
		readonly code:
			| "missing-value"
			| "extra-value"
			| "missing-island"
			| "extra-island"
			| "unowned-reuse"
			| "structure-lost"
			| "rollback-failed"
			| "commit-failed",
		readonly path?: string,
	) {
		super(message);
		this.name = "RetainedLeafTemplateTransactionError";
	}
}

type SyncSlotKind = "text" | "attribute";
type AsyncSlotKind = "markdown" | "content";
type EffectiveValue = string | null;

interface SyncSlotSpec {
	readonly id: string;
	readonly kind: SyncSlotKind;
}

interface AsyncSlotSpec {
	readonly id: string;
	readonly kind: AsyncSlotKind;
}

type SyncParticipantState =
	| "prepared"
	| "applying"
	| "applied"
	| "adopted"
	| "rolled-back"
	| "finalized"
	| "discarded";

/**
 * Leaf-only TemplateIR surface that composes synchronous retained slots and
 * prepared Markdown/content islands behind one final owner transaction.
 *
 * Expression evaluation stays outside this class. Callers resolve one complete
 * generation first, initialize the static shell once, then call `prepareUpdate`
 * for reused-structure generations. The returned batch performs no live DOM
 * mutation until its `commit()` is passed an owner-gated
 * `RetainedCommitTransaction`.
 *
 * Structural if/for and raw HTML ranges remain explicit separate surfaces; this
 * class intentionally does not weaken those semantics into string rebuilding.
 */
export class RetainedLeafTemplateTransactionSurface<E = unknown> {
	readonly plan: RetainedTemplateDomPlan<E>;
	readonly structureKey: string;

	private readonly syncSlots: readonly SyncSlotSpec[];
	private readonly asyncSlots: readonly AsyncSlotSpec[];
	private committedValues = new Map<string, EffectiveValue>();
	private initialized = false;
	private poisoned = false;
	private preparationGeneration = 0;
	private commitRevision = 0;

	constructor(
		private readonly runtime: RetainedDomRuntime,
		ir: RetainedTemplateIrLike<E>,
	) {
		this.plan = new RetainedTemplateDomPlan(ir);
		this.structureKey = this.plan.structureKey;
		this.syncSlots = collectSyncSlots(ir);
		this.asyncSlots = collectAsyncSlots(ir);
	}

	get isInitialized(): boolean {
		return this.initialized;
	}

	get isPoisoned(): boolean {
		return this.poisoned;
	}

	/**
	 * Mount the retained static shell and seed synchronous leaf values.
	 *
	 * Production callers should perform first initialization on their detached
	 * owner staging surface. Once initialized, hot-path updates use
	 * `prepareUpdate()` so sync leaves and async islands share one live commit.
	 */
	initialize(values: ReadonlyMap<string, RetainedScalar>): RetainedLeafTemplateInitializeResult {
		if (this.poisoned) {
			return { status: "failed", error: this.poisonedError() };
		}

		let nextValues: Map<string, EffectiveValue>;
		try {
			nextValues = this.snapshotValues(values);
		} catch (error) {
			return { status: "failed", error };
		}

		if (this.initialized) {
			if (this.runtime.currentStructureKey !== this.structureKey) {
				return { status: "failed", error: this.structureLostError() };
			}
			if (mapsEqual(this.committedValues, nextValues)) return { status: "unchanged" };
			return {
				status: "failed",
				error: new RetainedLeafTemplateTransactionError(
					"Retained leaf template is already initialized; use prepareUpdate for live changes",
					"commit-failed",
				),
			};
		}

		if (this.runtime.currentStructureKey === this.structureKey) {
			return {
				status: "failed",
				error: new RetainedLeafTemplateTransactionError(
					"Retained leaf template cannot adopt an already-mounted structure without a value snapshot",
					"unowned-reuse",
				),
			};
		}

		const builder = this.plan.builder();
		try {
			const status = this.runtime.mountStructure(this.structureKey, (context) => {
				builder(this.withInitialValues(context, nextValues));
			});
			if (status === "disposed") return { status: "disposed" };
			if (status === "reused") {
				return {
					status: "failed",
					error: new RetainedLeafTemplateTransactionError(
						"Retained leaf template unexpectedly reused an unowned structure",
						"unowned-reuse",
					),
				};
			}
		} catch (error) {
			return { status: "failed", error };
		}

		this.committedValues = nextValues;
		this.initialized = true;
		this.commitRevision += 1;
		this.preparationGeneration += 1;
		return { status: "mounted" };
	}

	async prepareUpdate(
		values: ReadonlyMap<string, RetainedScalar>,
		islands: ReadonlyMap<string, RetainedLeafAsyncRequest>,
	): Promise<RetainedLeafTemplatePreparationResult> {
		if (this.poisoned) return { status: "failed", error: this.poisonedError() };
		if (!this.initialized) {
			return {
				status: "failed",
				error: new RetainedLeafTemplateTransactionError(
					"Retained leaf template must be initialized before preparing a live update",
					"unowned-reuse",
				),
			};
		}
		if (this.runtime.currentStructureKey !== this.structureKey) {
			return { status: "failed", error: this.structureLostError() };
		}

		let nextValues: Map<string, EffectiveValue>;
		try {
			nextValues = this.snapshotValues(values);
			this.validateIslandRequests(islands);
		} catch (error) {
			return { status: "failed", error };
		}

		const generation = ++this.preparationGeneration;
		const baseRevision = this.commitRevision;
		const preparedIslands: RetainedPreparedIslandPatch[] = [];
		let results: RetainedIslandPreparationResult[];
		try {
			results = await Promise.all(this.asyncSlots.map((slot) => {
				const request = islands.get(slot.id);
				if (!request) throw this.missingIslandError(slot.id);
				return slot.kind === "markdown"
					? this.runtime.prepareMarkdown(slot.id, request.renderKey, request.renderer)
					: this.runtime.prepareContent(slot.id, request.renderKey, request.renderer);
			}));
		} catch (error) {
			if (this.isGenerationCurrent(generation, baseRevision)) {
				for (const prepared of preparedIslands) prepared.dispose();
			}
			return { status: "failed", error };
		}

		// A newer preparation may share the same retained island in-flight promise.
		// Do not dispose stale results here: the newer generation may own the exact
		// same PreparedIslandPatch object until participant claiming happens below.
		if (!this.isGenerationCurrent(generation, baseRevision)) return { status: "stale" };

		let terminalResult: RetainedLeafTemplatePreparationTerminalResult | null = null;
		for (const result of results) {
			if (result.status === "prepared") {
				preparedIslands.push(result);
				continue;
			}
			if (result.status === "unchanged") continue;
			terminalResult ??= { status: result.status, error: result.error };
		}
		if (terminalResult) {
			// Promise.all preserves slot ordering, but preparation happens concurrently.
			// Collect every successful sibling before returning a terminal result so
			// later prepared scopes cannot leak when an earlier slot failed.
			for (const prepared of preparedIslands) prepared.dispose();
			return terminalResult;
		}

		const participants: RetainedCommitParticipant[] = [];
		const syncParticipant = this.createSyncParticipant(nextValues, generation, baseRevision);
		if (syncParticipant) participants.push(syncParticipant);
		participants.push(...preparedIslands.map((prepared) => prepared.toCommitParticipant()));

		if (participants.length === 0) return { status: "unchanged" };

		return this.createPreparedBatch(
			participants,
			generation,
			baseRevision,
		);
	}

	private createPreparedBatch(
		participants: readonly RetainedCommitParticipant[],
		generation: number,
		baseRevision: number,
	): RetainedPreparedLeafTemplateUpdate {
		type OwnerState = "owned" | "claimed" | "terminal";
		let ownerState: OwnerState = "owned";
		const claimedParticipants = Object.freeze([...participants]);
		const isBatchCurrent = () => this.isGenerationCurrent(generation, baseRevision)
			&& participants.every((participant) => participant.isCurrent());
		const discardParticipants = () => {
			for (const participant of participants) participant.discard();
		};

		return {
			status: "prepared",
			participantCount: participants.length,
			isCurrent: () => ownerState === "owned" && isBatchCurrent(),
			claimParticipants: () => {
				if (ownerState !== "owned") return { status: "stale" };
				if (!isBatchCurrent()) {
					ownerState = "terminal";
					discardParticipants();
					return { status: "stale" };
				}

				ownerState = "claimed";
				let claimTerminal = false;
				const claim: RetainedLeafTemplateParticipantClaim = {
					participantCount: claimedParticipants.length,
					isCurrent: () => !claimTerminal
						&& this.isGenerationCurrent(generation, baseRevision)
						&& participants.every((participant) => participant.isCurrent()),
					toCommitParticipants: () => claimedParticipants,
					dispose: () => {
						if (claimTerminal) return;
						claimTerminal = true;
						discardParticipants();
					},
				};
				return { status: "claimed", claim };
			},
			commit: (transaction) => {
				if (ownerState !== "owned") return { status: "stale" };
				if (!isBatchCurrent()) {
					ownerState = "terminal";
					discardParticipants();
					return { status: "stale" };
				}
				const result = transaction.commit(participants);
				ownerState = "terminal";
				return result;
			},
			dispose: () => {
				if (ownerState !== "owned") return;
				ownerState = "terminal";
				discardParticipants();
			},
		};
	}

	private createSyncParticipant(
		nextValues: Map<string, EffectiveValue>,
		generation: number,
		baseRevision: number,
	): RetainedCommitParticipant | null {
		const changed = this.syncSlots.filter(
			(slot) => this.committedValues.get(slot.id) !== nextValues.get(slot.id),
		);
		if (changed.length === 0) return null;

		const previousValues = this.committedValues;
		let state: SyncParticipantState = "prepared";
		const applied: SyncSlotSpec[] = [];

		return {
			isCurrent: () => {
				if (state === "finalized" || state === "discarded" || state === "rolled-back") {
					return false;
				}
				if (!this.initialized || this.poisoned || this.runtime.currentStructureKey !== this.structureKey) {
					return false;
				}
				if (this.preparationGeneration !== generation) return false;
				if (state === "adopted") {
					return this.commitRevision === baseRevision + 1 && this.committedValues === nextValues;
				}
				return this.commitRevision === baseRevision && this.committedValues === previousValues;
			},
			apply: () => {
				if (state !== "prepared") throw new Error("Retained sync leaf participant is not prepared");
				state = "applying";
				for (const slot of changed) {
					// Track before mutation so rollback also owns DOM APIs that throw after
					// partially applying a custom/monkey-patched mutation.
					applied.push(slot);
					const status = this.patchSlot(slot, nextValues.get(slot.id) ?? null);
					if (status === "disposed") throw new Error("Retained runtime was disposed during sync apply");
				}
				state = "applied";
			},
			adopt: () => {
				if (state !== "applied") throw new Error("Retained sync leaf participant is not ready to adopt");
				if (!this.isGenerationCurrent(generation, baseRevision)) {
					throw new Error("Cannot adopt a stale retained sync leaf update");
				}
				this.committedValues = nextValues;
				this.commitRevision = baseRevision + 1;
				state = "adopted";
			},
			rollback: () => {
				if (state !== "applying" && state !== "applied" && state !== "adopted") return;

				if (state === "adopted") {
					if (this.commitRevision !== baseRevision + 1 || this.committedValues !== nextValues) {
						this.poisoned = true;
						throw this.rollbackAdvanceError();
					}
					this.committedValues = previousValues;
					this.commitRevision = baseRevision;
				} else if (this.commitRevision !== baseRevision || this.committedValues !== previousValues) {
					this.poisoned = true;
					throw this.rollbackAdvanceError();
				}

				try {
					for (let index = applied.length - 1; index >= 0; index--) {
						const slot = applied[index];
						const status = this.patchSlot(slot, previousValues.get(slot.id) ?? null);
						if (status === "disposed") throw new Error("Retained runtime was disposed during sync rollback");
					}
				} catch (error) {
					this.poisoned = true;
					throw new RetainedLeafTemplateTransactionError(
						`Retained sync leaf rollback failed: ${describeError(error)}`,
						"rollback-failed",
					);
				}
				state = "rolled-back";
			},
			finalize: () => {
				if (state === "adopted") state = "finalized";
			},
			discard: () => {
				if (state === "prepared" || state === "rolled-back") state = "discarded";
			},
		};
	}

	private snapshotValues(values: ReadonlyMap<string, RetainedScalar>): Map<string, EffectiveValue> {
		const next = new Map<string, EffectiveValue>();
		for (const slot of this.syncSlots) {
			if (!values.has(slot.id)) {
				throw new RetainedLeafTemplateTransactionError(
					`Missing resolved value for retained leaf slot ${slot.id}`,
					"missing-value",
					slot.id,
				);
			}
			const value = values.get(slot.id);
			next.set(slot.id, slot.kind === "text" ? normalizeText(value) : normalizeAttribute(value));
		}
		for (const id of values.keys()) {
			if (next.has(id)) continue;
			throw new RetainedLeafTemplateTransactionError(
				`Unexpected resolved value for retained leaf slot ${id}`,
				"extra-value",
				id,
			);
		}
		return next;
	}

	private validateIslandRequests(islands: ReadonlyMap<string, RetainedLeafAsyncRequest>): void {
		const expected = new Set(this.asyncSlots.map((slot) => slot.id));
		for (const slot of this.asyncSlots) {
			if (!islands.has(slot.id)) throw this.missingIslandError(slot.id);
		}
		for (const id of islands.keys()) {
			if (expected.has(id)) continue;
			throw new RetainedLeafTemplateTransactionError(
				`Unexpected retained async island request ${id}`,
				"extra-island",
				id,
			);
		}
	}

	private withInitialValues(
		context: RetainedStructureContext,
		values: ReadonlyMap<string, EffectiveValue>,
	): RetainedStructureContext {
		return {
			...context,
			textSlot: (id) => context.textSlot(id, values.get(id) ?? ""),
			attributeSlot: (id, element, attribute) => {
				const value = values.get(id) ?? null;
				if (value === null) element.removeAttribute(attribute);
				else element.setAttribute(attribute, value);
				context.attributeSlot(id, element, attribute);
			},
		};
	}

	private patchSlot(slot: SyncSlotSpec, value: EffectiveValue): RetainedSyncPatchStatus {
		if (slot.kind === "text") return this.runtime.patchText(slot.id, value ?? "");
		return this.runtime.patchAttribute(slot.id, value);
	}

	private isGenerationCurrent(generation: number, baseRevision: number): boolean {
		return !this.poisoned
			&& this.initialized
			&& this.runtime.currentStructureKey === this.structureKey
			&& this.preparationGeneration === generation
			&& this.commitRevision === baseRevision;
	}

	private missingIslandError(id: string): RetainedLeafTemplateTransactionError {
		return new RetainedLeafTemplateTransactionError(
			`Missing retained async island request ${id}`,
			"missing-island",
			id,
		);
	}

	private structureLostError(): RetainedLeafTemplateTransactionError {
		return new RetainedLeafTemplateTransactionError(
			"Retained leaf template structure is no longer mounted in its runtime",
			"structure-lost",
		);
	}

	private rollbackAdvanceError(): RetainedLeafTemplateTransactionError {
		return new RetainedLeafTemplateTransactionError(
			"Retained sync leaf state advanced during rollback; outer owner reset is required",
			"rollback-failed",
		);
	}

	private poisonedError(): RetainedLeafTemplateTransactionError {
		return new RetainedLeafTemplateTransactionError(
			"Retained leaf template surface is poisoned after rollback failure",
			"rollback-failed",
		);
	}
}

function collectSyncSlots<E>(ir: RetainedTemplateIrLike<E>): readonly SyncSlotSpec[] {
	const slots: SyncSlotSpec[] = [];
	for (const node of ir.nodes) {
		switch (node.kind) {
			case "text-slot":
			case "expression-slot":
				slots.push({ id: node.id, kind: "text" });
				break;
			case "attribute-slot":
				slots.push({ id: node.id, kind: "attribute" });
				break;
			case "static-fragment":
			case "set":
			case "markdown-slot":
			case "content-slot":
				break;
			case "raw-html-slot":
			case "if":
			case "for":
				// RetainedTemplateDomPlan rejects these before construction completes.
				break;
		}
	}
	return slots;
}

function collectAsyncSlots<E>(ir: RetainedTemplateIrLike<E>): readonly AsyncSlotSpec[] {
	const slots: AsyncSlotSpec[] = [];
	for (const node of ir.nodes) {
		if (node.kind === "markdown-slot") slots.push({ id: node.id, kind: "markdown" });
		if (node.kind === "content-slot") slots.push({ id: node.id, kind: "content" });
	}
	return slots;
}

function normalizeText(value: RetainedScalar): string {
	return value === null || value === undefined ? "" : String(value);
}

function normalizeAttribute(value: RetainedScalar): string | null {
	return value === null || value === undefined ? null : String(value);
}

function mapsEqual(
	left: ReadonlyMap<string, EffectiveValue>,
	right: ReadonlyMap<string, EffectiveValue>,
): boolean {
	if (left.size !== right.size) return false;
	for (const [key, value] of left) {
		if (right.get(key) !== value || !right.has(key)) return false;
	}
	return true;
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
