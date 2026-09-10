import { Component, TFile, type App } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { InvalidationEngine } from "../core/invalidation-engine";
import { ReactiveDataCore } from "../core/reactive-data-core";
import { beginRevisionTrackedRuntimeRender } from "../core/tracked-runtime-render";
import { renderTemplate } from "../renderer";

function file(path: string, size: number): TFile {
	const value = new TFile();
	value.path = path;
	value.name = path.split("/").pop() ?? path;
	value.basename = value.name.replace(/\.md$/, "");
	value.extension = "md";
	value.parent = null;
	value.stat = { ctime: 1, mtime: 1, size };
	return value;
}

function container(): HTMLElement {
	return document.createElement("div");
}

function runtimeFor(app: App) {
	const invalidation = new InvalidationEngine<string>(() => undefined);
	const core = new ReactiveDataCore(app, invalidation);
	return beginRevisionTrackedRuntimeRender(core);
}

describe("legacy renderer runtime body freshness", () => {
	it("rejects a persisted source render when its authoritative body fence sees newer same-stat bytes", async () => {
		const target = file("Body.md", 5);
		const cachedRead = vi.fn(async () => "alpha");
		const read = vi.fn(async () => "bravo");
		const app = {
			metadataCache: {
				getFileCache: vi.fn(() => null),
			},
			vault: { cachedRead, read },
		} as unknown as App;
		const tracked = runtimeFor(app);
		const host = container();

		await renderTemplate(
			app,
			"<article>{{content}}</article>",
			target,
			host,
			new Component(),
			false,
			undefined,
			undefined,
			false,
			undefined,
			undefined,
			tracked.runtime,
		);

		expect(host.textContent).toBe("alpha");
		const readSet = tracked.freezeReadSet();
		expect(readSet.isCurrent()).toBe(true);
		expect(await tracked.settleSynchronousValidation()).toBe(false);
		expect(tracked.isSynchronouslyCurrent()).toBe(false);
		expect(cachedRead).toHaveBeenCalledTimes(1);
		expect(read).toHaveBeenCalledTimes(1);
	});

	it("uses authoritative Vault.read after a known content revision even when cachedRead is stale", async () => {
		const target = file("Body.md", 5);
		const cachedRead = vi.fn(async () => "alpha");
		const read = vi.fn(async () => "bravo");
		const app = {
			metadataCache: {
				getFileCache: vi.fn(() => null),
			},
			vault: { cachedRead, read },
		} as unknown as App;
		const invalidation = new InvalidationEngine<string>(() => undefined);
		const core = new ReactiveDataCore(app, invalidation);
		core.fileContentModified(target);
		const tracked = beginRevisionTrackedRuntimeRender(core);
		const host = container();

		await renderTemplate(
			app,
			"<article>{{content}}</article>",
			target,
			host,
			new Component(),
			false,
			undefined,
			undefined,
			false,
			undefined,
			undefined,
			tracked.runtime,
		);

		expect(host.textContent).toBe("bravo");
		const readSet = tracked.freezeReadSet();
		expect(readSet.isCurrent()).toBe(true);
		expect(await tracked.settleSynchronousValidation()).toBe(true);
		expect(tracked.isSynchronouslyCurrent()).toBe(true);
		expect(cachedRead).not.toHaveBeenCalled();
		expect(read).toHaveBeenCalledTimes(2);
	});

	it("keeps an explicit Live Preview source snapshot editor-authoritative", async () => {
		const target = file("Draft.md", 11);
		const cachedRead = vi.fn(async () => "cached-disk-value");
		const read = vi.fn(async () => "direct-disk-value");
		const app = {
			metadataCache: {
				getFileCache: vi.fn(() => null),
			},
			vault: { cachedRead, read },
		} as unknown as App;
		const tracked = runtimeFor(app);
		const host = container();

		await renderTemplate(
			app,
			"<article>{{content}}</article>",
			target,
			host,
			new Component(),
			false,
			undefined,
			undefined,
			false,
			"editor-draft",
			undefined,
			tracked.runtime,
		);

		expect(host.textContent).toBe("editor-draft");
		const readSet = tracked.freezeReadSet();
		expect(readSet.isCurrent()).toBe(true);
		expect(await tracked.settleSynchronousValidation()).toBe(true);
		expect(tracked.isSynchronouslyCurrent()).toBe(true);
		expect(cachedRead).not.toHaveBeenCalled();
		expect(read).not.toHaveBeenCalled();
	});
});
