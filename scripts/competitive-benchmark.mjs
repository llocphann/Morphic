import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const CV_VERSION = "0.4.0";
const CV_SHA = "1d9f2e99c3bfcc82dd9d657ead65fffadbdac0f5";
const CV_RELEASE_MAIN_SHA256 = "7055eb74f42a2525e816945a212f89089909da4ef5aa6da1d5e41f67e8a8e998";
const FIXTURE_ID = "morphic-vs-cv04-live-v3";
const RESULT_KEY = "__morphicCompetitiveBenchmarkV3";
const MARKDOWN_MODE = "preview";

const [, , command, ...rest] = process.argv;
const args = parseArgs(rest);

if (command === "run") {
	await runCommand(args);
} else if (command === "compare") {
	compareCommand(args);
} else {
	usage();
	process.exitCode = 2;
}

async function runCommand(args) {
	const vault = required(args.vault, "--vault");
	const role = required(args.role, "--role");
	if (role !== "morphic" && role !== "custom-views") {
		throw new Error("--role must be morphic or custom-views");
	}
	const output = resolve(required(args.output, "--output"));
	const warmups = positiveInt(args.warmups, 20);
	const samples = positiveInt(args.samples, 100);
	const pluginId = role === "morphic" ? "morphic" : "custom-views";
	const otherPluginId = role === "morphic" ? "custom-views" : "morphic";
	const gitSha = role === "morphic" ? git("rev-parse", "HEAD") : CV_SHA;
	const expectedBundleSha = role === "morphic"
		? sha256File(resolve("main.js"))
		: CV_RELEASE_MAIN_SHA256;

	if (role === "morphic") {
		const branch = git("branch", "--show-current");
		if (branch !== "main") throw new Error(`Expected main, found ${branch}`);
		if (!existsSync(resolve("main.js"))) throw new Error("main.js is missing; run npm run build before the live benchmark");
	}

	const options = {
		role,
		pluginId,
		otherPluginId,
		gitSha,
		expectedBundleSha,
		cvVersion: CV_VERSION,
		cvSha: CV_SHA,
		fixtureId: FIXTURE_ID,
		markdownMode: MARKDOWN_MODE,
		warmups,
		samples,
		resultKey: RESULT_KEY,
	};
	const code = `(${runInObsidian.toString()})(${JSON.stringify(options)});`;
	obsidian(vault, ["eval", `code=${code}`], 60_000);

	let result = null;
	for (let attempt = 0; attempt < 1_800; attempt++) {
		await sleep(1_000);
		const poll = obsidian(
			vault,
			["eval", `code=JSON.stringify(window[${JSON.stringify(RESULT_KEY)}]??null)`],
			30_000,
		);
		const state = extractJson(poll);
		if (!state?.done) continue;
		if (state.error) throw new Error(`Obsidian benchmark failed: ${state.error}`);
		result = state.result;
		break;
	}
	if (!result) throw new Error("Obsidian benchmark timed out");
	if (result.schemaVersion !== 3) throw new Error("Unexpected benchmark result schema");
	if (result.environment.gitSha !== gitSha) throw new Error("Result SHA does not match requested target SHA");
	if (result.environment.bundleSha256 !== expectedBundleSha) {
		throw new Error(`Installed ${pluginId} main.js digest mismatch: expected ${expectedBundleSha}, got ${result.environment.bundleSha256}`);
	}
	if (result.environment.fixtureId !== FIXTURE_ID) throw new Error("Fixture identity mismatch");
	if (result.environment.markdownMode !== MARKDOWN_MODE || result.environment.markdownSource !== false) {
		throw new Error("Markdown benchmark mode was not pinned to Reading/Preview mode");
	}

	mkdirSync(dirname(output), { recursive: true });
	writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
	console.log(`MORPHIC_COMPETITIVE_RESULT ${JSON.stringify({ role, gitSha, bundleSha256: expectedBundleSha, output, cases: result.cases.length })}`);
}

function compareCommand(args) {
	const morphicPath = resolve(required(args.morphic, "--morphic"));
	const cvPath = resolve(required(args["custom-views"], "--custom-views"));
	const output = resolve(required(args.output, "--output"));
	const markdown = args.markdown ? resolve(args.markdown) : output.replace(/\.json$/i, ".md");
	const morphic = JSON.parse(readFileSync(morphicPath, "utf8"));
	const cv = JSON.parse(readFileSync(cvPath, "utf8"));
	validatePair(morphic, cv);

	const cvCases = new Map(cv.cases.map(item => [item.name, item]));
	const rows = [];
	let importantLosses = 0;
	for (const morphicCase of morphic.cases) {
		const cvCase = cvCases.get(morphicCase.name);
		if (!cvCase) throw new Error(`Custom Views result missing ${morphicCase.name}`);
		if (morphicCase.semanticChecksum !== cvCase.semanticChecksum) throw new Error(`${morphicCase.name}: semantic checksum mismatch`);
		const metricRows = compareCaseMetrics(morphicCase, cvCase);
		importantLosses += metricRows.filter(item => item.important && item.status === "loss").length;
		rows.push({
			name: morphicCase.name,
			scope: morphicCase.scope,
			semanticChecksum: morphicCase.semanticChecksum,
			metrics: metricRows,
			memory: {
				morphic: morphicCase.memory,
				customViews: cvCase.memory,
			},
		});
	}
	const summary = {
		status: importantLosses === 0 ? "NO_IMPORTANT_LOSSES_IN_THIS_RUN" : "IMPORTANT_LOSSES_PRESENT",
		importantLosses,
		fixtureId: morphic.environment.fixtureId,
		morphic: morphic.environment,
		customViews: cv.environment,
		warmups: morphic.warmups,
		samples: morphic.samples,
		rows,
	};
	mkdirSync(dirname(output), { recursive: true });
	writeFileSync(output, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
	writeFileSync(markdown, renderMarkdown(summary), "utf8");
	console.log(`MORPHIC_COMPETITIVE_COMPARISON ${JSON.stringify({ status: summary.status, importantLosses, output, markdown })}`);
	if (importantLosses > 0) process.exitCode = 1;
}

function compareCaseMetrics(morphicCase, cvCase) {
	const names = new Set([...Object.keys(morphicCase.metrics), ...Object.keys(cvCase.metrics)]);
	const important = new Set(morphicCase.importantMetrics ?? []);
	const rows = [];
	for (const metric of [...names].sort()) {
		const left = morphicCase.metrics[metric];
		const right = cvCase.metrics[metric];
		if (!left || !right) continue;
		for (const percentile of ["p50", "p95", "p99"]) {
			const morphicValue = left[percentile];
			const cvValue = right[percentile];
			if (!Number.isFinite(morphicValue) || !Number.isFinite(cvValue)) continue;
			const lowerIsBetter = morphicCase.metricDirection?.[metric] !== "higher";
			const ratioCvOverMorphic = morphicValue === 0 ? (cvValue === 0 ? 1 : Infinity) : cvValue / morphicValue;
			const status = lowerIsBetter
				? (morphicValue <= cvValue ? (morphicValue < cvValue ? "win" : "tie") : "loss")
				: (morphicValue >= cvValue ? (morphicValue > cvValue ? "win" : "tie") : "loss");
			rows.push({ metric, percentile, morphic: morphicValue, customViews: cvValue, ratioCvOverMorphic, status, important: important.has(metric) });
		}
	}
	return rows;
}

function validatePair(morphic, cv) {
	if (morphic.schemaVersion !== 3 || cv.schemaVersion !== 3) throw new Error("Comparison schema versions are invalid");
	if (morphic.role !== "morphic" || cv.role !== "custom-views") throw new Error("Comparison roles are invalid");
	if (morphic.environment.fixtureId !== cv.environment.fixtureId) throw new Error("Fixture IDs differ");
	if (morphic.environment.obsidianVersion !== cv.environment.obsidianVersion) throw new Error("Obsidian versions differ");
	for (const key of ["electronVersion", "chromeVersion", "nodeVersion", "platform", "arch", "logicalCpuCount", "markdownMode", "markdownSource", "markdownModeEnforcement"]) {
		if (morphic.environment[key] !== cv.environment[key]) throw new Error(`Environment mismatch for ${key}`);
	}
	if (morphic.environment.markdownMode !== MARKDOWN_MODE || morphic.environment.markdownSource !== false) throw new Error("Markdown mode is not the certified Preview boundary");
	if (morphic.warmups !== cv.warmups || morphic.samples !== cv.samples) throw new Error("Sampling configuration differs");
	if (cv.environment.gitSha !== CV_SHA) throw new Error("Custom Views source SHA is not the certified 0.4.0 baseline");
	if (cv.environment.bundleSha256 !== CV_RELEASE_MAIN_SHA256) throw new Error("Custom Views bundle is not the certified 0.4.0 release asset");
	if (morphic.cases.length !== cv.cases.length) throw new Error("Workload counts differ");
}

function renderMarkdown(summary) {
	const lines = [
		"# Morphic vs Custom Views 0.4.0 — live competitive benchmark",
		"",
		`Status: **${summary.status}**`,
		"",
		`- fixture: \`${summary.fixtureId}\``,
		`- Morphic: \`${summary.morphic.gitSha}\` (bundle \`${summary.morphic.bundleSha256}\`)`,
		`- Custom Views 0.4.0: \`${summary.customViews.gitSha}\` (bundle \`${summary.customViews.bundleSha256}\`)`,
		`- Obsidian: ${summary.morphic.obsidianVersion}; Electron: ${summary.morphic.electronVersion}; Node: ${summary.morphic.nodeVersion}`,
		`- Markdown boundary: ${summary.morphic.markdownMode} (source=${summary.morphic.markdownSource}) via ${summary.morphic.markdownModeEnforcement}`,
		`- sampling: ${summary.warmups} warmups + ${summary.samples} measured samples`,
		"",
		"Ratios are Custom Views / Morphic. For lower-is-better metrics, values >= 1 mean Morphic is at least as fast for that metric.",
		"",
		"| workload | metric | pct | Morphic | CV 0.4.0 | CV/Morphic | result | gate |",
		"| --- | --- | --- | ---: | ---: | ---: | --- | --- |",
	];
	for (const row of summary.rows) for (const metric of row.metrics) lines.push(`| ${row.name} | ${metric.metric} | ${metric.percentile} | ${fmt(metric.morphic)} | ${fmt(metric.customViews)} | ${fmt(metric.ratioCvOverMorphic)} | ${metric.status} | ${metric.important ? "important" : "observational"} |`);
	lines.push("", `Important losing metrics: **${summary.importantLosses}**`, "");
	return `${lines.join("\n")}\n`;
}

function runInObsidian(options) {
	const ROOT = "__morphic_competitive_bench__";
	const CUSTOM_CLASS = "obsidian-custom-view-render";
	const PENDING_CLASS = "obsidian-custom-view-pending";
	const state = window[options.resultKey] = { done: false, error: null, result: null };
	void (async () => {
		const originalLoadedTarget = isPluginLoaded(options.pluginId);
		const originalLoadedOther = isPluginLoaded(options.otherPluginId);
		const originalLeaf = app.workspace.activeLeaf;
		const originalViewState = originalLeaf?.getViewState?.() ?? null;
		let originalSettings = null;
		try {
			if (originalLoadedOther) await app.plugins.disablePlugin(options.otherPluginId);
			if (!isPluginLoaded(options.pluginId)) await app.plugins.enablePlugin(options.pluginId);
			let plugin = getPlugin();
			originalSettings = JSON.parse(JSON.stringify(plugin.settings ?? {}));
			await removeFixture();
			await createFixture();
			const bundleSha256 = await installedBundleSha(options.pluginId);
			if (bundleSha256 !== options.expectedBundleSha) throw new Error(`bundle digest mismatch: ${bundleSha256}`);

			const environment = {
				fixtureId: options.fixtureId,
				gitSha: options.gitSha,
				bundleSha256,
				pluginId: options.pluginId,
				pluginVersion: getPlugin().manifest?.version ?? "unknown",
				obsidianVersion: app.version ?? "unknown",
				electronVersion: process?.versions?.electron ?? "unknown",
				chromeVersion: process?.versions?.chrome ?? "unknown",
				nodeVersion: process?.versions?.node ?? "unknown",
				platform: process?.platform ?? "unknown",
				arch: process?.arch ?? "unknown",
				logicalCpuCount: navigator.hardwareConcurrency ?? 0,
				gcExposed: typeof globalThis.gc === "function",
				memoryKind: typeof process?.memoryUsage === "function" ? "electron-renderer-process.memoryUsage" : "performance.memory",
				runtimePluginState: "app.plugins.plugins",
				markdownMode: options.markdownMode,
				markdownSource: false,
				markdownModeEnforcement: "WorkspaceLeaf.setViewState",
			};
			const cases = [];
			cases.push(await benchmarkStartup());
			cases.push(await benchmarkFirstRender());
			cases.push(await benchmarkWarmRender());
			cases.push(await benchmarkRepeatedNavigation());
			cases.push(await benchmarkNoop());
			cases.push(await benchmarkMetadata());
			cases.push(await benchmarkBody());
			cases.push(await benchmarkLinked());
			cases.push(await benchmarkExpression());
			cases.push(await benchmarkLoop());
			cases.push(await benchmarkBasesCold());
			cases.push(await benchmarkBasesWarm());
			cases.push(await benchmarkFilterHeavy());
			for (const count of [1, 10, 50, 100]) cases.push(await benchmarkCanvasOpen(count));
			for (const count of [1, 10, 50, 100]) cases.push(await benchmarkCanvasActive(count));
			for (const count of [1, 10, 50, 100]) cases.push(await benchmarkCanvasIdle(count));
			cases.push(await benchmarkCurrentness());
			cases.push(await benchmarkResourceLifetime());

			state.result = { schemaVersion: 3, role: options.role, baseline: { customViewsVersion: options.cvVersion, customViewsSha: options.cvSha }, warmups: options.warmups, samples: options.samples, environment, cases };
		} finally {
			try {
				if (!isPluginLoaded(options.pluginId)) await app.plugins.enablePlugin(options.pluginId);
				const plugin = getPlugin();
				if (originalSettings) {
					plugin.settings = originalSettings;
					if (typeof plugin.saveSettings === "function") await plugin.saveSettings();
					else if (typeof plugin.saveData === "function") await plugin.saveData(originalSettings);
					plugin.refreshAllViews?.();
				}
				await removeFixture();
				if (originalLeaf && originalViewState) {
					await originalLeaf.setViewState(originalViewState);
					await drain();
				}
				if (!originalLoadedTarget && isPluginLoaded(options.pluginId)) await app.plugins.disablePlugin(options.pluginId);
				if (originalLoadedOther && !isPluginLoaded(options.otherPluginId)) await app.plugins.enablePlugin(options.otherPluginId);
				if (!originalLoadedOther && isPluginLoaded(options.otherPluginId)) await app.plugins.disablePlugin(options.otherPluginId);
			} catch (restoreError) {
				console.error("competitive benchmark restore failed", restoreError);
			}
		}
	})().then(() => { state.done = true; }).catch(error => {
		state.error = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : String(error);
		state.done = true;
	});

	function isPluginLoaded(pluginId) {
		return !!app.plugins.plugins[pluginId];
	}

	function getPlugin() {
		const plugin = app.plugins.plugins[options.pluginId];
		if (!plugin) throw new Error(`Plugin is not loaded: ${options.pluginId}`);
		return plugin;
	}

	async function installedBundleSha(pluginId) {
		const basePath = app.vault.adapter?.getBasePath?.() ?? app.vault.adapter?.basePath;
		if (!basePath) throw new Error("File-system vault path is unavailable; bundle identity cannot be certified");
		const fs = require("node:fs");
		const path = require("node:path");
		const crypto = require("node:crypto");
		const bytes = fs.readFileSync(path.join(basePath, ".obsidian", "plugins", pluginId, "main.js"));
		return crypto.createHash("sha256").update(bytes).digest("hex");
	}

	async function configure(template, bench, extra = {}) {
		const plugin = getPlugin();
		plugin.settings = { enabled: true, workInLivePreview: true, workInCanvas: !!extra.workInCanvas, editableContent: false, allowJavaScript: false, views: extra.views ?? [viewConfig(`bench-${bench}`, bench, template)] };
		if (typeof plugin.saveSettings === "function") await plugin.saveSettings();
		else await plugin.saveData(plugin.settings);
		plugin.refreshAllViews?.();
		await drain();
	}

	function viewConfig(id, bench, template) {
		return { id, name: id, rules: { type: "group", operator: "AND", conditions: [{ type: "filter", field: "bench", operator: "is", value: bench }] }, template, showNavigationBar: true };
	}

	async function benchmarkStartup() {
		await configure("<article>startup</article>", "startup");
		return runCase({ name: "startup-plugin-initialization", scope: "plugin-lifecycle", semantic: "Enable the target plugin from a runtime-unloaded state with the same persisted one-view benchmark settings and drain two animation frames.", importantMetrics: ["elapsedMs"], beforeSample: async () => { if (isPluginLoaded(options.pluginId)) await app.plugins.disablePlugin(options.pluginId); }, operation: async () => { await app.plugins.enablePlugin(options.pluginId); await drain(); }, verify: () => { if (!isPluginLoaded(options.pluginId)) throw new Error("plugin failed to enable"); } });
	}

	async function benchmarkFirstRender() {
		const expected = "FIRST First";
		await configure("<article>FIRST {{file.basename}}</article>", "first");
		return runCase({ name: "first-render-cold-plugin-runtime", scope: "end-to-end", semantic: "From a native reset note, runtime-unload and re-enable the plugin outside the timed region so product caches are cold, then open First.md in pinned Preview mode and wait for exact custom output.", importantMetrics: ["elapsedMs"], beforeSample: async () => { await openNative("Reset.md"); if (isPluginLoaded(options.pluginId)) await app.plugins.disablePlugin(options.pluginId); await app.plugins.enablePlugin(options.pluginId); await drain(); }, operation: () => openCustom("First.md", text => text.trim() === expected), verify: () => assertActiveCustom("First.md", text => text.trim() === expected) });
	}

	async function benchmarkWarmRender() {
		const expected = "WARM Warm";
		await configure("<article>WARM {{file.basename}}</article>", "warm");
		await openCustom("Warm.md", text => text.trim() === expected);
		return runCase({ name: "warm-render", scope: "end-to-end", semantic: "Reopen an already-rendered note in pinned Preview mode from a native reset note with plugin/compiler/data paths warm; wait for exact custom output.", importantMetrics: ["elapsedMs"], beforeSample: () => openNative("Reset.md"), operation: () => openCustom("Warm.md", text => text.trim() === expected), verify: () => assertActiveCustom("Warm.md", text => text.trim() === expected) });
	}

	async function benchmarkRepeatedNavigation() {
		await configure("<article>NAV {{file.basename}}</article>", "nav");
		let next = "Nav-A.md";
		await openCustom(next, text => text.includes("NAV Nav-A"));
		return runCase({ name: "repeated-navigation", scope: "end-to-end", semantic: "Alternate between two already-warm custom notes in the same pinned Preview leaf and wait until the current note's exact output is visible and not pending.", importantMetrics: ["elapsedMs"], operation: async () => { next = next === "Nav-A.md" ? "Nav-B.md" : "Nav-A.md"; await openCustom(next, text => text.includes(`NAV ${next.replace(/\.md$/, "")}`)); }, verify: () => assertActiveCustom(next, text => text.includes(`NAV ${next.replace(/\.md$/, "")}`)) });
	}

	async function benchmarkNoop() {
		await configure("<article>NOOP {{file.basename}}</article>", "noop");
		await openCustom("Noop.md", text => text.includes("NOOP Noop"));
		return runCase({ name: "unchanged-noop-update", scope: "end-to-end", semantic: "Request refreshAllViews with no semantic input changes and include scheduler/animation-frame drain in the timed boundary.", importantMetrics: ["elapsedMs"], operation: async () => { getPlugin().refreshAllViews?.(); await drain(); }, verify: () => assertActiveCustom("Noop.md", text => text.includes("NOOP Noop")) });
	}

	async function benchmarkMetadata() {
		await configure("<article>META {{status}}</article>", "metadata");
		let expected = "alpha";
		await setFrontmatter("Metadata.md", "status", expected);
		await openCustom("Metadata.md", text => text.includes(`META ${expected}`));
		return runCase({ name: "metadata-only-update", scope: "end-to-end", semantic: "In pinned Preview mode, toggle only the status frontmatter value through Obsidian fileManager.processFrontMatter and wait for exact refreshed output.", importantMetrics: ["elapsedMs"], operation: async () => { expected = expected === "alpha" ? "beta" : "alpha"; await setFrontmatter("Metadata.md", "status", expected); await waitActive(text => text.includes(`META ${expected}`)); }, verify: () => assertActiveCustom("Metadata.md", text => text.includes(`META ${expected}`)) });
	}

	async function benchmarkBody() {
		await configure("<article>{{content}}</article>", "body");
		const a = "A".repeat(64 * 1024);
		const b = "B".repeat(64 * 1024);
		let expected = a;
		await replaceBody("Body.md", expected);
		await openCustom("Body.md", text => text === expected);
		return runCase({ name: "body-heavy-update", scope: "end-to-end", semantic: "In pinned Preview mode, replace a 64 KiB note body A/B at equal byte size through app.vault.modify and wait until rendered text equals the current body byte-for-byte.", importantMetrics: ["elapsedMs"], operation: async () => { expected = expected === a ? b : a; await replaceBody("Body.md", expected); await waitActive(text => text === expected, 10_000); }, verify: () => assertActiveCustom("Body.md", text => text === expected) });
	}

	async function benchmarkLinked() {
		await configure("<article>LINK {{friend.status}}</article>", "linked");
		let expected = "linked-a";
		await setFrontmatter("Linked.md", "status", expected);
		await openCustom("Linked-Source.md", text => text.includes(`LINK ${expected}`));
		return runCase({ name: "linked-cross-file-update", scope: "end-to-end", semantic: "In pinned Preview mode, toggle only the linked note's status frontmatter and wait for the already-open source note to show the exact linked status.", importantMetrics: ["elapsedMs"], operation: async () => { expected = expected === "linked-a" ? "linked-b" : "linked-a"; await setFrontmatter("Linked.md", "status", expected); await waitActive(text => text.includes(`LINK ${expected}`)); }, verify: () => assertActiveCustom("Linked-Source.md", text => text.includes(`LINK ${expected}`)) });
	}

	async function benchmarkExpression() {
		const expressionCount = 64;
		const template = `<article>${Array.from({ length: expressionCount }, () => "{{ rating > 8 }}").join("")}</article>`;
		const expected = "true".repeat(expressionCount);
		await configure(template, "expression");
		await openCustom("Expression.md", text => text === expected);
		return runCase({ name: "expression-heavy-render", scope: "end-to-end", semantic: "Warm pinned-Preview navigation render containing 64 ordered rating > 8 expressions, with exact 64-true output verification.", importantMetrics: ["elapsedMs"], beforeSample: () => openNative("Reset.md"), operation: () => openCustom("Expression.md", text => text === expected), verify: () => assertActiveCustom("Expression.md", text => text === expected) });
	}

	async function benchmarkLoop() {
		const expected = Array.from({ length: 32 }, (_, index) => `item-${index}`).join("");
		await configure("<ul>{% for item in items %}<li>{{item}}</li>{% endfor %}</ul>", "loop");
		await openCustom("Loop.md", text => text === expected);
		return runCase({ name: "loop-heavy-render", scope: "end-to-end", semantic: "Warm pinned-Preview navigation render of a 32-item ordered template loop with exact concatenated item output verification.", importantMetrics: ["elapsedMs"], beforeSample: () => openNative("Reset.md"), operation: () => openCustom("Loop.md", text => text === expected), verify: () => assertActiveCustom("Loop.md", text => text === expected) });
	}

	async function benchmarkBasesCold() {
		const template = ["{% base \"Bench\" %}", '{"views":[{"type":"table","name":"Bench"}]}', "{% endbase %}", "<article>BASE {{bases[0].name}}</article>"].join("\n");
		await configure(template, "bases");
		return runCase({ name: "bases-cold", scope: "end-to-end", semantic: "Runtime-unload and re-enable the plugin outside timing to clear plugin-owned Bases caches, then open the same embedded Base template in pinned Preview mode and wait for normalized Bench view output.", importantMetrics: ["elapsedMs"], beforeSample: async () => { await openNative("Reset.md"); if (isPluginLoaded(options.pluginId)) await app.plugins.disablePlugin(options.pluginId); await app.plugins.enablePlugin(options.pluginId); await drain(); }, operation: () => openCustom("Bases.md", text => text.includes("BASE Bench"), 10_000), verify: () => assertActiveCustom("Bases.md", text => text.includes("BASE Bench")) });
	}

	async function benchmarkBasesWarm() {
		const template = ["{% base \"Bench\" %}", '{"views":[{"type":"table","name":"Bench"}]}', "{% endbase %}", "<article>BASE {{bases[0].name}}</article>"].join("\n");
		await configure(template, "bases");
		await openCustom("Bases.md", text => text.includes("BASE Bench"), 10_000);
		return runCase({ name: "bases-warm", scope: "end-to-end", semantic: "Revisit an identical embedded Base request in pinned Preview mode with plugin/provider caches warm and wait for the same normalized Bench view output.", importantMetrics: ["elapsedMs"], beforeSample: () => openNative("Reset.md"), operation: () => openCustom("Bases.md", text => text.includes("BASE Bench"), 10_000), verify: () => assertActiveCustom("Bases.md", text => text.includes("BASE Bench")) });
	}

	async function benchmarkFilterHeavy() {
		const views = Array.from({ length: 64 }, (_, index) => viewConfig(`miss-${index}`, `miss-${index}`, `<article>MISS ${index}</article>`));
		views.push(viewConfig("filter-hit", "filter-target", "<article>FILTER HIT</article>"));
		await configure("", "filter-target", { views });
		return runCase({ name: "filter-heavy-view-matching", scope: "end-to-end", semantic: "Navigate in pinned Preview mode to a note that matches only the final view after 64 semantically valid nonmatching view rules; wait for exact FILTER HIT output.", importantMetrics: ["elapsedMs"], beforeSample: () => openNative("Reset.md"), operation: () => openCustom("Filter.md", text => text.includes("FILTER HIT")), verify: () => assertActiveCustom("Filter.md", text => text.includes("FILTER HIT")) });
	}

	async function benchmarkCanvasOpen(count) {
		await configure("<article>CANVAS {{status}}</article>", "canvas", { workInCanvas: true });
		return runCase({ name: `canvas-open-${count}`, scope: "end-to-end", semantic: `Open a real Obsidian .canvas containing ${count} file nodes pointing at the same matching note and wait until all ${count} custom overlays are current and non-pending.`, importantMetrics: ["elapsedMs"], beforeSample: () => openNative("Reset.md"), operation: () => openCanvas(count, "alpha"), verify: () => assertCanvas(count, "alpha") });
	}

	async function benchmarkCanvasActive(count) {
		await configure("<article>CANVAS {{status}}</article>", "canvas", { workInCanvas: true });
		let expected = "alpha";
		await setFrontmatter("Canvas-Target.md", "status", expected);
		await openCanvas(count, expected);
		return runCase({ name: `canvas-active-update-${count}`, scope: "end-to-end", semantic: `With a real ${count}-node Canvas already rendered, toggle only target frontmatter status and wait until every custom node shows the exact current value.`, importantMetrics: ["elapsedMs"], operation: async () => { expected = expected === "alpha" ? "beta" : "alpha"; await setFrontmatter("Canvas-Target.md", "status", expected); await waitCanvas(count, expected, 10_000); }, verify: () => assertCanvas(count, expected) });
	}

	async function benchmarkCanvasIdle(count) {
		await configure("<article>CANVAS {{status}}</article>", "canvas", { workInCanvas: true });
		await setFrontmatter("Canvas-Target.md", "status", "alpha");
		await openCanvas(count, "alpha");
		return runCase({ name: `canvas-idle-${count}`, scope: "idle-work", semantic: `Observe a steady real ${count}-node Canvas for 100 ms with no semantic input changes; wall time is intentionally non-gating while renderer CPU and DOM mutations are measured.`, importantMetrics: ["domMutations"], operation: async () => { let mutations = 0; const root = app.workspace.activeLeaf?.view?.containerEl ?? document.body; const observer = new MutationObserver(records => { mutations += records.length; }); observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true }); await sleepInApp(100); observer.disconnect(); return { domMutations: mutations }; }, verify: () => assertCanvas(count, "alpha") });
	}

	async function benchmarkCurrentness() {
		const heavy = `<article>${Array.from({ length: 384 }, () => "{{ rating > 8 }}").join("")}</article>`;
		const views = [viewConfig("current-a", "current-a", "<article>CURRENT A</article>"), viewConfig("current-b", "current-b", heavy), viewConfig("current-c", "current-c", "<article>CURRENT C</article>")];
		await configure("", "current-a", { views });
		return runCase({ name: "rapid-navigation-currentness", scope: "end-to-end", semantic: "Complete the leaf navigation transition from A to heavy B without waiting for B custom output, immediately navigate the same pinned Preview leaf to C, then require C to become current and remain current after two animation frames; stale B commits are failures.", importantMetrics: ["elapsedMs"], beforeSample: () => openCustom("Current-A.md", text => text.includes("CURRENT A")), operation: async () => { const leaf = app.workspace.getLeaf(false); const b = file("Current-B.md"); const c = file("Current-C.md"); await leaf.openFile(b); await forceMarkdownMode(leaf); await leaf.openFile(c); await forceMarkdownMode(leaf); await waitUntil(() => readyOverlay(leaf, `${ROOT}/Current-C.md`, text => text.includes("CURRENT C")), 10_000, "custom Current-C.md"); await drain(); }, verify: () => assertActiveCustom("Current-C.md", text => text.includes("CURRENT C")) });
	}

	async function benchmarkResourceLifetime() {
		await configure("<article>RESOURCE {{file.basename}}</article>", "resource");
		return runCase({ name: "memory-resource-lifetime", scope: "resource", semantic: "Perform 20 pinned-Preview reset/custom navigation cycles per sample in one leaf, ending on native Reset; report wall/CPU plus per-sample heap/RSS delta when the Electron renderer exposes process.memoryUsage.", importantMetrics: typeof globalThis.gc === "function" ? ["elapsedMs", "heapDeltaBytes", "rssDeltaBytes"] : ["elapsedMs"], operation: async () => { const before = memorySnapshot(); for (let index = 0; index < 20; index++) { await openCustom("Resource.md", text => text.includes("RESOURCE Resource")); await openNative("Reset.md"); } if (typeof globalThis.gc === "function") globalThis.gc(); const after = memorySnapshot(); return { heapDeltaBytes: after.heapUsedBytes - before.heapUsedBytes, rssDeltaBytes: after.rssBytes - before.rssBytes }; }, verify: () => { if (app.workspace.getActiveFile()?.path !== `${ROOT}/Reset.md`) throw new Error("resource lifetime sample did not return to Reset.md"); } });
	}

	async function runCase(definition) {
		const warmups = options.warmups;
		const samples = options.samples;
		for (let index = 0; index < warmups; index++) { await definition.beforeSample?.({ phase: "warmup", index }); await definition.operation({ phase: "warmup", index }); await definition.verify?.({ phase: "warmup", index }); await definition.afterSample?.({ phase: "warmup", index }); }
		if (typeof globalThis.gc === "function") globalThis.gc();
		const memoryBefore = memorySnapshot();
		let memoryPeak = memoryBefore;
		const samplesOut = [];
		const extra = {};
		for (let index = 0; index < samples; index++) {
			await definition.beforeSample?.({ phase: "measured", index });
			const cpuBefore = cpuSnapshot();
			const start = performance.now();
			const returned = await definition.operation({ phase: "measured", index });
			const elapsedMs = performance.now() - start;
			const cpuAfter = cpuSnapshot(cpuBefore);
			await definition.verify?.({ phase: "measured", index });
			await definition.afterSample?.({ phase: "measured", index });
			const memory = memorySnapshot();
			memoryPeak = maxMemory(memoryPeak, memory);
			const sample = { elapsedMs, ...cpuAfter };
			if (returned && typeof returned === "object") for (const [key, value] of Object.entries(returned)) if (Number.isFinite(value)) { (extra[key] ??= []).push(value); sample[key] = value; }
			samplesOut.push(sample);
		}
		if (typeof globalThis.gc === "function") globalThis.gc();
		const memoryAfter = memorySnapshot();
		const metrics = { elapsedMs: summarize(samplesOut.map(item => item.elapsedMs)) };
		if (samplesOut.every(item => Number.isFinite(item.cpuUserUs))) metrics.cpuUserUs = summarize(samplesOut.map(item => item.cpuUserUs));
		if (samplesOut.every(item => Number.isFinite(item.cpuSystemUs))) metrics.cpuSystemUs = summarize(samplesOut.map(item => item.cpuSystemUs));
		for (const [key, values] of Object.entries(extra)) metrics[key] = summarize(values);
		return { name: definition.name, scope: definition.scope, semanticContract: definition.semantic, semanticChecksum: fnv1a(definition.semantic), importantMetrics: definition.importantMetrics ?? ["elapsedMs"], metricDirection: definition.metricDirection ?? {}, metrics, memory: { before: memoryBefore, after: memoryAfter, peak: memoryPeak, delta: memoryDelta(memoryBefore, memoryAfter) }, rawSamples: samplesOut };
	}

	async function createFixture() {
		await ensureFolder(ROOT);
		const notes = {
			"Reset.md": note({}, "native reset"),
			"First.md": note({ bench: "first" }, "first"),
			"Warm.md": note({ bench: "warm" }, "warm"),
			"Nav-A.md": note({ bench: "nav" }, "nav a"),
			"Nav-B.md": note({ bench: "nav" }, "nav b"),
			"Noop.md": note({ bench: "noop" }, "noop"),
			"Metadata.md": note({ bench: "metadata", status: "alpha" }, "metadata"),
			"Body.md": note({ bench: "body" }, "A".repeat(64 * 1024)),
			"Linked.md": note({ status: "linked-a" }, "linked"),
			"Linked-Source.md": note({ bench: "linked", friend: `[[${ROOT}/Linked]]` }, "source"),
			"Expression.md": note({ bench: "expression", rating: 9 }, "expression"),
			"Loop.md": note({ bench: "loop", items: Array.from({ length: 32 }, (_, index) => `item-${index}`) }, "loop"),
			"Bases.md": note({ bench: "bases" }, "bases"),
			"Filter.md": note({ bench: "filter-target" }, "filter"),
			"Canvas-Target.md": note({ bench: "canvas", status: "alpha" }, "canvas"),
			"Current-A.md": note({ bench: "current-a", rating: 9 }, "current a"),
			"Current-B.md": note({ bench: "current-b", rating: 9 }, "current b"),
			"Current-C.md": note({ bench: "current-c", rating: 9 }, "current c"),
			"Resource.md": note({ bench: "resource" }, "resource"),
		};
		for (const [name, content] of Object.entries(notes)) await writeVaultFile(`${ROOT}/${name}`, content);
		for (const count of [1, 10, 50, 100]) await writeVaultFile(`${ROOT}/Canvas-${count}.canvas`, JSON.stringify(canvasDocument(count)));
		await drain();
	}

	function canvasDocument(count) {
		return { nodes: Array.from({ length: count }, (_, index) => ({ id: `node-${index}`, type: "file", file: `${ROOT}/Canvas-Target.md`, x: (index % 10) * 420, y: Math.floor(index / 10) * 320, width: 400, height: 280 })), edges: [] };
	}

	function note(frontmatter, body) {
		const lines = ["---"];
		for (const [key, value] of Object.entries(frontmatter)) {
			if (Array.isArray(value)) { lines.push(`${key}:`); for (const item of value) lines.push(`  - ${yamlScalar(item)}`); }
			else lines.push(`${key}: ${yamlScalar(value)}`);
		}
		lines.push("---", body);
		return lines.join("\n");
	}

	function yamlScalar(value) { if (typeof value === "number" || typeof value === "boolean") return String(value); return JSON.stringify(String(value)); }

	async function writeVaultFile(path, content) {
		const existing = app.vault.getAbstractFileByPath(path);
		if (existing && existing.extension !== undefined) { await app.vault.modify(existing, content); return existing; }
		const parent = path.split("/").slice(0, -1).join("/");
		if (parent) await ensureFolder(parent);
		return app.vault.create(path, content);
	}

	async function ensureFolder(path) {
		const parts = path.split("/"); let current = "";
		for (const part of parts) { current = current ? `${current}/${part}` : part; if (!app.vault.getAbstractFileByPath(current)) await app.vault.createFolder(current); }
	}

	async function removeFixture() { const folder = app.vault.getAbstractFileByPath(ROOT); if (folder) await app.vault.delete(folder, true); await drain(); }
	function file(name) { const target = app.vault.getAbstractFileByPath(`${ROOT}/${name}`); if (!target || target.extension === undefined) throw new Error(`Missing fixture file: ${name}`); return target; }

	async function forceMarkdownMode(leaf) {
		const current = leaf.getViewState?.();
		if (!current || current.type !== "markdown") throw new Error(`Expected markdown leaf while pinning ${options.markdownMode}`);
		const state = current.state ?? {};
		if (state.mode === options.markdownMode && state.source === false) return;
		await leaf.setViewState({ ...current, state: { ...state, mode: options.markdownMode, source: false } });
		await waitUntil(
			() => leaf.view?.getViewType?.() === "markdown" && leaf.view?.getState?.().mode === options.markdownMode,
			5_000,
			`markdown ${options.markdownMode}`,
		);
	}

	async function openNative(name) {
		const leaf = app.workspace.getLeaf(false); await leaf.openFile(file(name)); await forceMarkdownMode(leaf);
		await waitUntil(() => app.workspace.getActiveFile()?.path === `${ROOT}/${name}` && leaf.view?.getState?.().mode === options.markdownMode && !leaf.view?.contentEl?.querySelector?.(`.${CUSTOM_CLASS}`), 5_000, `native ${name}`);
	}

	async function openCustom(name, predicate, timeout = 5_000) { const leaf = app.workspace.getLeaf(false); await leaf.openFile(file(name)); await forceMarkdownMode(leaf); await waitUntil(() => readyOverlay(leaf, `${ROOT}/${name}`, predicate), timeout, `custom ${name}`); }

	function readyOverlay(leaf, path, predicate) {
		if (leaf.view?.file?.path !== path) return false;
		if (leaf.view?.getViewType?.() !== "markdown" || leaf.view?.getState?.().mode !== options.markdownMode) return false;
		const content = leaf.view?.contentEl; if (!content?.querySelector) return false;
		const overlay = content.querySelector(`.${CUSTOM_CLASS}`); if (!overlay || overlay.classList.contains(PENDING_CLASS)) return false;
		const held = document.documentElement.hasAttribute("data-cv-navigation-held") || document.querySelector(".cv-navigation-snapshot"); if (held) return false;
		const pathAttr = content.getAttribute("data-cv-file-path"); if (pathAttr && pathAttr !== path) return false;
		return predicate(overlay.textContent ?? "");
	}

	async function waitActive(predicate, timeout = 5_000) { const leaf = app.workspace.getLeaf(false); const activePath = app.workspace.getActiveFile()?.path; if (!activePath) throw new Error("No active file"); await waitUntil(() => readyOverlay(leaf, activePath, predicate), timeout, `active custom ${activePath}`); }
	function assertActiveCustom(name, predicate) { const leaf = app.workspace.getLeaf(false); if (!readyOverlay(leaf, `${ROOT}/${name}`, predicate)) throw new Error(`Active custom output is not current for ${name}`); }

	async function openCanvas(count, expected) { const leaf = app.workspace.getLeaf(false); await leaf.openFile(file(`Canvas-${count}.canvas`)); await waitCanvas(count, expected, 15_000); }
	async function waitCanvas(count, expected, timeout) { await waitUntil(() => canvasState(count, expected), timeout, `canvas ${count} ${expected}`); }
	function assertCanvas(count, expected) { if (!canvasState(count, expected)) throw new Error(`Canvas ${count} is not current for ${expected}`); }
	function canvasState(count, expected) { const leaf = app.workspace.getLeaf(false); if (leaf.view?.file?.path !== `${ROOT}/Canvas-${count}.canvas`) return false; const content = leaf.view?.containerEl ?? leaf.view?.contentEl; if (!content?.querySelectorAll) return false; const overlays = [...content.querySelectorAll(`.${CUSTOM_CLASS}`)].filter(el => !el.classList.contains(PENDING_CLASS)); return overlays.length === count && overlays.every(el => (el.textContent ?? "").includes(`CANVAS ${expected}`)); }

	async function setFrontmatter(name, key, value) { await app.fileManager.processFrontMatter(file(name), frontmatter => { frontmatter[key] = value; }); }
	async function replaceBody(name, body) { const target = file(name); const current = await app.vault.read(target); const match = current.match(/^---\n[\s\S]*?\n---\n?/); const prefix = match ? match[0] : ""; await app.vault.modify(target, `${prefix}${body}`); }

	async function waitUntil(check, timeout, label) { const start = performance.now(); while (performance.now() - start < timeout) { if (check()) return; await frame(); } throw new Error(`Timed out waiting for ${label}`); }
	async function drain() { await Promise.resolve(); await sleepInApp(0); await frame(); await frame(); }
	function frame() { return new Promise(resolve => requestAnimationFrame(() => resolve())); }
	function sleepInApp(ms) { return new Promise(resolve => window.setTimeout(resolve, ms)); }

	function cpuSnapshot(previous) { if (typeof process?.cpuUsage !== "function") return { cpuUserUs: NaN, cpuSystemUs: NaN }; const value = previous ? process.cpuUsage(previous.raw) : process.cpuUsage(); if (!previous) return { raw: value }; return { cpuUserUs: value.user, cpuSystemUs: value.system }; }
	function memorySnapshot() { if (typeof process?.memoryUsage === "function") { const memory = process.memoryUsage(); return { heapUsedBytes: memory.heapUsed ?? 0, rssBytes: memory.rss ?? 0, externalBytes: memory.external ?? 0, arrayBuffersBytes: memory.arrayBuffers ?? 0 }; } const memory = performance.memory; return { heapUsedBytes: memory?.usedJSHeapSize ?? 0, rssBytes: 0, externalBytes: 0, arrayBuffersBytes: 0 }; }
	function maxMemory(a, b) { return { heapUsedBytes: Math.max(a.heapUsedBytes, b.heapUsedBytes), rssBytes: Math.max(a.rssBytes, b.rssBytes), externalBytes: Math.max(a.externalBytes, b.externalBytes), arrayBuffersBytes: Math.max(a.arrayBuffersBytes, b.arrayBuffersBytes) }; }
	function memoryDelta(a, b) { return { heapUsedBytes: b.heapUsedBytes - a.heapUsedBytes, rssBytes: b.rssBytes - a.rssBytes, externalBytes: b.externalBytes - a.externalBytes, arrayBuffersBytes: b.arrayBuffersBytes - a.arrayBuffersBytes }; }
	function summarize(values) { if (!values.length || values.some(value => !Number.isFinite(value))) throw new Error("Invalid benchmark distribution"); const sorted = [...values].sort((a, b) => a - b); const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length; return { min: sorted[0], p50: nearest(sorted, 0.50), p95: nearest(sorted, 0.95), p99: nearest(sorted, 0.99), max: sorted[sorted.length - 1], mean }; }
	function nearest(sorted, q) { return sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1))]; }
	function fnv1a(value) { let hash = 0x811c9dc5; for (let index = 0; index < value.length; index++) { hash ^= value.charCodeAt(index); hash = Math.imul(hash, 0x01000193) >>> 0; } return `fnv1a32:${hash.toString(16).padStart(8, "0")}`; }
}

function parseArgs(values) {
	const result = {};
	for (let index = 0; index < values.length; index++) {
		const value = values[index]; if (!value.startsWith("--")) throw new Error(`Unexpected argument: ${value}`);
		const [rawKey, inlineValue] = value.slice(2).split("=", 2);
		if (inlineValue !== undefined) result[rawKey] = inlineValue;
		else if (values[index + 1] && !values[index + 1].startsWith("--")) result[rawKey] = values[++index];
		else result[rawKey] = true;
	}
	return result;
}

function required(value, flag) { if (!value || value === true) throw new Error(`${flag} is required`); return String(value); }
function positiveInt(value, fallback) { if (value === undefined) return fallback; const parsed = Number(value); if (!Number.isInteger(parsed) || parsed <= 0) throw new Error("sample counts must be positive integers"); return parsed; }
function git(...args) { return execFileSync("git", args, { encoding: "utf8" }).trim(); }
function obsidian(vault, args, timeout) { return execFileSync("obsidian", [`vault=${vault}`, ...args], { encoding: "utf8", timeout }); }
function extractJson(text) { const first = text.indexOf("{"); const last = text.lastIndexOf("}"); if (first < 0 || last < first) return null; return JSON.parse(text.slice(first, last + 1)); }
function sha256File(path) { if (!existsSync(path)) throw new Error(`Missing file for digest: ${path}`); return createHash("sha256").update(readFileSync(path)).digest("hex"); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function fmt(value) { if (!Number.isFinite(value)) return "N/A"; if (Math.abs(value) >= 1000) return value.toFixed(1); return value.toFixed(3); }
function usage() { console.error(["Usage:", "  node scripts/competitive-benchmark.mjs run --vault <name> --role morphic|custom-views --output <result.json> [--warmups 20 --samples 100]", "  node scripts/competitive-benchmark.mjs compare --morphic <morphic.json> --custom-views <cv.json> --output <summary.json> [--markdown <summary.md>]"].join("\n")); }
