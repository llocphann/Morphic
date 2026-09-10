import { Keymap, Menu, type App } from "obsidian";
import {
	OverlayLinkBinding,
	type OverlayLinkBindingOptions,
} from "./overlay-link-binding";

export interface OverlayLinkLifetimeOwner {
	registerDisposer(disposer: () => void): unknown;
}

/**
 * Obsidian action adapter for a lifecycle-owned overlay link binding.
 *
 * This keeps workspace/menu semantics in one place so retained render owners do
 * not need to duplicate immutable source-path closures at each call site.
 */
export function createObsidianOverlayLinkBinding(
	root: HTMLElement,
	sourcePath: string,
	app: App,
	owner?: OverlayLinkLifetimeOwner,
	options: OverlayLinkBindingOptions = {},
): OverlayLinkBinding {
	const workspace = app.workspace as unknown as {
		openLinkText(linktext: string, sourcePath: string, newLeaf?: boolean): Promise<void> | void;
		handleLinkContextMenu?(menu: Menu, linktext: string, sourcePath: string): boolean;
		handleExternalLinkContextMenu?(menu: Menu, url: string): boolean;
	};

	const binding = new OverlayLinkBinding(
		root,
		sourcePath,
		{
			isModEvent: (event) => Boolean(Keymap.isModEvent(event)),
			openInternalLink: (href, currentSourcePath, newLeaf) =>
				workspace.openLinkText(href, currentSourcePath, newLeaf),
			openInternalLinkContextMenu: (event, href, currentSourcePath) => {
				if (typeof workspace.handleLinkContextMenu !== "function") return;
				const menu = Menu.forEvent(event);
				workspace.handleLinkContextMenu(menu, href, currentSourcePath);
			},
			openExternalLinkContextMenu: (event, href) => {
				if (typeof workspace.handleExternalLinkContextMenu !== "function") return;
				const menu = Menu.forEvent(event);
				workspace.handleExternalLinkContextMenu(menu, href);
			},
		},
		options,
	);

	if (owner) {
		try {
			owner.registerDisposer(() => binding.dispose());
		} catch (error) {
			binding.dispose();
			throw error;
		}
	}

	return binding;
}
