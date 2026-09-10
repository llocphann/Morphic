export interface EmbeddedBaseBlock {
	index: number;
	content: string;
	start: number;
	end: number;
	line: number;
}

export interface EmbeddedBaseFileLink {
	index: number;
	target: string;
	viewName?: string;
	display?: string;
	start: number;
	end: number;
	line: number;
}

export interface CollectorBaseDocument {
	sourceIndex: number;
	viewIndex: number;
	viewName: string;
	originalType: string;
	config: Record<string, unknown>;
}

interface BaseViewConfig extends Record<string, unknown> {
	name: string;
	type: string;
}

interface SourceLine {
	start: number;
	contentEnd: number;
	nextStart: number;
	text: string;
}

export function extractEmbeddedBaseBlocks(markdown: string): EmbeddedBaseBlock[] {
	const lines = splitLines(markdown);
	const result: EmbeddedBaseBlock[] = [];

	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const fence = readBaseFence(lines[lineIndex].text);
		if (!fence) continue;

		const closeIndex = findFenceClose(lines, lineIndex + 1, fence);
		if (closeIndex < 0) continue;

		const opening = lines[lineIndex];
		const closing = lines[closeIndex];
		let content = markdown.slice(opening.nextStart, closing.start);
		if (content.endsWith("\r\n")) content = content.slice(0, -2);
		else if (content.endsWith("\n")) content = content.slice(0, -1);

		result.push({
			index: result.length,
			content,
			start: opening.start,
			end: closing.contentEnd,
			line: lineIndex + 1,
		});
		lineIndex = closeIndex;
	}

	return result;
}

export function extractEmbeddedBaseFileLinks(markdown: string): EmbeddedBaseFileLink[] {
	const result: EmbeddedBaseFileLink[] = [];
	let cursor = 0;

	while (cursor < markdown.length) {
		const start = markdown.indexOf("![[", cursor);
		if (start < 0) break;
		const endMarker = markdown.indexOf("]]", start + 3);
		if (endMarker < 0) break;

		const payload = markdown.slice(start + 3, endMarker);
		if (!payload.includes("\n") && !payload.includes("\r")) {
			const parsed = parseBaseLinkPayload(payload);
			if (parsed) {
				result.push({
					index: result.length,
					...parsed,
					start,
					end: endMarker + 2,
					line: lineAt(markdown, start),
				});
			}
		}
		cursor = endMarker + 2;
	}

	return result;
}

export function createCollectorBaseDocuments(
	baseConfig: unknown,
	sourceIndex: number,
	viewName?: string,
): CollectorBaseDocument[] {
	if (!isObjectRecord(baseConfig)) return [];
	const sourceViews = isUnknownArray(baseConfig.views) ? baseConfig.views : [];
	const candidates = sourceViews
		.map((view, index) => ({ view, index }))
		.filter((entry): entry is { view: BaseViewConfig; index: number } => isBaseView(entry.view));
	const chosen = viewName === undefined
		? candidates[0]
		: candidates.find(entry => entry.view.name === viewName);
	if (!chosen) return [];

	const configCopy = copyData(baseConfig) as Record<string, unknown>;
	const viewCopy = copyData(chosen.view) as Record<string, unknown>;
	configCopy.views = [viewCopy];

	return [{
		sourceIndex,
		viewIndex: chosen.index,
		viewName: chosen.view.name,
		originalType: chosen.view.type,
		config: configCopy,
	}];
}

export function templateReferencesBases(...templates: (string | undefined)[]): boolean {
	for (const template of templates) {
		if (!template) continue;
		if (containsStandaloneIdentifier(template, "bases")) return true;
		if (containsStandaloneIdentifier(template, "baseViews")) return true;
		if (containsFileMember(template, "bases")) return true;
		if (containsFileMember(template, "baseViews")) return true;
	}
	return false;
}

function splitLines(source: string): SourceLine[] {
	const lines: SourceLine[] = [];
	let start = 0;
	for (let index = 0; index <= source.length; index++) {
		if (index !== source.length && source[index] !== "\n") continue;
		const newline = index;
		const contentEnd = newline > start && source[newline - 1] === "\r" ? newline - 1 : newline;
		const nextStart = index < source.length ? index + 1 : index;
		lines.push({ start, contentEnd, nextStart, text: source.slice(start, contentEnd) });
		start = nextStart;
	}
	return lines;
}

function readBaseFence(line: string): string | undefined {
	let length = 0;
	const marker = line[0];
	if (marker !== "`" && marker !== "~") return undefined;
	while (line[length] === marker) length++;
	if (length < 3) return undefined;

	const rest = line.slice(length);
	const match = /^[ \t]*base(?:[ \t].*)?$/.exec(rest);
	return match ? marker.repeat(length) : undefined;
}

function findFenceClose(lines: readonly SourceLine[], from: number, fence: string): number {
	for (let index = from; index < lines.length; index++) {
		if (lines[index].text.trimEnd() === fence) return index;
	}
	return -1;
}

function parseBaseLinkPayload(payload: string): Pick<EmbeddedBaseFileLink, "target" | "viewName" | "display"> | undefined {
	const pipe = payload.indexOf("|");
	const destination = (pipe < 0 ? payload : payload.slice(0, pipe)).trim();
	const display = pipe < 0 ? undefined : nonEmpty(payload.slice(pipe + 1));
	const hash = destination.indexOf("#");
	const target = (hash < 0 ? destination : destination.slice(0, hash)).trim();
	if (!target.toLowerCase().endsWith(".base")) return undefined;

	return {
		target,
		viewName: hash < 0 ? undefined : nonEmpty(destination.slice(hash + 1)),
		display,
	};
}

function nonEmpty(value: string): string | undefined {
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function lineAt(source: string, offset: number): number {
	let line = 1;
	for (let index = source.indexOf("\n"); index >= 0 && index < offset; index = source.indexOf("\n", index + 1)) {
		line++;
	}
	return line;
}

function containsStandaloneIdentifier(source: string, identifier: string): boolean {
	let offset = source.indexOf(identifier);
	while (offset >= 0) {
		const before = offset === 0 ? "" : source[offset - 1];
		const afterIndex = offset + identifier.length;
		const after = afterIndex >= source.length ? "" : source[afterIndex];
		if (!/[\w$.]/.test(before) && !/[\w$-]/.test(after)) return true;
		offset = source.indexOf(identifier, offset + 1);
	}
	return false;
}

function containsFileMember(source: string, member: string): boolean {
	const needle = `file.${member}`;
	let offset = source.indexOf(needle);
	while (offset >= 0) {
		const before = offset === 0 ? "" : source[offset - 1];
		const afterIndex = offset + needle.length;
		const after = afterIndex >= source.length ? "" : source[afterIndex];
		if (!/[\w$]/.test(before) && !/[\w$-]/.test(after)) return true;
		offset = source.indexOf(needle, offset + 1);
	}
	return false;
}

function copyData(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(copyData);
	if (!isObjectRecord(value)) return value;
	const copy: Record<string, unknown> = {};
	for (const key of Object.keys(value)) copy[key] = copyData(value[key]);
	return copy;
}

function isUnknownArray(value: unknown): value is unknown[] {
	return Array.isArray(value);
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isBaseView(value: unknown): value is BaseViewConfig {
	return isObjectRecord(value)
		&& typeof value.name === "string"
		&& typeof value.type === "string";
}
