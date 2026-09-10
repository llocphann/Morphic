import { buildBasesCollection } from "../bases/access";
import { applyCompiledFilterPipeline } from "../filters";
import {
	evaluate,
	parseExpression,
	splitExpressionAndPipes,
} from "../expression";
import type {
	ExprContext,
	ExprDate,
	ExprFile,
	ExprLink,
	ExprRegex,
	ExprValue,
} from "../expression";
import { compileFilterPipeline, type CompiledFilterPipeline } from "./filter-pipeline";

type LegacyAst = ReturnType<typeof parseExpression>;

/** Functions whose value can change without a vault/config revision. */
export type ExpressionVolatility = "today" | "now" | "random";

/**
 * Conservative compile-time dependency hints.
 *
 * These hints deliberately over-approximate. Runtime dependency tracking remains
 * authoritative because scoped variables, dynamic file paths, and lazy branches
 * can only be resolved while evaluating a concrete render.
 */
export interface StaticDependencyHints {
	readonly candidateSelfProperties: readonly string[];
	readonly usesSelfMetadata: boolean;
	readonly usesSelfContent: boolean;
	readonly staticLinkedFileTargets: readonly string[];
	readonly usesDynamicLinkedFile: boolean;
	readonly usesLinkedMetadata: boolean;
	readonly usesLinkedContent: boolean;
	readonly usesBases: boolean;
	readonly volatility: readonly ExpressionVolatility[];
}

/** Parsed once, evaluated many times against changing render contexts. */
export interface CompiledExpression {
	readonly source: string;
	readonly expressionSource: string;
	readonly ast: LegacyAst;
	/** Legacy source retained for compatibility/introspection during migration. */
	readonly pipeFilters: string | null;
	/** Pre-parsed execution form used by the warm compiled path. */
	readonly filterPipeline: CompiledFilterPipeline | null;
	readonly dependencyHints: StaticDependencyHints;
}

interface AstNodeLike {
	type: string;
	name?: string;
	value?: unknown;
	pattern?: string;
	flags?: string;
	property?: string;
	method?: string;
	op?: string;
	left?: AstNodeLike;
	right?: AstNodeLike;
	operand?: AstNodeLike;
	object?: AstNodeLike;
	index?: AstNodeLike;
	args?: AstNodeLike[];
	elements?: AstNodeLike[];
	body?: AstNodeLike;
}

interface MutableDependencyHints {
	candidateSelfProperties: Set<string>;
	usesSelfMetadata: boolean;
	usesSelfContent: boolean;
	staticLinkedFileTargets: Set<string>;
	usesDynamicLinkedFile: boolean;
	usesLinkedMetadata: boolean;
	usesLinkedContent: boolean;
	usesBases: boolean;
	volatility: Set<ExpressionVolatility>;
}

interface DirectPropertyResult {
	readonly handled: boolean;
	readonly value: ExprValue;
}

const SELF_METADATA_IDENTIFIERS = new Set([
	"file",
	"name",
	"basename",
	"size",
	"ctime",
	"mtime",
]);

const SELF_FILE_METADATA_PROPERTIES = new Set([
	"name",
	"basename",
	"path",
	"folder",
	"ext",
	"size",
	"ctime",
	"mtime",
	"tags",
	"links",
	"properties",
]);

const HANDLED_SELF_FILE_METHODS = new Set([
	"content",
	"hasLink",
	"hasProperty",
	"hasTag",
	"inFolder",
]);

const KNOWN_GLOBAL_FUNCTIONS = new Set([
	"link",
	"file",
	"if",
	"for",
	"now",
	"today",
	"date",
	"duration",
	"min",
	"max",
	"random",
	"list",
	"number",
	"image",
	"icon",
	"html",
	"escapeHTML",
	"length",
	"typeof",
	"concat",
]);

const SYNTHETIC_VARIABLE_PREFIX = "__morphic_compiled_value_";

/**
 * Compile an invariant expression string into an immutable reusable object.
 * Parsing errors are surfaced to the caller instead of being hidden as null.
 */
export function compileExpression(source: string): CompiledExpression {
	const { expression, pipeFilters } = splitExpressionAndPipes(source);
	const ast = parseExpression(expression);
	return {
		source,
		expressionSource: expression,
		ast,
		pipeFilters,
		filterPipeline: pipeFilters ? compileFilterPipeline(pipeFilters) : null,
		dependencyHints: collectStaticDependencyHints(ast),
	};
}

/**
 * Evaluate a previously compiled expression without tokenizing/parsing it again.
 *
 * The evaluator enforces lazy semantics for &&, ||, and if(). Literals,
 * identifiers, source-file identity properties, and pure binary/unary operators
 * execute directly with the legacy lookup/coercion rules, avoiding repeated
 * legacy evaluator dispatch, ExprFile construction, and synthetic AST/context
 * allocation on warm retained renders. Complex method/function/property
 * operations continue to delegate to the legacy evaluator so their established
 * semantics stay central.
 *
 * Trailing legacy filters execute from the pre-parsed CompiledFilterPipeline, so
 * warm evaluation does not rescan pipe/colon/comma syntax.
 */
export async function evaluateCompiledExpression(
	compiled: CompiledExpression,
	ctx: ExprContext,
): Promise<ExprValue> {
	let result = await evaluateControlSafe(compiled.ast, ctx);
	if (compiled.filterPipeline) {
		const filterInput = result as Parameters<typeof applyCompiledFilterPipeline>[0];
		result = applyCompiledFilterPipeline(filterInput, compiled.filterPipeline);
	}
	return result;
}

/** Exported for tests and future template-IR evaluators that already hold an AST. */
export async function evaluateCompiledAst(
	ast: LegacyAst,
	ctx: ExprContext,
): Promise<ExprValue> {
	return evaluateControlSafe(ast, ctx);
}

export function collectStaticDependencyHints(ast: LegacyAst): StaticDependencyHints {
	const hints: MutableDependencyHints = {
		candidateSelfProperties: new Set(),
		usesSelfMetadata: false,
		usesSelfContent: false,
		staticLinkedFileTargets: new Set(),
		usesDynamicLinkedFile: false,
		usesLinkedMetadata: false,
		usesLinkedContent: false,
		usesBases: false,
		volatility: new Set(),
	};

	walkDependencies(ast, hints);
	return {
		candidateSelfProperties: [...hints.candidateSelfProperties].sort(),
		usesSelfMetadata: hints.usesSelfMetadata,
		usesSelfContent: hints.usesSelfContent,
		staticLinkedFileTargets: [...hints.staticLinkedFileTargets].sort(),
		usesDynamicLinkedFile: hints.usesDynamicLinkedFile,
		usesLinkedMetadata: hints.usesLinkedMetadata,
		usesLinkedContent: hints.usesLinkedContent,
		usesBases: hints.usesBases,
		volatility: [...hints.volatility].sort(),
	};
}

async function evaluateControlSafe(node: AstNodeLike, ctx: ExprContext): Promise<ExprValue> {
	switch (node.type) {
		case "number":
		case "string":
		case "boolean":
			return node.value as ExprValue;

		case "null":
			return null;

		case "regex":
			return {
				__type: "regex",
				pattern: node.pattern ?? "",
				flags: node.flags ?? "",
			};

		case "identifier": {
			const name = node.name;
			if (!name) return null;
			if (name in ctx.variables) return ctx.variables[name];
			if (ctx.frontmatter && name in ctx.frontmatter) {
				return ctx.frontmatter[name] as ExprValue;
			}
			if (name === "content") return ctx.bodyContent;
			if (name === "name") return ctx.file.name;
			if (name === "basename") return ctx.file.basename;
			if (name === "size") return ctx.file.stat.size;
			if (name === "ctime") return ctx.file.stat.ctime;
			if (name === "mtime") return ctx.file.stat.mtime;
			if (name === "bases" || name === "baseViews") {
				return buildBasesCollection(ctx.bases ?? []) as ExprValue[];
			}
			// `file` constructs the legacy ExprFile object, whose exact shape and
			// linked-file behavior stay centralized in expression.ts.
			if (name === "file") return evaluate(node as unknown as LegacyAst, ctx);
			return null;
		}

		case "binaryOp": {
			if (!node.left || !node.right) return null;
			const left = await evaluateControlSafe(node.left, ctx);
			if (node.op === "&&") {
				return isTruthy(left) ? evaluateControlSafe(node.right, ctx) : left;
			}
			if (node.op === "||") {
				return isTruthy(left) ? left : evaluateControlSafe(node.right, ctx);
			}

			const right = await evaluateControlSafe(node.right, ctx);
			return evaluateBinaryOperator(node.op, left, right);
		}

		case "functionCall": {
			if (node.name === "if") {
				const args = node.args ?? [];
				const condition = args.length > 0
					? await evaluateControlSafe(args[0], ctx)
					: null;
				if (isTruthy(condition)) {
					return args.length > 1 ? evaluateControlSafe(args[1], ctx) : true;
				}
				return args.length > 2 ? evaluateControlSafe(args[2], ctx) : null;
			}

			// Preserve the legacy rule that an unknown function returns null before
			// evaluating its arguments.
			if (!node.name || !KNOWN_GLOBAL_FUNCTIONS.has(node.name)) {
				return evaluate(node as unknown as LegacyAst, ctx);
			}

			const values = await evaluateSequentially(node.args ?? [], ctx);
			return evaluateWithSyntheticValues(
				ctx,
				values,
				(references) => ({ ...node, args: references }),
			);
		}

		case "methodCall": {
			if (!node.object) return null;
			const object = await evaluateControlSafe(node.object, ctx);
			const args = await evaluateSequentially(node.args ?? [], ctx);
			return evaluateWithSyntheticValues(
				ctx,
				[object, ...args],
				(references) => ({
					...node,
					object: references[0],
					args: references.slice(1),
				}),
			);
		}

		case "propertyAccess": {
			if (!node.object) return null;
			const directSelfFile = getDirectSelfFileIdentityProperty(node, ctx);
			if (directSelfFile.handled) return directSelfFile.value;
			if (canDirectSelfBasesProperty(node, ctx)) {
				return buildBasesCollection(ctx.bases) as ExprValue[];
			}
			const object = await evaluateControlSafe(node.object, ctx);
			return evaluateWithSyntheticValues(
				ctx,
				[object],
				(references) => ({ ...node, object: references[0] }),
			);
		}

		case "arrayAccess": {
			if (!node.object || !node.index) return null;
			const object = await evaluateControlSafe(node.object, ctx);
			const index = await evaluateControlSafe(node.index, ctx);
			return evaluateWithSyntheticValues(
				ctx,
				[object, index],
				(references) => ({ ...node, object: references[0], index: references[1] }),
			);
		}

		case "arrayLiteral":
			return evaluateSequentially(node.elements ?? [], ctx);

		case "unaryOp": {
			if (!node.operand) return null;
			const operand = await evaluateControlSafe(node.operand, ctx);
			return evaluateUnaryOperator(node.op, operand);
		}

		default:
			return evaluate(node as unknown as LegacyAst, ctx);
	}
}

function getDirectSelfFileIdentityProperty(node: AstNodeLike, ctx: ExprContext): DirectPropertyResult {
	if (!isSelfFileExpression(node.object)) return { handled: false, value: null };
	if ("file" in ctx.variables) return { handled: false, value: null };
	if (ctx.frontmatter && "file" in ctx.frontmatter) return { handled: false, value: null };

	switch (node.property) {
		case "name": return { handled: true, value: ctx.file.name };
		case "basename": return { handled: true, value: ctx.file.basename };
		case "path": return { handled: true, value: ctx.file.path };
		case "folder": {
			const separator = ctx.file.path.lastIndexOf("/");
			return { handled: true, value: separator >= 0 ? ctx.file.path.slice(0, separator) : "" };
		}
		case "ext": return { handled: true, value: ctx.file.extension };
		default: return { handled: false, value: null };
	}
}

function canDirectSelfBasesProperty(node: AstNodeLike, ctx: ExprContext): ctx is ExprContext & { bases: ExprValue[] } {
	if (!isSelfFileExpression(node.object)) return false;
	if (node.property !== "bases" && node.property !== "baseViews") return false;
	if ("file" in ctx.variables) return false;
	if (ctx.frontmatter && "file" in ctx.frontmatter) return false;
	return Array.isArray(ctx.bases);
}

function evaluateBinaryOperator(op: string | undefined, left: ExprValue, right: ExprValue): ExprValue {
	switch (op) {
		case "+": {
			if (typeof left === "string" || typeof right === "string") {
				return exprToStringCompat(left) + exprToStringCompat(right);
			}
			return toNumberCompat(left) + toNumberCompat(right);
		}
		case "-": return toNumberCompat(left) - toNumberCompat(right);
		case "*": return toNumberCompat(left) * toNumberCompat(right);
		case "/": {
			const divisor = toNumberCompat(right);
			return divisor === 0 ? null : toNumberCompat(left) / divisor;
		}
		case "%": {
			const divisor = toNumberCompat(right);
			return divisor === 0 ? null : toNumberCompat(left) % divisor;
		}
		case "**": return Math.pow(toNumberCompat(left), toNumberCompat(right));
		case "==": return exprToStringCompat(left) === exprToStringCompat(right);
		case "!=": return exprToStringCompat(left) !== exprToStringCompat(right);
		case "<": return toNumberCompat(left) < toNumberCompat(right);
		case ">": return toNumberCompat(left) > toNumberCompat(right);
		case "<=": return toNumberCompat(left) <= toNumberCompat(right);
		case ">=": return toNumberCompat(left) >= toNumberCompat(right);
		default: return null;
	}
}

function evaluateUnaryOperator(op: string | undefined, operand: ExprValue): ExprValue {
	switch (op) {
		case "!": return !isTruthy(operand);
		case "-": return -toNumberCompat(operand);
		default: return null;
	}
}

/** Mirror expression.ts arithmetic coercion exactly for pure compiled operators. */
function toNumberCompat(value: ExprValue): number {
	if (typeof value === "number") return value;
	if (typeof value === "string") {
		const parsed = parseFloat(value);
		return isNaN(parsed) ? 0 : parsed;
	}
	if (typeof value === "boolean") return value ? 1 : 0;
	return 0;
}

/** Mirror expression.ts string coercion exactly for pure compiled operators. */
function exprToStringCompat(value: ExprValue): string {
	if (value === null || value === undefined) return "";
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (Array.isArray(value)) return value.map((item) => exprToStringCompat(item)).join(", ");
	if (isExprFileCompat(value)) return value.path;
	if (isExprLinkCompat(value)) {
		return value.display ? `[[${value.target}|${value.display}]]` : `[[${value.target}]]`;
	}
	if (isExprDateCompat(value)) return value._moment.format("YYYY-MM-DD");
	if (isExprRegexCompat(value)) return `/${value.pattern}/${value.flags}`;
	if (typeof value === "object") return JSON.stringify(value);
	return String(value);
}

function isExprFileCompat(value: ExprValue): value is ExprFile {
	return hasExpressionType(value, "file");
}

function isExprLinkCompat(value: ExprValue): value is ExprLink {
	return hasExpressionType(value, "link");
}

function isExprDateCompat(value: ExprValue): value is ExprDate {
	return hasExpressionType(value, "date");
}

function isExprRegexCompat(value: ExprValue): value is ExprRegex {
	return hasExpressionType(value, "regex");
}

function hasExpressionType(value: ExprValue, type: string): boolean {
	return value !== null
		&& typeof value === "object"
		&& !Array.isArray(value)
		&& (value as { __type?: unknown }).__type === type;
}

async function evaluateSequentially(nodes: readonly AstNodeLike[], ctx: ExprContext): Promise<ExprValue[]> {
	const values: ExprValue[] = [];
	for (const node of nodes) {
		values.push(await evaluateControlSafe(node, ctx));
	}
	return values;
}

async function evaluateWithSyntheticValues(
	ctx: ExprContext,
	values: readonly ExprValue[],
	buildNode: (references: AstNodeLike[]) => AstNodeLike,
): Promise<ExprValue> {
	const variables = { ...ctx.variables };
	const references: AstNodeLike[] = [];
	let sequence = 0;

	for (const value of values) {
		let name = `${SYNTHETIC_VARIABLE_PREFIX}${sequence++}`;
		while (Object.prototype.hasOwnProperty.call(variables, name)) {
			name = `${SYNTHETIC_VARIABLE_PREFIX}${sequence++}`;
		}
		variables[name] = value;
		references.push({ type: "identifier", name });
	}

	const delegatedContext: ExprContext = { ...ctx, variables };
	return evaluate(buildNode(references) as unknown as LegacyAst, delegatedContext);
}

function isTruthy(value: ExprValue): boolean {
	if (value === null || value === undefined || value === false) return false;
	if (value === 0 || value === "") return false;
	if (Array.isArray(value) && value.length === 0) return false;
	return true;
}

function walkDependencies(node: AstNodeLike, hints: MutableDependencyHints): void {
	switch (node.type) {
		case "identifier":
			collectIdentifierDependency(node.name, hints);
			return;

		case "functionCall": {
			collectFunctionDependency(node, hints);
			for (const arg of node.args ?? []) walkDependencies(arg, hints);
			return;
		}

		case "methodCall": {
			collectMethodDependency(node, hints);
			if (node.object && !isHandledSelfFileMethod(node)) {
				walkDependencies(node.object, hints);
			}
			for (const arg of node.args ?? []) walkDependencies(arg, hints);
			return;
		}

		case "propertyAccess": {
			collectPropertyDependency(node, hints);
			// Direct `file.<property>` accesses are fully classified above. Avoid
			// treating the bare `file` object itself as an extra metadata dependency.
			if (node.object && !isSelfFileExpression(node.object)) {
				walkDependencies(node.object, hints);
			}
			return;
		}

		case "arrayAccess":
			if (node.object) walkDependencies(node.object, hints);
			if (node.index) walkDependencies(node.index, hints);
			return;

		case "binaryOp":
			if (node.left) walkDependencies(node.left, hints);
			if (node.right) walkDependencies(node.right, hints);
			return;

		case "unaryOp":
			if (node.operand) walkDependencies(node.operand, hints);
			return;

		case "arrayLiteral":
			for (const element of node.elements ?? []) walkDependencies(element, hints);
			return;

		case "lambda":
			if (node.body) walkDependencies(node.body, hints);
			return;

		default:
			return;
	}
}

function collectIdentifierDependency(name: string | undefined, hints: MutableDependencyHints): void {
	if (!name) return;
	if (name === "content") {
		hints.usesSelfContent = true;
		return;
	}
	if (name === "bases" || name === "baseViews") {
		hints.usesBases = true;
		return;
	}
	if (SELF_METADATA_IDENTIFIERS.has(name)) {
		hints.usesSelfMetadata = true;
		return;
	}
	hints.candidateSelfProperties.add(name);
}

function collectFunctionDependency(node: AstNodeLike, hints: MutableDependencyHints): void {
	if (node.name === "today" || node.name === "now" || node.name === "random") {
		hints.volatility.add(node.name);
	}
	if (node.name !== "file") return;

	hints.usesLinkedMetadata = true;
	const target = literalString(node.args?.[0]);
	if (target !== null) {
		hints.staticLinkedFileTargets.add(target);
	} else {
		hints.usesDynamicLinkedFile = true;
	}
}

function collectMethodDependency(node: AstNodeLike, hints: MutableDependencyHints): void {
	// `date.relative()` delegates to Moment `fromNow()`, so the result changes as
	// wall-clock time advances. Static typing cannot prove the receiver is a date,
	// therefore conservatively classify every `relative()` method call as now-volatile.
	if (node.method === "relative") hints.volatility.add("now");

	if (node.method === "content") {
		if (isSelfFileExpression(node.object)) {
			hints.usesSelfContent = true;
		} else {
			hints.usesLinkedContent = true;
			hints.usesLinkedMetadata = true;
		}
	}

	if (node.method === "asFile" || node.method === "linksTo") {
		hints.usesLinkedMetadata = true;
		const target = extractStaticLinkTarget(node.object);
		if (target !== null) hints.staticLinkedFileTargets.add(target);
		else hints.usesDynamicLinkedFile = true;
	}

	if (
		isSelfFileExpression(node.object)
		&& (node.method === "hasLink" || node.method === "hasProperty" || node.method === "hasTag" || node.method === "inFolder")
	) {
		hints.usesSelfMetadata = true;
	}
}

function collectPropertyDependency(node: AstNodeLike, hints: MutableDependencyHints): void {
	if (!node.property || !isSelfFileExpression(node.object)) return;
	if (node.property === "content") {
		hints.usesSelfContent = true;
		return;
	}
	if (node.property === "bases" || node.property === "baseViews") {
		hints.usesBases = true;
		return;
	}
	if (SELF_FILE_METADATA_PROPERTIES.has(node.property)) {
		hints.usesSelfMetadata = true;
	} else {
		hints.candidateSelfProperties.add(node.property);
	}
}

function isHandledSelfFileMethod(node: AstNodeLike): boolean {
	return isSelfFileExpression(node.object)
		&& !!node.method
		&& HANDLED_SELF_FILE_METHODS.has(node.method);
}

function isSelfFileExpression(node: AstNodeLike | undefined): boolean {
	return node?.type === "identifier" && node.name === "file";
}

function extractStaticLinkTarget(node: AstNodeLike | undefined): string | null {
	if (!node || node.type !== "functionCall" || node.name !== "link") return null;
	return literalString(node.args?.[0]);
}

function literalString(node: AstNodeLike | undefined): string | null {
	return node?.type === "string" && typeof node.value === "string" ? node.value : null;
}
