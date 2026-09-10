import {
	RetainedCommitTransaction,
	type RetainedCommitParticipant,
	type RetainedCommitTransactionResult,
} from "./retained-commit-transaction";
import {
	RetainedDomRuntime,
	type RetainedDomRuntimeOptions,
	type RetainedStructureBuilder,
} from "./retained-slot-runtime";

export interface RetainedDetachedGenerationHostOptions {
	readonly runtime?: RetainedDomRuntimeOptions;
}

export interface RetainedReusedGeneration {
	readonly status: "reused";
	readonly structureKey: string;
	readonly runtime: RetainedDomRuntime;
}

export interface RetainedFailedGenerationPreparation {
	readonly status: "failed";
	readonly error: unknown;
}

export interface RetainedDisposedGenerationPreparation {
	readonly status: "disposed";
}

export interface RetainedPreparedGeneration {
	readonly status: "prepared";
	readonly structureKey: string;
	readonly runtime: RetainedDomRuntime;
	isCurrent(): boolean;
	toCommitParticipant(): RetainedCommitParticipant;
	commit(): RetainedCommitTransactionResult;
	dispose(): void;
}

export type RetainedGenerationPreparationResult =
	| RetainedPreparedGeneration
	| RetainedReusedGeneration
	| RetainedFailedGenerationPreparation
	| RetainedDisposedGenerationPreparation;

interface ActiveGeneration {
	readonly structureKey: string;
	readonly runtime: RetainedDomRuntime;
}

type PreparedGenerationState =
	| "prepared"
	| "applying"
	| "applied"
	| "adopting"
	| "adopted"
	| "rolled-back"
	| "finalized"
	| "discarded";

/**
 * Owner-level staging host for retained structure generations.
 *
 * A new structure is built inside a detached element using a normal
 * `RetainedDomRuntime`. Callers may fully initialize that staged runtime,
 * including awaited Markdown/content islands, before exposing its DOM as one
 * rollback-capable participant in the owner's final synchronous transaction.
 *
 * After adoption, the staged runtime intentionally keeps its detached staging
 * element as its internal root. Its retained bindings point at the exact Nodes
 * moved into the live root, so same-structure text/attribute/island patches keep
 * working without a semantic live wrapper. A later structure change creates a
 * fresh detached runtime rather than asking the adopted runtime to remount.
 */
export class RetainedDetachedGenerationHost {
	private readonly ownerDocument: Document;
	private readonly runtimeOptions?: RetainedDomRuntimeOptions;
	private active: ActiveGeneration | null = null;
	private pending: PreparedGeneration | null = null;
	private generation = 0;
	private disposed = false;

	constructor(
		private readonly root: HTMLElement,
		options: RetainedDetachedGenerationHostOptions = {},
	) {
		this.ownerDocument = root.ownerDocument;
		this.runtimeOptions = options.runtime;
	}

	get isDisposed(): boolean {
		return this.disposed;
	}

	get currentStructureKey(): string | null {
		return this.active?.structureKey ?? null;
	}

	get activeRuntime(): RetainedDomRuntime | null {
		return this.active?.runtime ?? null;
	}

	/**
	 * Prepare one structure generation without mutating the live root.
	 *
	 * A same-key active generation is reused. Every pending request is generation
	 * specific, including repeated structure keys: a newer request supersedes old
	 * detached staging so it cannot retain initial values or async work from an
	 * older render generation.
	 */
	prepareStructure(
		structureKey: string,
		builder: RetainedStructureBuilder,
	): RetainedGenerationPreparationResult {
		return this.prepareInitializedStructure(structureKey, (runtime) => {
			const status = runtime.mountStructure(structureKey, builder);
			if (status === "disposed") {
				throw new DetachedRuntimeDisposedError();
			}
			if (status !== "mounted") {
				throw new Error("Detached retained generation unexpectedly reused a fresh runtime");
			}
		});
	}

	/**
	 * Create one fresh detached runtime and let the caller initialize it fully.
	 *
	 * This is the composition point for higher-level retained surfaces that must
	 * own their initial value snapshot while mounting the structure themselves.
	 * The initializer runs only for a fresh detached generation; active same-key
	 * reuse still supersedes pending staging and returns the existing runtime.
	 * A successful initializer must leave `structureKey` mounted on the runtime.
	 */
	prepareInitializedStructure(
		structureKey: string,
		initialize: (runtime: RetainedDomRuntime) => void,
	): RetainedGenerationPreparationResult {
		if (this.disposed) return { status: "disposed" };

		if (this.active?.structureKey === structureKey) {
			this.supersedePending();
			return {
				status: "reused",
				structureKey,
				runtime: this.active.runtime,
			};
		}

		this.supersedePending();
		const generation = ++this.generation;
		const stagingRoot = this.ownerDocument.createElement("div");
		const runtime = new RetainedDomRuntime(stagingRoot, this.runtimeOptions);

		try {
			initialize(runtime);
			if (runtime.currentStructureKey !== structureKey) {
				throw new Error("Detached retained initializer did not mount the requested structure");
			}
		} catch (error) {
			runtime.dispose();
			return error instanceof DetachedRuntimeDisposedError
				? { status: "disposed" }
				: { status: "failed", error };
		}

		const prepared = new PreparedGeneration(
			this,
			generation,
			structureKey,
			runtime,
			stagingRoot,
		);
		this.pending = prepared;
		return prepared;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.generation++;

		const pending = this.pending;
		this.pending = null;
		pending?.disposeFromHost();

		const active = this.active;
		this.active = null;
		active?.runtime.dispose();
	}

	isPreparedCurrent(prepared: PreparedGeneration): boolean {
		if (this.disposed || prepared.generation !== this.generation || prepared.isCancelled) {
			return false;
		}
		if (prepared.isAdopted) return this.active?.runtime === prepared.runtime;
		return this.pending === prepared;
	}

	adopt(prepared: PreparedGeneration): ActiveGeneration | null {
		if (!this.isPreparedCurrent(prepared)) {
			throw new Error("Cannot adopt a stale detached retained generation");
		}
		const previous = this.active;
		this.active = {
			structureKey: prepared.structureKey,
			runtime: prepared.runtime,
		};
		if (this.pending === prepared) this.pending = null;
		return previous;
	}

	rollbackAdoption(
		prepared: PreparedGeneration,
		previous: ActiveGeneration | null,
	): void {
		if (this.active?.runtime === prepared.runtime) this.active = previous;
	}

	clearPending(prepared: PreparedGeneration): void {
		if (this.pending === prepared) this.pending = null;
	}

	snapshotLiveNodes(): Node[] {
		return Array.from(this.root.childNodes);
	}

	replaceLiveChildren(nodes: readonly Node[]): void {
		this.root.replaceChildren(...nodes);
	}

	private supersedePending(): void {
		if (!this.pending) return;
		this.generation++;
		const previous = this.pending;
		this.pending = null;
		previous.disposeFromHost();
	}
}

class PreparedGeneration implements RetainedPreparedGeneration, RetainedCommitParticipant {
	readonly status = "prepared" as const;
	private state: PreparedGenerationState = "prepared";
	private cancelled = false;
	private previousNodes: Node[] = [];
	private previousActive: ActiveGeneration | null = null;

	constructor(
		private readonly host: RetainedDetachedGenerationHost,
		readonly generation: number,
		readonly structureKey: string,
		readonly runtime: RetainedDomRuntime,
		private readonly stagingRoot: HTMLElement,
	) {}

	get isCancelled(): boolean {
		return this.cancelled;
	}

	get isAdopted(): boolean {
		return this.state === "adopted";
	}

	isCurrent(): boolean {
		return this.state !== "finalized"
			&& this.state !== "discarded"
			&& this.host.isPreparedCurrent(this);
	}

	toCommitParticipant(): RetainedCommitParticipant {
		return this;
	}

	commit(): RetainedCommitTransactionResult {
		const transaction = new RetainedCommitTransaction(() => this.isCurrent());
		return transaction.commit([this]);
	}

	apply(): void {
		if (this.state !== "prepared") {
			throw new Error("Detached retained generation is not ready to apply");
		}
		if (!this.isCurrent()) {
			throw new Error("Cannot apply a stale detached retained generation");
		}

		this.previousNodes = this.host.snapshotLiveNodes();
		const nextNodes = Array.from(this.stagingRoot.childNodes);
		this.state = "applying";
		this.host.replaceLiveChildren(nextNodes);
		this.state = "applied";
	}

	adopt(): void {
		if (this.state !== "applied") {
			throw new Error("Detached retained generation is not ready to adopt");
		}
		this.state = "adopting";
		this.previousActive = this.host.adopt(this);
		this.state = "adopted";
	}

	rollback(): void {
		if (
			this.state !== "applying"
			&& this.state !== "applied"
			&& this.state !== "adopting"
			&& this.state !== "adopted"
		) return;

		let adoptionError: unknown;
		if (this.state === "adopting" || this.state === "adopted") {
			try {
				this.host.rollbackAdoption(this, this.previousActive);
			} catch (error) {
				adoptionError = error;
			}
		}

		let domError: unknown;
		try {
			this.host.replaceLiveChildren(this.previousNodes);
		} catch (error) {
			domError = error;
		}
		this.state = "rolled-back";

		if (adoptionError !== undefined) throw normalizeError(adoptionError);
		if (domError !== undefined) throw normalizeError(domError);
	}

	finalize(): void {
		if (this.state !== "adopted") return;
		try {
			this.previousActive?.runtime.dispose();
			this.previousActive = null;
		} finally {
			this.state = "finalized";
		}
	}

	discard(): void {
		if (this.state === "finalized" || this.state === "discarded") return;
		this.host.clearPending(this);
		this.cancelled = true;
		try {
			this.runtime.dispose();
		} finally {
			this.state = "discarded";
		}
	}

	dispose(): void {
		if (
			this.state === "applying"
			|| this.state === "applied"
			|| this.state === "adopting"
			|| this.state === "adopted"
		) {
			this.cancelled = true;
			return;
		}
		this.discard();
	}

	disposeFromHost(): void {
		this.cancelled = true;
		if (
			this.state === "applying"
			|| this.state === "applied"
			|| this.state === "adopting"
			|| this.state === "adopted"
		) return;
		this.discard();
	}
}

class DetachedRuntimeDisposedError extends Error {
	constructor() {
		super("Detached retained runtime was disposed during initialization");
		this.name = "DetachedRuntimeDisposedError";
	}
}

function normalizeError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
