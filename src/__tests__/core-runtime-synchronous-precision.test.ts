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

describe("runtime synchronous observation precision", () => {
	it("keeps a linked exact property current across unrelated metadata and stat changes", () => {
		const root = file("Root.md");
		const linked = file("People/A.md");
		const frontmatter = new Map<string, Record<string, unknown>>([
			[linked.path, { author: "Alice", rating: 1 }],
		]);
		const app = makeApp(frontmatter, () => linked);
		const core = new ReactiveDataCore(app, new InvalidationEngine<string>(() => undefined));
		const render = beginRevisionTrackedRuntimeRender(core);

		expect(render.runtime.resolveFile("A", root.path)?.property("author")).toBe("Alice");
		const readSet = render.freezeReadSet();
		expect(readSet.isCurrent()).toBe(true);
		expect(render.isSynchronouslyCurrent()).toBe(true);

		frontmatter.set(linked.path, { author: "Alice", rating: 2 });
		expect(readSet.isCurrent()).toBe(true);
		expect(render.isSynchronouslyCurrent()).toBe(true);

		linked.stat = { ...linked.stat, mtime: 2, size: 2 };
		expect(readSet.isCurrent()).toBe(true);
		expect(render.isSynchronouslyCurrent()).toBe(true);

		frontmatter.set(linked.path, { author: "Bob", rating: 2 });
		expect(readSet.isCurrent()).toBe(true);
		expect(render.isSynchronouslyCurrent()).toBe(false);
	});

	it("stales an observed file when its dependency-key path changes before the rename event", () => {
		const target = file("People/A.md");
		const frontmatter = new Map<string, Record<string, unknown>>([
			[target.path, { author: "Alice" }],
		]);
		const app = makeApp(frontmatter, () => null);
		const core = new ReactiveDataCore(app, new InvalidationEngine<string>(() => undefined));
		const render = beginRevisionTrackedRuntimeRender(core);

		expect(render.runtime.file(target).property("author")).toBe("Alice");
		const readSet = render.freezeReadSet();
		expect(readSet.isCurrent()).toBe(true);

		frontmatter.delete("People/A.md");
		target.path = "Archive/A.md";
		frontmatter.set(target.path, { author: "Alice" });
		expect(readSet.isCurrent()).toBe(true);
		expect(render.isSynchronouslyCurrent()).toBe(false);
	});

	it("keeps broad metadata reads conservative", () => {
		const target = file("Target.md");
		const frontmatter = new Map<string, Record<string, unknown>>([
			[target.path, { author: "Alice", rating: 1 }],
		]);
		const app = makeApp(frontmatter, () => null);
		const core = new ReactiveDataCore(app, new InvalidationEngine<string>(() => undefined));
		const render = beginRevisionTrackedRuntimeRender(core);

		expect(render.runtime.file(target).metadata().frontmatter.author).toBe("Alice");
		expect(render.isSynchronouslyCurrent()).toBe(true);
		frontmatter.set(target.path, { author: "Alice", rating: 2 });
		expect(render.isSynchronouslyCurrent()).toBe(false);
	});

	it("guards explicit body reads with the file stat observed before the read", async () => {
		const target = file("Target.md");
		const app = makeApp(new Map(), () => null);
		const core = new ReactiveDataCore(app, new InvalidationEngine<string>(() => undefined));
		const render = beginRevisionTrackedRuntimeRender(core);

		expect(await render.runtime.file(target).body()).toBe("Body");
		expect(render.isSynchronouslyCurrent()).toBe(true);
		target.stat = { ...target.stat, mtime: 2 };
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
		vault: { cachedRead: async () => "Body" },
	} as unknown as App;
}
