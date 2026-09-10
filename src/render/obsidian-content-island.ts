import type { App } from "obsidian";
import { createObsidianMarkdownIslandPatch } from "./obsidian-markdown-island";
import type { RetainedIslandRenderer } from "./retained-slot-runtime";

export interface ObsidianContentIslandRequest {
	readonly app: App;
	readonly markdown: string;
	readonly sourcePath: string;
	/** Dependency/revision fingerprint supplied by the caller. */
	readonly revisionKey: string;
}

export interface ObsidianContentIslandPatch {
	readonly renderKey: string;
	readonly renderer: RetainedIslandRenderer;
}

/**
 * Build one retained read-only `{{content}}` island patch.
 *
 * The content shell itself belongs to the retained static structure. This
 * adapter owns only the Markdown preview sizer and the MarkdownRenderer child
 * Component for one island generation.
 */
export function createObsidianContentIslandPatch(
	request: ObsidianContentIslandRequest,
): ObsidianContentIslandPatch {
	const markdownPatch = createObsidianMarkdownIslandPatch({
		app: request.app,
		markdown: request.markdown,
		sourcePath: request.sourcePath,
		revisionKey: request.revisionKey,
		mode: "block",
	});

	return {
		renderKey: JSON.stringify([
			"obsidian-content-island-v1",
			markdownPatch.renderKey,
		]),
		renderer: async (context) => {
			if (!context.isCurrent()) return;

			const sizer = context.ownerDocument.win.createDiv();
			sizer.classList.add("markdown-preview-sizer", "markdown-preview-section");
			context.container.appendChild(sizer);

			await markdownPatch.renderer({
				...context,
				container: sizer,
			});
		},
	};
}
