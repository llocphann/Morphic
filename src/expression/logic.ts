import { applyFilterChain } from "../filters";
import { tokenizeExpression } from "./lexer";
import { LexemeKind, type ExprContext, type ExprValue } from "./model";
import { parseExpressionSource } from "./parser";
import { evaluateNode, exprToString, isTruthy } from "./compat-runtime";
import { splitExpressionPipeline } from "./syntax";

const DEFERRED_PREFIX = "__cv_deferred_markdown_";
const RENDERABLE_MARKDOWN = /!?\[\[[^\]\n]+\]\]|\[[^\]\n]+\]\([^)]+\)|!\[[^\]\n]*\]\([^)]+\)|(^|[\s([{])#[\w/-]+|[*_`~]/;
const SET_TAG = /\{%\s*set\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*%\}/g;
const FOR_TAG = /\{%\s*(for\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\s+([^%}]*?)|endfor)\s*%\}/g;
const IF_TAG = /\{%\s*(if\s+([^%}]*?)|endif)\s*%\}/g;
const PLACEHOLDER = /\{\{((?:[^{}]|\{[^{]|\}[^}])*?)\}\}/g;

interface ForBlock {
	start: number;
	end: number;
	body: string;
	variable: string;
	expression: string;
}

interface IfBlock {
	start: number;
	end: number;
	body: string;
	condition: string;
}

export async function processLogic(template: string, ctx: ExprContext): Promise<string> {
	let output = await processSets(template, ctx);
	output = await processFors(output, ctx);
	output = await processIfs(output, ctx);
	if (Object.keys(ctx.variables).length > 0) output = await resolveScopedPlaceholders(output, ctx);
	return output;
}

export function resolveDeferredMarkdown(
	expression: string,
	ctx: ExprContext,
): { found: boolean; value: ExprValue } {
	const key = expression.trim();
	if (!key.startsWith(DEFERRED_PREFIX)) return { found: false, value: null };
	if (!ctx.deferredMarkdown || !Object.prototype.hasOwnProperty.call(ctx.deferredMarkdown.values, key)) {
		return { found: false, value: null };
	}
	return { found: true, value: ctx.deferredMarkdown.values[key] };
}

async function processSets(template: string, ctx: ExprContext): Promise<string> {
	let output = template;
	let match: RegExpExecArray | null;
	SET_TAG.lastIndex = 0;
	while ((match = SET_TAG.exec(output)) !== null) {
		const name = match[1];
		const source = match[2];
		try {
			ctx.variables[name] = await evaluateNode(parseExpressionSource(source), ctx);
		} catch {
			ctx.variables[name] = source;
		}
		output = output.slice(0, match.index) + output.slice(match.index + match[0].length);
		SET_TAG.lastIndex = match.index;
	}
	return output;
}

async function processFors(template: string, ctx: ExprContext): Promise<string> {
	let output = template;
	for (let safety = 0; safety < 50; safety++) {
		const block = findOuterForBlock(output);
		if (!block) break;
		const list = await evaluateListExpression(block.expression, ctx);
		let replacement = "";
		if (Array.isArray(list)) {
			const pieces: string[] = [];
			for (let index = 0; index < list.length; index++) {
				const child: ExprContext = {
					...ctx,
					variables: {
						...ctx.variables,
						[block.variable]: list[index],
						loop: {
							index: index + 1,
							index0: index,
							first: index === 0,
							last: index === list.length - 1,
							length: list.length,
						},
					},
				};
				pieces.push(await processLogic(block.body, child));
			}
			replacement = pieces.join("");
		}
		output = output.slice(0, block.start) + replacement + output.slice(block.end);
	}
	return output;
}

function findOuterForBlock(template: string): ForBlock | undefined {
	const matcher = new RegExp(FOR_TAG.source, "g");
	const opening = matcher.exec(template);
	if (!opening || opening[1] === "endfor") return undefined;
	let depth = 1;
	let closing: RegExpExecArray | null = null;
	while ((closing = matcher.exec(template)) !== null) {
		if (closing[1] === "endfor") {
			depth--;
			if (depth === 0) break;
		} else {
			depth++;
		}
	}
	if (!closing || depth !== 0) return undefined;
	return {
		start: opening.index,
		end: closing.index + closing[0].length,
		variable: opening[2],
		expression: opening[3].trim(),
		body: template.slice(opening.index + opening[0].length, closing.index),
	};
}

async function evaluateListExpression(source: string, ctx: ExprContext): Promise<ExprValue> {
	try {
		return await evaluateNode(parseExpressionSource(source), ctx);
	} catch {
		const key = source.trim();
		return ctx.frontmatter && key in ctx.frontmatter ? ctx.frontmatter[key] as ExprValue : null;
	}
}

async function processIfs(template: string, ctx: ExprContext): Promise<string> {
	let output = template;
	for (let safety = 0; safety < 50; safety++) {
		const block = findInnermostIfBlock(output);
		if (!block) break;
		const replacement = await chooseBranch(block.condition, block.body, ctx);
		output = output.slice(0, block.start) + replacement + output.slice(block.end);
	}
	return output;
}

function findInnermostIfBlock(template: string): IfBlock | undefined {
	const matcher = new RegExp(IF_TAG.source, "g");
	const stack: Array<{ index: number; length: number; condition: string }> = [];
	let match: RegExpExecArray | null;
	while ((match = matcher.exec(template)) !== null) {
		if (match[1] === "endif") {
			const opening = stack.pop();
			if (!opening) continue;
			return {
				start: opening.index,
				end: match.index + match[0].length,
				condition: opening.condition,
				body: template.slice(opening.index + opening.length, match.index),
			};
		}
		stack.push({ index: match.index, length: match[0].length, condition: match[2].trim() });
	}
	return undefined;
}

async function chooseBranch(condition: string, body: string, ctx: ExprContext): Promise<string> {
	const branches: Array<{ condition: string | null; body: string }> = [];
	const split = /\{%\s*(elif\s+([^%}]*?)|else)\s*%\}/g;
	let cursor = 0;
	let currentCondition: string | null = condition;
	let match: RegExpExecArray | null;
	while ((match = split.exec(body)) !== null) {
		branches.push({ condition: currentCondition, body: body.slice(cursor, match.index) });
		currentCondition = match[1] === "else" ? null : match[2].trim();
		cursor = match.index + match[0].length;
	}
	branches.push({ condition: currentCondition, body: body.slice(cursor) });

	for (const branch of branches) {
		if (branch.condition === null) return branch.body;
		try {
			if (isTruthy(await evaluateNode(parseExpressionSource(branch.condition), ctx))) return branch.body;
		} catch {
			// Invalid conditions are treated as false.
		}
	}
	return "";
}

async function resolveScopedPlaceholders(template: string, ctx: ExprContext): Promise<string> {
	const replacements: Array<{ start: number; end: number; value: string }> = [];
	PLACEHOLDER.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = PLACEHOLDER.exec(template)) !== null) {
		const inner = match[1].trim();
		if (!inner || !referencesScopedVariable(inner, ctx.variables)) continue;
		const pipeline = splitExpressionPipeline(inner);
		let value: ExprValue;
		try {
			value = await evaluateNode(parseExpressionSource(pipeline.expression), ctx);
		} catch {
			continue;
		}
		if (pipeline.pipeFilters && value !== null && value !== undefined) {
			value = applyFilterChain(value as Parameters<typeof applyFilterChain>[0], pipeline.pipeFilters);
		}
		const text = exprToString(value);
		const rendered = shouldDefer(text, ctx) ? defer(value, ctx) : text;
		replacements.push({ start: match.index, end: match.index + match[0].length, value: rendered });
	}

	let output = template;
	for (let index = replacements.length - 1; index >= 0; index--) {
		const replacement = replacements[index];
		output = output.slice(0, replacement.start) + replacement.value + output.slice(replacement.end);
	}
	return output;
}

function referencesScopedVariable(source: string, variables: Record<string, ExprValue>): boolean {
	const names = new Set(Object.keys(variables));
	if (names.size === 0) return false;
	return tokenizeExpression(source).some(token => token.type === LexemeKind.Identifier && names.has(token.value));
}

function shouldDefer(value: string, ctx: ExprContext): boolean {
	return Boolean(ctx.deferredMarkdown) && RENDERABLE_MARKDOWN.test(value);
}

function defer(value: ExprValue, ctx: ExprContext): string {
	const store = ctx.deferredMarkdown;
	if (!store) return exprToString(value);
	const key = `${DEFERRED_PREFIX}${store.nextId++}`;
	store.values[key] = value;
	return `{{${key}}}`;
}
