import type { BasesFilter } from "./native-filters/api";

type NumericFilterOperator = "=" | "≠" | "<" | "≤" | ">" | "≥";
type MembershipFilterOperator =
	| "contains" | "does not contain"
	| "contains any of" | "does not contain any of"
	| "contains all of" | "does not contain all of";
type EqualityFilterOperator =
	| "is" | "is not"
	| "is exactly" | "is not exactly"
	| "is empty" | "is not empty";
type TextBoundaryFilterOperator =
	| "starts with" | "does not start with"
	| "ends with" | "does not end with";
type FileFilterOperator =
	| "links to" | "does not link to"
	| "in folder" | "is not in folder"
	| "has tag" | "does not have tag"
	| "has property" | "does not have property";
type DateFilterOperator =
	| "on" | "not on"
	| "before" | "on or before"
	| "after" | "on or after";

export type FilterOperator =
	| NumericFilterOperator
	| MembershipFilterOperator
	| EqualityFilterOperator
	| TextBoundaryFilterOperator
	| FileFilterOperator
	| DateFilterOperator;

export type FilterConjunction = "AND" | "OR" | "NOR";

export interface Filter {
	type: "filter";
	field: string;
	operator: FilterOperator;
	value?: string;
}

export interface FilterGroup {
	type: "group";
	operator: FilterConjunction;
	conditions: Array<Filter | FilterGroup>;
}

interface ViewPresentationOptions {
	css?: string;
	js?: string;
	showProperties?: boolean;
	showInlineTitle?: boolean;
	showNavigationBar?: boolean;
}

export interface ViewConfig extends ViewPresentationOptions {
	id: string;
	name: string;
	rules: FilterGroup;
	/** Native Obsidian Bases filters. Undefined keeps compiled legacy rules; null is match-all. */
	basesFilters?: BasesFilter | null;
	template: string;
}
