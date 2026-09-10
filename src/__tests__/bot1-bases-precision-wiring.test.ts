import { Component, TFile, type App, type Plugin } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { EmbeddedBasesProvider } from "../bases/provider";
import type { EmbeddedBasesRequest, TemplateBaseView } from "../bases/types";
import {
	DependencyCollector,
	RevisionStore,
	dependencyKey,
	propertyDataDependencyKey,
	type DependencyKey,
} from "../core";

interface TestProviderInternals {
	getCollectorBase(
		request: EmbeddedBasesRequest,
		baseContent: string,
		metadata: {
			sourceKind: "template" | "code-block" | "file-embed";
			sourceIndex: number;
			sourceLine: number;
			viewIndex: number;
			viewName: string;
			originalType: string;
		},
		dependencies: readonly DependencyKey[],
	): Promise<TemplateBaseView>;
	createRenderJobsForConfig(
		request: EmbeddedBasesRequest,
		sourceContent: string,
		source: {
			sourceKind: "template" | "code-block" | "file-embed";
			sourceIndex: number;
			sourceLine: number;
			sourcePath?: string;
			sourceName?: string;
			viewName?: string;
		},
	): Promise<TemplateBaseView>[];
	runCollectorBase: (...args: unknown[]) => Promise<TemplateBaseView>;
}

function file(path: string): TFile {
	const value = new TFile();
	value.path = path;
	value.name = path.split("/").pop() ?? path;
	value.basename = value.name.replace(/\.[^.]+$/, "");
	value.extension = value.name.split(".").pop() ?? "";
	value.parent = null;
	value.stat = { ctime: 1, mtime: 1, size: 1 };
	return value;
}

function baseView(name: string): TemplateBaseView {
	return {
		name,
		type: "table",
		index: 0,
		source: { kind: "code-block", index: 0, line: 1 },
		columns: [],
		rows: [],
		rowCount: 0,
	};
}

function request(collector?: DependencyCollector): EmbeddedBasesRequest {
	return {
		app: {} as App,
		file: file("Notes/Root.md"),
		templateContent: "",
		sourceContent: "",
		ownerDocument: document,
		component: new Component(),
		dependencyCollector: collector,
		settingsViewId: "view-1",
	};
}

describe("Bot 1 precise Bases integration", () => {
	it("reuses warm data across irrelevant revisions and reloads on relevant revisions", async () => {
		const revisions = new RevisionStore();
		const provider = new EmbeddedBasesProvider({ app: {} as App } as Plugin, revisions);
		const internals = provider as unknown as TestProviderInternals;
		let loads = 0;
		vi.spyOn(internals, "runCollectorBase").mockImplementation(async () => baseView(`load-${++loads}`));

		const metadata = {
			sourceKind: "code-block" as const,
			sourceIndex: 0,
			sourceLine: 1,
			viewIndex: 0,
			viewName: "All",
			originalType: "table",
		};
		const relevant = propertyDataDependencyKey("status");
		const dependencies = [dependencyKey.index("files"), relevant];

		const first = await internals.getCollectorBase(request(), "views: []", metadata, dependencies);
		const warm = await internals.getCollectorBase(request(), "views: []", metadata, dependencies);
		expect(first.name).toBe("load-1");
		expect(warm.name).toBe("load-1");
		expect(loads).toBe(1);

		revisions.bump(propertyDataDependencyKey("unrelated"));
		const irrelevant = await internals.getCollectorBase(request(), "views: []", metadata, dependencies);
		expect(irrelevant.name).toBe("load-1");
		expect(loads).toBe(1);

		revisions.bump(relevant);
		const changed = await internals.getCollectorBase(request(), "views: []", metadata, dependencies);
		expect(changed.name).toBe("load-2");
		expect(loads).toBe(2);
	});

	it("derives native Base query dependencies and forwards them to the render collector", async () => {
		const provider = new EmbeddedBasesProvider({ app: {} as App } as Plugin, new RevisionStore());
		const internals = provider as unknown as TestProviderInternals;
		const collector = new DependencyCollector();
		const captured: DependencyKey[][] = [];
		vi.spyOn(internals, "getCollectorBase").mockImplementation(async (_request, _content, _metadata, dependencies) => {
			captured.push([...dependencies]);
			return baseView("All");
		});

		const jobs = internals.createRenderJobsForConfig(
			request(collector),
			JSON.stringify({
				filters: { and: ['note.status == "open"'] },
				views: [{ type: "table", name: "All" }],
			}),
			{
				sourceKind: "code-block",
				sourceIndex: 0,
				sourceLine: 1,
			},
		);
		await Promise.all(jobs);

		const expectedProperty = propertyDataDependencyKey("status");
		expect(captured).toHaveLength(1);
		expect(captured[0]).toContain(dependencyKey.index("files"));
		expect(captured[0]).toContain(expectedProperty);
		expect(collector.has(dependencyKey.index("files"))).toBe(true);
		expect(collector.has(expectedProperty)).toBe(true);
		expect(collector.has(dependencyKey.file("Notes/Root.md", "content"))).toBe(true);
	});
});
