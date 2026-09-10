interface NavigationHold {
	readonly snapshot: HTMLElement;
	readonly previousInert: boolean;
}

/**
 * Keeps a static, inert copy of the last committed custom surface visible while
 * Obsidian switches the live MarkdownView to a new file. This class owns no
 * render authority or async resources: the RenderController still decides what
 * may commit, and the hold is removed as soon as the current generation either
 * commits or falls back to native Markdown.
 */
export class NavigationSurfaceHold {
	private readonly holds = new Map<HTMLElement, NavigationHold>();

	constructor(private readonly customViewClass: string) {}

	hold(container: HTMLElement): boolean {
		if (this.holds.has(container)) return true;
		if (!container.isConnected) return false;
		const custom = container.querySelector<HTMLElement>(`.${this.customViewClass}`);
		if (!custom) return false;

		const snapshot = container.cloneNode(true) as HTMLElement;
		snapshot.classList.add("morphic-navigation-hold");
		snapshot.removeAttribute("id");
		snapshot.setAttribute("aria-hidden", "true");
		snapshot.inert = true;
		snapshot.querySelectorAll("script").forEach(script => script.remove());
		copyKnownScrollPositions(container, snapshot);

		const bounds = container.getBoundingClientRect();
		const parentBounds = container.parentElement?.getBoundingClientRect();
		Object.assign(snapshot.style, {
			position: "absolute",
			left: `${bounds.left - (parentBounds?.left ?? 0)}px`,
			top: `${bounds.top - (parentBounds?.top ?? 0)}px`,
			width: `${bounds.width}px`,
			height: `${bounds.height}px`,
			margin: "0",
			zIndex: "20",
			pointerEvents: "none",
			overflow: "hidden",
		});

		const previousInert = container.inert;
		container.inert = true;
		container.classList.add("morphic-navigation-preparing");
		container.after(snapshot);
		this.holds.set(container, { snapshot, previousInert });
		return true;
	}

	has(container: HTMLElement): boolean {
		return this.holds.has(container);
	}

	release(container: HTMLElement): void {
		const hold = this.holds.get(container);
		if (!hold) return;
		hold.snapshot.remove();
		container.classList.remove("morphic-navigation-preparing");
		container.inert = hold.previousInert;
		this.holds.delete(container);
	}

	releaseDetached(): void {
		for (const container of Array.from(this.holds.keys())) {
			if (!container.isConnected) this.release(container);
		}
	}

	dispose(): void {
		for (const container of Array.from(this.holds.keys())) this.release(container);
	}
}

function copyKnownScrollPositions(source: HTMLElement, snapshot: HTMLElement): void {
	snapshot.scrollTop = source.scrollTop;
	snapshot.scrollLeft = source.scrollLeft;

	const sourceOverlay = source.querySelector<HTMLElement>(".obsidian-custom-view-render");
	const snapshotOverlay = snapshot.querySelector<HTMLElement>(".obsidian-custom-view-render");
	if (sourceOverlay && snapshotOverlay) {
		snapshotOverlay.scrollTop = sourceOverlay.scrollTop;
		snapshotOverlay.scrollLeft = sourceOverlay.scrollLeft;
	}

	const sourceScroller = source.querySelector<HTMLElement>(".cm-scroller");
	const snapshotScroller = snapshot.querySelector<HTMLElement>(".cm-scroller");
	if (sourceScroller && snapshotScroller) {
		snapshotScroller.scrollTop = sourceScroller.scrollTop;
		snapshotScroller.scrollLeft = sourceScroller.scrollLeft;
	}
}
