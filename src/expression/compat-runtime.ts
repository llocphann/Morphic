import { buildBasesCollection } from "../bases/access";
import type { ExprContext, ExprFile, ExprValue, ExpressionNode } from "./model";
import {
	callFunction,
	callMethod,
	directSelfFileProperty,
	isTruthy,
	normalizeValue,
	readProperty,
	resolveIdentifier,
	toNumber,
	unaryOperation,
} from "./compat-semantics";

const KNOWN_FUNCTIONS = new Set([
	"link", "file", "if", "for", "now", "today", "date", "duration",
	"min", "max", "random", "list", "number", "string", "boolean",
	"abs", "ceil", "floor", "round", "image", "icon", "html",
	"escapeHTML", "length", "typeof", "concat",
]);

export { isTruthy };

export function exprToString(value: ExprValue): string {
	if (value == null) return "";
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (Array.isArray(value)) return value.map(exprToString).join(", ");
	if (hasType(value, "file")) return (value as unknown as { path: string }).path;
	if (hasType(value, "link")) {
		const link = value as unknown as { target: string; display?: string };
		return link.display ? `[[${link.target}|${link.display}]]` : `[[${link.target}]]`;
	}
	if (hasType(value, "date")) {
		return (value as unknown as { _moment: { format(format: string): string } })._moment.format("YYYY-MM-DD");
	}
	if (hasType(value, "regex")) {
		const regex = value as unknown as { pattern: string; flags: string };
		return `/${regex.pattern}/${regex.flags}`;
	}
	try {
		return JSON.stringify(value);
	} catch {
		return Object.prototype.toString.call(value);
	}
}

export async function evaluateNode(node: ExpressionNode, ctx: ExprContext): Promise<ExprValue> {
	switch (node.type) {
		case "number":
		case "string":
		case "boolean":
			return node.value;
		case "null":
			return null;
		case "regex":
			return { __type: "regex", pattern: node.pattern, flags: node.flags };
		case "identifier":
			return resolveCompatIdentifier(node.name, ctx);
		case "arrayLiteral": {
			const result: ExprValue[] = [];
			for (const element of node.elements) result.push(await evaluateNode(element, ctx));
			return result;
		}
		case "arrayAccess": {
			const object = await evaluateNode(node.object, ctx);
			const index = await evaluateNode(node.index, ctx);
			if (Array.isArray(object) && typeof index === "number") return object[index] ?? null;
			if (typeof object === "string" && typeof index === "number") return object[index] ?? null;
			if (object !== null && typeof object === "object" && !Array.isArray(object)) {
				return (object as Record<string, ExprValue>)[exprToString(index)] ?? null;
			}
			return null;
		}
		case "propertyAccess": {
			if (node.object.type === "identifier" && node.object.name === "file") {
				const direct = directSelfFileProperty(node.property, ctx);
				if (direct.handled && !needsRichSelfFileFallback(node.property, direct.value, ctx)) {
					return direct.value;
				}
			}
			const object = await evaluateNode(node.object, ctx);
			const value = readProperty(object, node.property);
			if (value !== null || typeof object !== "string") return value;

			const target = wikilinkTarget(object);
			if (!target) return null;
			const linked = await callFunction("file", [target], ctx);
			return readProperty(linked, node.property);
		}
		case "functionCall": {
			if (node.name === "if") {
				const condition = node.args.length > 0 ? await evaluateNode(node.args[0], ctx) : null;
				if (isTruthy(condition)) return node.args.length > 1 ? evaluateNode(node.args[1], ctx) : true;
				return node.args.length > 2 ? evaluateNode(node.args[2], ctx) : null;
			}
			if (!KNOWN_FUNCTIONS.has(node.name)) return null;
			const args: ExprValue[] = [];
			for (const arg of node.args) args.push(await evaluateNode(arg, ctx));
			return callFunction(node.name, args, ctx);
		}
		case "methodCall": {
			const object = await evaluateNode(node.object, ctx);
			const args: ExprValue[] = [];
			for (const arg of node.args) args.push(await evaluateNode(arg, ctx));
			return callMethod(object, node.method, args, ctx);
		}
		case "binaryOp": {
			const left = await evaluateNode(node.left, ctx);
			if (node.op === "&&" && !isTruthy(left)) return left;
			if (node.op === "||" && isTruthy(left)) return left;
			const right = await evaluateNode(node.right, ctx);
			if (node.op === "&&" || node.op === "||") return right;
			return binaryOperation(node.op, left, right);
		}
		case "unaryOp":
			return unaryOperation(node.op, await evaluateNode(node.operand, ctx));
		case "lambda":
			return null;
	}
}

function resolveCompatIdentifier(name: string, ctx: ExprContext): ExprValue {
	if (name !== "file") return resolveIdentifier(name, ctx);
	if (Object.prototype.hasOwnProperty.call(ctx.variables, "file")) return ctx.variables.file;
	if (ctx.frontmatter && Object.prototype.hasOwnProperty.call(ctx.frontmatter, "file")) {
		return normalizeValue(ctx.frontmatter.file);
	}
	return buildSelfFile(ctx);
}

function needsRichSelfFileFallback(property: string, value: ExprValue, ctx: ExprContext): boolean {
	return (property === "bases" || property === "baseViews")
		&& value === undefined
		&& !Array.isArray(ctx.bases);
}

function buildSelfFile(ctx: ExprContext): ExprFile {
	const cache = ctx.app.metadataCache.getFileCache(ctx.file);
	const cachedFrontmatter = cache?.frontmatter ?? {};
	const frontmatter: Record<string, unknown> = {
		...cachedFrontmatter,
		...(ctx.frontmatter ?? {}),
	};
	delete frontmatter.position;

	const tags: string[] = [];
	for (const item of cache?.tags ?? []) {
		if (!tags.includes(item.tag)) tags.push(item.tag);
	}
	const rawTags = frontmatter.tags;
	const frontmatterTags = Array.isArray(rawTags) ? rawTags : rawTags == null ? [] : [rawTags];
	for (const item of frontmatterTags) {
		const text = String(item);
		const tag = text.startsWith("#") ? text : `#${text}`;
		if (!tags.includes(tag)) tags.push(tag);
	}

	const properties: Record<string, ExprValue> = {};
	for (const [key, value] of Object.entries(frontmatter)) properties[key] = normalizeValue(value);
	const slash = ctx.file.path.lastIndexOf("/");
	const file: ExprFile = {
		__type: "file",
		name: ctx.file.name,
		basename: ctx.file.basename,
		path: ctx.file.path,
		folder: slash < 0 ? "" : ctx.file.path.slice(0, slash),
		ext: ctx.file.extension,
		size: ctx.file.stat.size,
		ctime: ctx.file.stat.ctime,
		mtime: ctx.file.stat.mtime,
		tags,
		links: cache?.links?.map(link => link.link) ?? [],
		properties,
		_tfile: ctx.file,
	};

	if (Array.isArray(ctx.bases)) {
		const bases = buildBasesCollection(ctx.bases) as ExprValue[];
		file.bases = bases;
		file.baseViews = bases;
	}
	return file;
}

function binaryOperation(op: string, left: ExprValue, right: ExprValue): ExprValue {
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

function wikilinkTarget(value: string): string | undefined {
	const match = /^\[\[([^\]|]+)(?:\|[^\]]*)?\]\]$/.exec(value.trim());
	return match?.[1];
}

function hasType(value: ExprValue, type: string): boolean {
	return value !== null
		&& typeof value === "object"
		&& !Array.isArray(value)
		&& (value as { __type?: unknown }).__type === type;
}
