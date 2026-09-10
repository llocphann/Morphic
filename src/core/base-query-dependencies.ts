import {
	dependencyKey,
	type DependencyCollector,
	type DependencyKey,
} from "./dependencies";
import {
	fileDataDependencyKey,
	type FileDataField,
} from "./file-data-dependencies";
import {
	allPropertyDataDependencyKey,
	propertyDataDependencyKey,
} from "./property-data-dependencies";
import { tagFamilyDependencyKey } from "./tag-family-dependencies";

const FILE_FIELDS = new Set<FileDataField>([
	"name",
	"basename",
	"path",
	"folder",
	"extension",
	"size",
	"ctime",
	"mtime",
	"tags",
	"links",
	"embeds",
	"backlinks",
]);

const BARE_RESERVED = new Set([
	"and",
	"or",
	"not",
	"true",
	"false",
	"null",
	"undefined",
	"file",
	"note",
	"formula",
	"this",
	"value",
	"values",
	"index",
	"acc",
]);

interface SourceRange {
	readonly start: number;
	readonly end: number;
}

export interface BaseQueryDependencyContext {
	/** Embedding/active/Base file used by native Bases `this` semantics. */
	currentFilePath?: string;
	/** Optional selected source contract for config freshness. */
	sourceKind?: "template" | "code-block" | "file-embed";
	/** Resolved `.base` path for file-embed sources. */
	sourcePath?: string;
	/** Settings/view id that owns a template-defined Base block. */
	settingsViewId?: string;
}

/**
 * Statically derive the vault-data dependencies of one selected native Bases
 * config. The config itself remains part of provider/cache identity; these keys
 * answer which external revisions can change the result or selected row values.
 *
 * `index:files` is always present because Bases has the whole vault as its
 * implicit source: file create/delete/rename can change membership even when no
 * currently returned row depends on the changed file.
 */
export function collectBaseQueryDependencies(
	config: unknown,
	context: BaseQueryDependencyContext = {},
): readonly DependencyKey[] {
	const dependencies = new Set<DependencyKey>([dependencyKey.index("files")]);
	addSourceDependency(dependencies, context);

	const formulas = collectFormulaDefinitions(config);
	const resolvingFormulas = new Set<string>();
	const resolvedFormulas = new Set<string>();

	const resolveFormula = (name: string): void => {
		if (resolvedFormulas.has(name) || resolvingFormulas.has(name)) return;
		const expression = formulas.get(name);
		if (expression === undefined) return;
		resolvingFormulas.add(name);
		scanExpression(expression, dependencies, formulas, resolveFormula, context);
		resolvingFormulas.delete(name);
		resolvedFormulas.add(name);
	};

	visitConfig(config, dependencies, formulas, resolveFormula, context);
	// Native Bases may evaluate formula definitions beyond only visible columns;
	// tracking every configured formula is a bounded correctness-first fallback.
	for (const name of formulas.keys()) resolveFormula(name);
	return Array.from(dependencies).sort();
}

export function trackBaseQueryDependencies(
	collector: DependencyCollector,
	config: unknown,
	context: BaseQueryDependencyContext = {},
): readonly DependencyKey[] {
	const dependencies = collectBaseQueryDependencies(config, context);
	collector.trackMany(dependencies);
	return dependencies;
}

function visitConfig(
	value: unknown,
	dependencies: Set<DependencyKey>,
	formulas: ReadonlyMap<string, string>,
	resolveFormula: (name: string) => void,
	context: BaseQueryDependencyContext,
): void {
	if (!isRecord(value)) return;

	for (const [key, child] of Object.entries(value)) {
		if (key === "formulas") continue;
		if (key === "filters") {
			visitFilter(child, dependencies, formulas, resolveFormula, context);
			continue;
		}
		if (key === "property" || key === "groupBy") {
			if (typeof child === "string") {
				addPropertyReference(child, true, dependencies, resolveFormula);
			} else {
				visitConfig(child, dependencies, formulas, resolveFormula, context);
			}
			continue;
		}
		if (key === "order") {
			visitPropertyList(child, dependencies, resolveFormula);
			continue;
		}

		if (Array.isArray(child)) {
			for (const item of child) {
				if (isRecord(item)) visitConfig(item, dependencies, formulas, resolveFormula, context);
			}
		} else if (isRecord(child)) {
			visitConfig(child, dependencies, formulas, resolveFormula, context);
		}
	}
}

function visitFilter(
	value: unknown,
	dependencies: Set<DependencyKey>,
	formulas: ReadonlyMap<string, string>,
	resolveFormula: (name: string) => void,
	context: BaseQueryDependencyContext,
): void {
	if (typeof value === "string") {
		scanExpression(value, dependencies, formulas, resolveFormula, context);
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) visitFilter(item, dependencies, formulas, resolveFormula, context);
		return;
	}
	if (!isRecord(value)) return;

	for (const [key, child] of Object.entries(value)) {
		if (key === "property" && typeof child === "string") {
			addPropertyReference(child, true, dependencies, resolveFormula);
			continue;
		}
		if (key === "value" || key === "op" || key === "operator") continue;
		if (key === "and" || key === "or" || key === "not" || key === "filters" || key === "filter") {
			visitFilter(child, dependencies, formulas, resolveFormula, context);
			continue;
		}
		if (Array.isArray(child) || isRecord(child)) {
			visitFilter(child, dependencies, formulas, resolveFormula, context);
		}
	}
}

function visitPropertyList(
	value: unknown,
	dependencies: Set<DependencyKey>,
	resolveFormula: (name: string) => void,
): void {
	if (typeof value === "string") {
		addPropertyReference(value, true, dependencies, resolveFormula);
		return;
	}
	if (!Array.isArray(value)) return;
	for (const item of value) {
		if (typeof item === "string") addPropertyReference(item, true, dependencies, resolveFormula);
	}
}

function scanExpression(
	expression: string,
	dependencies: Set<DependencyKey>,
	formulas: ReadonlyMap<string, string>,
	resolveFormula: (name: string) => void,
	context: BaseQueryDependencyContext,
): void {
	const withoutStrings = stripStringLiterals(expression);
	const stringRanges = findStringLiteralRanges(expression);
	const outsideStrings = (index: number | undefined): boolean =>
		index !== undefined && !rangeContains(stringRanges, index);

	// Native Bases treats direct `this` (and `this.file` when passed to a file
	// function) as the current context File object. Link/File equality is identity
	// based, so path identity is the minimal dependency.
	if (/\bthis\b/.test(withoutStrings)) addCurrentFileIdentity(dependencies, context);

	for (const match of expression.matchAll(/\bthis\.file\.hasTag\(([^)]*)\)/g)) {
		if (!outsideStrings(match.index)) continue;
		addCurrentFileField("tags", dependencies, context);
		if (quotedArguments(match[1]).length === 0) addCurrentFileField("content", dependencies, context);
	}
	if (/\bthis\.file\.hasLink\s*\(/.test(withoutStrings)) addCurrentFileField("links", dependencies, context);
	for (const match of expression.matchAll(/\bthis\.file\.hasProperty\(([^)]*)\)/g)) {
		if (!outsideStrings(match.index)) continue;
		const [property] = quotedArguments(match[1]);
		addCurrentFileProperty(property, dependencies, context);
	}
	if (/\bthis\.file\.inFolder\s*\(/.test(withoutStrings)) addCurrentFileField("folder", dependencies, context);
	if (/\bthis\.file\.asLink\s*\(/.test(withoutStrings)) addCurrentFileField("path", dependencies, context);

	for (const match of expression.matchAll(/(?<!this\.)\bfile\.hasTag\(([^)]*)\)/g)) {
		if (!outsideStrings(match.index)) continue;
		const tags = quotedArguments(match[1]);
		if (tags.length === 0) dependencies.add(fileDataDependencyKey("tags"));
		for (const value of tags) dependencies.add(tagFamilyDependencyKey(value));
	}
	for (const match of expression.matchAll(/(?<!this\.)\bfile\.inFolder\(([^)]*)\)/g)) {
		if (!outsideStrings(match.index)) continue;
		const [folder] = quotedArguments(match[1]);
		if (folder === undefined) dependencies.add(fileDataDependencyKey("folder"));
		else dependencies.add(dependencyKey.index("folder", folder));
	}
	for (const match of expression.matchAll(/(?<!this\.)\bfile\.hasProperty\(([^)]*)\)/g)) {
		if (!outsideStrings(match.index)) continue;
		const [property] = quotedArguments(match[1]);
		if (property === undefined) dependencies.add(allPropertyDataDependencyKey());
		else dependencies.add(dependencyKey.index("property", property));
	}
	if (/(?<!this\.)\bfile\.hasLink\s*\(/.test(withoutStrings)) {
		dependencies.add(fileDataDependencyKey("links"));
	}
	if (/(?<!this\.)\bfile\.asLink\s*\(/.test(withoutStrings)) {
		dependencies.add(fileDataDependencyKey("path"));
	}
	if (/(?<![\w.])file\s*\(/.test(withoutStrings)) {
		addAllCandidateFileData(dependencies);
		dependencies.add(allPropertyDataDependencyKey());
	}

	for (const match of withoutStrings.matchAll(/\bnote\.([A-Za-z_][\w-]*)/g)) {
		dependencies.add(propertyDataDependencyKey(match[1]));
	}
	for (const match of expression.matchAll(/\bnote\[\s*(["'])(.*?)\1\s*\]/g)) {
		if (!outsideStrings(match.index)) continue;
		dependencies.add(propertyDataDependencyKey(match[2]));
	}
	if (/\bnote\s*\[\s*[^\]\s]/.test(withoutStrings)) {
		dependencies.add(allPropertyDataDependencyKey());
	}

	for (const match of withoutStrings.matchAll(/\bformula\.([A-Za-z_][\w-]*)/g)) {
		resolveFormula(match[1]);
	}
	for (const match of expression.matchAll(/\bformula\[\s*(["'])(.*?)\1\s*\]/g)) {
		if (!outsideStrings(match.index)) continue;
		resolveFormula(match[2]);
	}

	for (const match of withoutStrings.matchAll(/\bthis\.file\.([A-Za-z_][\w-]*)/g)) {
		const member = match[1];
		if (isKnownFileMethod(member)) continue;
		addCurrentFileField(member, dependencies, context);
	}
	for (const match of withoutStrings.matchAll(/(?<!this\.)\bfile\.([A-Za-z_][\w-]*)/g)) {
		const member = match[1];
		if (isKnownFileMethod(member)) continue;
		addCandidateFileField(member, dependencies);
	}

	if (/\bnow\s*\(/.test(withoutStrings)) dependencies.add(dependencyKey.time("now"));
	if (/\btoday\s*\(/.test(withoutStrings)) dependencies.add(dependencyKey.time("today"));
	if (/\brandom\s*\(/.test(withoutStrings)) dependencies.add(dependencyKey.time("random"));

	const sanitized = withoutStrings
		.replace(/\b(?:note|formula)\[[^\]]*\]/g, " ")
		.replace(/\bthis\.file\.[A-Za-z_][\w-]*/g, " ")
		.replace(/\b(?:note|formula|file)\.[A-Za-z_][\w-]*/g, " ")
		.replace(/\bthis\b/g, " ");
	const identifierPattern = /\b([A-Za-z_][\w-]*)\b/g;
	for (const match of sanitized.matchAll(identifierPattern)) {
		const identifier = match[1];
		if (BARE_RESERVED.has(identifier)) continue;
		const start = match.index ?? 0;
		const end = start + identifier.length;
		const previous = sanitized[start - 1];
		const rest = sanitized.slice(end);
		if (previous === "." || /^\s*\(/.test(rest)) continue;
		if (formulas.has(identifier)) {
			resolveFormula(identifier);
			continue;
		}
		dependencies.add(propertyDataDependencyKey(identifier));
	}
}

function addPropertyReference(
	reference: string,
	allowBare: boolean,
	dependencies: Set<DependencyKey>,
	resolveFormula: (name: string) => void,
): void {
	const trimmed = reference.trim();
	if (!trimmed) return;
	if (trimmed.startsWith("note.")) {
		const property = trimmed.slice("note.".length).trim();
		if (property) dependencies.add(propertyDataDependencyKey(property));
		return;
	}
	if (trimmed.startsWith("formula.")) {
		const formula = trimmed.slice("formula.".length).trim();
		if (formula) resolveFormula(formula);
		return;
	}
	if (trimmed.startsWith("file.")) {
		addCandidateFileField(trimmed.slice("file.".length), dependencies);
		return;
	}
	if (allowBare) dependencies.add(propertyDataDependencyKey(trimmed));
}

function addCandidateFileField(
	value: string,
	dependencies: Set<DependencyKey>,
): void {
	if (value === "properties") {
		dependencies.add(allPropertyDataDependencyKey());
		return;
	}
	if (value === "file") {
		dependencies.add(fileDataDependencyKey("path"));
		return;
	}
	const field = normalizeFileField(value);
	if (field) {
		dependencies.add(fileDataDependencyKey(field));
		return;
	}
	// Plugins may add file functions. Unknown candidate-file members must remain
	// correctness-safe until a plugin/runtime dependency contract is available.
	addAllCandidateFileData(dependencies);
	dependencies.add(allPropertyDataDependencyKey());
}

function addCurrentFileIdentity(
	dependencies: Set<DependencyKey>,
	context: BaseQueryDependencyContext,
): void {
	if (context.currentFilePath) {
		dependencies.add(dependencyKey.file(context.currentFilePath, "file", "path"));
	} else {
		dependencies.add(dependencyKey.index("files"));
	}
}

function addCurrentFileField(
	value: string,
	dependencies: Set<DependencyKey>,
	context: BaseQueryDependencyContext,
): void {
	const path = context.currentFilePath;
	if (!path) {
		if (value === "content") {
			dependencies.add(dependencyKey.index("files"));
			return;
		}
		addCandidateFileField(value, dependencies);
		return;
	}
	if (value === "content") {
		dependencies.add(dependencyKey.file(path, "content"));
		return;
	}
	if (value === "properties") {
		dependencies.add(dependencyKey.file(path, "metadata"));
		return;
	}
	if (value === "file") {
		dependencies.add(dependencyKey.file(path, "file", "path"));
		return;
	}
	const field = normalizeFileField(value);
	if (!field) {
		dependencies.add(dependencyKey.file(path, "metadata"));
		dependencies.add(dependencyKey.file(path, "content"));
		return;
	}
	if (field === "backlinks") {
		// Backlinks are a reverse-vault projection, so even current-file access
		// must observe source link changes outside the current file.
		dependencies.add(fileDataDependencyKey("backlinks"));
	} else if (field === "tags") {
		dependencies.add(dependencyKey.file(path, "tags"));
	} else if (field === "links") {
		dependencies.add(dependencyKey.file(path, "links"));
	} else if (field === "embeds") {
		dependencies.add(dependencyKey.file(path, "embeds"));
	} else if (field === "size" || field === "ctime" || field === "mtime") {
		dependencies.add(dependencyKey.file(path, "stat", field));
	} else {
		dependencies.add(dependencyKey.file(path, "file", field));
	}
}

function addCurrentFileProperty(
	property: string | undefined,
	dependencies: Set<DependencyKey>,
	context: BaseQueryDependencyContext,
): void {
	if (!context.currentFilePath) {
		dependencies.add(property === undefined
			? allPropertyDataDependencyKey()
			: dependencyKey.index("property", property));
		return;
	}
	dependencies.add(property === undefined
		? dependencyKey.file(context.currentFilePath, "metadata")
		: dependencyKey.file(context.currentFilePath, "frontmatter", property));
}

function addSourceDependency(
	dependencies: Set<DependencyKey>,
	context: BaseQueryDependencyContext,
): void {
	if (context.sourceKind === "file-embed" && context.sourcePath) {
		dependencies.add(dependencyKey.file(context.sourcePath, "content"));
	} else if (context.sourceKind === "code-block" && context.currentFilePath) {
		dependencies.add(dependencyKey.file(context.currentFilePath, "content"));
	} else if (context.sourceKind === "template") {
		dependencies.add(dependencyKey.settings(context.settingsViewId));
	}
}

function addAllCandidateFileData(dependencies: Set<DependencyKey>): void {
	for (const field of FILE_FIELDS) dependencies.add(fileDataDependencyKey(field));
}

function collectFormulaDefinitions(config: unknown): ReadonlyMap<string, string> {
	const formulas = new Map<string, string>();
	if (!isRecord(config) || !isRecord(config.formulas)) return formulas;
	for (const [name, expression] of Object.entries(config.formulas)) {
		if (typeof expression === "string") formulas.set(name, expression);
	}
	return formulas;
}

function normalizeFileField(value: string): FileDataField | null {
	const normalized = value === "ext" ? "extension" : value;
	return FILE_FIELDS.has(normalized as FileDataField)
		? normalized as FileDataField
		: null;
}

function isKnownFileMethod(value: string): boolean {
	return value === "hasTag"
		|| value === "hasLink"
		|| value === "hasProperty"
		|| value === "inFolder"
		|| value === "asLink";
}

function quotedArguments(value: string): readonly string[] {
	const result: string[] = [];
	for (const match of value.matchAll(/(["'])(.*?)\1/g)) result.push(match[2]);
	return result;
}

function stripStringLiterals(value: string): string {
	return value.replace(/(["'])(?:\\.|(?!\1).)*\1/g, match => " ".repeat(match.length));
}

function findStringLiteralRanges(value: string): readonly SourceRange[] {
	const ranges: SourceRange[] = [];
	for (const match of value.matchAll(/(["'])(?:\\.|(?!\1).)*\1/g)) {
		const start = match.index ?? 0;
		ranges.push({ start, end: start + match[0].length });
	}
	return ranges;
}

function rangeContains(ranges: readonly SourceRange[], index: number): boolean {
	return ranges.some(range => index >= range.start && index < range.end);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
