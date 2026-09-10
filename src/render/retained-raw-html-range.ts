import {
	RetainedKeyedRange,
	type RetainedKeyedRangeOptions,
} from "./keyed-dom-reconciler";
import type {
	ExplicitRawHtml,
	RetainedSyncPatchStatus,
} from "./retained-slot-runtime";

export type RetainedRawHtmlRangeOptions = RetainedKeyedRangeOptions;

/**
 * Semantically unwrapped retained range for explicit raw HTML.
 *
 * The range intentionally composes the transactional keyed reconciler instead
 * of writing live children directly. A changed HTML value is fully parsed into
 * detached owner-document nodes under a fresh numeric generation key; only then
 * does the keyed range synchronously swap the bounded live region. If staging or
 * commit throws, the previous raw-HTML nodes remain the last-known-good UI.
 *
 * Numeric generation keys are deliberate: raw HTML is never copied into comment
 * diagnostics or retained as a structural key. Exact same-value patches retain
 * the existing node identities without reparsing.
 */
export class RetainedRawHtmlRange {
	private readonly range: RetainedKeyedRange<number>;
	private activeKey: number | null = null;
	private committedHtml: string | null = null;
	private nextGeneration = 1;

	constructor(
		private readonly parent: HTMLElement,
		options: RetainedRawHtmlRangeOptions = {},
	) {
		this.range = new RetainedKeyedRange(parent, {
			...options,
			label: options.label ?? "raw-html",
		});
	}

	get isDisposed(): boolean {
		return this.range.isDisposed;
	}

	get currentHtml(): string | null {
		return this.committedHtml;
	}

	/** Current unwrapped content nodes, excluding the internal comment anchors. */
	get nodes(): readonly Node[] {
		if (this.activeKey === null) return [];
		return this.range.nodesFor(this.activeKey);
	}

	patch(value: ExplicitRawHtml): RetainedSyncPatchStatus {
		if (this.range.isDisposed) return "disposed";
		if (this.activeKey !== null && this.committedHtml === value.html) {
			return "unchanged";
		}

		const nextKey = this.nextGeneration++;
		const result = this.range.reconcile([nextKey], ({ ownerDocument }) =>
			parseExplicitRawHtmlRange(ownerDocument, value.html));
		if (result.status === "disposed") return "disposed";

		this.activeKey = nextKey;
		this.committedHtml = value.html;
		return "patched";
	}

	clear(): RetainedSyncPatchStatus {
		if (this.range.isDisposed) return "disposed";
		if (this.activeKey === null) return "unchanged";

		const result = this.range.reconcile([], () => null);
		if (result.status === "patched") {
			this.activeKey = null;
			this.committedHtml = null;
		}
		return result.status;
	}

	/**
	 * Releases retained resources but intentionally leaves DOM to the owner.
	 * This matches other Core V2 retained primitives: view/node teardown owns the
	 * final container removal, while disposal prevents any later Morphic patch.
	 */
	dispose(): void {
		if (this.range.isDisposed) return;
		this.activeKey = null;
		this.committedHtml = null;
		this.range.dispose();
	}
}

function parseExplicitRawHtmlRange(ownerDocument: Document, html: string): Node[] {
	const Parser = ownerDocument.defaultView?.DOMParser ?? DOMParser;
	const parsed = new Parser().parseFromString(html, "text/html");
	return [...Array.from(parsed.head.childNodes), ...Array.from(parsed.body.childNodes)]
		.map((node) => ownerDocument.importNode(node, true));
}
