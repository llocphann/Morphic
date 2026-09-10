import { syntaxTree } from "@codemirror/language";
import type { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";

export type EditorCompletionLanguage = "html" | "css" | "javascript";

const CSS_GLOBAL_VALUES = ["inherit", "initial", "revert", "revert-layer", "unset"];

const CSS_PROPERTY_VALUES: Record<string, readonly string[]> = {
	"display": ["block", "inline", "inline-block", "flex", "inline-flex", "grid", "inline-grid", "contents", "flow-root", "none"],
	"position": ["static", "relative", "absolute", "fixed", "sticky"],
	"flex-direction": ["row", "row-reverse", "column", "column-reverse"],
	"flex-wrap": ["nowrap", "wrap", "wrap-reverse"],
	"justify-content": ["start", "end", "center", "space-between", "space-around", "space-evenly", "stretch"],
	"justify-items": ["start", "end", "center", "stretch"],
	"align-items": ["start", "end", "center", "baseline", "stretch"],
	"align-content": ["start", "end", "center", "space-between", "space-around", "space-evenly", "stretch"],
	"align-self": ["auto", "start", "end", "center", "baseline", "stretch"],
	"overflow": ["visible", "hidden", "clip", "scroll", "auto"],
	"overflow-x": ["visible", "hidden", "clip", "scroll", "auto"],
	"overflow-y": ["visible", "hidden", "clip", "scroll", "auto"],
	"white-space": ["normal", "nowrap", "pre", "pre-wrap", "pre-line", "break-spaces"],
	"text-align": ["start", "end", "left", "right", "center", "justify"],
	"text-transform": ["none", "capitalize", "uppercase", "lowercase", "full-width"],
	"text-overflow": ["clip", "ellipsis"],
	"font-style": ["normal", "italic", "oblique"],
	"font-weight": ["normal", "bold", "lighter", "bolder", "100", "200", "300", "400", "500", "600", "700", "800", "900"],
	"visibility": ["visible", "hidden", "collapse"],
	"cursor": ["auto", "default", "pointer", "text", "move", "grab", "grabbing", "not-allowed", "help", "wait", "crosshair"],
	"box-sizing": ["content-box", "border-box"],
	"object-fit": ["fill", "contain", "cover", "none", "scale-down"],
	"float": ["none", "left", "right", "inline-start", "inline-end"],
	"word-break": ["normal", "break-all", "keep-all", "break-word"],
	"pointer-events": ["auto", "none"],
};

const JS_KEYWORDS = new Set([
	"async", "await", "break", "case", "catch", "class", "const", "continue",
	"debugger", "default", "delete", "do", "else", "export", "extends", "false",
	"finally", "for", "function", "if", "import", "in", "instanceof", "let",
	"new", "null", "of", "return", "static", "super", "switch", "this", "throw",
	"true", "try", "typeof", "undefined", "var", "void", "while", "yield",
]);

const JS_CLASSES = new Set([
	"Array", "Object", "String", "Number", "Date", "Promise", "Map", "Set", "RegExp",
]);

const JS_FUNCTIONS = new Set([
	"setTimeout", "setInterval", "clearTimeout", "clearInterval", "parseInt",
	"parseFloat", "encodeURIComponent", "decodeURIComponent", "querySelector",
	"querySelectorAll", "getElementById", "addEventListener", "removeEventListener",
	"fetch", "alert", "confirm",
]);

const DOCUMENT_MEMBERS: readonly Completion[] = [
	{ label: "querySelector", type: "method" },
	{ label: "querySelectorAll", type: "method" },
	{ label: "getElementById", type: "method" },
	{ label: "getElementsByClassName", type: "method" },
	{ label: "getElementsByTagName", type: "method" },
	{ label: "createElement", type: "method" },
	{ label: "createTextNode", type: "method" },
	{ label: "addEventListener", type: "method" },
	{ label: "removeEventListener", type: "method" },
	{ label: "body", type: "property" },
	{ label: "head", type: "property" },
	{ label: "documentElement", type: "property" },
];

const WINDOW_MEMBERS: readonly Completion[] = [
	{ label: "addEventListener", type: "method" },
	{ label: "removeEventListener", type: "method" },
	{ label: "setTimeout", type: "method" },
	{ label: "clearTimeout", type: "method" },
	{ label: "setInterval", type: "method" },
	{ label: "clearInterval", type: "method" },
	{ label: "requestAnimationFrame", type: "method" },
	{ label: "cancelAnimationFrame", type: "method" },
	{ label: "getComputedStyle", type: "method" },
	{ label: "document", type: "property" },
	{ label: "location", type: "property" },
];

const ELEMENT_MEMBERS: readonly Completion[] = [
	{ label: "querySelector", type: "method" },
	{ label: "querySelectorAll", type: "method" },
	{ label: "closest", type: "method" },
	{ label: "matches", type: "method" },
	{ label: "append", type: "method" },
	{ label: "appendChild", type: "method" },
	{ label: "prepend", type: "method" },
	{ label: "remove", type: "method" },
	{ label: "replaceChildren", type: "method" },
	{ label: "addEventListener", type: "method" },
	{ label: "removeEventListener", type: "method" },
	{ label: "setAttribute", type: "method" },
	{ label: "getAttribute", type: "method" },
	{ label: "removeAttribute", type: "method" },
	{ label: "classList", type: "property" },
	{ label: "style", type: "property" },
	{ label: "textContent", type: "property" },
	{ label: "innerHTML", type: "property" },
];

export function enhanceLanguageCompletion(
	language: EditorCompletionLanguage,
	context: CompletionContext,
	baseResult: CompletionResult | null,
): CompletionResult | null {
	const nodeName = syntaxTree(context.state).resolveInner(context.pos, -1).name;
	if ((language === "javascript" || language === "css") && /Comment|String/.test(nodeName)) {
		return decorateBaseResult(language, context.state.doc.toString(), context.pos, baseResult);
	}
	return enhanceCompletionResult(
		language,
		context.state.doc.toString(),
		context.pos,
		context.explicit,
		baseResult,
	);
}

export function enhanceCompletionResult(
	language: EditorCompletionLanguage,
	documentText: string,
	position: number,
	explicit: boolean,
	baseResult: CompletionResult | null,
): CompletionResult | null {
	switch (language) {
		case "css":
			return enhanceCssCompletion(documentText, position, baseResult);
		case "javascript":
			return enhanceJavaScriptCompletion(documentText, position, explicit, baseResult);
		case "html":
		default:
			return decorateBaseResult(language, documentText, position, baseResult);
	}
}

function enhanceCssCompletion(
	documentText: string,
	position: number,
	baseResult: CompletionResult | null,
): CompletionResult | null {
	const before = documentText.slice(0, position);
	const valueMatch = /([a-zA-Z-]+)\s*:\s*([a-zA-Z-]*)$/.exec(before);
	if (valueMatch) {
		const property = valueMatch[1].toLowerCase();
		const prefix = valueMatch[2];
		const propertyValues = CSS_PROPERTY_VALUES[property] ?? [];
		const values = uniqueStrings([...propertyValues, ...CSS_GLOBAL_VALUES]);
		return {
			from: position - prefix.length,
			options: values.map(label => ({ label, type: "constant" })),
		};
	}
	return decorateBaseResult("css", documentText, position, baseResult);
}

function enhanceJavaScriptCompletion(
	documentText: string,
	position: number,
	explicit: boolean,
	baseResult: CompletionResult | null,
): CompletionResult | null {
	const before = documentText.slice(0, position);
	const memberMatch = /([a-zA-Z_$][a-zA-Z0-9_$]*)\.([a-zA-Z_$][a-zA-Z0-9_$]*)?$/.exec(before);
	if (memberMatch) {
		const receiver = memberMatch[1];
		const prefix = memberMatch[2] ?? "";
		const members = getJavaScriptMembers(receiver, before.slice(0, memberMatch.index));
		if (members.length > 0) {
			return {
				from: position - prefix.length,
				options: members.slice(),
			};
		}
	}

	const decoratedBase = decorateBaseResult("javascript", documentText, position, baseResult);
	const wordMatch = /[a-zA-Z_$][a-zA-Z0-9_$]*$/.exec(before);
	if (!wordMatch || (wordMatch[0].length < 2 && !explicit)) return decoratedBase;

	const locals: Completion[] = collectJavaScriptLocals(before)
		.map(local => ({ label: local.label, type: local.type }));
	if (locals.length === 0) return decoratedBase;

	return {
		from: position - wordMatch[0].length,
		options: mergeCompletionOptions(locals, decoratedBase?.options ?? []),
	};
}

function getJavaScriptMembers(receiver: string, sourceBeforeReceiver: string): readonly Completion[] {
	if (receiver === "document") return DOCUMENT_MEMBERS;
	if (receiver === "window") return WINDOW_MEMBERS;
	if (isElementReceiver(receiver, sourceBeforeReceiver)) return ELEMENT_MEMBERS;
	return [];
}

function isElementReceiver(receiver: string, source: string): boolean {
	const escaped = escapeRegExp(receiver);
	const declaration = new RegExp(
		`\\b(?:const|let|var)\\s+${escaped}\\s*=\\s*document\\.(?:querySelector|getElementById|createElement)\\s*\\(`,
	);
	return declaration.test(source);
}

function collectJavaScriptLocals(source: string): { label: string; type: string }[] {
	const result: { label: string; type: string }[] = [];
	const seen = new Set<string>();
	const add = (label: string, type: string) => {
		if (!seen.has(label)) {
			seen.add(label);
			result.push({ label, type });
		}
	};

	collectMatches(source, /\b(?:const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g, label => add(label, "variable"));
	collectMatches(source, /\bfunction\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g, label => add(label, "function"));
	collectMatches(source, /\bclass\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g, label => add(label, "class"));

	const functionParams = /\bfunction(?:\s+[a-zA-Z_$][a-zA-Z0-9_$]*)?\s*\(([^)]*)\)/g;
	let paramsMatch: RegExpExecArray | null;
	while ((paramsMatch = functionParams.exec(source)) !== null) {
		collectParameterNames(paramsMatch[1], label => add(label, "variable"));
	}

	const arrowParams = /\(([^)]*)\)\s*=>/g;
	while ((paramsMatch = arrowParams.exec(source)) !== null) {
		collectParameterNames(paramsMatch[1], label => add(label, "variable"));
	}

	collectMatches(source, /\b([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=>/g, label => add(label, "variable"));
	return result;
}

function collectParameterNames(source: string, add: (label: string) => void): void {
	for (const part of source.split(",")) {
		const match = /^\s*([a-zA-Z_$][a-zA-Z0-9_$]*)/.exec(part);
		if (match) add(match[1]);
	}
}

function collectMatches(source: string, pattern: RegExp, add: (label: string) => void): void {
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(source)) !== null) add(match[1]);
}

function decorateBaseResult(
	language: EditorCompletionLanguage,
	documentText: string,
	position: number,
	baseResult: CompletionResult | null,
): CompletionResult | null {
	if (!baseResult) return null;
	const before = documentText.slice(0, position);
	const htmlTagContext = /<\/?[a-zA-Z0-9-]*$/.test(before);
	return {
		...baseResult,
		options: baseResult.options.map(option => ({
			...option,
			type: option.type ?? completionType(language, option.label, htmlTagContext),
		})),
	};
}

function completionType(
	language: EditorCompletionLanguage,
	label: string,
	htmlTagContext: boolean,
): string {
	if (language === "html") return htmlTagContext ? "type" : "property";
	if (language === "css") return "property";
	if (JS_KEYWORDS.has(label)) return "keyword";
	if (JS_CLASSES.has(label)) return "class";
	if (JS_FUNCTIONS.has(label)) return "function";
	return "variable";
}

function mergeCompletionOptions(primary: readonly Completion[], secondary: readonly Completion[]): Completion[] {
	const seen = new Set<string>();
	const result: Completion[] = [];
	for (const option of [...primary, ...secondary]) {
		if (seen.has(option.label)) continue;
		seen.add(option.label);
		result.push(option);
	}
	return result;
}

function uniqueStrings(values: readonly string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const value of values) {
		if (seen.has(value)) continue;
		seen.add(value);
		result.push(value);
	}
	return result;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
