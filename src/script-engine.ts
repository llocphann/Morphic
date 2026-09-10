import type { App, TFile } from "obsidian";
import type { ViewConfig } from "./types";

export interface CustomViewScriptContext {
	app: App;
	file: TFile;
	container: HTMLElement;
	frontmatter: Record<string, unknown> | undefined;
	bodyContent: string;
	viewConfig: ViewConfig | undefined;
	activeDocument: Document;
	activeWindow: Window;
}

type CompiledScript = (tp: CustomViewScriptContext) => Promise<unknown>;
type AsyncFunctionConstructor = new (...args: string[]) => CompiledScript;

const AsyncFunction = (async function () { /* noop */ }).constructor as unknown as AsyncFunctionConstructor;
const compiledScripts = new Map<string, CompiledScript>();
const MAX_COMPILED_SCRIPTS = 128;

/**
 * Execute user-authored local view JavaScript without a WASM templating layer.
 * The script runs with the rendered container as `this` and receives the same
 * `tp` context object as before.
 */
export async function executeCustomViewJavaScript(
	code: string,
	context: CustomViewScriptContext,
): Promise<void> {
	const script = getCompiledScript(code);
	await script(context);
}

/**
 * Kept temporarily as a compatibility no-op while the old plugin lifecycle is
 * being replaced. The v2 core has no script engine to warm.
 */
export async function warmCustomViewScriptEngine(): Promise<void> {
	return Promise.resolve();
}

export function clearCompiledScriptCache(): void {
	compiledScripts.clear();
}

function getCompiledScript(code: string): CompiledScript {
	let compiled = compiledScripts.get(code);
	if (compiled) {
		compiledScripts.delete(code);
		compiledScripts.set(code, compiled);
		return compiled;
	}

	compiled = new AsyncFunction(
		"tp",
		`return await (async function () {\n${code}\n}).call(tp.container);`,
	);
	compiledScripts.set(code, compiled);

	while (compiledScripts.size > MAX_COMPILED_SCRIPTS) {
		const oldest = compiledScripts.keys().next().value as string | undefined;
		if (oldest === undefined) break;
		compiledScripts.delete(oldest);
	}

	return compiled;
}
