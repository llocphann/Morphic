import { Component, MarkdownRenderer, type App } from "obsidian";
import type { RetainedIslandRenderer } from "./retained-slot-runtime";

export type MarkdownIslandMode = "inline" | "block";

export interface ObsidianMarkdownIslandRequest {
	readonly app: App;
	readonly markdown: string;
	readonly sourcePath: string;
	/**
	 * Dependency/revision fingerprint supplied by the caller.
	 *
	 * Markdown output can change even when the literal markdown does not, for
	 * example when link/embed resolution or dependent metadata changes. The
	 * retained runtime therefore must not key Markdown islands by source text
	 * alone.
	 */
	readonly revisionKey: string;
	readonly mode?: MarkdownIslandMode;
}

export interface ObsidianMarkdownIslandPatch {
	readonly renderKey: string;
	readonly renderer: RetainedIslandRenderer;
}

/**
 * Build one generation-safe retained Markdown island patch.
 *
 * The render key includes sourcePath because relative links are source-context
 * dependent, and includes the caller's dependency revision so an unchanged
 * markdown string can still be rerendered when its resolved output is stale.
 */
export function createObsidianMarkdownIslandPatch(
	request: ObsidianMarkdownIslandRequest,
): ObsidianMarkdownIslandPatch {
	const markdown = request.markdown;
	const sourcePath = request.sourcePath;
	const revisionKey = request.revisionKey;
	const mode = request.mode ?? "block";

	return {
		renderKey: JSON.stringify([
			"obsidian-markdown-island-v1",
			mode,
			sourcePath,
			revisionKey,
			markdown,
		]),
		renderer: async (context) => {
			if (!context.isCurrent()) return;

			const component = new Component();
			// Register cleanup before load/render so partial setup failures are still
			// owned by the staging island and cannot leak into plugin lifetime.
			context.resources.register(() => component.unload());
			component.load();

			await MarkdownRenderer.render(
				request.app,
				markdown,
				context.container,
				sourcePath,
				component,
			);

			// RetainedDomRuntime performs the authoritative final check immediately
			// before live commit. This guard prevents unnecessary staging mutation
			// after a generation has already become stale.
			if (!context.isCurrent()) return;
			if (mode === "inline") unwrapSingleParagraph(context.container);
		},
	};
}

function unwrapSingleParagraph(container: HTMLElement): void {
	const paragraph = container.querySelector("p");
	if (
		paragraph &&
		paragraph.parentElement === container &&
		container.children.length === 1
	) {
		paragraph.replaceWith(...Array.from(paragraph.childNodes));
	}
}
