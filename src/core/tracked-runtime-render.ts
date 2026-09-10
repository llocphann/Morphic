import {
	RevisionTrackingDependencyCollector,
	type DependencyRevisionReadSet,
} from "./dependency-read-set";
import type { DependencyKey } from "./dependencies";
import type { ReactiveDataCore } from "./reactive-data-core";
import type { RuntimeDataSession } from "./runtime-data";

/**
 * Render-generation data facade that binds RuntimeDataSession to the exact
 * revision store owned by one ReactiveDataCore.
 *
 * The constructor is private so callers cannot accidentally pair runtime reads
 * with an unrelated RevisionStore. Use beginRevisionTrackedRuntimeRender().
 */
export class RevisionTrackedRuntimeRenderSession {
	private constructor(
		readonly runtime: RuntimeDataSession,
		readonly collector: RevisionTrackingDependencyCollector,
	) {}

	static begin<Owner>(core: ReactiveDataCore<Owner>): RevisionTrackedRuntimeRenderSession {
		const collector = new RevisionTrackingDependencyCollector(core.snapshots.revisions);
		return new RevisionTrackedRuntimeRenderSession(
			core.beginRuntimeRender(collector),
			collector,
		);
	}

	/** Add one dependency that is semantically required by this committed render. */
	trackRequiredDependency(key: DependencyKey): void {
		this.collector.track(key);
	}

	/** Add commit-worthy dependencies in a batch; conservative hints must be filtered upstream. */
	trackRequiredDependencies(keys: Iterable<DependencyKey>): void {
		this.collector.trackMany(keys);
	}

	/** Current provisional dependency set; do not commit it before surface commit succeeds. */
	dependencies(): ReadonlySet<DependencyKey> {
		return this.collector.snapshot();
	}

	/** Freeze the first-read revision contract and request async freshness fences. */
	freezeReadSet(): DependencyRevisionReadSet {
		this.runtime.requestSynchronousValidation();
		return this.collector.readSet();
	}

	/** Wait for body freshness fences requested when the render was sealed. */
	async settleSynchronousValidation(): Promise<boolean> {
		return this.runtime.settleSynchronousValidation();
	}

	/** Guard metadata/link-resolution changes that become visible before their Obsidian event arrives. */
	isSynchronouslyCurrent(): boolean {
		return this.runtime.isSynchronouslyCurrent();
	}
}

/**
 * Begin one runtime-data preparation using ReactiveDataCore's authoritative
 * revision store. This function owns no controller, event, DOM, or scheduling behavior.
 */
export function beginRevisionTrackedRuntimeRender<Owner>(
	core: ReactiveDataCore<Owner>,
): RevisionTrackedRuntimeRenderSession {
	return RevisionTrackedRuntimeRenderSession.begin(core);
}
