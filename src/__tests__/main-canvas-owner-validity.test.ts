import { describe, expect, it } from "vitest";
import { TFile } from "obsidian";
import CustomViewsPlugin from "../main";
import { DEFAULT_SETTINGS } from "../settings";
import {
	RenderController,
	RenderScope,
	type RenderPreparationContext,
	type RenderTransaction,
} from "../core";

interface TestCanvasNode {
	file?: TFile;
	nodeEl?: HTMLElement;
}

interface TestCanvasInput {
	node: TestCanvasNode;
	file: TFile;
	container: HTMLElement;
	matchedConfig: null;
	isSchedulerCurrent: () => boolean;
	stateKey: string;
}

type CanvasPreparer = (
	owner: TestCanvasNode,
	input: TestCanvasInput,
	context: RenderPreparationContext,
) => Promise<RenderTransaction>;

type CanvasInputBuilder = (
	node: TestCanvasNode,
	isSchedulerCurrent?: () => boolean,
) => TestCanvasInput | null;

function createPlugin(): CustomViewsPlugin {
	const plugin = Object.create(CustomViewsPlugin.prototype) as CustomViewsPlugin;
	plugin.settings = {
		...DEFAULT_SETTINGS,
		enabled: false,
		workInCanvas: true,
	};
	const internals = plugin as unknown as {
		settingsVersion: number;
		nextScopeId: number;
		scopeIds: WeakMap<HTMLElement, string>;
	};
	internals.settingsVersion = 0;
	internals.nextScopeId = 0;
	internals.scopeIds = new WeakMap();
	return plugin;
}

function createNode(file: TFile) {
	const nodeEl = document.createElement("div");
	const container = document.createElement("div");
	container.className = "markdown-preview-view";
	nodeEl.appendChild(container);
	const node: TestCanvasNode = { file, nodeEl };
	return { node, nodeEl, container };
}

function getBuilder(plugin: CustomViewsPlugin): CanvasInputBuilder {
	return (
		plugin as unknown as { buildCanvasRenderInput: CanvasInputBuilder }
	).buildCanvasRenderInput.bind(plugin);
}

function getPreparer(plugin: CustomViewsPlugin): CanvasPreparer {
	return (
		plugin as unknown as { prepareCanvasRender: CanvasPreparer }
	).prepareCanvasRender.bind(plugin);
}

async function prepareNativeTransaction(
	plugin: CustomViewsPlugin,
	node: TestCanvasNode,
	isSchedulerCurrent: () => boolean = () => true,
) {
	const input = getBuilder(plugin)(node, isSchedulerCurrent);
	expect(input).not.toBeNull();
	const scope = new RenderScope();
	scope.load();
	const transaction = await getPreparer(plugin)(node, input as TestCanvasInput, {
		generation: 1,
		scope,
		signal: scope.signal,
	});
	return { input: input as TestCanvasInput, scope, transaction };
}

describe("production Canvas owner-state validation", () => {
	it("rejects a prepared transaction when its dirty-scheduler generation becomes stale", async () => {
		const plugin = createPlugin();
		const file = new TFile();
		file.path = "Canvas-A.md";
		let current = true;
		const { node } = createNode(file);
		const { scope, transaction } = await prepareNativeTransaction(plugin, node, () => current);

		expect(transaction.isValid?.()).toBe(true);
		current = false;
		expect(transaction.isValid?.()).toBe(false);
		scope.dispose();
	});

	it("rejects a prepared transaction when the node changes file", async () => {
		const plugin = createPlugin();
		const fileA = new TFile();
		fileA.path = "Canvas-A.md";
		const fileB = new TFile();
		fileB.path = "Canvas-B.md";
		const { node } = createNode(fileA);
		const { scope, transaction } = await prepareNativeTransaction(plugin, node);

		expect(transaction.isValid?.()).toBe(true);
		node.file = fileB;
		expect(transaction.isValid?.()).toBe(false);
		scope.dispose();
	});

	it("rejects a prepared transaction when Obsidian replaces the node preview container", async () => {
		const plugin = createPlugin();
		const file = new TFile();
		file.path = "Canvas-A.md";
		const { node, nodeEl, container } = createNode(file);
		const { scope, transaction } = await prepareNativeTransaction(plugin, node);

		expect(transaction.isValid?.()).toBe(true);
		const replacement = document.createElement("div");
		replacement.className = "markdown-preview-view";
		container.remove();
		nodeEl.appendChild(replacement);
		expect(transaction.isValid?.()).toBe(false);
		scope.dispose();
	});

	it("rejects a prepared transaction when the settings revision changes", async () => {
		const plugin = createPlugin();
		const file = new TFile();
		file.path = "Canvas-A.md";
		const { node } = createNode(file);
		const { scope, transaction } = await prepareNativeTransaction(plugin, node);

		expect(transaction.isValid?.()).toBe(true);
		(plugin as unknown as { settingsVersion: number }).settingsVersion = 1;
		expect(transaction.isValid?.()).toBe(false);
		scope.dispose();
	});

	it("makes scheduler invalidation win even when the Canvas state key is unchanged", async () => {
		const plugin = createPlugin();
		const file = new TFile();
		file.path = "Canvas-A.md";
		const { node } = createNode(file);
		let current = true;
		const buildInput = getBuilder(plugin);
		const input = buildInput(node, () => current);
		expect(input).not.toBeNull();
		const controller = new RenderController<TestCanvasInput>((next, context) =>
			getPreparer(plugin)(node, next, context)
		);

		const render = controller.render(input as TestCanvasInput, (input as TestCanvasInput).stateKey);
		current = false;

		expect((await render).status).toBe("stale");
		expect(controller.lastCommittedKey).toBeNull();
	});
});
