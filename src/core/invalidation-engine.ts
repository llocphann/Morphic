import type { DependencyRevisionReadSet } from "./dependency-read-set";
import {
	DependencyIndex,
	RevisionStore,
	type DependencyKey,
} from "./dependencies";

export interface InvalidationEngineOptions {
	/** Maximum unowned revision entries retained before compaction. */
	revisionCompactionSlack?: number;
}

/**
 * Connects dependency revisions to render owners. Event adapters translate
 * Obsidian events into DependencyKeys and feed them here.
 */
export class InvalidationEngine<Owner> {
	readonly revisions = new RevisionStore();
	readonly index = new DependencyIndex<Owner>();
	private readonly revisionCompactionSlack: number;

	constructor(
		private readonly invalidateOwner: (owner: Owner) => void,
		options: InvalidationEngineOptions = {},
	) {
		this.revisionCompactionSlack = nonNegativeInteger(options.revisionCompactionSlack, 2048);
	}

	commitDependencies(owner: Owner, dependencies: Iterable<DependencyKey>): void {
		this.index.replace(owner, dependencies);
		this.maybeCompactRevisions();
	}

	/**
	 * Commit one frozen render read set without first cloning its keys into a
	 * temporary Set. DependencyIndex still takes the single defensive Set copy it
	 * owns for reverse-index lifetime; callers keep no mutable alias into it.
	 */
	commitReadSet(owner: Owner, readSet: DependencyRevisionReadSet): void {
		this.index.replace(owner, readSet.dependencyIterator());
		this.maybeCompactRevisions();
	}

	remove(owner: Owner): void {
		this.index.remove(owner);
		this.maybeCompactRevisions();
	}

	invalidate(key: DependencyKey): readonly Owner[] {
		this.revisions.bump(key);
		const affected = this.index.affected(key);
		for (const owner of affected) this.invalidateOwner(owner);
		this.maybeCompactRevisions();
		return affected;
	}

	invalidateMany(keys: Iterable<DependencyKey>): readonly Owner[] {
		// Coalesced ReactiveDataCore paths already own ordinary native Sets while
		// collecting dependency changes. Reuse those synchronous, non-retained sets
		// instead of copying them again. Set subclasses/custom iterables still take
		// the defensive snapshot path so iterator semantics remain stable.
		const changed = isPlainDependencyKeySet(keys) ? keys : new Set(keys);
		for (const key of changed) this.revisions.bump(key);
		const affected = this.index.affectedMany(changed);
		for (const owner of affected) this.invalidateOwner(owner);
		this.maybeCompactRevisions();
		return affected;
	}

	fingerprint(owner: Owner): string {
		return this.revisions.fingerprint(this.index.dependenciesOf(owner));
	}

	private maybeCompactRevisions(): void {
		const tracked = this.revisions.trackedKeyCount();
		const active = this.index.dependencyKeyCount();
		if (tracked <= active + this.revisionCompactionSlack) return;
		this.revisions.compactKnownMembership(
			this.index.dependencyKeyIterator(),
			key => this.index.hasDependencyKey(key),
		);
	}
}

function isPlainDependencyKeySet(keys: Iterable<DependencyKey>): keys is Set<DependencyKey> {
	return keys instanceof Set && Object.getPrototypeOf(keys) === Set.prototype;
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? Math.floor(value)
		: fallback;
}
