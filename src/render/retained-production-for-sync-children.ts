import {
	evaluateCompiledExpression,
	type CompiledExpression,
} from "../compiler/expression-compiler";
import type { ForNode, TemplateIRNode } from "../compiler/template-ir";
import type { ExprContext, ExprValue } from "../expression";
import { resultToString } from "../renderer";
import type {
	RetainedCommitParticipant,
	RetainedCommitTransaction,
	RetainedCommitTransactionResult,
} from "./retained-commit-transaction";
import {
	RetainedKeyedTransactionRange,
	type RetainedKeyedTransactionEntry,
	type RetainedKeyedTransactionPreparationResult,
} from "./retained-keyed-transaction-range";
import type { RetainedKey } from "./keyed-dom-reconciler";
import type { RetainedKeyedSlotScope } from "./scoped-keyed-slot-runtime";
import type { RetainedScalar } from "./retained-slot-runtime";
import {
	RetainedTemplateDomPlan,
	decodeRetainedHtmlAttributeSource,
	type RetainedTemplateAttributeSlot,
	type RetainedTemplateIrLike,
	type RetainedTemplateIrNode,
} from "./retained-template-dom-plan";

export type RetainedProductionForSyncFallbackCode =
	| "attribute-slot"
	| "async-island"
	| "raw-html-range"
	| "nested-structural-control-flow"
	| "non-text-expression-context"
	| "index-variable";

export interface RetainedProductionForSyncFallback {
	readonly status: "fallback";
	readonly code: RetainedProductionForSyncFallbackCode;
	readonly path: string;
	readonly message: string;
}

export type RetainedProductionForSyncTerminalStatus =
	| "unchanged"
	| "stale"
	| "failed"
	| "disposed";

export interface RetainedProductionForSyncTerminalResult {
	readonly status: RetainedProductionForSyncTerminalStatus;
	readonly keys: readonly RetainedKey[];
	readonly error?: unknown;
}

export interface RetainedProductionForSyncParticipantClaim {
	readonly participantCount: number;
	isCurrent(): boolean;
	toCommitParticipants(): readonly RetainedCommitParticipant[];
	dispose(): void;
}

export type RetainedProductionForSyncParticipantClaimResult =
	| {
		readonly status: "claimed";
		readonly claim: RetainedProductionForSyncParticipantClaim;
	}
	| { readonly status: "stale" };

export interface RetainedPreparedProductionForSyncChildren {
	readonly status: "prepared";
	readonly keys: readonly RetainedKey[];
	readonly participantCount: number;
	isCurrent(): boolean;
	claimParticipants(): RetainedProductionForSyncParticipantClaimResult;
	commit(transaction: RetainedCommitTransaction): RetainedCommitTransactionResult;
	dispose(): void;
}

export type RetainedProductionForSyncPreparationResult =
	| RetainedPreparedProductionForSyncChildren
	| RetainedProductionForSyncTerminalResult
	| RetainedProductionForSyncFallback;

export interface RetainedProductionForSyncRequest {
	readonly node: ForNode;
	readonly sourceHash: string;
	readonly expressionContext: ExprContext;
}

export interface RetainedProductionForSyncChildrenOptions {
	readonly evaluateExpression?: RetainedProductionForSyncEvaluator;
	readonly onCleanupError?: (error: unknown) => void;
	/** Optional owner-shell insertion point; must be a child of parent. */
	readonly before?: Node | null;
}

export type RetainedProductionForSyncEvaluator = (
	expression: CompiledExpression,
	context: ExprContext,
) => Promise<ExprValue>;

type SyncSlotKind = "text" | "attribute";

interface SyncSlotSpec {
	readonly id: string;
	readonly kind: SyncSlotKind;
}

interface LoopPlan {
	readonly plan: RetainedTemplateDomPlan<CompiledExpression>;
	readonly nodes: readonly RetainedTemplateIrNode<CompiledExpression>[];
	readonly slots: readonly SyncSlotSpec[];
}

interface EvaluatedIteration {
	readonly key: RetainedKey;
	readonly values: Map<string, string>;
}

type PatchParticipantState =
	| "prepared"
	| "applying"
	| "applied"
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
 * Production-oriented synchronous child composer for one retained `{% for %}`.
 *
 * The class deliberately stops short of owner eligibility/wiring. It evaluates
 * the loop and synchronous child values off the live surface, delegates keyed
 * structural mutation to RetainedKeyedTransactionRange, and returns one unified
 * rollback-capable participant set for the caller's owner transaction.
 */
export class RetainedProductionForSyncChildren {
	private readonly range: RetainedKeyedTransactionRange<RetainedKey>;
	private readonly evaluateExpression: RetainedProductionForSyncEvaluator;
	private readonly ownerDocument: Document;
	private committedValues = new Map<RetainedKey, Map<string, string>>();
	private preparationGeneration = 0;
	private disposed = false;

	constructor(
		parent: HTMLElement,
		options: RetainedProductionForSyncChildrenOptions = {},
	) {
		this.ownerDocument = parent.ownerDocument;
		this.evaluateExpression = options.evaluateExpression ?? evaluateCompiledExpression;
		this.range = new RetainedKeyedTransactionRange(parent, {
			onCleanupError: options.onCleanupError,
			before: options.before,
			label: "production-for",
		});
	}

	get isDisposed(): boolean {
		return this.disposed;
	}

	get isPoisoned(): boolean {
		return this.range.isPoisoned;
	}

	get size(): number {
		return this.range.size;
	}

	get keys(): readonly RetainedKey[] {
		return this.range.keys;
	}

	entry(key: RetainedKey): RetainedKeyedTransactionEntry<RetainedKey> | undefined {
		return this.range.entry(key);
	}

	nodesFor(key: RetainedKey): readonly Node[] {
		return this.range.nodesFor(key);
	}

	async prepare(
		request: RetainedProductionForSyncRequest,
	): Promise<RetainedProductionForSyncPreparationResult> {
		if (this.disposed) return this.terminal("disposed");

		const generation = ++this.preparationGeneration;
		const support = inspectRetainedProductionForSyncSupport(request.node);
		if (support) return support;

		let plan: LoopPlan;
		try {
			plan = createLoopPlan(request.sourceHash, request.node.children);
		} catch (error) {
			return this.terminal("failed", error);
		}

		let iterable: ExprValue;
		try {
			iterable = await this.evaluateExpression(
				request.node.iterable,
				request.expressionContext,
			);
		} catch (error) {
			if (!this.isPreparationCurrent(generation)) {
				return this.terminal(this.disposed ? "disposed" : "stale");
			}
			return this.terminal("failed", error);
		}
		if (!this.isPreparationCurrent(generation)) {
			return this.terminal(this.disposed ? "disposed" : "stale");
		}

		const items = Array.isArray(iterable) ? iterable : [];
		let iterations: readonly EvaluatedIteration[];
		try {
			iterations = await this.evaluateIterations(request, plan, items, generation);
		} catch (error) {
			if (!this.isPreparationCurrent(generation)) {
				return this.terminal(this.disposed ? "disposed" : "stale");
			}
			return this.terminal("failed", error);
		}
		if (!this.isPreparationCurrent(generation)) {
			return this.terminal(this.disposed ? "disposed" : "stale");
		}

		const nextKeys = iterations.map((iteration) => iteration.key);
		const nextValues = new Map(
			iterations.map((iteration) => [iteration.key, iteration.values] as const),
		);

		let structural: RetainedKeyedTransactionPreparationResult<RetainedKey>;
		try {
			structural = this.range.prepare(nextKeys, ({ key, slots }) => {
				const values = nextValues.get(key);
				if (!values) throw new Error(`Missing retained loop values for key: ${String(key)}`);
				const roots = slots.mount(plan.plan.builder(), plan.plan.structureKey);
				seedDetachedValues(slots, plan.slots, values);
				return roots;
			});
		} catch (error) {
			return this.terminal("failed", error);
		}
		if (!this.isPreparationCurrent(generation)) {
			if (structural.status === "prepared") structural.dispose();
			return this.terminal(this.disposed ? "disposed" : "stale");
		}
		if (structural.status === "failed") return this.terminal("failed", structural.error);
		if (structural.status === "disposed") return this.terminal("disposed");

		const participants: RetainedCommitParticipant[] = [];
		const sourceDisposers: (() => void)[] = [];
		if (structural.status === "prepared") {
			participants.push(structural.toCommitParticipant());
			sourceDisposers.push(() => structural.dispose());
		}

		const createdKeys = new Set(
			structural.status === "prepared" ? structural.createdKeys : [],
		);
		for (const iteration of iterations) {
			if (createdKeys.has(iteration.key)) continue;
			const entry = this.range.entry(iteration.key);
			if (!entry) {
				this.disposeSources(sourceDisposers);
				return this.terminal(
					"failed",
					new Error(`Missing retained loop entry for key: ${String(iteration.key)}`),
				);
			}
			const previousValues = this.committedValues.get(iteration.key) ?? new Map();
			if (mapsEqual(previousValues, iteration.values)) continue;
			participants.push(this.createLivePatchParticipant(
				iteration.key,
				entry.slots,
				plan.slots,
				previousValues,
				iteration.values,
				generation,
			));
		}

		if (!mapsOfMapsEqual(this.committedValues, nextValues)) {
			participants.push(this.createSnapshotParticipant(nextValues, generation));
		}

		if (participants.length === 0) return this.terminal("unchanged");
		return this.createPrepared(
			participants,
			generation,
			nextKeys,
			sourceDisposers,
		);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.preparationGeneration += 1;
		this.range.dispose();
		this.committedValues.clear();
	}

	private async evaluateIterations(
		request: RetainedProductionForSyncRequest,
		plan: LoopPlan,
		items: readonly ExprValue[],
		generation: number,
	): Promise<readonly EvaluatedIteration[]> {
		const iterations: EvaluatedIteration[] = [];
		const keys = new Set<RetainedKey>();
		for (let index = 0; index < items.length; index++) {
			if (!this.isPreparationCurrent(generation)) break;
			const context = createIterationContext(
				request.expressionContext,
				request.node.itemVariable,
				items[index],
				index,
				items.length,
			);
			const key = request.node.key
				? normalizeRetainedKey(await this.evaluateExpression(request.node.key, context))
				: index;
			if (!this.isPreparationCurrent(generation)) break;
			if (keys.has(key)) throw new Error(`Duplicate retained loop key: ${String(key)}`);
			keys.add(key);
			const values = await this.evaluateEntryValues(plan, context, generation);
			iterations.push({ key, values });
		}
		return iterations;
	}

	private async evaluateEntryValues(
		plan: LoopPlan,
		context: ExprContext,
		generation: number,
	): Promise<Map<string, string>> {
		const values = new Map<string, string>();
		for (const node of plan.nodes) {
			if (!this.isPreparationCurrent(generation)) break;
			switch (node.kind) {
				case "static-fragment":
					break;
				case "set": {
					const value = await this.evaluateExpression(node.expression, context);
					if (!this.isPreparationCurrent(generation)) break;
					context.variables[node.variable] = value;
					break;
				}
				case "text-slot":
				case "expression-slot": {
					const value = await this.evaluateExpression(node.expression, context);
					if (!this.isPreparationCurrent(generation)) break;
					values.set(node.id, resultToString(value));
					break;
				}
				case "attribute-slot": {
					let assembled = "";
					for (const part of node.parts) {
						if (part.kind === "static") {
							assembled += decodeRetainedHtmlAttributeSource(
								this.ownerDocument,
								part.value,
								node.quote,
							);
							continue;
						}
						if (part.kind !== "expression") {
							throw new Error(`Unsupported retained loop attribute part: ${part.kind}`);
						}
						const value = await this.evaluateExpression(part.expression, context);
						if (!this.isPreparationCurrent(generation)) break;
						assembled += resultToString(value);
					}
					if (this.isPreparationCurrent(generation)) values.set(node.id, assembled);
					break;
				}
				case "markdown-slot":
				case "content-slot":
				case "raw-html-slot":
				case "if":
				case "for":
					throw new Error(`Unsupported retained loop sync child reached evaluation: ${node.kind}`);
			}
		}
		return values;
	}

	private createLivePatchParticipant(
		key: RetainedKey,
		slots: RetainedKeyedSlotScope,
		specs: readonly SyncSlotSpec[],
		previousValues: ReadonlyMap<string, string>,
		nextValues: ReadonlyMap<string, string>,
		generation: number,
	): RetainedCommitParticipant {
		const changed = specs.filter((spec) => previousValues.get(spec.id) !== nextValues.get(spec.id));
		const applied: SyncSlotSpec[] = [];
		let state: PatchParticipantState = "prepared";
		const patch = (spec: SyncSlotSpec, value: string): void => {
			const status = spec.kind === "text"
				? slots.patchText(spec.id, value)
				: slots.patchAttribute(spec.id, value);
			if (status === "disposed") {
				throw new Error(`Retained loop slot ${spec.id} was disposed during live patch`);
			}
		};

		return {
			isCurrent: () => state !== "rolled-back"
				&& state !== "finalized"
				&& state !== "discarded"
				&& this.isPreparationCurrent(generation)
				&& this.range.entry(key)?.slots === slots,
			apply: () => {
				if (state !== "prepared") throw new Error("Retained loop child patch is not prepared");
				state = "applying";
				for (const spec of changed) {
					patch(spec, nextValues.get(spec.id) ?? "");
					applied.push(spec);
				}
				state = "applied";
			},
			rollback: () => {
				if (state !== "applying" && state !== "applied") return;
				for (let index = applied.length - 1; index >= 0; index--) {
					const spec = applied[index];
					patch(spec, previousValues.get(spec.id) ?? "");
				}
				state = "rolled-back";
			},
			finalize: () => {
				if (state === "applied") state = "finalized";
			},
			discard: () => {
				if (state === "finalized" || state === "discarded") return;
				state = "discarded";
			},
		};
	}

	private createSnapshotParticipant(
		nextValues: Map<RetainedKey, Map<string, string>>,
		generation: number,
	): RetainedCommitParticipant {
		const previousValues = this.committedValues;
		let state: SnapshotParticipantState = "prepared";
		return {
			isCurrent: () => state !== "rolled-back"
				&& state !== "finalized"
				&& state !== "discarded"
				&& this.isPreparationCurrent(generation),
			apply: () => {
				if (state !== "prepared") throw new Error("Retained loop snapshot is not prepared");
				state = "applied";
			},
			adopt: () => {
				if (state !== "applied") throw new Error("Retained loop snapshot was not applied");
				this.committedValues = cloneValueSnapshot(nextValues);
				state = "adopted";
			},
			rollback: () => {
				if (state === "adopted") this.committedValues = previousValues;
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

	private createPrepared(
		participants: readonly RetainedCommitParticipant[],
		generation: number,
		keys: readonly RetainedKey[],
		sourceDisposers: readonly (() => void)[],
	): RetainedPreparedProductionForSyncChildren {
		type Ownership = "owned" | "claimed" | "terminal";
		let ownership: Ownership = "owned";
		const frozenParticipants = Object.freeze([...participants]);
		const frozenKeys = Object.freeze([...keys]);
		const participantsCurrent = () => this.isPreparationCurrent(generation)
			&& frozenParticipants.every((participant) => participant.isCurrent());
		const disposeAll = () => {
			for (const participant of frozenParticipants) participant.discard();
			this.disposeSources(sourceDisposers);
		};

		return {
			status: "prepared",
			keys: frozenKeys,
			participantCount: frozenParticipants.length,
			isCurrent: () => ownership === "owned" && participantsCurrent(),
			claimParticipants: () => {
				if (ownership !== "owned" || !participantsCurrent()) {
					if (ownership === "owned") {
						ownership = "terminal";
						disposeAll();
					}
					return { status: "stale" };
				}
				ownership = "claimed";
				let terminal = false;
				return {
					status: "claimed",
					claim: {
						participantCount: frozenParticipants.length,
						isCurrent: () => !terminal && participantsCurrent(),
						toCommitParticipants: () => frozenParticipants,
						dispose: () => {
							if (terminal) return;
							terminal = true;
							disposeAll();
						},
					},
				};
			},
			commit: (transaction) => {
				if (ownership !== "owned") return { status: "stale" };
				if (!participantsCurrent()) {
					ownership = "terminal";
					disposeAll();
					return { status: this.disposed ? "disposed" : "stale" };
				}
				const result = transaction.commit(frozenParticipants);
				ownership = "terminal";
				this.disposeSources(sourceDisposers);
				return result;
			},
			dispose: () => {
				if (ownership !== "owned") return;
				ownership = "terminal";
				disposeAll();
			},
		};
	}

	private isPreparationCurrent(generation: number): boolean {
		return !this.disposed && generation === this.preparationGeneration;
	}

	private terminal(
		status: RetainedProductionForSyncTerminalStatus,
		error?: unknown,
	): RetainedProductionForSyncTerminalResult {
		return {
			status,
			keys: this.keys,
			...(error === undefined ? {} : { error }),
		};
	}

	private disposeSources(disposers: readonly (() => void)[]): void {
		for (const dispose of disposers) dispose();
	}
}

export function inspectRetainedProductionForSyncSupport(
	node: ForNode,
): RetainedProductionForSyncFallback | null {
	if (node.indexVariable !== undefined) {
		return fallback(
			"index-variable",
			"indexVariable",
			"has no established legacy-compatible retained index-variable semantics",
		);
	}

	for (let childIndex = 0; childIndex < node.children.length; childIndex++) {
		const child = node.children[childIndex];
		const path = `children[${childIndex}]`;
		switch (child.kind) {
			case "attribute-slot":
				if (!getCompleteAttributeSlot(child)) {
					return fallback(
						"attribute-slot",
						path,
						"requires complete compiler targetKey/quote/parts metadata",
					);
				}
				break;
			case "markdown-slot":
			case "content-slot":
				return fallback(
					"async-island",
					path,
					"requires prepared scoped async-island loop composition",
				);
			case "raw-html-slot":
				return fallback(
					"raw-html-range",
					path,
					"requires retained raw-HTML loop child range composition",
				);
			case "if":
			case "for":
				return fallback(
					"nested-structural-control-flow",
					path,
					"requires recursive retained structural loop child composition",
				);
			case "expression-slot":
				if (child.context !== "text") {
					return fallback(
						"non-text-expression-context",
						path,
						`has unsupported expression context '${child.context}'`,
					);
				}
				break;
			case "static-fragment":
			case "text-slot":
			case "set":
				break;
		}
	}
	return null;
}

function createLoopPlan(
	outerSourceHash: string,
	children: readonly TemplateIRNode[],
): LoopPlan {
	const nodes = children.map(toRetainedNode);
	const ir: RetainedTemplateIrLike<CompiledExpression> = {
		version: 1,
		sourceHash: JSON.stringify([
			"morphic-production-for-sync-children-v1",
			outerSourceHash,
		]),
		nodes,
	};
	const plan = new RetainedTemplateDomPlan(ir);
	return {
		plan,
		nodes,
		slots: nodes.flatMap((node): SyncSlotSpec[] => {
			if (node.kind === "text-slot" || node.kind === "expression-slot") {
				return [{ id: node.id, kind: "text" }];
			}
			if (node.kind === "attribute-slot") return [{ id: node.id, kind: "attribute" }];
			return [];
		}),
	};
}

function toRetainedNode(node: TemplateIRNode): RetainedTemplateIrNode<CompiledExpression> {
	switch (node.kind) {
		case "static-fragment":
			return { kind: "static-fragment", html: node.html };
		case "set":
			return { kind: "set", variable: node.variable, expression: node.expression };
		case "text-slot":
			return { kind: "text-slot", id: node.id, expression: node.expression };
		case "expression-slot":
			return {
				kind: "expression-slot",
				id: node.id,
				expression: node.expression,
				context: "text",
			};
		case "attribute-slot": {
			const complete = getCompleteAttributeSlot(node);
			if (!complete) throw new Error(`Incomplete retained loop attribute slot: ${node.id}`);
			return complete;
		}
		case "markdown-slot":
		case "content-slot":
		case "raw-html-slot":
		case "if":
		case "for":
			throw new Error(`Unsupported retained loop sync child: ${node.kind}`);
	}
}

function getCompleteAttributeSlot(
	node: TemplateIRNode,
): RetainedTemplateAttributeSlot<CompiledExpression> | null {
	if (node.kind !== "attribute-slot") return null;
	if (typeof node.targetKey !== "string" || node.targetKey.length === 0) return null;
	if (node.quote !== "\"" && node.quote !== "'" && node.quote !== null) return null;
	const parts = node.parts;
	if (!parts || parts.length === 0) return null;
	for (const part of parts) {
		if (part.kind === "static") {
			if (part.encoding !== "html-attribute-source") return null;
			continue;
		}
		if (part.kind !== "expression") return null;
	}
	return {
		kind: "attribute-slot",
		id: node.id,
		attribute: node.attribute,
		targetKey: node.targetKey,
		quote: node.quote,
		parts,
	};
}

function createIterationContext(
	base: ExprContext,
	itemVariable: string,
	item: ExprValue,
	index: number,
	length: number,
): ExprContext {
	return {
		...base,
		variables: {
			...base.variables,
			[itemVariable]: item,
			loop: {
				index: index + 1,
				index0: index,
				first: index === 0,
				last: index === length - 1,
				length,
			},
		},
	};
}

function normalizeRetainedKey(value: ExprValue): RetainedKey {
	if (typeof value === "string") return value;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	throw new Error("Retained loop key must evaluate to a finite number or string");
}

function seedDetachedValues(
	slots: RetainedKeyedSlotScope,
	specs: readonly SyncSlotSpec[],
	values: ReadonlyMap<string, string>,
): void {
	for (const spec of specs) {
		const value: RetainedScalar = values.get(spec.id) ?? "";
		const status = spec.kind === "text"
			? slots.patchText(spec.id, value)
			: slots.patchAttribute(spec.id, value);
		if (status === "disposed") {
			throw new Error(`Retained loop slot ${spec.id} was disposed during detached seed`);
		}
	}
}

function mapsEqual(
	left: ReadonlyMap<string, string>,
	right: ReadonlyMap<string, string>,
): boolean {
	if (left.size !== right.size) return false;
	for (const [key, value] of left) {
		if (right.get(key) !== value) return false;
	}
	return true;
}

function mapsOfMapsEqual(
	left: ReadonlyMap<RetainedKey, ReadonlyMap<string, string>>,
	right: ReadonlyMap<RetainedKey, ReadonlyMap<string, string>>,
): boolean {
	if (left.size !== right.size) return false;
	for (const [key, values] of left) {
		const other = right.get(key);
		if (!other || !mapsEqual(values, other)) return false;
	}
	return true;
}

function cloneValueSnapshot(
	values: ReadonlyMap<RetainedKey, ReadonlyMap<string, string>>,
): Map<RetainedKey, Map<string, string>> {
	return new Map(
		[...values].map(([key, entryValues]) => [key, new Map(entryValues)] as const),
	);
}

function fallback(
	code: RetainedProductionForSyncFallbackCode,
	path: string,
	message: string,
): RetainedProductionForSyncFallback {
	return {
		status: "fallback",
		code,
		path,
		message: `Retained production for ${path} ${message}`,
	};
}
