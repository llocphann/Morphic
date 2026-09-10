import type { ViewConfig } from "../types";
import { compileRuleGroup } from "./rule-compiler";
import { compileTemplateCompat } from "./template-compat";
import type { CompiledView } from "./template-ir";

/**
 * Assemble one immutable compiler handoff object for a stable ViewConfig.
 *
 * Callers own revisioning/caching: when `configRevision` is unchanged, retain
 * and reuse the returned object instead of compiling the view again.
 *
 * Production view compilation preserves the legacy renderer's fail-soft boundary
 * for malformed interpolation/control-flow expressions. Tooling can still call
 * strict `compileTemplate()` directly when authoring diagnostics should throw.
 */
export function compileView(
	config: ViewConfig,
	configRevision: string | number,
): CompiledView {
	const template = compileTemplateCompat(config.template);
	const matcher = compileRuleGroup(config.rules);
	return {
		viewId: config.id,
		configRevision,
		template,
		matcher,
		matcherId: hashMatcher(config.rules),
		dependencyHints: {
			template: template.dependencyHints,
			matcher: matcher.dependencies,
		},
	};
}

function hashMatcher(value: unknown): string {
	return hashString(stableSerialize(value));
}

function stableSerialize(value: unknown): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map((entry) => stableSerialize(entry)).join(",")}]`;
	}

	const record = value as Record<string, unknown>;
	const keys = Object.keys(record).sort();
	return `{${keys.map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(",")}}`;
}

function hashString(source: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < source.length; i++) {
		hash ^= source.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return `rules-fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
