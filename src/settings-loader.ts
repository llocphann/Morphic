import { DEFAULT_SETTINGS, type CustomViewsSettings } from "./settings";
import type { ViewConfig } from "./types";

type RecoveredSettings = CustomViewsSettings & { recoveryData?: unknown };

type UnknownRecord = Record<string, unknown>;

const BOOLEAN_SETTINGS = [
	"enabled",
	"workInLivePreview",
	"workInCanvas",
	"editableContent",
	"allowJavaScript",
] as const;

const LEGACY_OPERATORS = new Set<string>([
	"=", "≠", "<", "≤", ">", "≥",
	"contains", "does not contain", "contains any of", "does not contain any of",
	"contains all of", "does not contain all of",
	"is", "is not", "is exactly", "is not exactly", "is empty", "is not empty",
	"starts with", "does not start with", "ends with", "does not end with",
	"links to", "does not link to", "in folder", "is not in folder",
	"has tag", "does not have tag", "has property", "does not have property",
	"on", "not on", "before", "on or before", "after", "on or after",
]);

const GROUP_OPERATORS = new Set(["AND", "OR", "NOR"]);
const NATIVE_GROUP_KEYS = new Set(["and", "or", "not"]);
const VIEW_TEXT_FIELDS = ["css", "js"] as const;
const VIEW_BOOLEAN_FIELDS = ["showProperties", "showInlineTitle", "showNavigationBar"] as const;

export function loadValidatedSettings(data: unknown): { settings: RecoveredSettings; recovered: boolean } {
	const defaults = structuredClone(DEFAULT_SETTINGS);
	if (data == null) return { settings: defaults, recovered: false };

	const sourceIsRecord = isRecord(data);
	const source: UnknownRecord = sourceIsRecord ? data : {};
	const settings = { ...source, ...defaults } as RecoveredSettings;
	let recovered = !sourceIsRecord;

	for (const key of BOOLEAN_SETTINGS) {
		const candidate = source[key];
		if (typeof candidate === "boolean") settings[key] = candidate;
		else if (candidate !== undefined) {
			settings[key] = false;
			recovered = true;
		}
	}

	if (Object.prototype.hasOwnProperty.call(source, "views")) {
		const validated = validateViews(source.views);
		settings.views = validated.views;
		recovered ||= validated.recovered;
	} else if (recovered) {
		settings.views = [];
	}

	if (recovered) settings.recoveryData = structuredClone(data);
	return { settings, recovered };
}

function validateViews(value: unknown): { views: ViewConfig[]; recovered: boolean } {
	if (!Array.isArray(value)) return { views: [], recovered: true };

	const views: ViewConfig[] = [];
	const seenIds = new Set<string>();
	let recovered = false;

	for (const candidate of value) {
		if (!isViewConfig(candidate) || seenIds.has(candidate.id)) {
			recovered = true;
			continue;
		}
		seenIds.add(candidate.id);
		views.push(structuredClone(candidate));
	}
	return { views, recovered };
}

function isViewConfig(value: unknown): value is ViewConfig {
	if (!isRecord(value)) return false;
	if (typeof value.id !== "string" || value.id.length === 0) return false;
	if (typeof value.name !== "string" || typeof value.template !== "string") return false;
	if (!isLegacyRule(value.rules, 0)) return false;
	if (value.basesFilters !== undefined && value.basesFilters !== null && !isNativeFilter(value.basesFilters, 0)) return false;

	for (const key of VIEW_TEXT_FIELDS) {
		if (value[key] !== undefined && typeof value[key] !== "string") return false;
	}
	for (const key of VIEW_BOOLEAN_FIELDS) {
		if (value[key] !== undefined && typeof value[key] !== "boolean") return false;
	}
	return true;
}

function isLegacyRule(value: unknown, depth: number): boolean {
	if (depth > 100 || !isRecord(value)) return false;
	if (value.type === "filter") {
		return typeof value.field === "string"
			&& typeof value.operator === "string"
			&& LEGACY_OPERATORS.has(value.operator)
			&& (value.value === undefined || typeof value.value === "string");
	}
	if (value.type !== "group") return false;
	if (typeof value.operator !== "string" || !GROUP_OPERATORS.has(value.operator)) return false;
	return Array.isArray(value.conditions)
		&& value.conditions.every(child => isLegacyRule(child, depth + 1));
}

function isNativeFilter(value: unknown, depth: number): boolean {
	if (typeof value === "string") return true;
	if (depth > 100 || !isRecord(value)) return false;
	const entries = Object.entries(value);
	if (entries.length !== 1) return false;
	const [operator, children] = entries[0];
	return NATIVE_GROUP_KEYS.has(operator)
		&& Array.isArray(children)
		&& children.every(child => isNativeFilter(child, depth + 1));
}

function isRecord(value: unknown): value is UnknownRecord {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
