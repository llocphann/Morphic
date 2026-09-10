import type { App, FrontMatterCache, TFile } from "obsidian";
import type { ViewConfig } from "../types";
import { checkRules } from "../matcher";
import { getNativeBasesApi, type NativeBasesApi, type ParsedFilter } from "./api";

const MAX_PARSED_FILTERS = 128;

export class NativeRuleEngine {
	private nativeApi: NativeBasesApi | undefined;
	private readonly parsed = new Map<string, ParsedFilter | null>();
	private recovery: Promise<void> | undefined;

	constructor(
		private readonly app: App,
		private readonly onReady: () => void = () => {},
	) {}

	async prepare(): Promise<void> {
		this.nativeApi = await getNativeBasesApi(this.app);
	}

	clear(): void {
		this.parsed.clear();
	}

	matches(view: ViewConfig, file: TFile, frontmatter?: FrontMatterCache): boolean {
		if (view.basesFilters === undefined) {
			return checkRules(this.app, view.rules, file, frontmatter);
		}
		if (view.basesFilters === null) return true;

		const api = this.nativeApi;
		if (!api) {
			this.scheduleRecovery();
			return false;
		}

		try {
			const parsed = this.getParsedFilter(api, view.basesFilters);
			return parsed === null || (!parsed.hasError() && api.test(parsed, file));
		} catch {
			return false;
		}
	}

	private getParsedFilter(api: NativeBasesApi, source: NonNullable<ViewConfig["basesFilters"]>): ParsedFilter | null {
		const cacheKey = JSON.stringify(source);
		if (this.parsed.has(cacheKey)) return this.parsed.get(cacheKey) ?? null;

		const parsed = api.parse(source).filters ?? null;
		this.parsed.set(cacheKey, parsed);
		this.trimCache();
		return parsed;
	}

	private trimCache(): void {
		while (this.parsed.size > MAX_PARSED_FILTERS) {
			const first = this.parsed.keys().next();
			if (first.done) return;
			this.parsed.delete(first.value);
		}
	}

	private scheduleRecovery(): void {
		if (this.recovery) return;
		this.recovery = getNativeBasesApi(this.app)
			.then(api => {
				this.nativeApi = api;
				this.onReady();
			})
			.catch(() => {
				// Keep fail-closed behavior; a later match attempt may retry discovery.
			})
			.finally(() => {
				this.recovery = undefined;
			});
	}
}
