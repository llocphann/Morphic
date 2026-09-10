export type FilterArgument = string | number;

export interface CompiledFilterStep {
	readonly name: string;
	readonly args: readonly FilterArgument[];
	readonly source: string;
}

/**
 * Immutable parse result for a legacy pipe filter chain.
 *
 * Execution can consume these pre-parsed steps directly so warm evaluation does
 * not rescan quote/pipe/comma syntax. Parsing intentionally mirrors the legacy
 * `applyFilterChain()` quirks unless a compatibility change is documented.
 */
export interface CompiledFilterPipeline {
	readonly source: string;
	readonly steps: readonly CompiledFilterStep[];
}

export function compileFilterPipeline(source: string | null | undefined): CompiledFilterPipeline {
	const normalizedSource = source ?? "";
	const rawSteps = splitPipeline(normalizedSource);
	return {
		source: normalizedSource,
		steps: rawSteps.flatMap((step) => {
			const parsed = compileStep(step);
			return parsed ? [parsed] : [];
		}),
	};
}

function splitPipeline(source: string): string[] {
	const steps: string[] = [];
	let current = "";
	let quoteChar: string | null = null;

	for (let i = 0; i < source.length; i++) {
		const char = source[i];
		if (char === '"' || char === "'") {
			if (quoteChar === char) quoteChar = null;
			else if (!quoteChar) quoteChar = char;
		}

		if (char === "|" && !quoteChar) {
			steps.push(current.trim());
			current = "";
		} else {
			current += char;
		}
	}
	if (current) steps.push(current.trim());
	return steps;
}

function compileStep(source: string): CompiledFilterStep | null {
	const trimmed = source.trim();
	if (!trimmed) return null;

	// Legacy applyFilterChain() uses the first colon and does not trim the name
	// substring after the outer step itself has been trimmed. Preserve that exact
	// lookup behavior so `replace :...` remains an unknown filter instead of
	// silently changing semantics during compilation.
	const colonIndex = trimmed.indexOf(":");
	const name = colonIndex >= 0 ? trimmed.slice(0, colonIndex) : trimmed;
	const args = colonIndex >= 0 ? parseArguments(trimmed.slice(colonIndex + 1)) : [];
	return { name, args, source: trimmed };
}

function parseArguments(source: string): FilterArgument[] {
	if (!source) return [];
	const content = source.trim().replace(/^\((.*)\)$/, "$1");
	const args: FilterArgument[] = [];
	let current = "";
	let quoteChar: string | null = null;

	for (let i = 0; i < content.length; i++) {
		const char = content[i];
		if (char === '"' || char === "'") {
			if (quoteChar === char) quoteChar = null;
			else if (!quoteChar) quoteChar = char;
		} else if (char === "," && !quoteChar) {
			args.push(cleanArgument(current));
			current = "";
			continue;
		}
		current += char;
	}
	if (current) args.push(cleanArgument(current));
	return args;
}

function cleanArgument(source: string): FilterArgument {
	const trimmed = source.trim();
	if (
		(trimmed.startsWith('"') && trimmed.endsWith('"'))
		|| (trimmed.startsWith("'") && trimmed.endsWith("'"))
	) {
		return trimmed.slice(1, -1);
	}
	if (!isNaN(Number(trimmed))) return Number(trimmed);
	return trimmed;
}
