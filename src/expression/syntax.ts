export interface ExpressionPipeline {
	expression: string;
	pipeFilters: string | null;
}

export function isExpressionSyntax(source: string): boolean {
	let quote: string | undefined;
	for (let index = 0; index < source.length; index++) {
		const character = source[index];
		if (quote) {
			if (character === "\\") index++;
			else if (character === quote) quote = undefined;
			continue;
		}
		if (character === '"' || character === "'") {
			quote = character;
			continue;
		}
		if (character === "(") return true;
		if (character === "|") return false;
	}
	return /[+\-*/<>=!&|%]/.test(source);
}

export function splitExpressionPipeline(source: string): ExpressionPipeline {
	let quote: string | undefined;
	let depth = 0;

	for (let index = 0; index < source.length; index++) {
		const character = source[index];
		if (quote) {
			if (character === "\\") index++;
			else if (character === quote) quote = undefined;
			continue;
		}
		if (character === '"' || character === "'") {
			quote = character;
			continue;
		}
		if (character === "(" || character === "[") {
			depth++;
			continue;
		}
		if (character === ")" || character === "]") {
			depth = Math.max(0, depth - 1);
			continue;
		}
		if (character !== "|" || depth !== 0) continue;
		if (source[index + 1] === "|") {
			index++;
			continue;
		}
		return {
			expression: source.slice(0, index).trim(),
			pipeFilters: source.slice(index + 1).trim(),
		};
	}

	return { expression: source.trim(), pipeFilters: null };
}
