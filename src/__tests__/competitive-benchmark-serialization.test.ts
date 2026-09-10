import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function benchmarkSource(): string {
	return readFileSync(resolve(process.cwd(), "scripts/competitive-benchmark.mjs"), "utf8");
}

describe("competitive benchmark serialization boundary", () => {
	it("keeps helper constants in the runInObsidian lexical scope", () => {
		const source = benchmarkSource();
		const functionStart = source.indexOf("function runInObsidian(options) {");
		const functionEnd = source.indexOf("\nfunction parseArgs", functionStart);

		expect(functionStart).toBeGreaterThanOrEqual(0);
		expect(functionEnd).toBeGreaterThan(functionStart);

		const body = source.slice(functionStart, functionEnd);
		const asyncStart = body.indexOf("void (async () => {");

		expect(asyncStart).toBeGreaterThan(0);

		for (const declaration of [
			'const ROOT = "__morphic_competitive_bench__";',
			'const CUSTOM_CLASS = "obsidian-custom-view-render";',
			'const PENDING_CLASS = "obsidian-custom-view-pending";',
		]) {
			const declarationIndex = body.indexOf(declaration);
			expect(declarationIndex).toBeGreaterThan(0);
			expect(declarationIndex).toBeLessThan(asyncStart);
		}

		const serializedAsyncBody = body.slice(asyncStart);
		expect(serializedAsyncBody).not.toContain('const ROOT = "__morphic_competitive_bench__";');
		expect(serializedAsyncBody).not.toContain('const CUSTOM_CLASS = "obsidian-custom-view-render";');
		expect(serializedAsyncBody).not.toContain('const PENDING_CLASS = "obsidian-custom-view-pending";');
	});

	it("uses runtime-loaded state rather than persisted enabled state for lifecycle timing", () => {
		const source = benchmarkSource();
		const functionStart = source.indexOf("function runInObsidian(options) {");
		const functionEnd = source.indexOf("\nfunction parseArgs", functionStart);
		const body = source.slice(functionStart, functionEnd);

		expect(source).toContain('const FIXTURE_ID = "morphic-vs-cv04-live-v3";');
		expect(source).toContain('const RESULT_KEY = "__morphicCompetitiveBenchmarkV3";');
		expect(source).toContain("if (result.schemaVersion !== 3)");
		expect(body).toContain("function isPluginLoaded(pluginId)");
		expect(body).toContain("const originalLoadedTarget = isPluginLoaded(options.pluginId);");
		expect(body).toContain("const originalLoadedOther = isPluginLoaded(options.otherPluginId);");
		expect(body).not.toContain("enabledPlugins?.has(options.pluginId)");
		expect(body).not.toContain("enabledPlugins?.has(options.otherPluginId)");

		for (const workload of ["benchmarkStartup", "benchmarkFirstRender", "benchmarkBasesCold"]) {
			const start = body.indexOf(`async function ${workload}()`);
			expect(start).toBeGreaterThanOrEqual(0);
			const next = body.indexOf("\n\tasync function ", start + 1);
			const section = body.slice(start, next < 0 ? body.length : next);
			expect(section).toContain("isPluginLoaded(options.pluginId)");
			expect(section).not.toContain("enabledPlugins");
		}
	});

	it("pins every Markdown navigation to Preview mode and records the boundary", () => {
		const source = benchmarkSource();
		const functionStart = source.indexOf("function runInObsidian(options) {");
		const functionEnd = source.indexOf("\nfunction parseArgs", functionStart);
		const body = source.slice(functionStart, functionEnd);

		expect(source).toContain('const MARKDOWN_MODE = "preview";');
		expect(source).toContain("markdownMode: MARKDOWN_MODE");
		expect(source).toContain('"markdownMode", "markdownSource", "markdownModeEnforcement"');
		expect(body).toContain('markdownMode: options.markdownMode');
		expect(body).toContain('markdownSource: false');
		expect(body).toContain('markdownModeEnforcement: "WorkspaceLeaf.setViewState"');
		expect(body).toContain("async function forceMarkdownMode(leaf)");
		expect(body).toContain("await leaf.setViewState({ ...current, state: { ...state, mode: options.markdownMode, source: false } });");
		expect(body).toContain("await leaf.openFile(file(name)); await forceMarkdownMode(leaf);");
		expect(body).toContain('leaf.view?.getState?.().mode !== options.markdownMode');
		expect(body).toContain("const originalViewState = originalLeaf?.getViewState?.() ?? null;");
		expect(body).toContain("await originalLeaf.setViewState(originalViewState);");
	});
	it("orders rapid currentness navigation as B then C without waiting for B custom output", () => {
		const source = benchmarkSource();
		const functionStart = source.indexOf("async function benchmarkCurrentness() {");
		const functionEnd = source.indexOf("\n\tasync function benchmarkResourceLifetime()", functionStart);

		expect(functionStart).toBeGreaterThanOrEqual(0);
		expect(functionEnd).toBeGreaterThan(functionStart);

		const section = source.slice(functionStart, functionEnd);
		const openB = section.indexOf('await leaf.openFile(b);');
		const openC = section.indexOf('await leaf.openFile(c);');

		expect(openB).toBeGreaterThanOrEqual(0);
		expect(openC).toBeGreaterThan(openB);
		expect(section).not.toContain("Promise.allSettled([pendingB, pendingC])");
		expect(section).not.toContain('await waitActive(text => text.includes("CURRENT C")');
		expect(section).toContain(
			'readyOverlay(leaf, `${ROOT}/Current-C.md`, text => text.includes("CURRENT C"))',
		);
	});

});
