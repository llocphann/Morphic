import { TFile, type App } from "obsidian";
import { describe, expect, it } from "vitest";
import { dependencyKey } from "../core/dependencies";
import { InvalidationEngine } from "../core/invalidation-engine";
import { ReactiveDataCore } from "../core/reactive-data-core";
import { resolveRuntimePropertyChain } from "../core/runtime-property-chain";

describe("Morphic runtime property chains", () => {
	it("resolves linked metadata without materializing any note body", async () => {
		const fixture = createChainFixture();
		const core = new ReactiveDataCore(fixture.app, new InvalidationEngine<string>(() => undefined));
		core.bootstrap([fixture.movie, fixture.actor, fixture.secret]);
		const session = core.beginRuntimeRender();

		const value = await resolveRuntimePropertyChain(session, [
			{ key: "cast", index: 0 },
			{ key: "cover", index: 1 },
		], fixture.movie);

		expect(value).toBe("actor-cover-2");
		expect(fixture.totalReads()).toBe(0);
		const dependencies = session.dependencies();
		expect(dependencies.has(dependencyKey.file(fixture.movie.path, "frontmatter", "cast"))).toBe(true);
		expect(dependencies.has(dependencyKey.index("files"))).toBe(true);
		expect(dependencies.has(dependencyKey.file(fixture.actor.path, "exists"))).toBe(true);
		expect(dependencies.has(dependencyKey.file(fixture.actor.path, "frontmatter", "cover"))).toBe(true);
		expect(dependencies.has(dependencyKey.file(fixture.movie.path, "content"))).toBe(false);
		expect(dependencies.has(dependencyKey.file(fixture.actor.path, "content"))).toBe(false);
	});

	it("loads only the final linked body in a multi-hop chain", async () => {
		const fixture = createChainFixture();
		const core = new ReactiveDataCore(fixture.app, new InvalidationEngine<string>(() => undefined));
		core.bootstrap([fixture.movie, fixture.actor, fixture.secret]);
		const session = core.beginRuntimeRender();

		const value = await resolveRuntimePropertyChain(session, [
			{ key: "cast", index: 0 },
			{ key: "puchi" },
			{ key: "content" },
		], fixture.movie);

		expect(value).toBe("secret body");
		expect(fixture.readsFor(fixture.movie)).toBe(0);
		expect(fixture.readsFor(fixture.actor)).toBe(0);
		expect(fixture.readsFor(fixture.secret)).toBe(1);
		const dependencies = session.dependencies();
		expect(dependencies.has(dependencyKey.file(fixture.actor.path, "frontmatter", "puchi"))).toBe(true);
		expect(dependencies.has(dependencyKey.file(fixture.actor.path, "content"))).toBe(false);
		expect(dependencies.has(dependencyKey.file(fixture.secret.path, "content"))).toBe(true);
	});

	it("keeps the last file source path while traversing nested plain values", async () => {
		const fixture = createChainFixture();
		const core = new ReactiveDataCore(fixture.app, new InvalidationEngine<string>(() => undefined));
		core.bootstrap([fixture.movie, fixture.actor, fixture.secret]);
		const session = core.beginRuntimeRender();

		const value = await resolveRuntimePropertyChain(session, [
			{ key: "profile" },
			{ key: "ref" },
			{ key: "basename" },
		], fixture.movie);

		expect(value).toBe("Actor");
		expect(fixture.resolveCalls()).toContainEqual({
			linkPath: "People/Actor",
			sourcePath: fixture.movie.path,
		});
		expect(fixture.totalReads()).toBe(0);
	});

	it("uses an already-loaded root body while still tracking content revision", async () => {
		const fixture = createChainFixture();
		const core = new ReactiveDataCore(fixture.app, new InvalidationEngine<string>(() => undefined));
		core.bootstrap([fixture.movie, fixture.actor, fixture.secret]);
		const session = core.beginRuntimeRender();

		const value = await resolveRuntimePropertyChain(
			session,
			[{ key: "content" }],
			fixture.movie,
			{ rootBody: "live editor body" },
		);

		expect(value).toBe("live editor body");
		expect(fixture.totalReads()).toBe(0);
		expect(session.dependencies().has(
			dependencyKey.file(fixture.movie.path, "content"),
		)).toBe(true);
	});

	it("preserves Bases and baseViews built-in precedence without false frontmatter reads", async () => {
		const fixture = createChainFixture();
		const core = new ReactiveDataCore(fixture.app, new InvalidationEngine<string>(() => undefined));
		core.bootstrap([fixture.movie, fixture.actor, fixture.secret]);
		const rootSession = core.beginRuntimeRender();

		const rootValue = await resolveRuntimePropertyChain(
			rootSession,
			[{ key: "baseViews" }, { key: "length" }],
			fixture.movie,
			{ rootBases: ["a", "b", "c"] },
		);

		expect(rootValue).toBe(3);
		expect(rootSession.dependencies().has(
			dependencyKey.file(fixture.movie.path, "frontmatter", "baseViews"),
		)).toBe(false);

		const linkedSession = core.beginRuntimeRender();
		const linkedValue = await resolveRuntimePropertyChain(linkedSession, [
			{ key: "cast", index: 0 },
			{ key: "bases" },
			{ key: "length" },
		], fixture.movie, { rootBases: ["root-only"] });

		expect(linkedValue).toBe(0);
		expect(linkedSession.dependencies().has(
			dependencyKey.file(fixture.actor.path, "frontmatter", "bases"),
		)).toBe(false);
		expect(fixture.totalReads()).toBe(0);
	});

	it("keeps legacy renderer precedence for tags as a frontmatter property", async () => {
		const fixture = createChainFixture();
		const core = new ReactiveDataCore(fixture.app, new InvalidationEngine<string>(() => undefined));
		core.bootstrap([fixture.movie, fixture.actor, fixture.secret]);
		const session = core.beginRuntimeRender();

		const value = await resolveRuntimePropertyChain(
			session,
			[{ key: "tags", index: 0 }],
			fixture.movie,
		);

		expect(value).toBe("frontmatter-tag");
		const dependencies = session.dependencies();
		expect(dependencies.has(
			dependencyKey.file(fixture.movie.path, "frontmatter", "tags"),
		)).toBe(true);
		expect(dependencies.has(dependencyKey.file(fixture.movie.path, "tags"))).toBe(false);
		expect(fixture.totalReads()).toBe(0);
	});
});

function createChainFixture(): {
	app: App;
	movie: TFile;
	actor: TFile;
	secret: TFile;
	readsFor(file: TFile): number;
	totalReads(): number;
	resolveCalls(): readonly { linkPath: string; sourcePath: string }[];
} {
	const movie = createFile("Movies/Movie.md");
	const actor = createFile("People/Actor.md");
	const secret = createFile("Secrets/Secret.md");
	const frontmatter = new Map<string, Record<string, unknown>>([
		[movie.path, {
			cast: ["[[People/Actor]]"],
			profile: { ref: "[[People/Actor|Actor alias]]" },
			bases: "frontmatter should not win",
			baseViews: "frontmatter should not win",
			tags: ["frontmatter-tag"],
		}],
		[actor.path, {
			cover: ["actor-cover-1", "actor-cover-2"],
			puchi: "[[Secrets/Secret]]",
			bases: ["linked frontmatter should not win"],
		}],
		[secret.path, { title: "Secret" }],
	]);
	const rawContent = new Map<string, string>([
		[movie.path, "---\ncast: []\n---\nmovie body"],
		[actor.path, "---\ncover: []\n---\nactor body"],
		[secret.path, "---\ntitle: Secret\n---\nsecret body"],
	]);
	const resolutions = new Map<string, TFile>([
		[`${movie.path}\u0000People/Actor`, actor],
		[`${actor.path}\u0000Secrets/Secret`, secret],
	]);
	const resolveLog: { linkPath: string; sourcePath: string }[] = [];
	const readCounts = new Map<string, number>();

	const app = {
		metadataCache: {
			getFirstLinkpathDest(linkPath: string, sourcePath: string) {
				resolveLog.push({ linkPath, sourcePath });
				return resolutions.get(`${sourcePath}\u0000${linkPath}`) ?? null;
			},
			getFileCache(file: TFile) {
				return {
					frontmatter: frontmatter.get(file.path) ?? {},
					tags: [{ tag: "#cache-only" }],
					links: [],
				};
			},
		},
		vault: {
			async cachedRead(file: TFile) {
				readCounts.set(file.path, (readCounts.get(file.path) ?? 0) + 1);
				return rawContent.get(file.path) ?? "";
			},
		},
	} as unknown as App;

	return {
		app,
		movie,
		actor,
		secret,
		readsFor: file => readCounts.get(file.path) ?? 0,
		totalReads: () => Array.from(readCounts.values()).reduce((sum, count) => sum + count, 0),
		resolveCalls: () => resolveLog.slice(),
	};
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
