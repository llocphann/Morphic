import { applyFilterChain } from "./filters";
import type { ExprContext, ExprValue } from "./expression/model";
import { parseExpressionSource } from "./expression/parser";
import { evaluateNode } from "./expression/compat-runtime";
import { splitExpressionPipeline } from "./expression/syntax";

export * from "./expression/model";
export { tokenizeExpression as tokenize } from "./expression/lexer";
export { parseExpressionSource as parseExpression } from "./expression/parser";
export { evaluateNode as evaluate } from "./expression/compat-runtime";
export { processLogic as processLogicBlocks } from "./expression/logic";
export { resolveDeferredMarkdown as resolveDeferredMarkdownPlaceholder } from "./expression/logic";
export { isExpressionSyntax as isExpressionMode } from "./expression/syntax";
export { splitExpressionPipeline as splitExpressionAndPipes } from "./expression/syntax";

export async function evaluateExpression(source: string, ctx: ExprContext): Promise<ExprValue> {
	const pipeline = splitExpressionPipeline(source);
	try {
		let value = await evaluateNode(parseExpressionSource(pipeline.expression), ctx);
		if (pipeline.pipeFilters) {
			value = applyFilterChain(
				value as Parameters<typeof applyFilterChain>[0],
				pipeline.pipeFilters,
			);
		}
		return value;
	} catch (error) {
		console.error("[Morphic] expression evaluation failed:", error);
		return null;
	}
}
