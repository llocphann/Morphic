import { MarkdownView, TFile } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import CustomViewsPlugin from "../main";

interface MarkdownInput {
	view: MarkdownView;
	file: TFile;
	matchedConfig: null;
	mode: "preview";
	stateKey: string;
	requestKey: string;
}

interface FakeController {
	currentGeneration: number;
	invalidate(): void;
	render(input: unknown, key: string): Promise<{
		status: "stale" | "committed";
		generation: number;
	}>;
}

interface Internals {
	unloaded: boolean;
	markdownSelfStaleRetries: WeakMap<
		MarkdownView,
		{ requestKey: string; retries: number }
	>;
	markdownControllers: {
		getOrCreate(view: MarkdownView): FakeController;
	} | null;
	buildMarkdownRenderInput(view: MarkdownView, file: TFile): MarkdownInput;
	appliedDomIsValid(input: MarkdownInput): boolean;
	currentMarkdownRequestKey(view: MarkdownView, file: TFile): string | null;
	queueMarkdownView(view: MarkdownView, file: TFile): void;
	renderMarkdownView(
		view: MarkdownView,
		file: TFile,
		forceSemanticRefresh?: boolean,
	): Promise<void>;
}

interface MutableMarkdownView extends MarkdownView {
	file: TFile | null;
	contentEl: HTMLElement;
}

const REQUEST_KEY = "Body.md::bench-body::preview::126";

function createFile(): TFile {
	const file = new TFile();
	file.path = "Body.md";
	return file;
}

function createView(file: TFile): MutableMarkdownView {
	const view = Object.create(MarkdownView.prototype) as MutableMarkdownView;
	view.file = file;
	view.contentEl = document.createElement("div");
	view.contentEl.setAttribute("data-cv-state", REQUEST_KEY);
	return view;
}

function createHarness(controller: FakeController) {
	const plugin = Object.create(CustomViewsPlugin.prototype) as CustomViewsPlugin;
	const internals = plugin as unknown as Internals;
	const file = createFile();
	const view = createView(file);
	const queue = vi.fn();

	internals.unloaded = false;
	internals.markdownSelfStaleRetries = new WeakMap();
	internals.markdownControllers = {
		getOrCreate: () => controller,
	};
	internals.buildMarkdownRenderInput = () => ({
		view,
		file,
		matchedConfig: null,
		mode: "preview",
		stateKey: REQUEST_KEY,
		requestKey: REQUEST_KEY,
	});
	internals.appliedDomIsValid = () => true;
	internals.currentMarkdownRequestKey = () => REQUEST_KEY;
	internals.queueMarkdownView = queue;

	return { internals, file, view, queue };
}

describe("production Markdown current-generation stale retry", () => {
	it("requeues one current self-stale generation, bounds the retry, and resets after success", async () => {
		let status: "stale" | "committed" = "stale";
		const controller: FakeController = {
			currentGeneration: 0,
			invalidate: vi.fn(),
			render: vi.fn(async () => {
				controller.currentGeneration += 1;
				return {
					status,
					generation: controller.currentGeneration,
				};
			}),
		};
		const { internals, file, view, queue } = createHarness(controller);

		await internals.renderMarkdownView(view, file, false);
		expect(queue).toHaveBeenCalledTimes(1);
		expect(queue).toHaveBeenLastCalledWith(view, file);

		await internals.renderMarkdownView(view, file, false);
		expect(queue).toHaveBeenCalledTimes(1);

		status = "committed";
		await internals.renderMarkdownView(view, file, false);
		expect(queue).toHaveBeenCalledTimes(1);

		status = "stale";
		await internals.renderMarkdownView(view, file, false);
		expect(queue).toHaveBeenCalledTimes(2);
	});

	it("does not resurrect a stale generation after a newer generation supersedes it", async () => {
		const controller: FakeController = {
			currentGeneration: 0,
			invalidate: vi.fn(),
			render: vi.fn(async () => {
				controller.currentGeneration += 2;
				return {
					status: "stale" as const,
					generation: controller.currentGeneration - 1,
				};
			}),
		};
		const { internals, file, view, queue } = createHarness(controller);

		await internals.renderMarkdownView(view, file, false);
		expect(queue).not.toHaveBeenCalled();
	});
});
