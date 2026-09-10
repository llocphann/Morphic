import { parseExpression, splitExpressionAndPipes } from "../expression";
import {
	assembleFlatAttributeParts,
	assembleStructuralAttributeParts,
	normalizeAttributeSlotContexts,
} from "./template-attribute-parts";
import {
	compileExpression,
	type ExpressionVolatility,
	type StaticDependencyHints,
} from "./expression-compiler";
import { compileTemplate } from "./template-compiler";
import type { TemplateIR } from "./template-ir";

export type TemplateCompileDiagnosticContext =
	| "interpolation"
	| "if-condition"
	| "elif-condition"
	| "for-iterable";

export interface TemplateCompileDiagnostic {
	readonly kind: "legacy-null-fallback";
	readonly context: TemplateCompileDiagnosticContext;
	readonly source: string;
	readonly message: string;
}

/**
 * Strict TemplateIR plus diagnostics for syntax that legacy rendering treated as
 * a null/false/no-loop value instead of aborting the complete view render.
 */
export interface CompatibleTemplateIR extends TemplateIR {
	readonly diagnostics: readonly TemplateCompileDiagnostic[];
}

const TEMPLATE_EXPR_RE = /\{\{((?:[^{}]|\{[^{]|\}[^}])*?)\}\}/g;
const LOGIC_TAG_RE = /\{%\s*([\s\S]*?)\s*%\}/g;
const IMPLICIT_LINK_PROPERTY_RE = /\b([a-zA-Z_][a-zA-Z0-9_-]*)(?:\s*\[\s*\d+\s*\])*\s*\.\s*[a-zA-Z_][a-zA-Z0-9_-]*\b(?!\s*\()/g;
const SAFE_NON_LINK_PROPERTY_ROOTS = new Set(["file", "loop"]);
const ALL_VOLATILITY: readonly ExpressionVolatility[] = ["now", "random", "today"];
const TEMPLATE_COMPAT_CACHE_LIMIT = 128;
const templateCompatCache = new Map<string, CompatibleTemplateIR>();

/**
 * Clear the production template compatibility cache.
 *
 * The cache is source-keyed, so normal settings/template edits naturally compile
 * a new entry. This explicit hook exists for deterministic tests and lifecycle
 * cleanup without exposing the cache itself.
 */
export function clearTemplateCompatCache(): void {
	templateCompatCache.clear();
}

/**
 * Compile a template with the legacy renderer's fail-soft expression boundary.
 *
 * The strict `compileTemplate()` API intentionally continues to throw on invalid
 * expressions so compiler/tooling callers can surface authoring errors. Production
 * view compilation uses this compatibility wrapper because the legacy renderer
 * converted malformed interpolation expressions to an empty string, malformed
 * if/elif conditions to false, and malformed for iterables to no output.
 *
 * Any recovered syntax receives maximally conservative dependency hints. Runtime
 * invalidation must never treat an unparseable source expression as static merely
 * because its execution fallback is the literal `null` AST.
 *
 * Legacy expression semantics also auto-traverse a wiki-link string when ordinary
 * property access (for example `friend.status`) cannot be satisfied on the string
 * itself. The compiled retained evaluators do not own RuntimeDataSession link-edge
 * tracking yet, so production compatibility compilation marks such property chains
 * as dynamic linked metadata. Retained self-only gates therefore fail closed to the
 * legacy runtime-tracked resolver instead of committing an incomplete read-set.
 */
export function compileTemplateCompat(source: string): CompatibleTemplateIR {
	const cached = templateCompatCache.get(source);
	if (cached) {
		// Refresh recency so frequently rendered views remain resident while old
		// template revisions are naturally evicted.
		templateCompatCache.delete(source);
		templateCompatCache.set(source, cached);
		return cached;
	}

	const diagnostics: TemplateCompileDiagnostic[] = [];
	const sanitized = sanitizeTemplateExpressions(source, diagnostics);
	const compiled = compileTemplate(sanitized);
	const normalizedNodes = normalizeAttributeSlotContexts(sanitized, compiled.nodes);
	const flatNodes = assembleFlatAttributeParts(sanitized, normalizedNodes);
	const nodes = assembleStructuralAttributeParts(flatNodes);
	const baseHints = diagnostics.length > 0
		? makeConservativeHints(compiled.dependencyHints)
		: compiled.dependencyHints;
	const dependencyHints = templateHasImplicitWikiLinkTraversal(source)
		? makeImplicitLinkedTraversalHints(baseHints)
		: baseHints;

	const compatible: CompatibleTemplateIR = {
		...compiled,
		nodes,
		sourceHash: hashTemplateSource(source),
		dependencyHints,
		diagnostics,
	};

	cacheCompatibleTemplate(source, compatible);
	return compatible;
}

function cacheCompatibleTemplate(source: string, compiled: CompatibleTemplateIR): void {
	templateCompatCache.set(source, compiled);
	if (templateCompatCache.size <= TEMPLATE_COMPAT_CACHE_LIMIT) return;

	const oldest = templateCompatCache.keys().next();
	if (!oldest.done) {
		templateCompatCache.delete(oldest.value);
	}
}

function sanitizeTemplateExpressions(
	source: string,
	diagnostics: TemplateCompileDiagnostic[],
): string {
	TEMPLATE_EXPR_RE.lastIndex = 0;
	let sanitized = source.replace(TEMPLATE_EXPR_RE, (fullMatch: string, inner: string) => {
		const expression = inner.trim();
		try {
			compileExpression(expression);
			return fullMatch;
		} catch (error) {
			diagnostics.push(makeDiagnostic("interpolation", expression, error));
			return "{{ null }}";
		}
	});
	TEMPLATE_EXPR_RE.lastIndex = 0;

	LOGIC_TAG_RE.lastIndex = 0;
	sanitized = sanitized.replace(LOGIC_TAG_RE, (fullMatch: string, content: string) => {
		const directive = parseLegacyLogicExpression(content);
		if (!directive) return fullMatch;

		try {
			// Legacy logic parses only the expression prefix before an outside pipe.
			// Interpolation filters do not execute inside {% if %}/{% for %} tags.
			const { expression, pipeFilters } = splitExpressionAndPipes(directive.expression);
			parseExpression(expression);
			return pipeFilters === null
				? fullMatch
				: formatLogicDirective(directive, expression);
		} catch (error) {
			diagnostics.push(makeDiagnostic(directive.context, directive.expression, error));
			return formatLogicDirective(directive, "null");
		}
	});
	LOGIC_TAG_RE.lastIndex = 0;

	return sanitized;
}

function templateHasImplicitWikiLinkTraversal(source: string): boolean {
	TEMPLATE_EXPR_RE.lastIndex = 0;
	let interpolation: RegExpExecArray | null;
	while ((interpolation = TEMPLATE_EXPR_RE.exec(source)) !== null) {
		if (expressionHasImplicitWikiLinkTraversal(interpolation[1])) {
			TEMPLATE_EXPR_RE.lastIndex = 0;
			return true;
		}
	}
	TEMPLATE_EXPR_RE.lastIndex = 0;

	LOGIC_TAG_RE.lastIndex = 0;
	let logic: RegExpExecArray | null;
	while ((logic = LOGIC_TAG_RE.exec(source)) !== null) {
		const content = logic[1].trim();
		const directive = parseLegacyLogicExpression(content);
		if (directive && expressionHasImplicitWikiLinkTraversal(directive.expression)) {
			LOGIC_TAG_RE.lastIndex = 0;
			return true;
		}
		const setMatch = content.match(/^set\s+[a-zA-Z_][a-zA-Z0-9_]*\s*=\s*([\s\S]+)$/);
		if (setMatch && expressionHasImplicitWikiLinkTraversal(setMatch[1])) {
			LOGIC_TAG_RE.lastIndex = 0;
			return true;
		}
	}
	LOGIC_TAG_RE.lastIndex = 0;
	return false;
}

function expressionHasImplicitWikiLinkTraversal(source: string): boolean {
	let expression = source.trim();
	try {
		expression = splitExpressionAndPipes(expression).expression;
	} catch {
		// Invalid syntax is already handled conservatively by diagnostics.
		return false;
	}

	IMPLICIT_LINK_PROPERTY_RE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = IMPLICIT_LINK_PROPERTY_RE.exec(expression)) !== null) {
		if (!SAFE_NON_LINK_PROPERTY_ROOTS.has(match[1])) {
			IMPLICIT_LINK_PROPERTY_RE.lastIndex = 0;
			return true;
		}
	}
	IMPLICIT_LINK_PROPERTY_RE.lastIndex = 0;
	return false;
}

function parseLegacyLogicExpression(content: string):
	| {
		readonly context: "if-condition" | "elif-condition";
		readonly expression: string;
	  }
	| {
		readonly context: "for-iterable";
		readonly expression: string;
		readonly variable: string;
	  }
	| null {
	const trimmed = content.trim();
	const ifMatch = trimmed.match(/^if(?:\s+([\s\S]*))?$/);
	if (ifMatch) {
		return { context: "if-condition", expression: (ifMatch[1] ?? "").trim() };
	}

	const elifMatch = trimmed.match(/^elif(?:\s+([\s\S]*))?$/);
	if (elifMatch) {
		return { context: "elif-condition", expression: (elifMatch[1] ?? "").trim() };
	}

	const forMatch = trimmed.match(/^for\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+in\s+([\s\S]*)$/);
	if (forMatch) {
		return {
			context: "for-iterable",
			variable: forMatch[1],
			expression: forMatch[2].trim(),
		};
	}

	return null;
}

function formatLogicDirective(
	directive: NonNullable<ReturnType<typeof parseLegacyLogicExpression>>,
	expression: string,
): string {
	if (directive.context === "for-iterable") {
		return `{% for ${directive.variable} in ${expression} %}`;
	}
	return directive.context === "elif-condition"
		? `{% elif ${expression} %}`
		: `{% if ${expression} %}`;
}

function makeDiagnostic(
	context: TemplateCompileDiagnosticContext,
	source: string,
	error: unknown,
): TemplateCompileDiagnostic {
	return {
		kind: "legacy-null-fallback",
		context,
		source,
		message: error instanceof Error ? error.message : String(error),
	};
}

function makeImplicitLinkedTraversalHints(existing: StaticDependencyHints): StaticDependencyHints {
	return {
		...existing,
		usesDynamicLinkedFile: true,
		usesLinkedMetadata: true,
	};
}

function makeConservativeHints(existing: StaticDependencyHints): StaticDependencyHints {
	return {
		candidateSelfProperties: existing.candidateSelfProperties,
		usesSelfMetadata: true,
		usesSelfContent: true,
		staticLinkedFileTargets: existing.staticLinkedFileTargets,
		usesDynamicLinkedFile: true,
		usesLinkedMetadata: true,
		usesLinkedContent: true,
		usesBases: true,
		volatility: mergeVolatility(existing.volatility),
	};
}

function mergeVolatility(
	existing: readonly ExpressionVolatility[],
): readonly ExpressionVolatility[] {
	const values = new Set<ExpressionVolatility>(existing);
	for (const volatility of ALL_VOLATILITY) values.add(volatility);
	return [...values].sort();
}

function hashTemplateSource(source: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < source.length; i++) {
		hash ^= source.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}