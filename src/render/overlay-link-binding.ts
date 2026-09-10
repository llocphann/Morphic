export interface OverlayLinkActions {
	isModEvent(event: MouseEvent): boolean;
	openInternalLink(href: string, sourcePath: string, newLeaf: boolean): void | Promise<void>;
	openInternalLinkContextMenu(event: MouseEvent, href: string, sourcePath: string): void;
	openExternalLinkContextMenu(event: MouseEvent, href: string): void;
}

export interface OverlayLinkBindingOptions {
	skipSelector?: string;
}

/**
 * Lifecycle-owned link handler binding for one rendered overlay.
 *
 * The source path is mutable and read at event time. Retained/reused overlays
 * must resolve relative links against the currently committed note, never the
 * note that first created the listeners.
 */
export class OverlayLinkBinding {
	private sourcePath: string;
	private disposed = false;
	private readonly skipSelector?: string;

	constructor(
		private readonly root: HTMLElement,
		sourcePath: string,
		private readonly actions: OverlayLinkActions,
		options: OverlayLinkBindingOptions = {},
	) {
		this.sourcePath = sourcePath;
		this.skipSelector = options.skipSelector;
		this.root.addEventListener("click", this.handleClick);
		this.root.addEventListener("contextmenu", this.handleContextMenu);
	}

	get currentSourcePath(): string {
		return this.sourcePath;
	}

	get isDisposed(): boolean {
		return this.disposed;
	}

	updateSourcePath(sourcePath: string): void {
		if (this.disposed) return;
		this.sourcePath = sourcePath;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.root.removeEventListener("click", this.handleClick);
		this.root.removeEventListener("contextmenu", this.handleContextMenu);
	}

	private readonly handleClick = (event: Event): void => {
		if (this.disposed) return;
		const mouseEvent = event as MouseEvent;
		const target = eventTargetElement(mouseEvent.target);
		if (!target || this.shouldSkip(target)) return;

		const link = closestAnchor(target, ".internal-link");
		if (!link) return;
		const href = link.getAttribute("data-href") || link.getAttribute("href");
		if (!href) return;

		mouseEvent.preventDefault();
		void this.actions.openInternalLink(
			href,
			this.sourcePath,
			this.actions.isModEvent(mouseEvent),
		);
	};

	private readonly handleContextMenu = (event: Event): void => {
		if (this.disposed) return;
		const mouseEvent = event as MouseEvent;
		const target = eventTargetElement(mouseEvent.target);
		if (!target || this.shouldSkip(target)) return;

		const internalLink = closestAnchor(target, ".internal-link");
		if (internalLink) {
			const href = internalLink.getAttribute("data-href") || internalLink.getAttribute("href");
			if (!href) return;
			this.actions.openInternalLinkContextMenu(mouseEvent, href, this.sourcePath);
			return;
		}

		const externalLink = closestAnchor(target, ".external-link");
		if (!externalLink) return;
		const href = externalLink.getAttribute("data-href") || externalLink.getAttribute("href");
		if (!href) return;
		this.actions.openExternalLinkContextMenu(mouseEvent, href);
	};

	private shouldSkip(target: Element): boolean {
		return !!this.skipSelector && !!target.closest(this.skipSelector);
	}
}

function eventTargetElement(target: EventTarget | null): Element | null {
	if (!target || typeof (target as Element).closest !== "function") return null;
	return target as Element;
}

function closestAnchor(target: Element, selector: string): HTMLAnchorElement | null {
	const element = target.closest(selector);
	return element?.tagName === "A" ? element as HTMLAnchorElement : null;
}
