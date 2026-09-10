import type { CachedMetadata } from "obsidian";

export interface FrontmatterStripContext {
	readonly endOffset: number | undefined;
	readonly hasFrontmatter: boolean;
}

type LegacyFrontmatterShape = {
	position?: { end?: { offset?: number } };
};

export function captureFrontmatterStripContext(
	cache: CachedMetadata | null | undefined,
): FrontmatterStripContext {
	if (!cache) return Object.freeze({ endOffset: undefined, hasFrontmatter: false });
	const legacy = cache.frontmatter as LegacyFrontmatterShape | undefined;
	return Object.freeze({
		endOffset: cache.frontmatterPosition?.end?.offset ?? legacy?.position?.end?.offset,
		hasFrontmatter: Boolean(cache.frontmatterPosition ?? cache.frontmatter),
	});
}

export function stripFrontmatterWithContext(
	context: FrontmatterStripContext,
	raw: string,
): string {
	const cachedBoundary = context.endOffset;
	if (cachedBoundary !== undefined && boundaryMatches(raw, cachedBoundary)) {
		return bodyAfter(raw, cachedBoundary);
	}
	if (!context.hasFrontmatter) return raw;

	const scannedBoundary = scanYamlBoundary(raw);
	return scannedBoundary === undefined ? raw : bodyAfter(raw, scannedBoundary);
}

export function stripFrontmatter(
	cache: CachedMetadata | null | undefined,
	raw: string,
): string {
	return stripFrontmatterWithContext(captureFrontmatterStripContext(cache), raw);
}

function boundaryMatches(raw: string, boundary: number): boolean {
	if (boundary < 0 || boundary > raw.length) return false;
	if (!hasOpeningFence(raw)) return boundary === 0;
	if (boundary === 0) return false;

	const line = lineEndingAt(raw, boundary);
	return line?.trim() === "---";
}

function scanYamlBoundary(raw: string): number | undefined {
	if (!hasOpeningFence(raw)) return undefined;
	let cursor = afterFirstLine(raw);

	while (cursor <= raw.length) {
		const lineEnd = nextLineEnd(raw, cursor);
		const contentEnd = lineEnd > cursor && raw[lineEnd - 1] === "\r" ? lineEnd - 1 : lineEnd;
		if (raw.slice(cursor, contentEnd) === "---") return lineEnd;
		if (lineEnd >= raw.length) break;
		cursor = lineEnd + 1;
	}
	return undefined;
}

function hasOpeningFence(raw: string): boolean {
	const end = nextLineEnd(raw, 0);
	const contentEnd = end > 0 && raw[end - 1] === "\r" ? end - 1 : end;
	return raw.slice(0, contentEnd) === "---" && end < raw.length;
}

function afterFirstLine(raw: string): number {
	const end = nextLineEnd(raw, 0);
	return end < raw.length ? end + 1 : raw.length;
}

function nextLineEnd(raw: string, from: number): number {
	const newline = raw.indexOf("\n", from);
	return newline < 0 ? raw.length : newline;
}

function lineEndingAt(raw: string, boundary: number): string | undefined {
	let lineEnd = boundary;
	if (lineEnd > 0 && raw[lineEnd - 1] === "\n") lineEnd--;
	if (lineEnd > 0 && raw[lineEnd - 1] === "\r") lineEnd--;
	const previousNewline = raw.lastIndexOf("\n", Math.max(0, lineEnd - 1));
	const lineStart = previousNewline < 0 ? 0 : previousNewline + 1;
	return raw.slice(lineStart, lineEnd);
}

function bodyAfter(raw: string, boundary: number): string {
	return raw.slice(boundary).trim();
}
