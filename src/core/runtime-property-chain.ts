import type { TFile } from "obsidian";
import { buildBasesCollection } from "../bases/access";
import { dependencyKey } from "./dependencies";
import type { TrackedFileSnapshot } from "./file-snapshot";
import type { RuntimeDataSession } from "./runtime-data";

/** Parsed property segment shared with renderer/compiler adapters. */
export interface RuntimePropertySegment {
	readonly key: string;
	readonly index?: number;
}

export interface RuntimePropertyChainOptions {
	/** Already-loaded root body (for example from an active MarkdownView). */
	readonly rootBody?: string;
	/** Already-collected Bases values for the root file. Linked files see an empty collection. */
	readonly rootBases?: readonly unknown[];
}

type RuntimeChainContext =
	| {
		readonly kind: "file";
		readonly path: string;
		readonly snapshot: TrackedFileSnapshot;
		readonly root: boolean;
	}
	| {
		readonly kind: "value";
		readonly value: unknown;
	};

/**
 * Resolve a property chain with runtime dependency tracking and lazy file bodies.
 *
 * Every file/frontmatter/stat read records its exact dependency through
 * `RuntimeDataSession`. Wiki-link traversal records the conservative vault file-set
 * dependency plus the exact resolved target existence key. Body text is loaded only
 * when the chain explicitly asks for `content`; intermediate linked files remain
 * metadata-only.
 */
export async function resolveRuntimePropertyChain(
	session: RuntimeDataSession,
	segments: readonly RuntimePropertySegment[],
	file: TFile,
	options: RuntimePropertyChainOptions = {},
): Promise<unknown> {
	if (segments.length === 0) return null;

	let context: RuntimeChainContext = {
		kind: "file",
		path: file.path,
		snapshot: session.file(file),
		root: true,
	};
	let linkSourcePath = file.path;

	for (let index = 0; index < segments.length; index++) {
		const segment = segments[index];
		let value: unknown = context.kind === "file"
			? await resolveFileSegment(session, context, segment.key, options)
			: resolvePlainValueSegment(context.value, segment.key);

		if (value === undefined) return null;
		if (segment.index !== undefined) value = applySegmentIndex(value, segment.index);
		if (value === null || value === undefined) return null;
		if (index === segments.length - 1) return value;

		if (canTraversePlainValue(value)) {
			context = { kind: "value", value };
			continue;
		}

		const linkTarget = extractRuntimeWikiLink(typeof value === "string" ? value : "");
		if (!linkTarget) return null;

		const resolved = session.resolveFileTarget(linkTarget, linkSourcePath);
		if (!resolved) return null;
		linkSourcePath = resolved.path;
		context = {
			kind: "file",
			path: resolved.path,
			snapshot: resolved.snapshot,
			root: false,
		};
	}

	return null;
}

/** Extract `target` from `[[target]]` or `[[target|alias]]`. */
export function extractRuntimeWikiLink(value: string): string | null {
	if (typeof value !== "string") return null;
	const match = value.trim().match(/^\[\[([^\]|]+)(?:\|[^\]]+)?\]\]$/);
	return match ? match[1].trim() : null;
}

async function resolveFileSegment(
	session: RuntimeDataSession,
	context: Extract<RuntimeChainContext, { kind: "file" }>,
	key: string,
	options: RuntimePropertyChainOptions,
): Promise<unknown> {
	const snapshot = context.snapshot;

	if (key === "name") return snapshot.fileField("name");
	if (key === "basename") return snapshot.fileField("basename");
	if (key === "path") return snapshot.fileField("path");
	if (key === "folder") return snapshot.fileField("folder");
	if (key === "ext" || key === "extension") return snapshot.fileField("extension");
	if (key === "size") return snapshot.stat("size");
	if (key === "ctime") return snapshot.stat("ctime");
	if (key === "mtime") return snapshot.stat("mtime");
	if (key === "content") {
		if (context.root && options.rootBody !== undefined) {
			session.snapshots.collector.track(dependencyKey.file(context.path, "content"));
			return options.rootBody;
		}
		return snapshot.body();
	}
	if (key === "bases" || key === "baseViews") {
		return buildBasesCollection(context.root ? options.rootBases ?? [] : []);
	}

	return snapshot.property(key);
}

function resolvePlainValueSegment(value: unknown, key: string): unknown {
	if (Array.isArray(value)) {
		if (key === "length") return value.length;
		return (value as unknown as Record<string, unknown>)[key];
	}
	if (isRecord(value)) return value[key];
	return undefined;
}

function applySegmentIndex(value: unknown, index: number): unknown {
	if (!Array.isArray(value)) return null;
	return index < value.length ? value[index] : null;
}

function canTraversePlainValue(value: unknown): boolean {
	return Array.isArray(value) || isRecord(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
