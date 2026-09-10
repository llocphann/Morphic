import { TFile, type App, type BasesView, type Vault } from "obsidian";
import { abortError, raceWithAbort } from "./reliability";

const POLL_INTERVAL_MS = 25;

interface EmbedFactoryContext {
	app: App;
	containerEl: HTMLElement;
	sourcePath: string;
	linktext: string;
}

export type BaseEmbedFactory = (
	context: EmbedFactoryContext,
	file: TFile,
	viewName?: string,
) => InternalBaseEmbed;

interface InternalBaseController {
	currentFile?: TFile;
	view?: BasesView | null;
	error?: unknown;
	errorEl?: HTMLElement;
	queue?: {
		queue?: {
			runnable?: {
				running?: boolean;
			};
		};
	};
}

interface InternalBaseEmbed {
	containerEl?: HTMLElement;
	containingFile?: TFile;
	controller?: InternalBaseController;
	loadFile?: () => Promise<void> | void;
	unload?: () => void;
}

interface TemporaryFileEntry {
	file: TFile;
	content: string;
}

interface VaultOverlay {
	files: Map<string, TemporaryFileEntry>;
	read: Vault["read"];
	cachedRead: Vault["cachedRead"];
	modify: Vault["modify"];
	create: Vault["create"];
}

const overlays = new WeakMap<Vault, VaultOverlay>();
let temporaryFileSequence = 0;

export function resolveBaseEmbedFactory(app: App): BaseEmbedFactory | null {
	const registry = (app as App & {
		embedRegistry?: { embedByExtension?: Record<string, unknown> };
	}).embedRegistry;
	const candidate = registry?.embedByExtension?.base;
	return typeof candidate === "function" ? candidate as BaseEmbedFactory : null;
}

export class BaseEmbedCollectionSession {
	private host: HTMLElement | null = null;
	private embed: InternalBaseEmbed | null = null;
	private restoreVault: (() => void) | null = null;
	private disposed = false;

	constructor(
		private readonly app: App,
		private readonly ownerDocument: Document,
		private readonly sourceFile: TFile,
		private readonly baseContent: string,
		private readonly viewName: string,
		private readonly factory: BaseEmbedFactory,
	) {}

	async collect(signal: AbortSignal): Promise<BasesView> {
		if (this.disposed) throw new Error("Bases collection session is already disposed.");
		if (signal.aborted) throw abortError(signal);

		const host = this.ownerDocument.createElement("div");
		host.classList.add("cv-bases-collector-host");
		this.host = host;
		this.ownerDocument.body.appendChild(host);

		const temporaryFile = createTemporaryBaseFile(this.app);
		this.restoreVault = installVaultOverlay(this.app.vault, temporaryFile, this.baseContent);

		const embed = this.factory(
			{
				app: this.app,
				containerEl: host,
				sourcePath: this.sourceFile.path,
				linktext: "",
			},
			temporaryFile,
			this.viewName ? `#${this.viewName}` : "",
		);
		this.embed = embed;

		if (!embed || typeof embed.loadFile !== "function") {
			throw new Error("Obsidian Bases embed API did not return a loadable embed.");
		}

		embed.containingFile = this.sourceFile;
		if (embed.controller) embed.controller.currentFile = this.sourceFile;

		let load: Promise<void>;
		try {
			load = Promise.resolve(embed.loadFile());
		} catch (error) {
			load = Promise.reject(error instanceof Error ? error : new Error(String(error)));
		}
		await raceWithAbort(load, signal);
		await waitUntilReady(embed, signal, this.ownerDocument);

		const view = embed.controller?.view;
		if (!isBasesViewLike(view)) {
			throw new Error(controllerError(embed) ?? "Could not collect Bases view data.");
		}
		return view;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		safe(() => this.embed?.unload?.());
		safe(() => this.restoreVault?.());
		safe(() => this.host?.remove());
		this.embed = null;
		this.restoreVault = null;
		this.host = null;
	}
}

function createTemporaryBaseFile(app: App): TFile {
	temporaryFileSequence++;
	const basename = `.morphic-bases-query-${Date.now()}-${temporaryFileSequence}`;
	const path = `${basename}.base`;
	const file = Object.create(TFile.prototype) as unknown;
	if (!(file instanceof TFile)) throw new Error("Could not create a temporary Bases file.");

	Object.assign(file, {
		basename,
		cache: () => undefined,
		deleted: false,
		extension: "base",
		getNewPathAfterRename: () => path,
		getShortName: () => basename,
		name: `${basename}.base`,
		parent: null,
		path,
		saving: false,
		setPath: () => undefined,
		stat: { ctime: -1, mtime: -1, size: 0 },
		updateCacheLimit: () => undefined,
		vault: app.vault,
	});
	return file;
}

function installVaultOverlay(vault: Vault, file: TFile, content: string): () => void {
	let overlay = overlays.get(vault);
	if (!overlay) {
		overlay = {
			files: new Map(),
			read: vault.read.bind(vault),
			cachedRead: vault.cachedRead.bind(vault),
			modify: vault.modify.bind(vault),
			create: vault.create.bind(vault),
		};
		overlays.set(vault, overlay);
		activateOverlay(vault, overlay);
	}

	overlay.files.set(file.path, { file, content });
	return () => releaseOverlayFile(vault, file.path);
}

function activateOverlay(vault: Vault, overlay: VaultOverlay): void {
	vault.read = function readWithOverlay(target: TFile) {
		return overlay.files.has(target.path)
			? Promise.resolve(overlay.files.get(target.path)!.content)
			: overlay.read(target);
	};
	vault.cachedRead = function cachedReadWithOverlay(target: TFile) {
		return overlay.files.has(target.path)
			? Promise.resolve(overlay.files.get(target.path)!.content)
			: overlay.cachedRead(target);
	};
	vault.modify = function modifyWithOverlay(target: TFile, data: string, options?: Parameters<Vault["modify"]>[2]) {
		return overlay.files.has(target.path)
			? Promise.resolve()
			: overlay.modify(target, data, options);
	};
	vault.create = function createWithOverlay(path: string, data: string, options?: Parameters<Vault["create"]>[2]) {
		for (const entry of overlay.files.values()) {
			if (entry.file.path === path) return Promise.resolve(entry.file);
		}
		return overlay.create(path, data, options);
	};
}

function releaseOverlayFile(vault: Vault, path: string): void {
	const overlay = overlays.get(vault);
	if (!overlay) return;
	overlay.files.delete(path);
	if (overlay.files.size > 0) return;
	vault.read = overlay.read;
	vault.cachedRead = overlay.cachedRead;
	vault.modify = overlay.modify;
	vault.create = overlay.create;
	overlays.delete(vault);
}

function waitUntilReady(embed: InternalBaseEmbed, signal: AbortSignal, ownerDocument: Document): Promise<void> {
	if (signal.aborted) return Promise.reject(abortError(signal));
	const timers = ownerDocument.defaultView ?? window;
	return new Promise((resolve, reject) => {
		let timer: number | undefined;
		const stop = () => {
			if (timer !== undefined) timers.clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
		};
		const onAbort = () => {
			stop();
			reject(abortError(signal));
		};
		const inspect = () => {
			const error = controllerError(embed);
			if (error) {
				stop();
				reject(new Error(error));
				return;
			}
			if (isBasesViewLike(embed.controller?.view)) {
				stop();
				resolve();
				return;
			}
			timer = timers.setTimeout(inspect, POLL_INTERVAL_MS);
		};
		signal.addEventListener("abort", onAbort, { once: true });
		inspect();
	});
}

function controllerError(embed: InternalBaseEmbed): string | null {
	const controller = embed.controller;
	if (!controller?.error) return null;
	const rendered = controller.errorEl?.textContent?.trim();
	if (rendered) return rendered;
	if (controller.error instanceof Error) return controller.error.message;
	if (typeof controller.error === "string") return controller.error;
	return "Obsidian reported a Bases collection error.";
}

function isBasesViewLike(value: unknown): value is BasesView {
	return isRecord(value)
		&& isRecord(value.config)
		&& typeof value.config.getDisplayName === "function"
		&& isRecord(value.data)
		&& Array.isArray(value.data.properties)
		&& Array.isArray(value.data.data);
}

function safe(action: () => void): void {
	try {
		action();
	} catch {
		// Internal Obsidian cleanup is best-effort; ownership still advances.
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
