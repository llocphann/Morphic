import type { App, FrontMatterCache, TFile } from "obsidian";
import {
	compileRuleGroup,
	type CompiledRuleGroup,
} from "./compiler/rule-compiler";
import type { Filter, FilterConjunction, FilterGroup, FilterOperator } from "./types";

type RuleConditionSnapshot = FilterSnapshot | FilterGroupSnapshot;

interface FilterSnapshot {
	readonly type: "filter";
	readonly field: string;
	readonly operator: FilterOperator;
	readonly value?: string;
}

interface FilterGroupSnapshot {
	readonly type: "group";
	readonly operator: FilterConjunction;
	readonly conditions: readonly RuleConditionSnapshot[];
}

interface CompiledRuleCacheEntry {
	readonly snapshot: FilterGroupSnapshot;
	readonly compiled: CompiledRuleGroup;
}

/**
 * Rules normally retain object identity for many owner renders. A WeakMap keeps
 * compiled predicates attached to that settings object without extending its
 * lifetime. The structural snapshot guards settings editors that mutate an
 * existing FilterGroup in place instead of replacing the object.
 */
let compiledRuleCache = new WeakMap<FilterGroup, CompiledRuleCacheEntry>();

/** Reset matcher compilation state for deterministic tests or plugin lifecycle cleanup. */
export function clearCompiledRuleCache(): void {
	compiledRuleCache = new WeakMap<FilterGroup, CompiledRuleCacheEntry>();
}

/**
 * Evaluate a rule group through the compiler-backed matcher while preserving the
 * historical `checkRules()` API used by production owner selection.
 *
 * Compilation is repeated only when the rule object is new or its semantic rule
 * fields changed in place. File/frontmatter inputs remain fully dynamic and are
 * evaluated by the compiled predicate on every call.
 */
export function checkRules(
	app: App,
	group: FilterGroup,
	file: TFile,
	frontmatter?: FrontMatterCache,
): boolean {
	if (!group || !group.conditions || group.conditions.length === 0) return true;

	const cached = compiledRuleCache.get(group);
	if (cached && matchesSnapshot(group, cached.snapshot)) {
		return cached.compiled.matches(app, file, frontmatter);
	}

	const compiled = compileRuleGroup(group);
	compiledRuleCache.set(group, {
		snapshot: snapshotGroup(group),
		compiled,
	});
	return compiled.matches(app, file, frontmatter);
}

function snapshotGroup(group: FilterGroup): FilterGroupSnapshot {
	return {
		type: "group",
		operator: group.operator,
		conditions: group.conditions.map(condition => condition.type === "group"
			? snapshotGroup(condition)
			: snapshotFilter(condition)),
	};
}

function snapshotFilter(filter: Filter): FilterSnapshot {
	return {
		type: "filter",
		field: filter.field,
		operator: filter.operator,
		value: filter.value,
	};
}

function matchesSnapshot(group: FilterGroup, snapshot: FilterGroupSnapshot): boolean {
	if (group.operator !== snapshot.operator) return false;
	if (group.conditions.length !== snapshot.conditions.length) return false;

	for (let index = 0; index < group.conditions.length; index++) {
		const current = group.conditions[index];
		const previous = snapshot.conditions[index];
		if (current.type !== previous.type) return false;

		if (current.type === "group") {
			if (previous.type !== "group" || !matchesSnapshot(current, previous)) return false;
			continue;
		}

		if (previous.type !== "filter" || !matchesFilterSnapshot(current, previous)) return false;
	}

	return true;
}

function matchesFilterSnapshot(filter: Filter, snapshot: FilterSnapshot): boolean {
	return filter.field === snapshot.field
		&& filter.operator === snapshot.operator
		&& filter.value === snapshot.value;
}
