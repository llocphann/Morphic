import { TFile, type App } from "obsidian";
import { describe, expect, it } from "vitest";
import { InvalidationEngine } from "../core/invalidation-engine";
import { ReactiveDataCore } from "../core/reactive-data-core";
import { beginRevisionTrackedRuntimeRender } from "../core/tracked-runtime-render";

function file(path: string): TFile {
	const value = new TFile();
	value.path = path;
	value.name = path.split("/").pop() ?? path;
	value.basename = value.name.replace(/\.md$/, "");
	value.extension = "md";
	value.parent = null;
	value.stat = { ctime: 1, mtime: 1, size: 1 };
	return value;
}

describe("runtime synchronous validity", () => {
	it("detects metadata mutation even before a revision event is forwarded", () => {
		const root = file("Root.md");
		const frontmatter = new Map([[root.path, { rating: 1 }]]);
		const app = makeApp(frontmatter, () => null);
		const core = new ReactiveDataCore(app, new InvalidationEngine<string>(() => undefined));
		const render = beginRevisionTrackedRuntimeRender(core);

		expect(render.runtime.file(root).property("rating")).toBe(1);
		const readSet = render.freezeReadSet();
		expect(readSet.isCurrent()).toBe(true);
		expect(render.isSynchronouslyCurrent()).toBe(true);

		frontmatter.set(root.path, { rating: 2 });
		expect(readSet.isCurrent()).toBe(true);
		expect(render.isSynchronouslyCurrent()).toBe(false);
	});

	it("detects link retargeting before the file-set revision event is forwarded", () => {
		const root = file("Root.md");
		const first = file("A.md");
		const second = file("B.md");
		let target = first;
		const app = makeApp(new Map([[first.path, { name: "A" }], [second.path, { name: "B" }]]), () => target);
		const core = new ReactiveDataCore(app, new InvalidationEngine<string>(() => undefined));
		const render = beginRevisionTrackedRuntimeRender(core);

		expect(render.runtime.resolveFile("Target", root.path)?.property("name")).toBe("A");
		expect(render.isSynchronouslyCurrent()).toBe(true);
		target = second;
		expect(render.isSynchronouslyCurrent()).toBe(false);
	});
});

function makeApp(
	frontmatter: Map<string, Record<string, unknown>>,
	resolve: (linkPath: string, sourcePath: string) => TFile | null,
): App {
	return {
		metadataCache: {
			getFileCache(target: TFile) {
				return { frontmatter: frontmatter.get(target.path) ?? {}, tags: [], links: [] };
			},
			getFirstLinkpathDest(linkPath: string, sourcePath: string) {
				return resolve(linkPath, sourcePath);
			},
		},
		vault: { cachedRead: async () => "" },
	} as unknown as App;
}
