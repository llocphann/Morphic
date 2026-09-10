import { moment } from "obsidian";
import type { CompiledFilterPipeline, CompiledFilterStep } from "./compiler/filter-pipeline";

export type FilterValue = string | number | string[] | number[] | boolean | null | undefined;
type FilterFunction = (value: FilterValue, ...args: unknown[]) => FilterValue;

type MutableFilterRegistry = Map<string, FilterFunction>;

const registry: MutableFilterRegistry = new Map();
const register = (name: string, implementation: FilterFunction): void => {
	registry.set(name, implementation);
};

const WORD = /[A-Z]{2,}(?=[A-Z][a-z]+[0-9]*|\b)|[A-Z]?[a-z]+[0-9]*|[A-Z]|[0-9]+/g;
const HTML_ENTITY = /&(amp|lt|gt|quot|#039|#x27|#x2F);/g;
const ENTITIES: Record<string, string> = {
	"&amp;": "&",
	"&lt;": "<",
	"&gt;": ">",
	"&quot;": '"',
	"&#039;": "'",
	"&#x27;": "'",
	"&#x2F;": "/",
};

register("date", (value, format, inputFormat) => {
	const source = typeof value === "string" || typeof value === "number" ? value : String(value);
	const parsed = typeof inputFormat === "string" ? moment(source, inputFormat) : moment(source);
	return parsed.isValid() ? parsed.format(typeof format === "string" ? format : "YYYY-MM-DD") : value;
});
register("date_modify", (value, modification) => {
	if (typeof modification !== "string") return value;
	const [amountText, unitText] = modification.trim().split(/\s+/, 2);
	const amount = Number.parseInt(amountText, 10);
	const parsed = moment(String(value));
	if (!parsed.isValid() || !Number.isFinite(amount) || !unitText) return value;
	return parsed.add(amount, unitText as moment.unitOfTime.DurationConstructor).format("YYYY-MM-DD");
});

register("capitalize", value => {
	const text = String(value);
	return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
});
register("upper", value => String(value).toUpperCase());
register("lower", value => String(value).toLowerCase());
register("title", value => String(value).replace(/\w\S*/g, word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()));
register("camel", value => String(value).toLowerCase().replace(/[^a-zA-Z0-9]+(.)/g, (_match, next: string) => next.toUpperCase()));
register("kebab", value => joinWords(value, "-"));
register("snake", value => joinWords(value, "_"));
register("pascal", value => {
	const words = splitWords(value);
	return words ? words.map(capitalizeWord).join("") : value;
});
register("uncamel", value => String(value).replace(/([A-Z])/g, " $1").trim().toLowerCase());
register("trim", value => String(value).trim());

register("replace", (value, search, replacement) => {
	const needle = scalarString(search);
	const next = scalarString(replacement);
	const source = String(value);
	const regex = parseRegexLiteral(needle) ?? new RegExp(escapeRegex(needle), "g");
	try {
		return source.replace(regex, next);
	} catch {
		return source.replace(new RegExp(escapeRegex(needle), "g"), next);
	}
});

register("wikilink", (value, alias) => mapRenderable(value, item => `[[${item}${typeof alias === "string" ? `|${alias}` : ""}]]`, ", "));
register("link", (value, label) => mapRenderable(value, item => markdownLink(item, typeof label === "string" ? label : "link"), ", "));
register("image", (value, alt) => mapRenderable(value, item => `![${typeof alt === "string" ? alt : ""}](${markdownDestination(item)})`, "\n"));
register("blockquote", value => String(value).split("\n").map(line => `> ${line}`).join("\n"));
register("callout", (value, type, title) => {
	const kind = typeof type === "string" ? type : "info";
	const heading = typeof title === "string" && title.length > 0 ? ` ${title}` : "";
	return `> [!${kind}]${heading}\n${String(value).split("\n").map(line => `> ${line}`).join("\n")}`;
});
register("footnote", (value, id) => `[^${typeof id === "string" ? id : String(Math.random()).slice(2, 8)}]: ${String(value)}`);
register("fragment_link", (value, fragment) => {
	const section = typeof fragment === "string" ? fragment.trim() : "";
	return `[[${String(value)}${section ? `#${section}` : ""}]]`;
});

register("split", (value, separator) => String(value).split(typeof separator === "string" ? separator : ","));
register("join", (value, separator) => Array.isArray(value) ? value.join(typeof separator === "string" ? separator : ",") : value);
register("first", value => Array.isArray(value) ? value[0] : value);
register("last", value => Array.isArray(value) ? value[value.length - 1] : value);
register("slice", (value, start, end) => {
	const from = typeof start === "number" ? start : 0;
	const to = typeof end === "number" ? end : undefined;
	return typeof value === "string" || Array.isArray(value) ? value.slice(from, to) : value;
});
register("count", value => Array.isArray(value) ? value.length : String(value).length);
register("map", (value, property) => {
	if (!Array.isArray(value) || typeof property !== "string") return value;
	return value.map(item => isRecord(item) ? item[property] ?? null : null) as unknown as FilterValue;
});
register("unique", value => Array.isArray(value) ? [...new Set(value.map(String))] : value);
register("list", value => Array.isArray(value) ? value : [String(value)]);
register("nth", (value, index) => {
	if (!Array.isArray(value)) return value;
	const position = typeof index === "number" ? index : 0;
	return position >= 0 && position < value.length ? value[position] : null;
});
register("merge", (value, ...rest) => {
	if (!Array.isArray(value)) return value;
	const merged = value.map(String);
	for (const item of rest) appendMergeValue(merged, item);
	return merged;
});
register("reverse", value => Array.isArray(value) ? [...value].reverse() as FilterValue : typeof value === "string" ? [...value].reverse().join("") : value);
register("length", value => typeof value === "string" || Array.isArray(value) ? value.length : 0);

register("calc", (value, operation) => {
	if (typeof operation !== "string") return value;
	const left = Number.parseFloat(String(value));
	if (!Number.isFinite(left)) return value;
	const expression = operation.trim();
	const power = expression.startsWith("**");
	const operator = power ? "^" : expression.charAt(0);
	const right = Number.parseFloat(expression.slice(power ? 2 : 1));
	if (!Number.isFinite(right)) return value;
	switch (operator) {
		case "+": return left + right;
		case "-": return left - right;
		case "*": return left * right;
		case "/": return left / right;
		case "^": return Math.pow(left, right);
		default: return value;
	}
});
register("round", (value, decimals) => {
	const number = Number.parseFloat(String(value));
	if (!Number.isFinite(number)) return value;
	const places = typeof decimals === "number" ? decimals : 0;
	const scale = Math.pow(10, places);
	return Math.round(number * scale) / scale;
});
register("number_format", (value, decimals, decimalPoint, thousandsSeparator) => {
	const number = Number.parseFloat(String(value));
	if (!Number.isFinite(number)) return value;
	const places = typeof decimals === "number" ? decimals : 0;
	const [integer, fraction] = number.toFixed(places).split(".");
	const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, typeof thousandsSeparator === "string" ? thousandsSeparator : ",");
	return fraction ? `${grouped}${typeof decimalPoint === "string" ? decimalPoint : "."}${fraction}` : grouped;
});
register("duration", value => {
	const milliseconds = Number.parseFloat(String(value));
	if (!Number.isFinite(milliseconds)) return value;
	const duration = moment.duration(milliseconds);
	const pieces: string[] = [];
	for (const [amount, suffix] of [
		[duration.years(), "y"], [duration.months(), "mo"], [duration.days(), "d"],
		[duration.hours(), "h"], [duration.minutes(), "m"], [duration.seconds(), "s"],
	] as Array<[number, string]>) {
		if (amount) pieces.push(`${amount}${suffix}`);
	}
	return pieces.join(" ") || "0s";
});

register("strip_tags", value => stripHtml(String(value)));
register("remove_html", value => stripHtml(String(value)));
register("markdown", value => htmlToMarkdown(String(value)));
register("strip_md", value => stripMarkdown(String(value)));
register("table", value => markdownTable(value));
register("remove_tags", (value, ...tags) => {
	let html = String(value);
	for (const raw of tags) {
		if (typeof raw !== "string") continue;
		const tag = validHtmlName(raw);
		if (!tag) continue;
		const escaped = escapeRegex(tag);
		html = html
			.replace(new RegExp(`<${escaped}\\b[^>]*>[\\s\\S]*?<\\/${escaped}>`, "gi"), "")
			.replace(new RegExp(`<${escaped}\\b[^>]*\\/?>`, "gi"), "")
			.replace(new RegExp(`<\\/${escaped}>`, "gi"), "");
	}
	return html;
});
register("strip_attr", (value, ...attributes) => stripAttributes(String(value), attributes));
register("remove_attr", (value, ...attributes) => stripAttributes(String(value), attributes));
register("replace_tags", (value, oldName, newName) => {
	if (typeof oldName !== "string" || typeof newName !== "string") return value;
	const oldTag = validHtmlName(oldName);
	const newTag = validHtmlName(newName);
	if (!oldTag || !newTag) return value;
	const escaped = escapeRegex(oldTag);
	return String(value)
		.replace(new RegExp(`<${escaped}(\\s[^>]*)?>`, "gi"), `<${newTag}$1>`)
		.replace(new RegExp(`</${escaped}>`, "gi"), `</${newTag}>`);
});
register("unescape", value => String(value).replace(HTML_ENTITY, entity => ENTITIES[entity] ?? entity));

register("object", value => {
	if (Array.isArray(value) && value.length >= 2) {
		const output: Record<string, FilterValue> = {};
		for (let index = 0; index + 1 < value.length; index += 2) output[String(value[index])] = value[index + 1];
		return JSON.stringify(output);
	}
	return value;
});
register("template", (value, source) => typeof source === "string" ? source.replace(/\{\{value\}\}/g, String(value)) : value);
register("safe_name", value => String(value).replace(/[<>:"/\\|?*]/g, "-").replace(/\s+/g, " ").trim());
register("html_to_json", value => htmlToJson(String(value)));

export function applyCompiledFilterPipeline(value: FilterValue, pipeline: CompiledFilterPipeline): FilterValue {
	let current = value;
	for (const step of pipeline.steps) current = invokeCompiled(current, step);
	return current;
}

export function applyFilterChain(value: FilterValue, filterChain: string): FilterValue {
	let current = value;
	for (const source of splitPipeline(filterChain)) {
		const step = parseFilterStep(source);
		if (!step) continue;
		current = invoke(current, step.name, step.args);
	}
	return current;
}

function invokeCompiled(value: FilterValue, step: CompiledFilterStep): FilterValue {
	return invoke(value, step.name, step.args);
}

function invoke(value: FilterValue, name: string, args: readonly unknown[]): FilterValue {
	const implementation = registry.get(name);
	if (!implementation) return value;
	try {
		return implementation(value, ...args);
	} catch (error) {
		console.error(`[Morphic] filter ${JSON.stringify(name)} failed`, error);
		return value;
	}
}

function splitPipeline(source: string): string[] {
	if (!source) return [];
	const result: string[] = [];
	let quote: string | undefined;
	let start = 0;
	for (let index = 0; index < source.length; index++) {
		const character = source[index];
		if (character === '"' || character === "'") {
			quote = quote === character ? undefined : quote ?? character;
			continue;
		}
		if (character === "|" && !quote) {
			pushTrimmed(result, source.slice(start, index));
			start = index + 1;
		}
	}
	pushTrimmed(result, source.slice(start));
	return result;
}

function parseFilterStep(source: string): { name: string; args: Array<string | number> } | undefined {
	const separator = source.indexOf(":");
	const name = separator < 0 ? source : source.slice(0, separator);
	if (!name) return undefined;
	return {
		name,
		args: separator < 0 ? [] : parseArgumentList(source.slice(separator + 1)),
	};
}

function parseArgumentList(source: string): Array<string | number> {
	const input = unwrapParentheses(source.trim());
	if (!input) return [];
	const values: Array<string | number> = [];
	let quote: string | undefined;
	let start = 0;
	for (let index = 0; index < input.length; index++) {
		const character = input[index];
		if (character === '"' || character === "'") {
			quote = quote === character ? undefined : quote ?? character;
			continue;
		}
		if (character === "," && !quote) {
			values.push(parseArgument(input.slice(start, index)));
			start = index + 1;
		}
	}
	if (start < input.length) values.push(parseArgument(input.slice(start)));
	return values;
}

function parseArgument(source: string): string | number {
	const text = source.trim();
	if (text.length >= 2 && ((text[0] === '"' && text[text.length - 1] === '"') || (text[0] === "'" && text[text.length - 1] === "'"))) {
		return text.slice(1, -1);
	}
	const number = Number(text);
	return text !== "" && Number.isFinite(number) ? number : text;
}

function unwrapParentheses(source: string): string {
	return source.startsWith("(") && source.endsWith(")") ? source.slice(1, -1) : source;
}

function splitWords(value: FilterValue): string[] | undefined {
	return String(value).match(WORD)?.map(word => word.toLowerCase());
}

function joinWords(value: FilterValue, separator: string): FilterValue {
	return splitWords(value)?.join(separator) ?? value;
}

function capitalizeWord(word: string): string {
	return word.charAt(0).toUpperCase() + word.slice(1);
}

function scalarString(value: unknown): string {
	return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function parseRegexLiteral(source: string): RegExp | undefined {
	if (!source.startsWith("/")) return undefined;
	const slash = source.lastIndexOf("/");
	if (slash <= 0) return undefined;
	try {
		return new RegExp(source.slice(1, slash), source.slice(slash + 1));
	} catch {
		return undefined;
	}
}

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function markdownDestination(destination: string): string {
	if (!/[\s()<>]/.test(destination)) return destination;
	return `<${destination.replace(/</g, "%3C").replace(/>/g, "%3E").replace(/\n/g, "%0A")}>`;
}

function markdownLink(destination: string, label: string): string {
	return `[${label}](${markdownDestination(destination)})`;
}

function mapRenderable(value: FilterValue, render: (item: string) => string, separator: string): string {
	if (Array.isArray(value)) return value.map(item => render(String(item))).join(separator);
	if (value == null) return render("");
	return render(String(value));
}

function appendMergeValue(target: string[], value: unknown): void {
	if (Array.isArray(value)) {
		target.push(...value.map(String));
		return;
	}
	if (value === undefined) return;
	if (value !== null && typeof value === "object") {
		const serialized = JSON.stringify(value);
		if (serialized !== undefined) target.push(serialized);
		return;
	}
	if (typeof value === "string"
		|| typeof value === "number"
		|| typeof value === "boolean"
		|| typeof value === "bigint") {
		target.push(String(value));
	}
}

function stripHtml(source: string): string {
	let output = "";
	let inside = false;
	let quote: string | undefined;
	for (let index = 0; index < source.length; index++) {
		const character = source[index];
		if (!inside) {
			if (character === "<" && source.indexOf(">", index + 1) >= 0) inside = true;
			else output += character;
			continue;
		}
		if (quote) {
			if (character === quote) quote = undefined;
			continue;
		}
		if (character === '"' || character === "'") quote = character;
		else if (character === ">") inside = false;
	}
	return output;
}

function htmlToMarkdown(source: string): string {
	let html = source;
	const links: string[] = [];
	html = html
		.replace(/<(strong|b)>(.*?)<\/\1>/gi, "**$2**")
		.replace(/<(em|i)>(.*?)<\/\1>/gi, "*$2*")
		.replace(/<a href="(.*?)">(.*?)<\/a>/gi, (_match, href: string, label: string) => {
			const index = links.push(markdownLink(href, label)) - 1;
			return `@@MORPHIC_LINK_${index}@@`;
		})
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<p>(.*?)<\/p>/gi, "$1\n\n")
		.replace(/<h([1-6])>(.*?)<\/h\1>/gi, (_match, level: string, text: string) => `${"#".repeat(Number(level))} ${text}\n`)
		.replace(/<li>(.*?)<\/li>/gi, "- $1\n");
	html = stripHtml(html);
	return html.replace(/@@MORPHIC_LINK_(\d+)@@/g, (_match, index: string) => links[Number(index)] ?? "").trim();
}

function stripMarkdown(source: string): string {
	return source
		.replace(/#{1,6}\s/g, "")
		.replace(/(\*\*|__)(.*?)\1/g, "$2")
		.replace(/(\*|_)(.*?)\1/g, "$2")
		.replace(/~~(.*?)~~/g, "$1")
		.replace(/`{1,3}(.*?)`{1,3}/g, "$1")
		.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
		.replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
		.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_match, target: string, display: string | undefined) => display || target)
		.replace(/^>\s/gm, "")
		.replace(/^[-*+]\s/gm, "")
		.replace(/^\d+\.\s/gm, "");
}

function markdownTable(value: FilterValue): FilterValue {
	if (!Array.isArray(value)) return value;
	if (value.length === 0) return "";
	const rows = value.map(row => `| ${Array.isArray(row) ? row.map(String).join(" | ") : String(row)} |`);
	const first = Array.isArray(value[0]) ? value[0] : [value[0]];
	return [rows[0], `| ${first.map(() => "---").join(" | ")} |`, ...rows.slice(1)].join("\n");
}

function validHtmlName(source: string): string | undefined {
	const value = source.trim();
	return /^[A-Za-z][A-Za-z0-9:-]*$/.test(value) ? value : undefined;
}

function stripAttributes(source: string, rawAttributes: unknown[]): string {
	if (rawAttributes.length === 0) return source.replace(/<(\w+)\s[^>]*>/g, "<$1>");
	let output = source;
	for (const raw of rawAttributes) {
		if (typeof raw !== "string") continue;
		const attribute = validHtmlName(raw);
		if (!attribute) continue;
		output = output.replace(new RegExp(`\\s${escapeRegex(attribute)}(?:\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]+))?`, "gi"), "");
	}
	return output;
}

function htmlToJson(source: string): string {
	const document = new DOMParser().parseFromString(source, "text/html");
	const children = Array.from(document.body.childNodes)
		.map(domNodeToJson)
		.filter((value): value is unknown => value !== undefined);
	return JSON.stringify(children.length === 1 ? children[0] : children);
}

function domNodeToJson(node: ChildNode): unknown {
	if (node.nodeType === 3) return node.textContent?.trim() || undefined;
	if (node.nodeType !== 1) return undefined;
	const element = node as Element;
	const output: Record<string, unknown> = { tag: element.tagName.toLowerCase() };
	if (element.attributes.length) {
		const attributes: Record<string, string> = {};
		for (const attribute of Array.from(element.attributes)) attributes[attribute.name] = attribute.value;
		output.attributes = attributes;
	}
	const children = Array.from(element.childNodes).map(domNodeToJson).filter(value => value !== undefined);
	if (children.length) output.children = children;
	return output;
}

function pushTrimmed(target: string[], value: string): void {
	const trimmed = value.trim();
	if (trimmed) target.push(trimmed);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
