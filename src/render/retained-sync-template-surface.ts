import {
	RetainedDomRuntime,
	type RetainedScalar,
	type RetainedStructureContext,
	type RetainedSyncPatchStatus,
} from "./retained-slot-runtime";
import {
	RetainedTemplateDomPlan,
	RetainedTemplateDomPlanError,
	inspectRetainedTemplateDomSupport,
	type RetainedTemplateDomUnsupportedCode,
	type RetainedTemplateIrLike,
} from "./retained-template-dom-plan";

export type RetainedSyncTemplateUnsupportedCode =
	| RetainedTemplateDomUnsupportedCode
	| "async-island";

export interface RetainedSyncTemplateSupported {
	readonly supported: true;
}

export interface RetainedSyncTemplateUnsupported {
	readonly supported: false;
	readonly code: RetainedSyncTemplateUnsupportedCode;
	readonly path: string;
	readonly message: string;
}

export type RetainedSyncTemplateSupport =
	| RetainedSyncTemplateSupported
	| RetainedSyncTemplateUnsupported;

export type RetainedSyncTemplateCommitStatus =
	| "mounted"
	| "patched"
	| "unchanged"
	| "failed"
	| "disposed";

export interface RetainedSyncTemplateCommitResult {
	readonly status: RetainedSyncTemplateCommitStatus;
	readonly error?: unknown;
}

export interface RetainedSyncTemplateSurfaceOptions {
	onRollbackError?: (error: unknown) => void;
}

export class RetainedSyncTemplateSurfaceError extends Error {
	constructor(
		message: string,
		readonly code:
			| RetainedSyncTemplateUnsupportedCode
			| "missing-value"
			| "extra-value"
			| "unowned-reuse"
			| "rollback-failed",
		readonly path?: string,
	) {
		super(message);
		this.name = "RetainedSyncTemplateSurfaceError";
	}
}

type SyncSlotKind = "text" | "attribute";

type EffectiveValue = string | null;

interface SyncSlotSpec {
	readonly id: string;
	readonly kind: SyncSlotKind;
}

/**
 * Transactional retained surface for the synchronous leaf subset of TemplateIR.
 *
 * Expression evaluation stays outside this adapter. Callers resolve one complete
 * generation first, then pass the resolved slot map here. New structures receive
 * their initial text/attribute values while still detached inside
 * `RetainedDomRuntime.mountStructure()`, so a builder failure cannot expose a
 * partially initialized tree. Reused structures patch only changed leaves and
 * roll back earlier leaf mutations if a later DOM write throws.
 *
 * Markdown/content islands, raw HTML, and structural control flow are explicit
 * fallback requirements. This class never silently downgrades them to legacy
 * string interpolation.
 */
export class RetainedSyncTemplateSurface<E = unknown> {
	readonly plan: RetainedTemplateDomPlan<E>;
	readonly structureKey: string;

	private readonly slots: readonly SyncSlotSpec[];
	private readonly onRollbackError?: (error: unknown) => void;
	private committedValues = new Map<string, EffectiveValue>();
	private hasCommitted = false;
	private poisoned = false;

	constructor(
		private readonly runtime: RetainedDomRuntime,
		ir: RetainedTemplateIrLike<E>,
		options: RetainedSyncTemplateSurfaceOptions = {},
	) {
		const support = inspectRetainedSyncTemplateSupport(ir);
		if (!support.supported) {
			throw new RetainedSyncTemplateSurfaceError(
				support.message,
				support.code,
				support.path,
			);
		}

		this.plan = new RetainedTemplateDomPlan(ir);
		this.structureKey = this.plan.structureKey;
		this.slots = collectSyncSlots(ir);
		this.onRollbackError = options.onRollbackError;
	}

	get isPoisoned(): boolean {
		return this.poisoned;
	}

	commit(values: ReadonlyMap<string, RetainedScalar>): RetainedSyncTemplateCommitResult {
		if (this.poisoned) {
			return {
				status: "failed",
				error: new RetainedSyncTemplateSurfaceError(
					"Retained sync template surface cannot continue after rollback failure",
					"rollback-failed",
				),
			};
		}

		let nextValues: Map<string, EffectiveValue>;
		try {
			nextValues = this.snapshotValues(values);
		} catch (error) {
			return { status: "failed", error };
		}

		if (this.runtime.currentStructureKey !== this.structureKey) {
			return this.mount(nextValues);
		}

		if (!this.hasCommitted) {
			return {
				status: "failed",
				error: new RetainedSyncTemplateSurfaceError(
					"Retained sync template surface cannot adopt an already-mounted structure without a rollback snapshot",
					"unowned-reuse",
				),
			};
		}

		return this.patch(nextValues);
	}

	private mount(nextValues: Map<string, EffectiveValue>): RetainedSyncTemplateCommitResult {
		const builder = this.plan.builder();
		try {
			const status = this.runtime.mountStructure(this.structureKey, (context) => {
				builder(this.withInitialValues(context, nextValues));
			});
			if (status === "disposed") return { status: "disposed" };
			if (status === "reused") {
				return {
					status: "failed",
					error: new RetainedSyncTemplateSurfaceError(
						"Retained sync template surface unexpectedly encountered an unowned reused structure",
						"unowned-reuse",
					),
				};
			}

			this.committedValues = nextValues;
			this.hasCommitted = true;
			return { status: "mounted" };
		} catch (error) {
			return { status: "failed", error };
		}
	}

	private patch(nextValues: Map<string, EffectiveValue>): RetainedSyncTemplateCommitResult {
		const changed = this.slots.filter(
			(slot) => this.committedValues.get(slot.id) !== nextValues.get(slot.id),
		);
		if (changed.length === 0) return { status: "unchanged" };

		const applied: SyncSlotSpec[] = [];
		try {
			for (const slot of changed) {
				const status = this.patchSlot(slot, nextValues.get(slot.id) ?? null);
				if (status === "disposed") {
					this.poisoned = applied.length > 0;
					return { status: "disposed" };
				}
				if (status === "patched") applied.push(slot);
			}
		} catch (error) {
			const rollbackError = this.rollback(applied);
			if (rollbackError !== undefined) {
				this.poisoned = true;
				this.reportRollbackError(rollbackError);
				return {
					status: "failed",
					error: new RetainedSyncTemplateSurfaceError(
						`Retained sync patch failed and rollback also failed: ${describeError(error)}; rollback: ${describeError(rollbackError)}`,
						"rollback-failed",
					),
				};
			}
			return { status: "failed", error };
		}

		this.committedValues = nextValues;
		return { status: "patched" };
	}

	private rollback(applied: readonly SyncSlotSpec[]): unknown {
		for (let index = applied.length - 1; index >= 0; index--) {
			const slot = applied[index];
			try {
				const status = this.patchSlot(slot, this.committedValues.get(slot.id) ?? null);
				if (status === "disposed") {
					return new Error("Retained runtime was disposed during rollback");
				}
			} catch (error) {
				return error;
			}
		}
		return undefined;
	}

	private patchSlot(slot: SyncSlotSpec, value: EffectiveValue): RetainedSyncPatchStatus {
		if (slot.kind === "text") return this.runtime.patchText(slot.id, value ?? "");
		return this.runtime.patchAttribute(slot.id, value);
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

	private snapshotValues(values: ReadonlyMap<string, RetainedScalar>): Map<string, EffectiveValue> {
		const next = new Map<string, EffectiveValue>();
		for (const slot of this.slots) {
			if (!values.has(slot.id)) {
				throw new RetainedSyncTemplateSurfaceError(
					`Missing resolved value for retained slot ${slot.id}`,
					"missing-value",
					slot.id,
				);
			}
			const value = values.get(slot.id);
			next.set(
				slot.id,
				slot.kind === "text" ? normalizeText(value) : normalizeAttribute(value),
			);
		}

		for (const id of values.keys()) {
			if (next.has(id)) continue;
			throw new RetainedSyncTemplateSurfaceError(
				`Unexpected resolved value for retained slot ${id}`,
				"extra-value",
				id,
			);
		}
		return next;
	}

	private reportRollbackError(error: unknown): void {
		if (!this.onRollbackError) return;
		try {
			this.onRollbackError(error);
		} catch {
			// Rollback reporting is diagnostic only and must not mask the failure.
		}
	}
}

export function inspectRetainedSyncTemplateSupport<E>(
	ir: RetainedTemplateIrLike<E>,
): RetainedSyncTemplateSupport {
	const domSupport = inspectRetainedTemplateDomSupport(ir);
	if (!domSupport.supported) return domSupport;

	for (let index = 0; index < ir.nodes.length; index++) {
		const node = ir.nodes[index];
		if (node.kind === "markdown-slot" || node.kind === "content-slot") {
			return {
				supported: false,
				code: "async-island",
				path: `nodes[${index}]`,
				message: `nodes[${index}] requires generation-staged async island commit`,
			};
		}
	}
	return { supported: true };
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
				break;
			case "markdown-slot":
			case "content-slot":
			case "raw-html-slot":
			case "if":
			case "for":
				throw new RetainedTemplateDomPlanError(
					`Unsupported node ${node.kind} reached retained sync slot collection`,
					node.kind === "raw-html-slot"
						? "raw-html-range"
						: node.kind === "if" || node.kind === "for"
							? "structural-control-flow"
							: "non-text-expression-context",
				);
		}
	}
	return slots;
}

function normalizeText(value: RetainedScalar): string {
	return value === null || value === undefined ? "" : String(value);
}

function normalizeAttribute(value: RetainedScalar): string | null {
	return value === null || value === undefined ? null : String(value);
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
