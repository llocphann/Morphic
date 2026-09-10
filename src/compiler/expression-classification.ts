import type {
	CompiledExpression,
	ExpressionVolatility,
	StaticDependencyHints,
} from "./expression-compiler";
import type { CompiledRuleDependencies } from "./rule-compiler";
import type { CompiledView, TemplateIR } from "./template-ir";

/**
 * Stable dependency classes exposed to cache/invalidation consumers.
 *
 * `static` is exclusive. Other classes may coexist because one expression/view
 * can depend on several revision domains at the same time.
 */
export type ExpressionDependencyClass =
	| "static"
	| "metadata-dependent"
	| "content-dependent"
	| "linked-file-dependent"
	| "bases-dependent"
	| "settings-dependent"
	| "today"
	| "now"
	| "random"
	| "unknown-runtime-dynamic";

/** Coarse scheduling/cache safety classification derived from dependency classes. */
export type ExpressionPurity = "static" | "context-dependent" | "volatile" | "unknown";

export interface ExpressionClassificationOptions {
	/** The caller knows this expression also depends on plugin/view settings. */
	readonly settingsDependent?: boolean;
	/** The caller observed or inferred a dependency that cannot be classified statically. */
	readonly unknownRuntimeDynamic?: boolean;
}

export interface ExpressionClassification {
	readonly dependencyClasses: readonly ExpressionDependencyClass[];
	readonly purity: ExpressionPurity;
}

export interface CompiledViewClassificationOptions {
	/**
	 * Compiled views originate from ViewConfig, so settings/config revision is a
	 * dependency by default. Pass false only when the caller keys the compiled
	 * object by an external immutable configuration identity.
	 */
	readonly settingsDependent?: boolean;
	/** Extra runtime-dynamic dependency observed outside the compiler hints. */
	readonly unknownRuntimeDynamic?: boolean;
}

const VOLATILITY_ORDER: readonly ExpressionVolatility[] = ["today", "now", "random"];
const DEPENDENCY_CLASS_ORDER: readonly ExpressionDependencyClass[] = [
	"metadata-dependent",
	"content-dependent",
	"linked-file-dependent",
	"bases-dependent",
	"settings-dependent",
	"today",
	"now",
	"random",
	"unknown-runtime-dynamic",
];

/**
 * Convert detailed static expression/template hints into a compact,
 * deterministic classification.
 *
 * Runtime dependency tracking remains authoritative. In particular, dynamic
 * linked-file targets are marked both linked-file-dependent and unknown-runtime-
 * dynamic so consumers do not incorrectly treat a static hint as an exact key.
 */
export function classifyExpressionDependencies(
	hints: StaticDependencyHints,
	options: ExpressionClassificationOptions = {},
): ExpressionClassification {
	const classes = new Set<ExpressionDependencyClass>();

	if (hints.usesSelfMetadata || hints.candidateSelfProperties.length > 0) {
		classes.add("metadata-dependent");
	}
	if (hints.usesSelfContent) classes.add("content-dependent");
	if (
		hints.staticLinkedFileTargets.length > 0
		|| hints.usesDynamicLinkedFile
		|| hints.usesLinkedMetadata
		|| hints.usesLinkedContent
	) {
		classes.add("linked-file-dependent");
	}
	if (hints.usesBases) classes.add("bases-dependent");
	if (options.settingsDependent) classes.add("settings-dependent");

	for (const volatility of VOLATILITY_ORDER) {
		if (hints.volatility.includes(volatility)) classes.add(volatility);
	}

	if (hints.usesDynamicLinkedFile || options.unknownRuntimeDynamic) {
		classes.add("unknown-runtime-dynamic");
	}

	return finalizeClassification(classes);
}

/** Convenience wrapper for callers that already retain a CompiledExpression. */
export function classifyCompiledExpression(
	compiled: Pick<CompiledExpression, "dependencyHints">,
	options: ExpressionClassificationOptions = {},
): ExpressionClassification {
	return classifyExpressionDependencies(compiled.dependencyHints, options);
}

/**
 * Classify one already-compiled template from its aggregate dependency hints.
 * No individual expression source is reparsed or walked again.
 */
export function classifyTemplateDependencies(
	template: Pick<TemplateIR, "dependencyHints">,
	options: ExpressionClassificationOptions = {},
): ExpressionClassification {
	return classifyExpressionDependencies(template.dependencyHints, options);
}

/**
 * Convert compiled matcher requirements into the same revision-domain vocabulary
 * used by expressions/templates.
 *
 * Named targets and generic outgoing-link matching are linked-file dependencies:
 * resolution can change when a linked target is created, renamed, moved, or
 * deleted. The matcher also depends on current-file metadata for its cached link
 * set and all other file/frontmatter/tag observations.
 */
export function classifyRuleDependencies(
	hints: CompiledRuleDependencies,
	options: ExpressionClassificationOptions = {},
): ExpressionClassification {
	const classes = new Set<ExpressionDependencyClass>();
	const usesSelfMetadata = hints.frontmatterFields.length > 0
		|| hints.usesAllFrontmatterForLinks
		|| hints.usesFileIdentity
		|| hints.usesFilePath
		|| hints.usesFileStats
		|| hints.usesOutgoingLinks
		|| hints.usesTags;

	if (usesSelfMetadata) classes.add("metadata-dependent");
	if (hints.staticLinkTargets.length > 0 || hints.usesOutgoingLinks) {
		classes.add("linked-file-dependent");
	}
	if (options.settingsDependent) classes.add("settings-dependent");
	if (options.unknownRuntimeDynamic) classes.add("unknown-runtime-dynamic");

	return finalizeClassification(classes);
}

/**
 * Classify the full compiled view handoff without re-reading source syntax.
 *
 * A CompiledView is config-derived, so settings/config dependency is included by
 * default. Bot 1 may pass `settingsDependent: false` only when an external stable
 * configuration identity already owns that revision boundary.
 */
export function classifyCompiledViewDependencies(
	view: Pick<CompiledView, "template" | "matcher">,
	options: CompiledViewClassificationOptions = {},
): ExpressionClassification {
	const classes = new Set<ExpressionDependencyClass>();
	const template = classifyTemplateDependencies(view.template);
	const matcher = classifyRuleDependencies(view.matcher.dependencies);

	for (const dependencyClass of template.dependencyClasses) {
		if (dependencyClass !== "static") classes.add(dependencyClass);
	}
	for (const dependencyClass of matcher.dependencyClasses) {
		if (dependencyClass !== "static") classes.add(dependencyClass);
	}
	if (options.settingsDependent ?? true) classes.add("settings-dependent");
	if (options.unknownRuntimeDynamic) classes.add("unknown-runtime-dynamic");

	return finalizeClassification(classes);
}

function finalizeClassification(
	classes: ReadonlySet<ExpressionDependencyClass>,
): ExpressionClassification {
	if (classes.size === 0) {
		return {
			dependencyClasses: ["static"],
			purity: "static",
		};
	}

	const dependencyClasses = DEPENDENCY_CLASS_ORDER.filter((entry) => classes.has(entry));
	return {
		dependencyClasses,
		purity: classifyPurity(dependencyClasses),
	};
}

function classifyPurity(classes: readonly ExpressionDependencyClass[]): ExpressionPurity {
	if (classes.includes("unknown-runtime-dynamic")) return "unknown";
	if (classes.some((entry) => entry === "today" || entry === "now" || entry === "random")) {
		return "volatile";
	}
	if (classes.length === 1 && classes[0] === "static") return "static";
	return "context-dependent";
}
