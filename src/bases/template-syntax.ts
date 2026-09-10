export interface TemplateBaseBlock {
	index: number;
	name?: string;
	content: string;
	start: number;
	end: number;
	line: number;
}

interface SourceLine {
	start: number;
	contentEnd: number;
	nextStart: number;
	text: string;
}

const OPEN_BASE_DIRECTIVE = /^[ \t]*\{%\s*base\b([^%]*)%}[ \t]*$/;
const CLOSE_BASE_DIRECTIVE = /^[ \t]*\{%\s*endbase\s*%}[ \t]*$/;

export function extractTemplateBaseBlocks(template: string): TemplateBaseBlock[] {
	const lines = splitSourceLines(template);
	const found: TemplateBaseBlock[] = [];

	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const opening = OPEN_BASE_DIRECTIVE.exec(lines[lineIndex].text);
		if (!opening) continue;

		const closingIndex = findClosingDirective(lines, lineIndex + 1);
		if (closingIndex < 0) continue;

		const openingLine = lines[lineIndex];
		const closingLine = lines[closingIndex];
		const bodyStart = openingLine.nextStart;
		const bodyEnd = closingLine.start;

		found.push({
			index: found.length,
			name: normalizeBaseName(opening[1] ?? ""),
			content: trimSingleBoundaryNewline(template.slice(bodyStart, bodyEnd)),
			start: openingLine.start,
			end: closingLine.contentEnd,
			line: lineIndex + 1,
		});

		lineIndex = closingIndex;
	}

	return found;
}

export function stripTemplateBaseBlocks(template: string): string {
	const blocks = extractTemplateBaseBlocks(template);
	if (blocks.length === 0) return template;

	let cursor = 0;
	let output = "";
	for (const block of blocks) {
		output += template.slice(cursor, block.start);
		cursor = block.end;
	}
	return output + template.slice(cursor);
}

function splitSourceLines(source: string): SourceLine[] {
	const lines: SourceLine[] = [];
	let start = 0;

	for (let index = 0; index <= source.length; index++) {
		if (index !== source.length && source[index] !== "\n") continue;
		const newlineStart = index;
		const hasCr = newlineStart > start && source[newlineStart - 1] === "\r";
		const contentEnd = hasCr ? newlineStart - 1 : newlineStart;
		const nextStart = index < source.length ? index + 1 : index;
		lines.push({
			start,
			contentEnd,
			nextStart,
			text: source.slice(start, contentEnd),
		});
		start = nextStart;
	}

	return lines;
}

function findClosingDirective(lines: readonly SourceLine[], from: number): number {
	for (let index = from; index < lines.length; index++) {
		if (CLOSE_BASE_DIRECTIVE.test(lines[index].text)) return index;
	}
	return -1;
}

function normalizeBaseName(raw: string): string | undefined {
	const value = raw.trim();
	if (value.length === 0) return undefined;
	if (value.length >= 2) {
		const first = value[0];
		const last = value[value.length - 1];
		if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
			return value.slice(1, -1);
		}
	}
	return value;
}

function trimSingleBoundaryNewline(content: string): string {
	if (content.endsWith("\r\n")) return content.slice(0, -2);
	if (content.endsWith("\n")) return content.slice(0, -1);
	return content;
}
