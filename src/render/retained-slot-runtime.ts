import type { RetainedCommitParticipant } from "./retained-commit-transaction";

export type RetainedScalar = string | number | boolean | null | undefined;

export interface ExplicitRawHtml {
	readonly explicitRawHtml: true;
	readonly html: string;
}

export type RetainedSyncPatchStatus = "patched" | "unchanged" | "disposed";
export type RetainedAsyncPatchStatus = "patched" | "unchanged" | "stale" | "failed" | "disposed";

export interface RetainedAsyncPatchResult {
	readonly status: RetainedAsyncPatchStatus;
	readonly error?: unknown;
}

export type RetainedIslandPreparationStatus =
	| "prepared"
	| Exclude<RetainedAsyncPatchStatus, "patched">;

export interface RetainedPreparedIslandPatch {
	readonly status: "prepared";
	readonly renderKey: string;
	isCurrent(): boolean;
	toCommitParticipant(): RetainedCommitParticipant;
	commit(): RetainedAsyncPatchResult;
	dispose(): void;
}

export interface RetainedIslandPreparationTerminalResult {
	readonly status: Exclude<RetainedIslandPreparationStatus, "prepared">;
	readonly error?: unknown;
}

export type RetainedIslandPreparationResult =
	| RetainedPreparedIslandPatch
	| RetainedIslandPreparationTerminalResult;

export interface RetainedDomRuntimeOptions {
	onCleanupError?: (error: unknown) => void;
}

export interface RetainedIslandRenderContext {
	readonly container: HTMLElement;
	readonly ownerDocument: Document;
	readonly resources: RetainedResourceScope;
	isCurrent(): boolean;
}

export type RetainedIslandRenderer = (
	context: RetainedIslandRenderContext,
) => void | Promise<void>;

export interface RetainedStructureContext {
	readonly ownerDocument: Document;
	readonly fragment: DocumentFragment;
	textSlot(id: string, initialValue?: RetainedScalar): Text;
	attributeSlot(id: string, element: Element, attribute: string): void;
	rawHtmlSlot(id: string, element: HTMLElement): void;
	markdownSlot(id: string, element: HTMLElement): void;
	contentSlot(id: string, element: HTMLElement): void;
}

export type RetainedStructureBuilder = (context: RetainedStructureContext) => void;

interface TextBinding {
	readonly kind: "text";
	readonly node: Text;
	lastValue: string;
}

interface AttributeBinding {
	readonly kind: "attribute";
	readonly element: Element;
	readonly attribute: string;
	lastValue: string | null;
}

interface RawHtmlBinding {
	readonly kind: "raw-html";
	readonly element: HTMLElement;
	lastValue: string | null;
}

type AsyncIslandKind = "markdown" | "content";

interface AsyncIslandBinding {
	readonly kind: AsyncIslandKind;
	readonly element: HTMLElement;
	generation: number;
	disposed: boolean;
	hasCommitted: boolean;
	committedKey: string | null;
	committedScope: RetainedResourceScope | null;
	pendingScope: RetainedResourceScope | null;
	inFlightKey: string | null;
	inFlightPromise: Promise<RetainedIslandPreparationResult> | null;
}

type RetainedBinding = TextBinding | AttributeBinding | RawHtmlBinding | AsyncIslandBinding;

/**
 * Small resource owner used by retained Markdown/content islands.
 *
 * Production integration can adapt this contract to Core V2 RenderScope. The
 * important invariant is that resources created for staging work are not owned
 * by plugin lifetime and are disposed as soon as that staging generation loses.
 */
export class RetainedResourceScope {
	private readonly cleanups: Array<() => void> = [];
	private disposed = false;

	constructor(private readonly onCleanupError?: (error: unknown) => void) {}

	get isDisposed(): boolean {
		return this.disposed;
	}

	register(cleanup: () => void): void {
		if (this.disposed) {
			this.runCleanup(cleanup);
			return;
		}
		this.cleanups.push(cleanup);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (let index = this.cleanups.length - 1; index >= 0; index--) {
			this.runCleanup(this.cleanups[index]);
		}
		this.cleanups.length = 0;
	}

	private runCleanup(cleanup: () => void): void {
		try {
			cleanup();
		} catch (error) {
			this.reportCleanupError(error);
		}
	}

	private reportCleanupError(error: unknown): void {
		if (!this.onCleanupError) return;
		try {
			this.onCleanupError(error);
		} catch {
			// Cleanup reporting is diagnostic only and must never escape teardown.
		}
	}
}

type PreparedIslandPatchState =
	| "prepared"
	| "applying"
	| "applied"
	| "adopting"
	| "adopted"
	| "rolled-back"
	| "finalized"
	| "discarded";

class PreparedIslandPatch implements RetainedPreparedIslandPatch, RetainedCommitParticipant {
	readonly status = "prepared" as const;
	private terminalResult: RetainedAsyncPatchResult | null = null;
	private state: PreparedIslandPatchState = "prepared";
	private previousNodes: Node[] = [];
	private claimed = false;

	constructor(
		readonly renderKey: string,
		private readonly target: HTMLElement,
		private readonly staging: HTMLElement,
		private readonly current: () => boolean,
		private readonly staleStatus: () => "stale" | "disposed",
		private readonly claimPatch: () => void,
		private readonly adoptPatch: () => void,
		private readonly rollbackAdoptionPatch: () => void,
		private readonly finalizePatch: () => void,
		private readonly discardPatch: () => void,
	) {}

	isCurrent(): boolean {
		return this.terminalResult === null
			&& this.state !== "finalized"
			&& this.state !== "discarded"
			&& this.current();
	}

	toCommitParticipant(): RetainedCommitParticipant {
		if (!this.claimed) {
			this.claimPatch();
			this.claimed = true;
		}
		return this;
	}

	apply(): void {
		if (this.state !== "prepared") {
			throw new Error("Prepared retained island is not ready to apply");
		}
		this.previousNodes = Array.from(this.target.childNodes);
		const nextNodes = Array.from(this.staging.childNodes);
		this.state = "applying";
		this.target.replaceChildren(...nextNodes);
		this.state = "applied";
	}

	adopt(): void {
		if (this.state !== "applied") {
			throw new Error("Prepared retained island is not ready to adopt");
		}
		this.state = "adopting";
		this.adoptPatch();
		this.state = "adopted";
	}

	rollback(): void {
		if (
			this.state !== "applying"
			&& this.state !== "applied"
			&& this.state !== "adopting"
			&& this.state !== "adopted"
		) return;

		let adoptionError: Error | undefined;
		if (this.state === "adopting" || this.state === "adopted") {
			try {
				this.rollbackAdoptionPatch();
			} catch (error) {
				adoptionError = normalizeThrownError(error);
			}
		}

		let domError: Error | undefined;
		try {
			this.target.replaceChildren(...this.previousNodes);
		} catch (error) {
			domError = normalizeThrownError(error);
		}
		this.state = "rolled-back";

		if (adoptionError) throw adoptionError;
		if (domError) throw domError;
	}

	finalize(): void {
		if (this.state !== "adopted") return;
		try {
			this.finalizePatch();
		} finally {
			this.state = "finalized";
			this.terminalResult = { status: "patched" };
		}
	}

	discard(): void {
		if (this.state === "finalized" || this.state === "discarded") return;
		try {
			this.discardPatch();
		} finally {
			this.state = "discarded";
			this.terminalResult ??= { status: this.staleStatus() };
		}
	}

	commit(): RetainedAsyncPatchResult {
		if (this.terminalResult) return this.terminalResult;
		if (!this.current()) {
			this.discard();
			return this.terminalResult ?? { status: this.staleStatus() };
		}

		try {
			this.apply();
		} catch (error) {
			return this.failDirectCommit(error);
		}

		if (!this.current()) return this.rollbackDirectStale();

		try {
			this.adopt();
		} catch (error) {
			return this.failDirectCommit(error);
		}

		if (!this.current()) return this.rollbackDirectStale();

		this.finalize();
		return this.terminalResult ?? { status: "patched" };
	}

	dispose(): void {
		this.discard();
	}

	private failDirectCommit(error: unknown): RetainedAsyncPatchResult {
		const status = this.current() ? "failed" : this.staleStatus();
		let rollbackError: unknown;
		try {
			this.rollback();
		} catch (caught) {
			rollbackError = caught;
		}
		try {
			this.discardPatch();
		} finally {
			this.state = "discarded";
		}
		this.terminalResult = status === "failed"
			? { status: "failed", error: rollbackError ?? error }
			: { status };
		return this.terminalResult;
	}

	private rollbackDirectStale(): RetainedAsyncPatchResult {
		try {
			this.rollback();
		} catch (error) {
			try {
				this.discardPatch();
			} finally {
				this.state = "discarded";
			}
			this.terminalResult = { status: "failed", error };
			return this.terminalResult;
		}
		this.discard();
		return this.terminalResult ?? { status: this.staleStatus() };
	}
}

/**
 * Retained DOM primitive for Core V2 typed slots.
 *
 * Correctness contract:
 * - one static tree is retained while `structureKey` is unchanged;
 * - a new static tree is built off-DOM and only replaces live DOM after the
 *   synchronous builder completes successfully;
 * - text and attribute slots patch their exact retained target;
 * - raw HTML is only accepted through an explicit wrapper and is confined to
 *   its registered island;
 * - Markdown/content islands can be prepared asynchronously off-DOM and then
 *   either committed directly or exposed as rollback-capable synchronous
 *   participants in a wider retained owner transaction;
 * - in-flight same-key work may be shared only until a prepared patch is claimed
 *   as a commit participant; claimed handles are generation-exclusive;
 * - transaction participants adopt all new resource ownership before any old
 *   committed resource cleanup can reenter the runtime;
 * - legacy `patchMarkdown()` / `patchContent()` compose the same prepare/commit
 *   path, preserving generation-safe last-known-good behavior;
 * - all created DOM uses `root.ownerDocument`, including pop-out windows.
 */
export class RetainedDomRuntime {
	private readonly ownerDocument: Document;
	private readonly onCleanupError?: (error: unknown) => void;
	private bindings = new Map<string, RetainedBinding>();
	private structureKey: string | null = null;
	private disposed = false;

	constructor(
		private readonly root: HTMLElement,
		options: RetainedDomRuntimeOptions = {},
	) {
		this.ownerDocument = root.ownerDocument;
		this.onCleanupError = options.onCleanupError;
	}

	get currentStructureKey(): string | null {
		return this.structureKey;
	}

	get slotCount(): number {
		return this.bindings.size;
	}

	mountStructure(
		structureKey: string,
		builder: RetainedStructureBuilder,
	): "mounted" | "reused" | "disposed" {
		if (this.disposed) return "disposed";
		if (this.structureKey === structureKey) return "reused";

		const fragment = this.ownerDocument.createDocumentFragment();
		const nextBindings = new Map<string, RetainedBinding>();
		const register = (id: string, binding: RetainedBinding) => {
			if (nextBindings.has(id)) {
				throw new Error(`Duplicate retained slot id: ${id}`);
			}
			this.assertOwnerDocument(binding);
			nextBindings.set(id, binding);
		};

		const context: RetainedStructureContext = {
			ownerDocument: this.ownerDocument,
			fragment,
			textSlot: (id, initialValue = "") => {
				const value = normalizeScalar(initialValue);
				const node = this.ownerDocument.createTextNode(value);
				register(id, { kind: "text", node, lastValue: value });
				return node;
			},
			attributeSlot: (id, element, attribute) => {
				register(id, {
					kind: "attribute",
					element,
					attribute,
					lastValue: element.getAttribute(attribute),
				});
			},
			rawHtmlSlot: (id, element) => {
				register(id, { kind: "raw-html", element, lastValue: null });
			},
			markdownSlot: (id, element) => {
				register(id, createAsyncIslandBinding("markdown", element));
			},
			contentSlot: (id, element) => {
				register(id, createAsyncIslandBinding("content", element));
			},
		};

		// The existing live tree remains untouched if builder throws.
		builder(context);

		const previousBindings = this.bindings;
		this.root.replaceChildren(fragment);
		this.bindings = nextBindings;
		this.structureKey = structureKey;
		this.disposeBindings(previousBindings);
		return "mounted";
	}

	patchText(id: string, value: RetainedScalar): RetainedSyncPatchStatus {
		if (this.disposed) return "disposed";
		const binding = this.requireBinding(id, "text");
		const normalized = normalizeScalar(value);
		if (binding.lastValue === normalized) return "unchanged";
		binding.node.data = normalized;
		binding.lastValue = normalized;
		return "patched";
	}

	patchAttribute(id: string, value: RetainedScalar): RetainedSyncPatchStatus {
		if (this.disposed) return "disposed";
		const binding = this.requireBinding(id, "attribute");
		const normalized = value === null || value === undefined ? null : String(value);
		if (binding.lastValue === normalized) return "unchanged";

		if (normalized === null) binding.element.removeAttribute(binding.attribute);
		else binding.element.setAttribute(binding.attribute, normalized);
		binding.lastValue = normalized;
		return "patched";
	}

	patchRawHtml(id: string, value: ExplicitRawHtml): RetainedSyncPatchStatus {
		if (this.disposed) return "disposed";
		const binding = this.requireBinding(id, "raw-html");
		if (binding.lastValue === value.html) return "unchanged";

		const nodes = parseExplicitRawHtml(binding.element.ownerDocument, value.html);
		binding.element.replaceChildren(...nodes);
		binding.lastValue = value.html;
		return "patched";
	}

	prepareMarkdown(
		id: string,
		renderKey: string,
		renderer: RetainedIslandRenderer,
	): Promise<RetainedIslandPreparationResult> {
		return this.prepareIsland(id, "markdown", renderKey, renderer);
	}

	prepareContent(
		id: string,
		renderKey: string,
		renderer: RetainedIslandRenderer,
	): Promise<RetainedIslandPreparationResult> {
		return this.prepareIsland(id, "content", renderKey, renderer);
	}

	patchMarkdown(
		id: string,
		renderKey: string,
		renderer: RetainedIslandRenderer,
	): Promise<RetainedAsyncPatchResult> {
		return this.patchIsland(id, "markdown", renderKey, renderer);
	}

	patchContent(
		id: string,
		renderKey: string,
		renderer: RetainedIslandRenderer,
	): Promise<RetainedAsyncPatchResult> {
		return this.patchIsland(id, "content", renderKey, renderer);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.structureKey = null;
		const previous = this.bindings;
		this.bindings = new Map();
		this.disposeBindings(previous);
	}

	private async patchIsland(
		id: string,
		kind: AsyncIslandKind,
		renderKey: string,
		renderer: RetainedIslandRenderer,
	): Promise<RetainedAsyncPatchResult> {
		const preparation = await this.prepareIsland(id, kind, renderKey, renderer);
		if (preparation.status !== "prepared") return preparation;
		return preparation.commit();
	}

	private prepareIsland(
		id: string,
		kind: AsyncIslandKind,
		renderKey: string,
		renderer: RetainedIslandRenderer,
	): Promise<RetainedIslandPreparationResult> {
		if (this.disposed) return Promise.resolve({ status: "disposed" });
		const binding = this.requireBinding(id, kind);
		if (binding.disposed) return Promise.resolve({ status: "disposed" });

		if (binding.inFlightKey === renderKey && binding.inFlightPromise) {
			return binding.inFlightPromise;
		}

		if (binding.hasCommitted && binding.committedKey === renderKey) {
			if (binding.inFlightPromise) this.cancelPendingIsland(binding);
			return Promise.resolve({ status: "unchanged" });
		}

		const generation = this.cancelPendingIsland(binding);
		if (!this.isCurrentIsland(id, binding, generation)) {
			return Promise.resolve({ status: this.staleIslandStatus(binding) });
		}
		const scope = new RetainedResourceScope(this.onCleanupError);
		binding.pendingScope = scope;
		binding.inFlightKey = renderKey;

		const promise = this.runIslandPreparation(
			id,
			binding,
			generation,
			renderKey,
			renderer,
			scope,
		).then((result) => {
			if (result.status !== "prepared") {
				this.clearPreparedTracking(binding, generation, scope, renderKey);
			}
			return result;
		});
		binding.inFlightPromise = promise;
		return promise;
	}

	private async runIslandPreparation(
		id: string,
		binding: AsyncIslandBinding,
		generation: number,
		renderKey: string,
		renderer: RetainedIslandRenderer,
		scope: RetainedResourceScope,
	): Promise<RetainedIslandPreparationResult> {
		const staging = binding.element.ownerDocument.createElement("div");
		const isCurrent = () => this.isCurrentIsland(id, binding, generation);

		try {
			await renderer({
				container: staging,
				ownerDocument: binding.element.ownerDocument,
				resources: scope,
				isCurrent,
			});
		} catch (error) {
			scope.dispose();
			if (!isCurrent()) return { status: this.staleIslandStatus(binding) };
			return { status: "failed", error };
		}

		if (!isCurrent()) {
			scope.dispose();
			return { status: this.staleIslandStatus(binding) };
		}

		let previousScope: RetainedResourceScope | null = null;
		let previousKey: string | null = null;
		let previousHasCommitted = false;
		let adopted = false;

		return new PreparedIslandPatch(
			renderKey,
			binding.element,
			staging,
			isCurrent,
			() => this.staleIslandStatus(binding),
			() => this.claimPreparedIsland(binding, generation, renderKey),
			() => {
				if (!this.isCurrentIsland(id, binding, generation)) {
					throw new Error("Cannot adopt a stale retained island");
				}
				previousScope = binding.committedScope;
				previousKey = binding.committedKey;
				previousHasCommitted = binding.hasCommitted;
				binding.committedScope = scope;
				binding.committedKey = renderKey;
				binding.hasCommitted = true;
				this.clearPreparedTracking(binding, generation, scope, renderKey);
				adopted = true;
			},
			() => {
				if (!adopted) return;
				if (!binding.disposed && this.bindings.get(id) === binding) {
					binding.committedScope = previousScope;
					binding.committedKey = previousKey;
					binding.hasCommitted = previousHasCommitted;
				}
				adopted = false;
			},
			() => {
				previousScope?.dispose();
				previousScope = null;
			},
			() => {
				this.disposePreparedIsland(
					id,
					binding,
					generation,
					renderKey,
					scope,
				);
			},
		);
	}

	private claimPreparedIsland(
		binding: AsyncIslandBinding,
		generation: number,
		renderKey: string,
	): void {
		if (binding.generation !== generation) return;
		if (binding.inFlightKey !== renderKey) return;
		binding.inFlightKey = null;
		binding.inFlightPromise = null;
	}

	private disposePreparedIsland(
		id: string,
		binding: AsyncIslandBinding,
		generation: number,
		renderKey: string,
		scope: RetainedResourceScope,
	): RetainedAsyncPatchResult {
		const isCurrent = this.isCurrentIsland(id, binding, generation);
		if (isCurrent) {
			binding.generation += 1;
			if (binding.pendingScope === scope) binding.pendingScope = null;
			if (binding.inFlightKey === renderKey) {
				binding.inFlightKey = null;
				binding.inFlightPromise = null;
			}
		}
		scope.dispose();
		return { status: this.staleIslandStatus(binding) };
	}

	private clearPreparedTracking(
		binding: AsyncIslandBinding,
		generation: number,
		scope: RetainedResourceScope,
		renderKey: string,
	): void {
		if (binding.generation !== generation) return;
		if (binding.pendingScope === scope) binding.pendingScope = null;
		if (binding.inFlightKey === renderKey) {
			binding.inFlightKey = null;
			binding.inFlightPromise = null;
		}
	}

	private cancelPendingIsland(binding: AsyncIslandBinding): number {
		const generation = binding.generation + 1;
		binding.generation = generation;
		const pendingScope = binding.pendingScope;
		binding.pendingScope = null;
		binding.inFlightKey = null;
		binding.inFlightPromise = null;
		pendingScope?.dispose();
		return generation;
	}

	private isCurrentIsland(
		id: string,
		binding: AsyncIslandBinding,
		generation: number,
	): boolean {
		return !this.disposed
			&& !binding.disposed
			&& this.bindings.get(id) === binding
			&& binding.generation === generation;
	}

	private staleIslandStatus(binding: AsyncIslandBinding): "stale" | "disposed" {
		return this.disposed || binding.disposed ? "disposed" : "stale";
	}

	private requireBinding<K extends RetainedBinding["kind"]>(
		id: string,
		kind: K,
	): Extract<RetainedBinding, { kind: K }> {
		const binding = this.bindings.get(id);
		if (!binding) throw new Error(`Unknown retained slot id: ${id}`);
		if (binding.kind !== kind) {
			throw new Error(`Retained slot ${id} is ${binding.kind}, expected ${kind}`);
		}
		return binding as Extract<RetainedBinding, { kind: K }>;
	}

	private assertOwnerDocument(binding: RetainedBinding): void {
		const target = binding.kind === "text" ? binding.node : binding.element;
		if (target.ownerDocument !== this.ownerDocument) {
			throw new Error("Retained slot target belongs to a different document");
		}
	}

	private disposeBindings(bindings: Map<string, RetainedBinding>): void {
		for (const binding of bindings.values()) {
			if (binding.kind !== "markdown" && binding.kind !== "content") continue;
			this.disposeIslandBinding(binding);
		}
		bindings.clear();
	}

	private disposeIslandBinding(binding: AsyncIslandBinding): void {
		if (binding.disposed) return;
		binding.disposed = true;
		binding.generation += 1;
		binding.pendingScope?.dispose();
		binding.pendingScope = null;
		binding.inFlightKey = null;
		binding.inFlightPromise = null;
		binding.committedScope?.dispose();
		binding.committedScope = null;
		binding.committedKey = null;
		binding.hasCommitted = false;
	}
}

function createAsyncIslandBinding(
	kind: AsyncIslandKind,
	element: HTMLElement,
): AsyncIslandBinding {
	return {
		kind,
		element,
		generation: 0,
		disposed: false,
		hasCommitted: false,
		committedKey: null,
		committedScope: null,
		pendingScope: null,
		inFlightKey: null,
		inFlightPromise: null,
	};
}

function parseExplicitRawHtml(ownerDocument: Document, html: string): Node[] {
	const Parser = ownerDocument.defaultView?.DOMParser ?? DOMParser;
	const parsed = new Parser().parseFromString(html, "text/html");
	return [...Array.from(parsed.head.childNodes), ...Array.from(parsed.body.childNodes)]
		.map((node) => ownerDocument.importNode(node, true));
}

function normalizeScalar(value: RetainedScalar): string {
	return value === null || value === undefined ? "" : String(value);
}

function normalizeThrownError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
