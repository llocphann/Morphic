import type { App } from "obsidian";
import type { Filter, FilterGroup, FilterOperator } from "../types";
import type { BasesFilter } from "./api";

const FIELD_ALIASES: Record<string, string> = {
	"file.name": "file.fullname",
	"file.extension": "file.ext",
	"file links": "file.links",
	"file tags": "file.tags",
};

const NUMERIC_OPERATOR: Partial<Record<FilterOperator, string>> = {
	"=": "==",
	"≠": "!=",
	"<": "<",
	"≤": "<=",
	">": ">",
	"≥": ">=",
};

const DATE_OPERATOR: Partial<Record<FilterOperator, string>> = {
	"on": "==",
	"not on": "!=",
	"before": "<",
	"on or before": "<=",
	"after": ">",
	"on or after": ">=",
};

export function toBasesFilter(app: App, group: FilterGroup): BasesFilter | null {
	if (group.conditions.length === 0) return null;
	const children: BasesFilter[] = group.conditions.map(condition => {
		if (condition.type === "filter") return emitFilter(app, condition);
		return toBasesFilter(app, condition) ?? "true";
	});

	if (group.operator === "AND") return { and: children };
	if (group.operator === "OR") return { or: children };
	return { not: children };
}

function emitFilter(app: App, filter: Filter): string {
	const field = basesField(filter.field);
	const raw = filter.value ?? "";
	const widget = assignedWidget(app, filter.field);

	if (NUMERIC_OPERATOR[filter.operator]) {
		return emitNumeric(field, raw, NUMERIC_OPERATOR[filter.operator]!);
	}
	if (DATE_OPERATOR[filter.operator]) {
		return `date(${field}).date() ${DATE_OPERATOR[filter.operator]} date(${JSON.stringify(raw.split("T")[0])})`;
	}

	switch (filter.operator) {
		case "is":
		case "is not":
			return maybeNegate(emitEquality(field, raw, widget), filter.operator === "is not");
		case "is exactly":
		case "is not exactly":
			return emitExactList(field, raw, filter.operator === "is exactly");
		case "is empty":
		case "is not empty":
			return maybeNegate(emitEmpty(field), filter.operator === "is not empty");
		case "contains":
		case "does not contain":
		case "contains any of":
		case "does not contain any of":
		case "contains all of":
		case "does not contain all of":
			return emitContains(field, raw, filter.operator);
		case "starts with":
		case "does not start with":
		case "ends with":
		case "does not end with":
			return emitBoundary(field, raw, filter.operator);
		case "links to":
			return methodCall(field, "hasLink", scalarLiteral(raw));
		case "does not link to":
			return `!${methodCall(field, "hasLink", scalarLiteral(raw))}`;
		case "in folder":
			return methodCall(field, "inFolder", scalarLiteral(raw));
		case "is not in folder":
			return `!${methodCall(field, "inFolder", scalarLiteral(raw))}`;
		case "has tag":
			return methodCall(field, "hasTag", commaLiterals(raw));
		case "does not have tag":
			return `!${methodCall(field, "hasTag", commaLiterals(raw))}`;
		case "has property":
			return methodCall(field, "hasProperty", scalarLiteral(raw));
		case "does not have property":
			return `!${methodCall(field, "hasProperty", scalarLiteral(raw))}`;
		default:
			return "false";
	}
}

function basesField(field: string): string {
	const alias = FIELD_ALIASES[field];
	if (alias) return alias;
	if (field === "file" || field.startsWith("file.")) return field;
	return `note[${JSON.stringify(field)}]`;
}

function assignedWidget(app: App, field: string): string | undefined {
	const manager = (app as App & { metadataTypeManager?: {
		getAssignedWidget?(name: string): string | null;
		getAllProperties?(): Record<string, { name: string; widget?: string }>;
	} }).metadataTypeManager;
	const direct = manager?.getAssignedWidget?.(field);
	if (direct) return direct;
	const lower = field.toLowerCase();
	return Object.values(manager?.getAllProperties?.() ?? {})
		.find(property => property.name.toLowerCase() === lower)?.widget;
}

function emitNumeric(field: string, raw: string, operator: string): string {
	if (raw.trim() === "" || !Number.isFinite(Number(raw))) return "false";
	const normalized = String(Number(raw));
	const rhs = /e/i.test(normalized) ? `number(${JSON.stringify(normalized)})` : normalized;
	return [
		`${field} != null`,
		`!${field}.isType("boolean")`,
		`!${field}.isType("list")`,
		`${field}.toString().trim() != ""`,
		`${field} > -number("Infinity")`,
		`${field} < number("Infinity")`,
		`${field} ${operator} ${rhs}`,
	].join(" && ");
}

function emitEquality(field: string, raw: string, widget: string | undefined): string {
	const text = JSON.stringify(raw);
	const scalar = widget === "checkbox" && /^(true|false)$/.test(raw)
		? `${field} == ${raw}`
		: `${field}.toString() == ${text}`;
	return `if(${field}.isType("list"), ${field}.map(value.toString()).contains(${text}), if(${field} == null, ${raw === ""}, ${scalar}))`;
}

function emitExactList(field: string, raw: string, equal: boolean): string {
	const list = splitTerms(raw).map(value => JSON.stringify(value)).join(", ");
	return `if(${field}.isType("list"), ${field}.map(value.toString()).sort() ${equal ? "==" : "!="} [${list}].sort(), false)`;
}

function emitEmpty(field: string): string {
	return `if(${field}.isType("list"), ${field}.length == 0, ${field} == null || ${field}.toString() == "")`;
}

function emitContains(field: string, raw: string, operator: FilterOperator): string {
	const single = operator === "contains" || operator === "does not contain";
	const terms = single ? [raw] : splitTerms(raw);
	const checks = terms.map(term => {
		if (term === "") return `if(${field}.isType("list"), ${field}.length > 0, true)`;
		const text = JSON.stringify(term);
		return `if(${field}.isType("list"), ${field}.filter(value.toString().split(${text}).length > 1).length > 0, ${field}.toString().split(${text}).length > 1)`;
	});
	const all = operator === "contains all of" || operator === "does not contain all of";
	const expression = checks.length === 0 ? "false" : checks.join(all ? " && " : " || ");
	return maybeNegate(expression, operator.startsWith("does not"));
}

function emitBoundary(field: string, raw: string, operator: FilterOperator): string {
	const scalar = `if(${field} == null, "", ${field}.toString())`;
	const starts = operator === "starts with" || operator === "does not start with";
	const sliceArgs = starts ? `0, ${raw.length}` : `${-raw.length}`;
	const match = raw === "" ? "true" : `${scalar}.slice(${sliceArgs}) == ${JSON.stringify(raw)}`;
	const expression = maybeNegate(match, operator.startsWith("does not"));
	return `if(${field}.isType("list"), false, ${expression})`;
}

function scalarLiteral(value: string): string {
	const link = /^\[\[([^\]|]+)(?:\|[^\]]*)?\]\]$/.exec(value);
	return link ? `link(${JSON.stringify(link[1])})` : JSON.stringify(value);
}

function commaLiterals(raw: string): string {
	return splitTerms(raw).map(scalarLiteral).join(", ");
}

function splitTerms(raw: string): string[] {
	return raw.split(",").map(value => value.trim()).filter(Boolean);
}

function methodCall(field: string, method: string, argumentsSource: string): string {
	return `${field}.${method}(${argumentsSource})`;
}

function maybeNegate(expression: string, negate: boolean): string {
	return negate ? `!(${expression})` : expression;
}
