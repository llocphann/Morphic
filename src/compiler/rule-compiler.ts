import type { App, FrontMatterCache, TFile } from "obsidian";
import type { Filter, FilterGroup, FilterOperator } from "../types";

type MatcherScalar = string | number | boolean;
type MatcherValue = MatcherScalar | string[] | null;
type FrontmatterRuleValue = string | number | boolean | string[] | undefined;

type CompiledPredicate = (state: MatchEvaluationState) => boolean;

export interface CompiledRuleDependencies {
	frontmatterFields: string[];
	staticLinkTargets: string[];
	usesAllFrontmatterForLinks: boolean;
	usesFileIdentity: boolean;
	usesFilePath: boolean;
	usesFileStats: boolean;
	usesOutgoingLinks: boolean;
	usesTags: boolean;
}

export interface CompiledRuleGroup {
	readonly source: FilterGroup;
	readonly dependencies: CompiledRuleDependencies;
	matches(app: App, file: TFile, frontmatter?: FrontMatterCache): boolean;
}

interface MutableRuleDependencies {
	frontmatterFields: Set<string>;
	staticLinkTargets: Set<string>;
	usesAllFrontmatterForLinks: boolean;
	usesFileIdentity: boolean;
	usesFilePath: boolean;
	usesFileStats: boolean;
	usesOutgoingLinks: boolean;
	usesTags: boolean;
}

interface MatchEvaluationState {
	app: App;
	file: TFile;
	frontmatter?: FrontMatterCache;
	fileTags?: string[];
	resolvedOutgoingLinkPaths?: string[];
	resolvedOutgoingLinkNames?: string[];
}

const DATE_OPERATORS = new Set<FilterOperator>([
	"on",
	"not on",
	"before",
	"on or before",
	"after",
	"on or after",
	"is empty",
	"is not empty",
]);

const NUMERIC_OPERATORS = new Set<FilterOperator>([
	"=",
	"≠",
	"<",
	"≤",
	">",
	"≥",
]);

/**
 * Compile a rule tree once so stable rule syntax is not normalized repeatedly
 * for every matching file/render pass.
 *
 * The compiled matcher is a semantic peer of matcher.checkRules(), but it also:
 * - short-circuits AND/OR/NOR groups;
 * - pre-parses comma-separated rule constants;
 * - pre-normalizes folders, property names, tags, and date constants;
 * - memoizes self tags/outgoing-link resolution inside one match evaluation.
 *
 * Recompile when the rule configuration changes.
 */
export function compileRuleGroup(group: FilterGroup): CompiledRuleGroup {
	const mutableDependencies = createMutableDependencies();
	const predicate = compileGroup(group, mutableDependencies);
	const dependencies = freezeDependencies(mutableDependencies);

	return {
		source: group,
		dependencies,
		matches(app, file, frontmatter) {
			return predicate({ app, file, frontmatter });
		},
	};
}

function createMutableDependencies(): MutableRuleDependencies {
	return {
		frontmatterFields: new Set(),
		staticLinkTargets: new Set(),
		usesAllFrontmatterForLinks: false,
		usesFileIdentity: false,
		usesFilePath: false,
		usesFileStats: false,
		usesOutgoingLinks: false,
		usesTags: false,
	};
}

function freezeDependencies(dependencies: MutableRuleDependencies): CompiledRuleDependencies {
	return {
		frontmatterFields: [...dependencies.frontmatterFields].sort(),
		staticLinkTargets: [...dependencies.staticLinkTargets].sort(),
		usesAllFrontmatterForLinks: dependencies.usesAllFrontmatterForLinks,
		usesFileIdentity: dependencies.usesFileIdentity,
		usesFilePath: dependencies.usesFilePath,
		usesFileStats: dependencies.usesFileStats,
		usesOutgoingLinks: dependencies.usesOutgoingLinks,
		usesTags: dependencies.usesTags,
	};
}

function compileGroup(group: FilterGroup, dependencies: MutableRuleDependencies): CompiledPredicate {
	if (!group || !group.conditions || group.conditions.length === 0) {
		return () => true;
	}

	const children = group.conditions.map(condition => condition.type === "group"
		? compileGroup(condition, dependencies)
		: compileFilter(condition, dependencies));

	switch (group.operator) {
		case "AND":
			return state => {
				for (const child of children) {
					if (!child(state)) return false;
				}
				return true;
			};
		case "OR":
			return state => {
				for (const child of children) {
					if (child(state)) return true;
				}
				return false;
			};
		case "NOR":
			return state => {
				for (const child of children) {
					if (child(state)) return false;
				}
				return true;
			};
		default:
			// Preserve legacy matcher behavior for malformed persisted configs.
			return () => true;
	}
}

function compileFilter(filter: Filter, dependencies: MutableRuleDependencies): CompiledPredicate {
	const filterValue = String(filter.value || "");
	const trimmedValue = filterValue.trim();
	const commaValues = splitCommaValues(filterValue);

	collectFilterDependencies(filter, trimmedValue, dependencies);

	if (filter.field === "file") {
		return compileSpecialFileFilter(filter.operator, filterValue, trimmedValue, commaValues);
	}

	const dateConstant = DATE_OPERATORS.has(filter.operator)
		&& (filter.field === "file.ctime" || filter.field === "file.mtime")
		? compileDateConstant(filterValue)
		: null;
	const numericConstant = NUMERIC_OPERATORS.has(filter.operator)
		? compileNumericConstant(trimmedValue)
		: undefined;

	return state => {
		let targetValue = readTargetValue(state, filter.field);
		if (targetValue === undefined || targetValue === null) targetValue = "";

		if (dateConstant && typeof targetValue === "number") {
			return evaluateDateOperator(targetValue, filter.operator, dateConstant);
		}

		if (numericConstant !== undefined) {
			return numericConstant !== null
				&& evaluateNumericOperator(targetValue, filter.operator, numericConstant);
		}

		if (Array.isArray(targetValue)) {
			return evaluateArrayOperator(targetValue, filter.operator, filterValue, commaValues);
		}
		return evaluateScalarOperator(targetValue, filter.operator, filterValue, commaValues);
	};
}

function compileSpecialFileFilter(
	operator: FilterOperator,
	filterValue: string,
	trimmedValue: string,
	commaValues: string[],
): CompiledPredicate {
	switch (operator) {
		case "links to":
		case "does not link to":
			return state => {
				const targetFile = state.app.metadataCache.getFirstLinkpathDest(filterValue, state.file.path);
				if (!targetFile) return operator === "does not link to";
				const hasLink = getResolvedOutgoingLinkPaths(state).includes(targetFile.path);
				return operator === "links to" ? hasLink : !hasLink;
			};

		case "in folder":
		case "is not in folder": {
			const normalizedTarget = normalizeFolder(trimmedValue);
			if (!trimmedValue) return () => operator === "is not in folder";
			return state => {
				const normalizedFileFolder = normalizeFolder(state.file.parent?.path || "");
				const isInFolder = normalizedFileFolder === normalizedTarget
					|| normalizedFileFolder.startsWith(normalizedTarget + "/");
				return operator === "in folder" ? isInFolder : !isInFolder;
			};
		}

		case "has tag":
		case "does not have tag":
			if (commaValues.length === 0) return () => operator === "does not have tag";
			return state => {
				const fileTagNames = getFileTags(state);
				const hasAnyTag = commaValues.some(filterTag =>
					fileTagNames.some(fileTag =>
						fileTag === filterTag
						|| fileTag.startsWith(filterTag + "/")
						|| filterTag.startsWith(fileTag + "/")
					));
				return operator === "has tag" ? hasAnyTag : !hasAnyTag;
			};

		case "has property":
		case "does not have property":
			if (!trimmedValue) return () => operator === "does not have property";
			return state => {
				const hasProperty = !!state.frontmatter && trimmedValue in state.frontmatter;
				return operator === "has property" ? hasProperty : !hasProperty;
			};

		default:
			return () => false;
	}
}

function collectFilterDependencies(
	filter: Filter,
	trimmedValue: string,
	dependencies: MutableRuleDependencies,
): void {
	if (filter.field === "file") {
		switch (filter.operator) {
			case "links to":
			case "does not link to":
				dependencies.usesFilePath = true;
				dependencies.usesOutgoingLinks = true;
				dependencies.usesAllFrontmatterForLinks = true;
				if (trimmedValue) dependencies.staticLinkTargets.add(trimmedValue);
				break;
			case "in folder":
			case "is not in folder":
				dependencies.usesFilePath = true;
				break;
			case "has tag":
			case "does not have tag":
				dependencies.usesTags = true;
				dependencies.frontmatterFields.add("tags");
				break;
			case "has property":
			case "does not have property":
				if (trimmedValue) dependencies.frontmatterFields.add(trimmedValue);
				break;
		}
		return;
	}

	if (filter.field.startsWith("file.")) {
		switch (filter.field) {
			case "file.path":
			case "file.folder":
				dependencies.usesFilePath = true;
				break;
			case "file.size":
			case "file.ctime":
			case "file.mtime":
				dependencies.usesFileStats = true;
				break;
			default:
				dependencies.usesFileIdentity = true;
		}
		return;
	}

	if (filter.field === "file links") {
		dependencies.usesFilePath = true;
		dependencies.usesOutgoingLinks = true;
		dependencies.usesAllFrontmatterForLinks = true;
		return;
	}

	if (filter.field === "file tags") {
		dependencies.usesTags = true;
		dependencies.frontmatterFields.add("tags");
		return;
	}

	dependencies.frontmatterFields.add(filter.field);
}

function splitCommaValues(value: string): string[] {
	return value.split(",").map(item => item.trim()).filter(item => item.length > 0);
}

function normalizeFolder(value: string): string {
	return value.replace(/^\/+|\/+$/g, "");
}

function readTargetValue(state: MatchEvaluationState, field: string): MatcherValue {
	if (field.startsWith("file.")) {
		switch (field) {
			case "file.name": return state.file.name;
			case "file.basename": return state.file.basename;
			case "file.path": return state.file.path;
			case "file.folder": return state.file.parent?.path || "";
			case "file.size": return state.file.stat.size;
			case "file.ctime": return state.file.stat.ctime;
			case "file.mtime": return state.file.stat.mtime;
			case "file.extension": return state.file.extension;
			default: return null;
		}
	}

	if (field === "file links") return getResolvedOutgoingLinkNames(state);
	if (field === "file tags") return getFileTags(state);
	if (field === "aliases") {
		const aliases = state.frontmatter?.aliases as string | string[] | undefined;
		if (!aliases) return [];
		return Array.isArray(aliases) ? aliases.map(alias => String(alias)) : [String(aliases)];
	}

	if (!state.frontmatter) return null;
	const frontmatterRecord = state.frontmatter as Record<string, FrontmatterRuleValue>;
	const fieldValue = frontmatterRecord[field];
	return fieldValue !== undefined ? fieldValue : null;
}

function getFileTags(state: MatchEvaluationState): string[] {
	if (state.fileTags) return state.fileTags;

	const cache = state.app.metadataCache.getFileCache(state.file);
	const bodyTags = (cache?.tags || []).map(tag => tag.tag.replace(/^#/, ""));
	const fmTags = state.frontmatter?.tags as string | string[] | undefined;
	if (!fmTags) {
		state.fileTags = bodyTags;
		return state.fileTags;
	}

	const rawTags = Array.isArray(fmTags) ? fmTags : [fmTags];
	state.fileTags = [...bodyTags, ...rawTags.map(tag => String(tag).replace(/^#/, ""))];
	return state.fileTags;
}

function getResolvedOutgoingLinkPaths(state: MatchEvaluationState): string[] {
	if (state.resolvedOutgoingLinkPaths) return state.resolvedOutgoingLinkPaths;

	const cache = state.app.metadataCache.getFileCache(state.file);
	const linkPaths = (cache?.links || []).map(link => {
		const resolvedPath = state.app.metadataCache.getFirstLinkpathDest(link.link, state.file.path);
		return resolvedPath?.path;
	}).filter((path): path is string => Boolean(path));

	if (state.frontmatter) {
		const frontmatterRecord = state.frontmatter as Record<string, FrontmatterRuleValue>;
		for (const key of Object.keys(frontmatterRecord)) {
			for (const linkText of extractFrontmatterLinks(frontmatterRecord[key])) {
				const resolvedPath = state.app.metadataCache.getFirstLinkpathDest(linkText, state.file.path);
				if (resolvedPath?.path) linkPaths.push(resolvedPath.path);
			}
		}
	}

	state.resolvedOutgoingLinkPaths = linkPaths;
	return state.resolvedOutgoingLinkPaths;
}

function getResolvedOutgoingLinkNames(state: MatchEvaluationState): string[] {
	if (state.resolvedOutgoingLinkNames) return state.resolvedOutgoingLinkNames;
	state.resolvedOutgoingLinkNames = [...new Set(
		getResolvedOutgoingLinkPaths(state).map(path => path.replace(/\.md$/, "")),
	)];
	return state.resolvedOutgoingLinkNames;
}

function extractFrontmatterLinks(value: FrontmatterRuleValue): string[] {
	if (value === undefined || value === null) return [];
	if (Array.isArray(value)) return value.flatMap(item => extractFrontmatterLinks(item));
	const strValue = String(value);
	const results: string[] = [];
	const wikilinkPattern = /\[\[([^\]]+)\]\]/g;
	let match: RegExpExecArray | null;
	while ((match = wikilinkPattern.exec(strValue)) !== null) {
		results.push(match[1].split("|")[0]);
	}
	return results;
}

interface CompiledDateConstant {
	filterDateString: string;
	filterTime: number;
}

function compileDateConstant(filterValue: string): CompiledDateConstant {
	const filterDateString = filterValue.split("T")[0];
	const filterDate = new Date(filterDateString);
	filterDate.setHours(0, 0, 0, 0);
	return { filterDateString, filterTime: filterDate.getTime() };
}

function compileNumericConstant(value: string): number | null {
	if (!value) return null;
	const numeric = Number(value);
	return Number.isFinite(numeric) ? numeric : null;
}

function evaluateDateOperator(
	targetValue: number,
	operator: FilterOperator,
	dateConstant: CompiledDateConstant,
): boolean {
	if (operator === "is empty") return !targetValue || targetValue === 0;
	if (operator === "is not empty") return !!targetValue && targetValue !== 0;
	if (!dateConstant.filterDateString) return false;

	const targetDate = new Date(targetValue);
	const targetDateString = targetDate.toISOString().split("T")[0];
	const targetDateOnly = new Date(targetDateString);
	targetDateOnly.setHours(0, 0, 0, 0);
	const targetTime = targetDateOnly.getTime();

	switch (operator) {
		case "on": return targetTime === dateConstant.filterTime;
		case "not on": return targetTime !== dateConstant.filterTime;
		case "before": return targetTime < dateConstant.filterTime;
		case "on or before": return targetTime <= dateConstant.filterTime;
		case "after": return targetTime > dateConstant.filterTime;
		case "on or after": return targetTime >= dateConstant.filterTime;
		default: return false;
	}
}

function evaluateNumericOperator(
	targetValue: MatcherValue,
	operator: FilterOperator,
	right: number,
): boolean {
	if (targetValue === null || Array.isArray(targetValue) || typeof targetValue === "boolean") return false;
	if (typeof targetValue === "string" && !targetValue.trim()) return false;
	const left = Number(targetValue);
	if (!Number.isFinite(left)) return false;

	switch (operator) {
		case "=": return left === right;
		case "≠": return left !== right;
		case "<": return left < right;
		case "≤": return left <= right;
		case ">": return left > right;
		case "≥": return left >= right;
		default: return false;
	}
}

function evaluateArrayOperator(
	targetArray: string[],
	operator: FilterOperator,
	filterValue: string,
	commaValues: string[],
): boolean {
	switch (operator) {
		case "is empty": return targetArray.length === 0;
		case "is not empty": return targetArray.length > 0;
		case "is":
		case "is not": {
			const match = targetArray.some(value => String(value) === filterValue);
			return operator === "is" ? match : !match;
		}
		case "is exactly":
		case "is not exactly": {
			const targetStrings = targetArray.map(value => String(value));
			const match = commaValues.length === targetStrings.length
				&& commaValues.every(value => targetStrings.includes(value));
			return operator === "is exactly" ? match : !match;
		}
		case "contains":
		case "does not contain": {
			const match = targetArray.some(value => String(value).includes(filterValue));
			return operator === "contains" ? match : !match;
		}
		case "contains any of":
		case "does not contain any of": {
			if (commaValues.length === 0) return operator === "does not contain any of";
			const match = commaValues.some(filterItem =>
				targetArray.some(value => String(value).includes(filterItem)));
			return operator === "contains any of" ? match : !match;
		}
		case "contains all of":
		case "does not contain all of": {
			if (commaValues.length === 0) return operator === "does not contain all of";
			const match = commaValues.every(filterItem =>
				targetArray.some(value => String(value).includes(filterItem)));
			return operator === "contains all of" ? match : !match;
		}
		case "starts with":
		case "ends with":
			return false;
		default:
			return false;
	}
}

function evaluateScalarOperator(
	targetScalar: MatcherScalar,
	operator: FilterOperator,
	filterValue: string,
	commaValues: string[],
): boolean {
	switch (operator) {
		case "is empty": return !targetScalar;
		case "is not empty": return !!targetScalar;
		case "is":
		case "is not": {
			const match = String(targetScalar) === filterValue;
			return operator === "is" ? match : !match;
		}
		case "contains":
		case "does not contain": {
			const match = String(targetScalar).includes(filterValue);
			return operator === "contains" ? match : !match;
		}
		case "contains any of":
		case "does not contain any of": {
			if (commaValues.length === 0) return operator === "does not contain any of";
			const match = commaValues.some(value => String(targetScalar).includes(value));
			return operator === "contains any of" ? match : !match;
		}
		case "contains all of":
		case "does not contain all of": {
			if (commaValues.length === 0) return operator === "does not contain all of";
			const match = commaValues.every(value => String(targetScalar).includes(value));
			return operator === "contains all of" ? match : !match;
		}
		case "starts with":
		case "does not start with": {
			const match = String(targetScalar).startsWith(filterValue);
			return operator === "starts with" ? match : !match;
		}
		case "ends with":
		case "does not end with": {
			const match = String(targetScalar).endsWith(filterValue);
			return operator === "ends with" ? match : !match;
		}
		default:
			return false;
	}
}
