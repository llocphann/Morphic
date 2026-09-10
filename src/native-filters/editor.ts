import type { App } from "obsidian";
import type { ViewConfig } from "../types";
import { getNativeBasesApi } from "./api";
import { toBasesFilter } from "./convert";

export function mountNativeFilters(
	app: App,
	host: HTMLElement,
	view: ViewConfig,
	save: () => void,
): () => void {
	const mount = new NativeFilterEditorMount(app, host, view, save);
	mount.open();
	return () => mount.close();
}

class NativeFilterEditorMount {
	private disposed = false;
	private loading = false;
	private releaseEditor: (() => void) | undefined;

	constructor(
		private readonly app: App,
		private readonly host: HTMLElement,
		private readonly view: ViewConfig,
		private readonly save: () => void,
	) {}

	open(): void {
		if (this.disposed || this.loading || this.releaseEditor) return;
		this.loading = true;
		this.host.textContent = "Loading filters…";

		void getNativeBasesApi(this.app)
			.then(api => {
				if (this.disposed) return;
				const initial = this.view.basesFilters === undefined
					? toBasesFilter(this.app, this.view.rules)
					: this.view.basesFilters;
				this.releaseEditor = api.createEditor(this.host, initial, filters => {
					if (this.disposed) return;
					this.view.basesFilters = filters;
					this.save();
				});
			})
			.catch(error => {
				if (!this.disposed) this.showLoadFailure(error);
			})
			.finally(() => {
				this.loading = false;
			});
	}

	close(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.releaseEditor?.();
		this.releaseEditor = undefined;
		this.host.replaceChildren();
	}

	private showLoadFailure(error: unknown): void {
		this.host.replaceChildren();
		const document = this.host.ownerDocument;
		const message = document.createElement("p");
		message.setAttribute("role", "alert");
		message.textContent = error instanceof Error
			? error.message
			: "The Bases filter editor could not be loaded.";

		const retry = document.createElement("button");
		retry.type = "button";
		retry.textContent = "Retry";
		retry.addEventListener("click", () => this.open(), { once: true });
		this.host.append(message, retry);
	}
}
