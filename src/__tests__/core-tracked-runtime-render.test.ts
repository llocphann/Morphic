import { TFile, type App } from "obsidian";
import { describe, expect, it } from "vitest";
import { dependencyKey } from "../core/dependencies";
import { InvalidationEngine } from "../core/invalidation-engine";
import { ReactiveDataCore } from "../core/reactive-data-core";
import { beginRevisionTrackedRuntimeRender } from "../core/tracked-runtime-render";

describe("Morphic revision-tracked runtime render composition", () => {
	it("uses ReactiveDataCore's authoritative revisions for direct runtime reads", () => {
		const file = createFile("Notes/A.md");
		const frontmatter = new Map<string, Record<string, unknown>>([
			[file.path, { rating: 9 }],
		]);
		const app = createApp({ frontmatter });
		const invalidation = new InvalidationEngine<string>(() => undefined);
		const core = new ReactiveDataCore(app, invalidation);
		core.bootstrap([file]);
		const render = beginRevisionTrackedRuntimeRender(core);

		expect(render.runtime.file(file).property("rating")).toBe(9);
		const readSet = render.freezeReadSet();
		expect(readSet.isCurrent()).toBe(true);

		frontmatter.set(file.path, { rating: 10 });
		core.fileMetadataRefreshed(file);

		const ratingKey = dependencyKey.file(file.path, "frontmatter", "rating");
		expect(readSet.isCurrent()).toBe(false);
		expect(readSet.staleDependencies()).toContain(ratingKey);
	});

	it("shares one collector across runtime link resolution and linked property reads", () => {
		const root = createFile("Notes/A.md");
		const target = createFile("People/B.md");
		const frontmatter = new Map<string, Record<string, unknown>>([
			[root.path, { person: "[[People/B]]" }],
			[target.path, { author: "Ada" }],
		]);
		const app = createApp({
			frontmatter,
			resolve: () => target,
		});
		const invalidation = new InvalidationEngine<string>(() => undefined);
		const core = new ReactiveDataCore(app, invalidation);
		core.bootstrap([root, target]);
		const render = beginRevisionTrackedRuntimeRender(core);

		expect(render.runtime.linkedProperty("People/B", root.path, "author")).toBe("Ada");
		const readSet = render.freezeReadSet();
		expect(readSet.dependencies()).toEqual(new Set([
			dependencyKey.index("files"),
			dependencyKey.file(target.path, "exists"),
			dependencyKey.file(target.path, "frontmatter", "author"),
		]));

		frontmatter.set(target.path, { author: "Grace" });
		core.fileMetadataRefreshed(target);
		expect(readSet.isCurrent()).toBe(false);
		expect(readSet.staleDependencies()).toContain(
			dependencyKey.file(target.path, "frontmatter", "author"),
		);
	});

	it("tracks commit-worthy external dependencies on the same revision contract", () => {
		const file = createFile("Notes/A.md");
		const app = createApp({ frontmatter: new Map([[file.path, { rating: 9 }]]) });
		const invalidation = new InvalidationEngine<string>(() => undefined);
		const core = new ReactiveDataCore(app, invalidation);
		core.bootstrap([file]);
		const render = beginRevisionTrackedRuntimeRender(core);
		const settingsKey = dependencyKey.settings();

		render.trackRequiredDependency(settingsKey);
		const readSet = render.freezeReadSet();
		expect(readSet.dependencies()).toEqual(new Set([settingsKey]));
		expect(readSet.isCurrent()).toBe(true);

		core.settingsChanged();
		expect(readSet.isCurrent()).toBe(false);
		expect(readSet.staleDependencies()).toEqual([settingsKey]);
	});

	it("keeps frozen transaction contracts immutable while the render continues tracking", () => {
		const file = createFile("Notes/A.md");
		const app = createApp({ frontmatter: new Map([[file.path, { rating: 9 }]]) });
		const invalidation = new InvalidationEngine<string>(() => undefined);
		const core = new ReactiveDataCore(app, invalidation);
		core.bootstrap([file]);
		const render = beginRevisionTrackedRuntimeRender(core);
		const ratingKey = dependencyKey.file(file.path, "frontmatter", "rating");
		const settingsKey = dependencyKey.settings();

		render.runtime.file(file).property("rating");
		const first = render.freezeReadSet();
		render.trackRequiredDependencies([settingsKey]);
		const second = render.freezeReadSet();

		expect(first.dependencies()).toEqual(new Set([ratingKey]));
		expect(second.dependencies()).toEqual(new Set([ratingKey, settingsKey]));
		expect(render.dependencies()).toEqual(new Set([ratingKey, settingsKey]));
	});
});

function createApp(options: {
	frontmatter: Map<string, Record<string, unknown>>;
	resolve?: (linkPath: string, sourcePath: string) => TFile | null;
}): App {
	return {
		metadataCache: {
			getFileCache(file: TFile) {
				return {
					frontmatter: options.frontmatter.get(file.path) ?? {},
					tags: [],
					links: [],
				};
			},
			getFirstLinkpathDest(linkPath: string, sourcePath: string) {
				return options.resolve?.(linkPath, sourcePath) ?? null;
			},
		},
		vault: {
			async cachedRead(file: TFile) {
				return `${file.basename} body`;
			},
		},
	} as unknown as App;
}

function createFile(path: string): TFile {
	const file = new TFile();
	file.path = path;
	file.name = path.split("/").pop() ?? path;
	file.basename = file.name.replace(/\.md$/, "");
	file.extension = "md";
	file.parent = null;
	file.stat = { ctime: 1, mtime: 1, size: 32 };
	return file;
}
