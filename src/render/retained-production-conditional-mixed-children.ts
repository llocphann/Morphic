import {
	evaluateCompiledExpression,
	type CompiledExpression,
} from "../compiler/expression-compiler";
import type { IfNode } from "../compiler/template-ir";
import type { ExprContext } from "../expression";
import type {
	RetainedCommitParticipant,
	RetainedCommitTransaction,
	RetainedCommitTransactionResult,
} from "./retained-commit-transaction";
import {
	RetainedKeyedPreparedIslandBatch,
	type RetainedKeyedPreparedIslandClaim,
	type RetainedKeyedPreparedIslandRequest,
	type RetainedPreparedKeyedIslandBatch,
} from "./retained-keyed-prepared-island-batch";
import {
	RetainedProductionConditionalMixedBranchPlan,
	inspectRetainedProductionConditionalMixedBranchSupport,
	type RetainedConditionalMixedAsyncSlot,
	type RetainedConditionalMixedBranchEvaluator,
	type RetainedConditionalMixedBranchUnsupportedCode,
	type RetainedConditionalMixedSyncSlot,
} from "./retained-production-conditional-mixed-branch-plan";
import { commitRetainedProductionConditionalPreparedChildren } from "./retained-production-conditional-prepared-children";
import {
	RetainedProductionConditionalSelector,
	type RetainedPreparedProductionConditional,
} from "./retained-production-conditional-selector";
import type {
	RetainedPreparedProductionConditionalSyncChildren,
	RetainedProductionConditionalSyncParticipantClaim,
} from "./retained-production-conditional-sync-children";
import type { RetainedIslandRenderer, RetainedScalar } from "./retained-slot-runtime";
import type { RetainedKeyedSlotScope } from "./scoped-keyed-slot-runtime";

export type RetainedProductionConditionalMixedChildrenFallbackCode =
	RetainedConditionalMixedBranchUnsupportedCode;

export interface RetainedProductionConditionalMixedChildrenFallback {
	readonly status: "fallback";
	readonly code: RetainedProductionConditionalMixedChildrenFallbackCode;
	readonly path: string;
	readonly message: string;
}

export type RetainedProductionConditionalMixedChildrenTerminalStatus =
	| "unchanged"
	| "stale"
	| "failed"
	| "disposed";

export interface RetainedProductionConditionalMixedChildrenTerminalResult {
	readonly status: RetainedProductionConditionalMixedChildrenTerminalStatus;
	readonly selectedIndex: number | null;
	readonly error?: unknown;
}

export interface RetainedProductionConditionalMixedIslandContext {
	readonly selectedIndex: number;
	readonly slot: RetainedConditionalMixedAsyncSlot;
	readonly expression: CompiledExpression;
	readonly value: string;
	readonly slots: RetainedKeyedSlotScope;
	isCurrent(): boolean;
}

export interface RetainedProductionConditionalMixedIslandBinding {
	readonly renderKey: string;
	readonly renderer: RetainedIslandRenderer;
}

export type RetainedProductionConditionalMixedIslandFactory = (
	context: RetainedProductionConditionalMixedIslandContext,
) => RetainedProductionConditionalMixedIslandBinding;

export interface RetainedProductionConditionalMixedChildrenRequest {
	readonly node: IfNode;
	readonly sourceHash: string;
	readonly expressionContext: ExprContext;
	readonly createIsland: RetainedProductionConditionalMixedIslandFactory;
}

export interface RetainedProductionConditionalMixedChildrenOptions {
	readonly evaluateExpression?: RetainedConditionalMixedBranchEvaluator;
	readonly onCleanupError?: (error: unknown) => void;
}

export interface RetainedPreparedProductionConditionalMixedChildren {
	readonly status: "prepared";
	readonly selectedIndex: number | null;
	readonly participantCount: number;
	readonly syncParticipantCount: number;
	readonly islandParticipantCount: number;
	isCurrent(): boolean;
	commit(transaction: RetainedCommitTransaction): RetainedCommitTransactionResult;
	dispose(): void;
}

export type RetainedProductionConditionalMixedChildrenPreparationResult =
	| RetainedPreparedProductionConditionalMixedChildren
	| RetainedProductionConditionalMixedChildrenTerminalResult
	| RetainedProductionConditionalMixedChildrenFallback;

type PatchParticipantState =
	| "prepared"
	| "applying"
	| "applied"
	| "adopted"
	| "rolled-back"
	| "finalized"
	| "discarded";

type SnapshotParticipantState =
	| "prepared"
	| "applied"
	| "adopted"
	| "rolled-back"
	| "finalized"
	| "discarded";

/**
 * Capability layer for retained `{% if %}` branches that mix synchronous leaves
 * with Markdown/content islands.
 *
 * Branch selection, detached structure ownership, synchronous values, and async
 * island staging are deliberately kept separate until every child has prepared.
 * The resulting sources are committed only through the corrected combined child
 * transaction, so branch structure/value and Markdown/content ownership cannot
 * publish independently.
 *
 * The owner remains authoritative for Markdown/content identity and rendering:
 * `createIsland()` receives the evaluated branch-local string plus selected slot
 * scope and returns the exact renderKey/renderer to stage. This layer does not
 * invent sourcePath, revision identity, or Obsidian renderer resources.
 */
export class RetainedProductionConditionalMixedChildren {
	private readonly selector: RetainedProductionConditionalSelector;
	private readonly islands: RetainedKeyedPreparedIslandBatch<number>;
	private readonly evaluateExpression: RetainedConditionalMixedBranchEvaluator;
	private readonly onCleanupError?: (error: unknown) => void;
	private readonly ownerDocument: Document;
	private preparationGeneration = 0;
	private committedIndex: number | null = null;
	private committedSyncValues = new Map<string, string>();
	private disposed = false;

	constructor(
		parent: HTMLElement,
		options: RetainedProductionConditionalMixedChildrenOptions = {},
	) {
		this.ownerDocument = parent.ownerDocument;
		this.evaluateExpression = options.evaluateExpression ?? evaluateCompiledExpression;
		this.onCleanupError = options.onCleanupError;
		this.selector = new RetainedProductionConditionalSelector(parent, {
			evaluateExpression: this.evaluateExpression,
			onCleanupError: options.onCleanupError,
		});
		this.islands = new RetainedKeyedPreparedIslandBatch<number>(this.ownerDocument, {
			onCleanupError: options.onCleanupError,
		});
	}

	get isDisposed(): boolean {
		return this.disposed;
	}

	get activeIndex(): number | null {
		return this.selector.activeIndex;
	}

	get activeSlots(): RetainedKeyedSlotScope | null {
		return this.selector.activeSlots;
	}

	get nodes(): readonly Node[] {
		return this.selector.nodes;
	}

	async prepare(
		request: RetainedProductionConditionalMixedChildrenRequest,
	): Promise<RetainedProductionConditionalMixedChildrenPreparationResult> {
		if (this.disposed) return this.terminal("disposed");

		const generation = ++this.preparationGeneration;
		// A newer request with no async leaves (or an invalid/fallback request) must
		// still supersede any older unclaimed island staging.
		await this.islands.prepare([]);
		if (!this.isPreparationCurrent(generation)) {
			return this.terminal(this.disposed ? "disposed" : "stale");
		}

		const plans: RetainedProductionConditionalMixedBranchPlan[] = [];
		for (let branchIndex = 0; branchIndex < request.node.branches.length; branchIndex++) {
			const children = request.node.branches[branchIndex].children;
			const support = inspectRetainedProductionConditionalMixedBranchSupport(children);
			if (!support.supported) {
				return {
					status: "fallback",
					code: support.code,
					path: `branches[${branchIndex}].${support.path}`,
					message: `branches[${branchIndex}].${support.message}`,
				};
			}
			try {
				plans.push(new RetainedProductionConditionalMixedBranchPlan(
					this.ownerDocument,
					request.sourceHash,
					branchIndex,
					children,
				));
			} catch (error) {
				return this.terminal("failed", error);
			}
		}

		const selection = await this.selector.prepare(
			request.node,
			request.expressionContext,
			(_branch, index) => plans[index].builder(),
		);
		if (!this.isPreparationCurrent(generation)) {
			if (selection.status === "prepared") this.runCleanup(() => selection.dispose());
			return this.terminal(this.disposed ? "disposed" : "stale");
		}
		if (selection.status === "failed") {
			return this.terminal("failed", selection.error, selection.selectedIndex);
		}
		if (selection.status === "stale" || selection.status === "disposed") {
			return this.terminal(selection.status, undefined, selection.selectedIndex);
		}

		const selectedIndex = selection.selectedIndex;
		if (selectedIndex === null) {
			if (selection.status !== "prepared") {
				return this.terminal(selection.status, selection.error, null);
			}
			const isCurrent = () => this.isPreparationCurrent(generation) && selection.isCurrent();
			const sync = this.createBranchChangeSync(
				selection,
				null,
				new Map(),
				generation,
			);
			return this.wrapPrepared(sync, createNoopPreparedIslands(isCurrent), null);
		}

		const slots = selection.slots;
		if (!slots) {
			if (selection.status === "prepared") this.runCleanup(() => selection.dispose());
			return this.terminal(
				"failed",
				new Error("Selected conditional mixed branch has no retained slot scope"),
				selectedIndex,
			);
		}
		const plan = plans[selectedIndex];
		if (!plan) {
			if (selection.status === "prepared") this.runCleanup(() => selection.dispose());
			return this.terminal(
				"failed",
				new Error(`Missing retained conditional mixed branch plan: ${selectedIndex}`),
				selectedIndex,
			);
		}

		const selectionCurrent = selection.status === "prepared"
			? () => this.isPreparationCurrent(generation) && selection.isCurrent()
			: () => this.isPreparationCurrent(generation)
				&& this.selector.activeIndex === selectedIndex
				&& this.selector.activeSlots === slots;
		const evaluated = await plan.evaluate(
			request.expressionContext,
			this.evaluateExpression,
			selectionCurrent,
		);
		if (evaluated.status === "stale") {
			if (selection.status === "prepared") this.runCleanup(() => selection.dispose());
			return this.terminal(this.disposed ? "disposed" : "stale", undefined, selectedIndex);
		}
		if (evaluated.status === "failed") {
			if (selection.status === "prepared") this.runCleanup(() => selection.dispose());
			return this.terminal("failed", evaluated.error, selectedIndex);
		}

		let sync: RetainedPreparedProductionConditionalSyncChildren;
		if (selection.status === "prepared") {
			try {
				seedDetachedSyncValues(slots, plan.syncSlots, evaluated.syncValues);
			} catch (error) {
				this.runCleanup(() => selection.dispose());
				return this.terminal("failed", error, selectedIndex);
			}
			sync = this.createBranchChangeSync(
				selection,
				selectedIndex,
				evaluated.syncValues,
				generation,
			);
		} else {
			if (this.committedIndex !== selectedIndex || this.selector.activeSlots !== slots) {
				return this.terminal(
					"failed",
					new Error("Retained conditional mixed child snapshot does not match active branch authority"),
					selectedIndex,
				);
			}
			sync = this.createSameActiveSync(
				slots,
				plan.syncSlots,
				evaluated.syncValues,
				selectedIndex,
				generation,
				selectionCurrent,
			);
		}

		let islandRequests: RetainedKeyedPreparedIslandRequest<number>[];
		try {
			islandRequests = plan.asyncSlots.map((slot) => {
				const value = evaluated.asyncValues.get(slot.id) ?? "";
				const binding = request.createIsland({
					selectedIndex,
					slot,
					expression: slot.expression,
					value,
					slots,
					isCurrent: selectionCurrent,
				});
				if (!binding || typeof binding.renderKey !== "string" || typeof binding.renderer !== "function") {
					throw new Error(`Invalid retained conditional island binding: ${slot.id}`);
				}
				const renderer: RetainedIslandRenderer = async (context) => {
					await binding.renderer({
						...context,
						isCurrent: () => selectionCurrent() && context.isCurrent(),
					});
				};
				return {
					key: selectedIndex,
					slots,
					kind: slot.kind,
					slotId: slot.id,
					renderKey: binding.renderKey,
					renderer,
				};
			});
		} catch (error) {
			this.runCleanup(() => sync.dispose());
			return this.terminal("failed", error, selectedIndex);
		}

		const islandResult = await this.islands.prepare(islandRequests);
		if (!selectionCurrent()) {
			if (islandResult.status === "prepared") this.runCleanup(() => islandResult.dispose());
			this.runCleanup(() => sync.dispose());
			return this.terminal(this.disposed ? "disposed" : "stale", undefined, selectedIndex);
		}
		if (islandResult.status !== "prepared") {
			if (islandResult.status === "failed") {
				this.runCleanup(() => sync.dispose());
				return this.terminal("failed", islandResult.error, selectedIndex);
			}
			if (islandResult.status === "stale" || islandResult.status === "disposed") {
				this.runCleanup(() => sync.dispose());
				return this.terminal(islandResult.status, undefined, selectedIndex);
			}
			if (sync.participantCount === 0) {
				this.runCleanup(() => sync.dispose());
				return this.terminal("unchanged", undefined, selectedIndex);
			}
			return this.wrapPrepared(sync, createNoopPreparedIslands(selectionCurrent), selectedIndex);
		}

		return this.wrapPrepared(sync, islandResult, selectedIndex);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.preparationGeneration += 1;
		this.runCleanup(() => this.islands.dispose());
		this.runCleanup(() => this.selector.dispose());
		this.committedIndex = null;
		this.committedSyncValues.clear();
	}

	private createBranchChangeSync(
		selection: RetainedPreparedProductionConditional,
		nextIndex: number | null,
		nextValues: ReadonlyMap<string, string>,
		generation: number,
	): RetainedPreparedProductionConditionalSyncChildren {
		const structural = selection.toCommitParticipant();
		const snapshot = this.createSnapshotParticipant(
			nextIndex,
			nextValues,
			generation,
			() => selection.isCurrent(),
		);
		return this.createPreparedSync(
			[structural, snapshot],
			generation,
			nextIndex,
			() => selection.isCurrent(),
			[() => selection.dispose()],
		);
	}

	private createSameActiveSync(
		slots: RetainedKeyedSlotScope,
		specs: readonly RetainedConditionalMixedSyncSlot[],
		nextValues: ReadonlyMap<string, string>,
		selectedIndex: number,
		generation: number,
		isSelectionCurrent: () => boolean,
	): RetainedPreparedProductionConditionalSyncChildren {
		if (mapsEqual(this.committedSyncValues, nextValues)) {
			return this.createPreparedSync(
				[],
				generation,
				selectedIndex,
				isSelectionCurrent,
				[],
			);
		}
		const participant = this.createLivePatchParticipant(
			slots,
			specs,
			nextValues,
			selectedIndex,
			generation,
		);
		return this.createPreparedSync(
			[participant],
			generation,
			selectedIndex,
			isSelectionCurrent,
			[],
		);
	}

	private createLivePatchParticipant(
		slots: RetainedKeyedSlotScope,
		specs: readonly RetainedConditionalMixedSyncSlot[],
		nextValues: ReadonlyMap<string, string>,
		selectedIndex: number,
		generation: number,
	): RetainedCommitParticipant {
		const previousValues = new Map(this.committedSyncValues);
		const changed = specs.filter((spec) => previousValues.get(spec.id) !== nextValues.get(spec.id));
		const applied: RetainedConditionalMixedSyncSlot[] = [];
		let state: PatchParticipantState = "prepared";
		let snapshotAdopted = false;
		const patch = (spec: RetainedConditionalMixedSyncSlot, value: string): void => {
			const status = spec.kind === "text"
				? slots.patchText(spec.id, value)
				: slots.patchAttribute(spec.id, value);
			if (status === "disposed") {
				throw new Error(`Retained conditional mixed slot ${spec.id} was disposed during live patch`);
			}
		};

		return {
			isCurrent: () => state !== "finalized"
				&& state !== "discarded"
				&& this.isPreparationCurrent(generation)
				&& this.selector.activeIndex === selectedIndex
				&& this.selector.activeSlots === slots,
			apply: () => {
				if (state !== "prepared") throw new Error("Conditional mixed sync patch is not prepared");
				state = "applying";
				for (const spec of changed) {
					patch(spec, nextValues.get(spec.id) ?? "");
					applied.push(spec);
				}
				state = "applied";
			},
			adopt: () => {
				if (state !== "applied") throw new Error("Conditional mixed sync patch was not applied");
				this.committedIndex = selectedIndex;
				this.committedSyncValues = new Map(nextValues);
				snapshotAdopted = true;
				state = "adopted";
			},
			rollback: () => {
				if (state !== "applying" && state !== "applied" && state !== "adopted") return;
				for (let index = applied.length - 1; index >= 0; index--) {
					const spec = applied[index];
					patch(spec, previousValues.get(spec.id) ?? "");
				}
				if (snapshotAdopted) {
					this.committedIndex = selectedIndex;
					this.committedSyncValues = previousValues;
					snapshotAdopted = false;
				}
				state = "rolled-back";
			},
			finalize: () => {
				if (state === "adopted") state = "finalized";
			},
			discard: () => {
				if (state === "finalized" || state === "discarded") return;
				state = "discarded";
			},
		};
	}

	private createSnapshotParticipant(
		nextIndex: number | null,
		nextValues: ReadonlyMap<string, string>,
		generation: number,
		isStructuralCurrent: () => boolean,
	): RetainedCommitParticipant {
		const previousIndex = this.committedIndex;
		const previousValues = new Map(this.committedSyncValues);
		let state: SnapshotParticipantState = "prepared";
		return {
			isCurrent: () => state !== "finalized"
				&& state !== "discarded"
				&& this.isPreparationCurrent(generation)
				&& isStructuralCurrent(),
			apply: () => {
				if (state !== "prepared") throw new Error("Conditional mixed snapshot is not prepared");
				state = "applied";
			},
			adopt: () => {
				if (state !== "applied") throw new Error("Conditional mixed snapshot was not applied");
				this.committedIndex = nextIndex;
				this.committedSyncValues = new Map(nextValues);
				state = "adopted";
			},
			rollback: () => {
				if (state === "adopted") {
					this.committedIndex = previousIndex;
					this.committedSyncValues = previousValues;
				}
				if (state === "applied" || state === "adopted") state = "rolled-back";
			},
			finalize: () => {
				if (state === "adopted") state = "finalized";
			},
			discard: () => {
				if (state === "finalized" || state === "discarded") return;
				state = "discarded";
			},
		};
	}

	private createPreparedSync(
		participants: readonly RetainedCommitParticipant[],
		generation: number,
		selectedIndex: number | null,
		isSourceCurrent: () => boolean,
		sourceDisposers: readonly (() => void)[],
	): RetainedPreparedProductionConditionalSyncChildren {
		type Ownership = "owned" | "claimed" | "terminal";
		let ownership: Ownership = "owned";
		const frozenParticipants = Object.freeze([...participants]);
		const participantsCurrent = () => this.isPreparationCurrent(generation)
			&& isSourceCurrent()
			&& frozenParticipants.every((participant) => participant.isCurrent());
		const disposeSources = () => {
			for (const dispose of sourceDisposers) this.runCleanup(dispose);
		};
		const disposeParticipants = () => {
			for (const participant of frozenParticipants) this.runCleanup(() => participant.discard());
			disposeSources();
		};

		return {
			status: "prepared",
			selectedIndex,
			participantCount: frozenParticipants.length,
			isCurrent: () => ownership === "owned" && participantsCurrent(),
			claimParticipants: () => {
				if (ownership !== "owned" || !participantsCurrent()) {
					if (ownership === "owned") {
						ownership = "terminal";
						disposeParticipants();
					}
					return { status: "stale" };
				}
				ownership = "claimed";
				let terminal = false;
				const claim: RetainedProductionConditionalSyncParticipantClaim = {
					participantCount: frozenParticipants.length,
					isCurrent: () => !terminal && participantsCurrent(),
					toCommitParticipants: () => frozenParticipants,
					dispose: () => {
						if (terminal) return;
						terminal = true;
						disposeParticipants();
					},
				};
				return { status: "claimed", claim };
			},
			commit: (transaction) => {
				if (ownership !== "owned") return { status: "stale" };
				if (!participantsCurrent()) {
					ownership = "terminal";
					disposeParticipants();
					return { status: this.disposed ? "disposed" : "stale" };
				}
				const result = transaction.commit(frozenParticipants);
				ownership = "terminal";
				disposeSources();
				return result;
			},
			dispose: () => {
				if (ownership !== "owned") return;
				ownership = "terminal";
				disposeParticipants();
			},
		};
	}

	private wrapPrepared(
		sync: RetainedPreparedProductionConditionalSyncChildren,
		islands: RetainedPreparedKeyedIslandBatch,
		selectedIndex: number | null,
	): RetainedPreparedProductionConditionalMixedChildren {
		let terminal = false;
		return {
			status: "prepared",
			selectedIndex,
			participantCount: sync.participantCount + islands.participantCount,
			syncParticipantCount: sync.participantCount,
			islandParticipantCount: islands.participantCount,
			isCurrent: () => !terminal && sync.isCurrent() && islands.isCurrent(),
			commit: (transaction) => {
				if (terminal) return { status: this.disposed ? "disposed" : "stale" };
				const result = commitRetainedProductionConditionalPreparedChildren(sync, islands, transaction);
				terminal = true;
				return result;
			},
			dispose: () => {
				if (terminal) return;
				terminal = true;
				this.runCleanup(() => islands.dispose());
				this.runCleanup(() => sync.dispose());
			},
		};
	}

	private terminal(
		status: RetainedProductionConditionalMixedChildrenTerminalStatus,
		error?: unknown,
		selectedIndex: number | null = this.selector.activeIndex,
	): RetainedProductionConditionalMixedChildrenTerminalResult {
		return {
			status,
			selectedIndex,
			...(error === undefined ? {} : { error }),
		};
	}

	private isPreparationCurrent(generation: number): boolean {
		return !this.disposed && generation === this.preparationGeneration;
	}

	private runCleanup(dispose: () => void): void {
		try {
			dispose();
		} catch (error) {
			try {
				this.onCleanupError?.(error);
			} catch {
				// Cleanup diagnostics must never replace the authoritative result.
			}
		}
	}
}

function seedDetachedSyncValues(
	slots: RetainedKeyedSlotScope,
	specs: readonly RetainedConditionalMixedSyncSlot[],
	values: ReadonlyMap<string, string>,
): void {
	for (const spec of specs) {
		const value: RetainedScalar = values.get(spec.id) ?? "";
		const status = spec.kind === "text"
			? slots.patchText(spec.id, value)
			: slots.patchAttribute(spec.id, value);
		if (status === "disposed") {
			throw new Error(`Retained conditional mixed slot ${spec.id} was disposed during detached initialization`);
		}
	}
}

function createNoopPreparedIslands(
	isSourceCurrent: () => boolean,
): RetainedPreparedKeyedIslandBatch {
	type Ownership = "owned" | "claimed" | "terminal";
	let ownership: Ownership = "owned";
	return {
		status: "prepared",
		requestCount: 0,
		participantCount: 0,
		isCurrent: () => ownership === "owned" && isSourceCurrent(),
		claimParticipants: () => {
			if (ownership !== "owned" || !isSourceCurrent()) {
				if (ownership === "owned") ownership = "terminal";
				return { status: "stale" };
			}
			ownership = "claimed";
			let terminal = false;
			const claim: RetainedKeyedPreparedIslandClaim = {
				participantCount: 0,
				isCurrent: () => !terminal && isSourceCurrent(),
				toCommitParticipants: () => [],
				dispose: () => {
					terminal = true;
				},
			};
			return { status: "claimed", claim };
		},
		commit: (transaction) => {
			if (ownership !== "owned" || !isSourceCurrent()) {
				ownership = "terminal";
				return { status: "stale" };
			}
			ownership = "terminal";
			return transaction.commit([]);
		},
		dispose: () => {
			if (ownership === "owned") ownership = "terminal";
		},
	};
}

function mapsEqual(
	left: ReadonlyMap<string, string>,
	right: ReadonlyMap<string, string>,
): boolean {
	if (left.size !== right.size) return false;
	for (const [key, value] of left) {
		if (!right.has(key) || right.get(key) !== value) return false;
	}
	return true;
}