import { moment, type App, type CachedMetadata, type TFile } from "obsidian";
import { buildBasesCollection } from "../bases/access";
import { stripFrontmatter } from "../frontmatter";
import type {
	ExprContext,
	ExprDate,
	ExprFile,
	ExprLink,
	ExprRegex,
	ExprValue,
} from "./model";

export function exprToString(value: ExprValue): string {
	if (value == null) return "";
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (Array.isArray(value)) return value.map(exprToString).join(", ");
	if (isExprDate(value)) return value._moment.format();
	if (isExprLink(value)) return `[[${value.target}${value.display ? `|${value.display}` : ""}]]`;
	if (isExprRegex(value)) return `/${value.pattern}/${value.flags}`;
	if (isExprFile(value)) return value.path;
	try {
		return JSON.stringify(value);
	} catch {
		return Object.prototype.toString.call(value);
	}
}

export function isTruthy(value: ExprValue): boolean {
	if (value == null || value === false || value === 0 || value === "") return false;
	if (Array.isArray(value)) return value.length > 0;
	return true;
}

export function toNumber(value: ExprValue): number {
	if (typeof value === "number") return value;
	if (typeof value === "boolean") return value ? 1 : 0;
	const parsed = Number.parseFloat(exprToString(value));
	return Number.isFinite(parsed) ? parsed : 0;
}

export function normalizeValue(value: unknown): ExprValue {
	if (value == null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
		return value;
	}
	if (Array.isArray(value)) return value.map(normalizeValue);
	if (typeof value === "object") return normalizeRecord(value as Record<string, unknown>);
	if (typeof value === "bigint" || typeof value === "symbol") return String(value);
	if (typeof value === "function") return value.name || "function";
	return null;
}

export function normalizeRecord(value: Record<string, unknown>): Record<string, ExprValue> {
	const result: Record<string, ExprValue> = {};
	for (const [key, child] of Object.entries(value)) {
		if (key === "position") continue;
		result[key] = normalizeValue(child);
	}
	return result;
}

export function resolveIdentifier(name: string, ctx: ExprContext): ExprValue {
	if (Object.prototype.hasOwnProperty.call(ctx.variables, name)) return ctx.variables[name];
	if (ctx.frontmatter && Object.prototype.hasOwnProperty.call(ctx.frontmatter, name)) {
		return normalizeValue(ctx.frontmatter[name]);
	}

	switch (name) {
		case "content": return ctx.bodyContent;
		case "name": return ctx.file.name;
		case "basename": return ctx.file.basename;
		case "size": return ctx.file.stat.size;
		case "ctime": return ctx.file.stat.ctime;
		case "mtime": return ctx.file.stat.mtime;
		case "bases":
		case "baseViews": return buildBasesCollection(ctx.bases ?? []) as ExprValue[];
		case "file": return buildExprFile(ctx.app, ctx.file, ctx.bases, ctx.frontmatter);
		default: return null;
	}
}

export function directSelfFileProperty(
	property: string,
	ctx: ExprContext,
): { handled: boolean; value: ExprValue } {
	if (Object.prototype.hasOwnProperty.call(ctx.variables, "file")) return { handled: false, value: null };
	if (ctx.frontmatter && Object.prototype.hasOwnProperty.call(ctx.frontmatter, "file")) {
		return { handled: false, value: null };
	}

	switch (property) {
		case "name": return { handled: true, value: ctx.file.name };
		case "basename": return { handled: true, value: ctx.file.basename };
		case "path": return { handled: true, value: ctx.file.path };
		case "folder": return { handled: true, value: folderFromPath(ctx.file.path) };
		case "ext": return { handled: true, value: ctx.file.extension };
		case "size": return { handled: true, value: ctx.file.stat.size };
		case "ctime": return { handled: true, value: ctx.file.stat.ctime };
		case "mtime": return { handled: true, value: ctx.file.stat.mtime };
		case "content": return { handled: true, value: ctx.bodyContent };
		case "bases":
		case "baseViews":
			if (Array.isArray(ctx.bases)) {
				return { handled: true, value: buildBasesCollection(ctx.bases) as ExprValue[] };
			}
			return { handled: true, value: normalizeValue(ctx.frontmatter?.[property]) };
		default:
			return { handled: false, value: null };
	}
}

export function readProperty(object: ExprValue, property: string): ExprValue {
	if (object == null) return null;
	if (isExprFile(object)) {
		if (property !== "__type" && property !== "_tfile" && Object.prototype.hasOwnProperty.call(object, property)) {
			return (object as unknown as Record<string, ExprValue>)[property] ?? null;
		}
		return object.properties[property] ?? null;
	}
	if (isExprDate(object)) {
		switch (property) {
			case "year": return object._moment.year();
			case "month": return object._moment.month() + 1;
			case "day": return object._moment.date();
			case "hour": return object._moment.hour();
			case "minute": return object._moment.minute();
			case "second": return object._moment.second();
			case "millisecond": return object._moment.millisecond();
			default: return null;
		}
	}
	if (isExprLink(object)) {
		if (property === "target") return object.target;
		if (property === "display") return object.display ?? object.target;
		return null;
	}
	if (Array.isArray(object)) {
		if (property === "length") return object.length;
		return (object as unknown as Record<string, ExprValue>)[property] ?? null;
	}
	if (typeof object === "string") return property === "length" ? object.length : null;
	if (typeof object === "object") return (object as Record<string, ExprValue>)[property] ?? null;
	return null;
}

export async function callFunction(name: string, args: ExprValue[], ctx: ExprContext): Promise<ExprValue> {
	switch (name) {
		case "link":
			return {
				__type: "link",
				target: exprToString(args[0]),
				display: args.length > 1 ? exprToString(args[1]) : undefined,
			};
		case "file": {
			const target = resolveToFile(ctx.app, exprToString(args[0]), ctx.file.path);
			return target ? buildExprFile(ctx.app, target) : null;
		}
		case "for": {
			const list = args[0];
			const template = args.length > 1 ? exprToString(args[1]) : "{{value}}";
			const separator = args.length > 2 ? exprToString(args[2]) : ", ";
			if (!Array.isArray(list)) return exprToString(list);
			return list.map((item, index) => template
				.replace(/\{\{value\}\}/g, exprToString(item))
				.replace(/\{\{index\}\}/g, String(index)))
				.join(separator);
		}
		case "now": return { __type: "date", _moment: moment() };
		case "today": return { __type: "date", _moment: moment().startOf("day") };
		case "date": {
			const input = exprToString(args[0]);
			const format = args.length > 1 ? exprToString(args[1]) : undefined;
			const parsed = format ? moment(input, format) : moment(input);
			return parsed.isValid() ? { __type: "date", _moment: parsed } : null;
		}
		case "duration": {
			const input = args[0];
			if (typeof input === "number") return moment.duration(input).asMilliseconds();
			return moment.duration(exprToString(input)).asMilliseconds();
		}
		case "min": return Math.min(...args.map(toNumber));
		case "max": return Math.max(...args.map(toNumber));
		case "abs": return Math.abs(toNumber(args[0]));
		case "ceil": return Math.ceil(toNumber(args[0]));
		case "floor": return Math.floor(toNumber(args[0]));
		case "round": return Math.round(toNumber(args[0]));
		case "random": {
			if (args.length >= 2) {
				const minimum = toNumber(args[0]);
				const maximum = toNumber(args[1]);
				return Math.floor(Math.random() * (maximum - minimum + 1)) + minimum;
			}
			return Math.random();
		}
		case "list": return args;
		case "number": return toNumber(args[0]);
		case "string": return exprToString(args[0]);
		case "boolean": return isTruthy(args[0]);
		case "image": return markdownImage(exprToString(args[0]), args.length > 1 ? exprToString(args[1]) : "");
		case "icon": return `<span class="icon">${exprToString(args[0])}</span>`;
		case "html": return exprToString(args[0]);
		case "escapeHTML": return escapeHtml(exprToString(args[0]));
		case "length": {
			const value = args[0];
			return typeof value === "string" || Array.isArray(value) ? value.length : 0;
		}
		case "typeof": return typeName(args[0]);
		case "concat": return args.map(exprToString).join("");
		default: return null;
	}
}

export async function callMethod(
	object: ExprValue,
	method: string,
	args: ExprValue[],
	ctx: ExprContext,
): Promise<ExprValue> {
	if (isExprFile(object)) return fileMethod(object, method, args, ctx);
	if (isExprLink(object)) return linkMethod(object, method, args, ctx);
	if (isExprDate(object)) return dateMethod(object, method, args);
	if (Array.isArray(object)) return listMethod(object, method, args);
	if (typeof object === "number") return numberMethod(object, method, args);
	if (typeof object === "string") return stringMethod(object, method, args);
	if (object !== null && typeof object === "object") {
		const objectResult = objectMethod(object as Record<string, ExprValue>, method, args);
		if (objectResult.handled) return objectResult.value;
	}
	return stringMethod(exprToString(object), method, args);
}

export function binaryOperation(op: string, left: ExprValue, right: ExprValue): ExprValue {
	switch (op) {
		case "+": return typeof left === "string" || typeof right === "string"
			? exprToString(left) + exprToString(right)
			: toNumber(left) + toNumber(right);
		case "-": return toNumber(left) - toNumber(right);
		case "*": return toNumber(left) * toNumber(right);
		case "/": {
			const divisor = toNumber(right);
			return divisor === 0 ? null : toNumber(left) / divisor;
		}
		case "%": {
			const divisor = toNumber(right);
			return divisor === 0 ? null : toNumber(left) % divisor;
		}
		case "**": return Math.pow(toNumber(left), toNumber(right));
		case "==": return exprToString(left) === exprToString(right);
		case "!=": return exprToString(left) !== exprToString(right);
		case "<": return toNumber(left) < toNumber(right);
		case ">": return toNumber(left) > toNumber(right);
		case "<=": return toNumber(left) <= toNumber(right);
		case ">=": return toNumber(left) >= toNumber(right);
		default: return null;
	}
}

export function unaryOperation(op: string, value: ExprValue): ExprValue {
	if (op === "!") return !isTruthy(value);
	if (op === "-") return -toNumber(value);
	return null;
}

function stringMethod(value: string, method: string, args: ExprValue[]): ExprValue {
	switch (method) {
		case "contains": return value.includes(exprToString(args[0]));
		case "containsAll": return unpackTargets(args).every(target => value.includes(exprToString(target)));
		case "containsAny": return unpackTargets(args).some(target => value.includes(exprToString(target)));
		case "endsWith": return value.endsWith(exprToString(args[0]));
		case "startsWith": return value.startsWith(exprToString(args[0]));
		case "isEmpty": return value.length === 0;
		case "lower": return value.toLowerCase();
		case "upper": return value.toUpperCase();
		case "title": return value.replace(/\w\S*/g, word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
		case "capitalize": return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
		case "trim": return value.trim();
		case "replace": {
			const replacement = args.length > 1 ? exprToString(args[1]) : "";
			if (isExprRegex(args[0])) {
				try {
					return value.replace(new RegExp(args[0].pattern, args[0].flags), replacement);
				} catch {
					return value;
				}
			}
			return value.split(exprToString(args[0])).join(replacement);
		}
		case "repeat": return value.repeat(toNumber(args[0]));
		case "reverse": return value.split("").reverse().join("");
		case "slice": return value.slice(toNumber(args[0]), args.length > 1 ? toNumber(args[1]) : undefined);
		case "split": return value.split(args.length > 0 ? exprToString(args[0]) : ",");
		case "length": return value.length;
		case "toString": return value;
		case "isTruthy": return isTruthy(value);
		case "isType": return exprToString(args[0]) === "string";
		default: return null;
	}
}

function numberMethod(value: number, method: string, args: ExprValue[]): ExprValue {
	switch (method) {
		case "abs": return Math.abs(value);
		case "ceil": return Math.ceil(value);
		case "floor": return Math.floor(value);
		case "round": {
			const decimals = args.length > 0 ? toNumber(args[0]) : 0;
			const factor = Math.pow(10, decimals);
			return Math.round(value * factor) / factor;
		}
		case "toFixed": return value.toFixed(args.length > 0 ? toNumber(args[0]) : 0);
		case "isEmpty": return false;
		case "toString": return String(value);
		case "isTruthy": return isTruthy(value);
		case "isType": return exprToString(args[0]) === "number";
		default: return null;
	}
}

function listMethod(value: ExprValue[], method: string, args: ExprValue[]): ExprValue {
	switch (method) {
		case "contains": return value.some(item => exprToString(item) === exprToString(args[0]));
		case "containsAll": return unpackTargets(args).every(target => value.some(item => exprToString(item) === exprToString(target)));
		case "containsAny": return unpackTargets(args).some(target => value.some(item => exprToString(item) === exprToString(target)));
		case "filter": {
			if (args.length === 0) return value.filter(isTruthy);
			if (typeof args[0] === "string") return value.filter(item => exprToString(item).includes(args[0] as string));
			return value.filter(isTruthy);
		}
		case "flat": {
			const result: ExprValue[] = [];
			for (const item of value) {
				if (Array.isArray(item)) result.push(...item);
				else result.push(item);
			}
			return result;
		}
		case "isEmpty": return value.length === 0;
		case "join": return value.map(exprToString).join(args.length > 0 ? exprToString(args[0]) : ", ");
		case "map": return args.length > 0 && typeof args[0] === "string"
			? value.map(item => item !== null && typeof item === "object" && !Array.isArray(item)
				? (item as Record<string, ExprValue>)[args[0] as string] ?? null
				: null)
			: value;
		case "reduce": return value.reduce<number>((total, item) => total + toNumber(item), args.length > 0 ? toNumber(args[0]) : 0);
		case "reverse": return [...value].reverse();
		case "slice": return value.slice(toNumber(args[0]), args.length > 1 ? toNumber(args[1]) : undefined);
		case "sort": {
			const result = [...value].sort((left, right) => exprToString(left).localeCompare(exprToString(right)));
			return args.length > 0 && exprToString(args[0]) === "desc" ? result.reverse() : result;
		}
		case "unique": {
			const seen = new Set<string>();
			return value.filter(item => {
				const key = exprToString(item);
				if (seen.has(key)) return false;
				seen.add(key);
				return true;
			});
		}
		case "first": return value.length > 0 ? value[0] : null;
		case "last": return value.length > 0 ? value[value.length - 1] : null;
		case "length": return value.length;
		case "toString": return exprToString(value);
		case "isTruthy": return isTruthy(value);
		case "isType": return exprToString(args[0]) === "list";
		default: return null;
	}
}

function dateMethod(value: ExprDate, method: string, args: ExprValue[]): ExprValue {
	switch (method) {
		case "format": return value._moment.format(args.length > 0 ? exprToString(args[0]) : undefined);
		case "date": return value._moment.format("YYYY-MM-DD");
		case "time": return value._moment.format("HH:mm:ss");
		case "isEmpty": return false;
		case "toString": return value._moment.format();
		case "isTruthy": return true;
		case "isType": return exprToString(args[0]) === "date";
		default: return null;
	}
}

async function linkMethod(value: ExprLink, method: string, args: ExprValue[], ctx: ExprContext): Promise<ExprValue> {
	switch (method) {
		case "asFile": {
			const file = resolveToFile(ctx.app, value.target, ctx.file.path);
			return file ? buildExprFile(ctx.app, file) : null;
		}
		case "exists": return resolveToFile(ctx.app, value.target, ctx.file.path) !== null;
		case "toString": return exprToString(value);
		case "isTruthy": return true;
		case "isType": return exprToString(args[0]) === "link";
		default: return stringMethod(exprToString(value), method, args);
	}
}

async function fileMethod(value: ExprFile, method: string, args: ExprValue[], ctx: ExprContext): Promise<ExprValue> {
	switch (method) {
		case "content": {
			const raw = await ctx.app.vault.cachedRead(value._tfile);
			return stripFrontmatter(ctx.app.metadataCache.getFileCache(value._tfile), raw);
		}
		case "asLink": return { __type: "link", target: value.basename };
		case "hasLink": return unpackTargets(args).some(target => value.links.includes(exprToString(target)));
		case "hasProperty": return unpackTargets(args).every(target => Object.prototype.hasOwnProperty.call(value.properties, exprToString(target)));
		case "hasTag": return unpackTargets(args).some(target => value.tags.includes(normalizeTag(exprToString(target))));
		case "inFolder": {
			const folder = exprToString(args[0]);
			return value.folder === folder || value.path.startsWith(`${folder}/`);
		}
		case "toString": return value.path;
		case "isTruthy": return true;
		case "isType": return exprToString(args[0]) === "file";
		default: return stringMethod(exprToString(value), method, args);
	}
}

function objectMethod(
	value: Record<string, ExprValue>,
	method: string,
	args: ExprValue[],
): { handled: boolean; value: ExprValue } {
	switch (method) {
		case "get": return { handled: true, value: value[exprToString(args[0])] ?? null };
		case "contains": return { handled: true, value: Object.prototype.hasOwnProperty.call(value, exprToString(args[0])) };
		case "keys": return { handled: true, value: Object.keys(value).filter(key => key !== "__type") };
		case "values": return { handled: true, value: Object.keys(value).filter(key => key !== "__type").map(key => value[key]) };
		case "length": return { handled: true, value: Object.keys(value).filter(key => key !== "__type").length };
		case "isEmpty": return { handled: true, value: Object.keys(value).filter(key => key !== "__type").length === 0 };
		case "toString": return { handled: true, value: exprToString(value) };
		case "isTruthy": return { handled: true, value: true };
		case "isType": return { handled: true, value: exprToString(args[0]) === "object" };
		default: return { handled: false, value: null };
	}
}

function buildExprFile(
	app: App,
	file: TFile,
	bases?: ExprValue[],
	frontmatterOverride?: Record<string, unknown>,
): ExprFile {
	const cache = app.metadataCache.getFileCache(file);
	const frontmatter = frontmatterOverride ?? cache?.frontmatter;
	const tags = collectTags(cache, frontmatter);
	const links = cache?.links?.map(link => link.link) ?? [];
	const result: ExprFile = {
		__type: "file",
		name: file.name,
		basename: file.basename,
		path: file.path,
		folder: folderFromPath(file.path),
		ext: file.extension,
		size: file.stat.size,
		ctime: file.stat.ctime,
		mtime: file.stat.mtime,
		tags,
		links,
		properties: normalizeRecord(frontmatter ?? {}),
		_tfile: file,
	};
	if (bases) {
		const collection = buildBasesCollection(bases) as ExprValue[];
		result.bases = collection;
		result.baseViews = collection;
	}
	return result;
}

function collectTags(cache: CachedMetadata | null | undefined, frontmatter: Record<string, unknown> | undefined): string[] {
	const tags: string[] = [];
	for (const item of cache?.tags ?? []) {
		if (!tags.includes(item.tag)) tags.push(item.tag);
	}
	const raw = frontmatter?.tags;
	const frontmatterTags = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
	for (const item of frontmatterTags) {
		const tag = normalizeTag(String(item));
		if (!tags.includes(tag)) tags.push(tag);
	}
	return tags;
}

function resolveToFile(app: App, target: string, sourcePath: string): TFile | null {
	return app.metadataCache.getFirstLinkpathDest(target, sourcePath);
}

function unpackTargets(args: ExprValue[]): ExprValue[] {
	return args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
}

function typeName(value: ExprValue): string {
	if (value == null) return "null";
	if (Array.isArray(value)) return "list";
	if (isExprFile(value)) return "file";
	if (isExprLink(value)) return "link";
	if (isExprDate(value)) return "date";
	if (isExprRegex(value)) return "regex";
	if (typeof value === "object") return "object";
	return typeof value;
}

function markdownImage(source: string, alt: string): string {
	return `![${alt}](${markdownDestination(source)})`;
}

function markdownDestination(source: string): string {
	if (!/[\s()<>]/.test(source)) return source;
	return `<${source.replace(/</g, "%3C").replace(/>/g, "%3E").replace(/\n/g, "%0A")}>`;
}

function escapeHtml(source: string): string {
	return source
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");
}

function normalizeTag(tag: string): string {
	return tag.startsWith("#") ? tag : `#${tag}`;
}

function folderFromPath(path: string): string {
	const slash = path.lastIndexOf("/");
	return slash < 0 ? "" : path.slice(0, slash);
}

function isExprFile(value: ExprValue): value is ExprFile {
	return value !== null && typeof value === "object" && !Array.isArray(value) && value.__type === "file";
}

function isExprLink(value: ExprValue): value is ExprLink {
	return value !== null && typeof value === "object" && !Array.isArray(value) && value.__type === "link";
}

function isExprDate(value: ExprValue): value is ExprDate {
	return value !== null && typeof value === "object" && !Array.isArray(value) && value.__type === "date";
}

function isExprRegex(value: ExprValue): value is ExprRegex {
	return value !== null && typeof value === "object" && !Array.isArray(value) && value.__type === "regex";
}
