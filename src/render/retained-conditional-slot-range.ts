import type {
	RetainedKey,
	RetainedKeyedRangeOptions,
	RetainedKeyedReconcileStatus,
} from "./keyed-dom-reconciler";
import {
	RetainedScopedKeyedRange,
	type RetainedKeyedSlotScope,
} from "./scoped-keyed-slot-runtime";
import type { RetainedStructureBuilder } from "./retained-slot-runtime";

export interface RetainedConditionalSelectResult<K extends RetainedKey> {
	readonly status: RetainedKeyedReconcileStatus;
	readonly activeKey: K | null;
	readonly slots: RetainedKeyedSlotScope | null;
	readonly created: boolean;
	readonly removedKey: K | null;
}

export interface RetainedConditionalClearResult<K extends RetainedKey> {
	readonly status: RetainedKeyedReconcileStatus;
	readonly removedKey: K | null;
}

/**
 * Anchor-bounded retained conditional region with one typed-slot namespace for
 * the currently selected branch.
 *
 * Branch identity must describe the compiled branch itself (for example a
 * stable branch id or source position), not merely the truthiness result. The
 * selected branch is represented as a one-entry RetainedScopedKeyedRange, so a
 * branch switch stages the next branch completely before the previous branch is
 * removed. Same-branch reevaluation retains exact DOM, slot-scope, and async
 * island identity without rerunning the static builder.
 */
export class RetainedConditionalSlotRange<K extends RetainedKey = RetainedKey> {
	private readonly range: RetainedScopedKeyedRange<K>;

	constructor(
		parent: HTMLElement,
		options: RetainedKeyedRangeOptions = {},
	) {
		this.range = new RetainedScopedKeyedRange(parent, options);
	}

	get activeKey(): K | null {
		const keys = this.range.keys;
		return keys.length === 0 ? null : keys[0];
	}

	get activeSlots(): RetainedKeyedSlotScope | null {
		const key = this.activeKey;
		if (key === null) return null;
		return this.range.entry(key)?.slots ?? null;
	}

	get isDisposed(): boolean {
		return this.range.isDisposed;
	}

	/**
	 * Select one compiled branch. The builder is invoked only when that branch
	 * identity is not already retained in this conditional region.
	 */
	select(
		key: K,
		builder: RetainedStructureBuilder,
	): RetainedConditionalSelectResult<K> {
		const result = this.range.reconcile([key], ({ slots }) =>
			slots.mount(builder, "conditional-branch"));
		const activeKey = this.activeKey;
		const activeEntry = activeKey === null ? undefined : this.range.entry(activeKey);

		return {
			status: result.status,
			activeKey,
			slots: activeEntry?.slots ?? null,
			created: result.createdKeys.length > 0,
			removedKey: result.removedKeys.length === 0 ? null : result.removedKeys[0],
		};
	}

	/** Clear the conditional region and dispose the active branch resources. */
	clear(): RetainedConditionalClearResult<K> {
		const result = this.range.reconcile([], () => null);
		return {
			status: result.status,
			removedKey: result.removedKeys.length === 0 ? null : result.removedKeys[0],
		};
	}

	dispose(): void {
		this.range.dispose();
	}
}
