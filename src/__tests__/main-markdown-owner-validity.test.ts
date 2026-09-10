import { describe, expect, it } from "vitest";
import { MarkdownView, TFile } from "obsidian";
import CustomViewsPlugin from "../main";
import { DEFAULT_SETTINGS } from "../settings";
import {
	RenderController,
	RenderScope,
	type RenderPreparationContext,
	type RenderTransaction,
} from "../core";

interface TestMarkdownInput {
	view: MarkdownView;
	file: TFile;
	matchedConfig: null;
	mode: "preview" | "source" | "livepreview";
	stateKey: string;
	sourceContent?: string;
}

interface MutableMarkdownView extends MarkdownView {
	file: TFile | null;
	contentEl: HTMLElement;
}

type MarkdownPreparer = (
	owner: MarkdownView,
	input: TestMarkdownInput,
	context: RenderPreparationContext,
) => Promise<RenderTransaction>;

function createPlugin(): CustomViewsPlugin {
	const plugin = Object.create(CustomViewsPlugin.prototype) as CustomViewsPlugin;
	plugin.settings = { ...DEFAULT_SETTINGS, enabled: false };
	(plugin as unknown as { settingsVersion: number }).settingsVersion = 0;
	return plugin;
}

function createView(file: TFile): MutableMarkdownView {
	const view = Object.create(MarkdownView.prototype) as MutableMarkdownView;
	view.file = file;
	view.contentEl = document.createElement("div");
	return view;
}

function getPreparer(plugin: CustomViewsPlugin): MarkdownPreparer {
	return (
		plugin as unknown as { prepareMarkdownRender: MarkdownPreparer }
	).prepareMarkdownRender.bind(plugin);
}

describe("production Markdown owner-state validation", () => {
	it("rejects a prepared transaction if the MarkdownView navigates before commit", async () => {
		const plugin = createPlugin();
		const fileA = new TFile();
		fileA.path = "A.md";
		const fileB = new TFile();
		fileB.path = "B.md";
		const view = createView(fileA);
		const prepareMarkdownRender = getPreparer(plugin);
		const controller = new RenderController<TestMarkdownInput>((input, context) =>
			prepareMarkdownRender(view, input, context)
		);

		const render = controller.render({
			view,
			file: fileA,
			matchedConfig: null,
			mode: "preview",
			stateKey: "A.md::none::preview::0",
		}, "A.md::none::preview::0");

		view.file = fileB;

		expect((await render).status).toBe("stale");
		expect(controller.lastCommittedKey).toBeNull();
	});

	it("rejects a prepared transaction if the owner mode changes before commit", async () => {
		const plugin = createPlugin();
		const fileA = new TFile();
		fileA.path = "A.md";
		const view = createView(fileA);
		let mode: "preview" | "source" = "preview";
		(view as unknown as { getState: () => { mode: string; source: boolean } }).getState = () => ({
			mode,
			source: mode === "source",
		});

		const scope = new RenderScope();
		scope.load();
		const transaction = await getPreparer(plugin)(view, {
			view,
			file: fileA,
			matchedConfig: null,
			mode: "preview",
			stateKey: "A.md::none::preview::0",
		}, {
			generation: 1,
			scope,
			signal: scope.signal,
		});

		expect(transaction.isValid?.()).toBe(true);
		mode = "source";
		expect(transaction.isValid?.()).toBe(false);
		scope.dispose();
	});

	it("rejects a prepared transaction if the settings revision changes before commit", async () => {
		const plugin = createPlugin();
		const fileA = new TFile();
		fileA.path = "A.md";
		const view = createView(fileA);
		(view as unknown as { getState: () => { mode: string; source: boolean } }).getState = () => ({
			mode: "preview",
			source: false,
		});

		const scope = new RenderScope();
		scope.load();
		const transaction = await getPreparer(plugin)(view, {
			view,
			file: fileA,
			matchedConfig: null,
			mode: "preview",
			stateKey: "A.md::none::preview::0",
		}, {
			generation: 1,
			scope,
			signal: scope.signal,
		});

		expect(transaction.isValid?.()).toBe(true);
		(plugin as unknown as { settingsVersion: number }).settingsVersion = 1;
		expect(transaction.isValid?.()).toBe(false);
		scope.dispose();
	});
});
