import { LexemeKind, type Lexeme } from "./model";

const TWO_CHAR_OPERATORS = new Set(["==", "!=", "<=", ">=", "&&", "||", "**"]);
const ONE_CHAR_OPERATORS = new Set(["+", "-", "*", "/", "%", "<", ">", "!", "|"]);

export function tokenizeExpression(source: string): Lexeme[] {
	const tokens: Lexeme[] = [];
	let cursor = 0;

	while (cursor < source.length) {
		const character = source[cursor];
		if (/\s/.test(character)) {
			cursor++;
			continue;
		}

		if (isNumberStart(source, cursor)) {
			const start = cursor;
			cursor = readNumberEnd(source, cursor);
			tokens.push({ type: LexemeKind.Number, value: source.slice(start, cursor), pos: start });
			continue;
		}

		if (character === '"' || character === "'") {
			const string = readString(source, cursor);
			tokens.push({ type: LexemeKind.String, value: string.value, pos: cursor });
			cursor = string.end;
			continue;
		}

		if (character === "/" && regexMayStartAfter(tokens[tokens.length - 1])) {
			const regex = readRegex(source, cursor);
			if (regex) {
				tokens.push({
					type: LexemeKind.Regex,
					value: regex.pattern,
					flags: regex.flags,
					pos: cursor,
				});
				cursor = regex.end;
				continue;
			}
		}

		if (cursor + 2 < source.length) {
			const strict = source.slice(cursor, cursor + 3);
			if (strict === "===" || strict === "!==") {
				tokens.push({
					type: LexemeKind.Operator,
					value: strict === "===" ? "==" : "!=",
					pos: cursor,
				});
				cursor += 3;
				continue;
			}
		}

		const pair = source.slice(cursor, cursor + 2);
		if (TWO_CHAR_OPERATORS.has(pair)) {
			tokens.push({ type: LexemeKind.Operator, value: pair, pos: cursor });
			cursor += 2;
			continue;
		}

		const punctuation = punctuationKind(character);
		if (punctuation !== undefined) {
			tokens.push({ type: punctuation, value: character, pos: cursor });
			cursor++;
			continue;
		}

		if (ONE_CHAR_OPERATORS.has(character)) {
			tokens.push({ type: LexemeKind.Operator, value: character, pos: cursor });
			cursor++;
			continue;
		}

		if (/[A-Za-z_]/.test(character)) {
			const start = cursor++;
			while (cursor < source.length && /[A-Za-z0-9_-]/.test(source[cursor])) cursor++;
			tokens.push({ type: LexemeKind.Identifier, value: source.slice(start, cursor), pos: start });
			continue;
		}

		cursor++;
	}

	tokens.push({ type: LexemeKind.EOF, value: "", pos: source.length });
	return tokens;
}

function punctuationKind(character: string): LexemeKind | undefined {
	switch (character) {
		case "(": return LexemeKind.LeftParen;
		case ")": return LexemeKind.RightParen;
		case "[": return LexemeKind.LeftBracket;
		case "]": return LexemeKind.RightBracket;
		case ".": return LexemeKind.Dot;
		case ",": return LexemeKind.Comma;
		default: return undefined;
	}
}

function isNumberStart(source: string, cursor: number): boolean {
	if (/\d/.test(source[cursor])) return true;
	return source[cursor] === "." && /\d/.test(source[cursor + 1] ?? "");
}

function readNumberEnd(source: string, start: number): number {
	let cursor = start;
	while (/\d/.test(source[cursor] ?? "")) cursor++;
	if (source[cursor] === ".") {
		cursor++;
		while (/\d/.test(source[cursor] ?? "")) cursor++;
	}
	return cursor;
}

function readString(source: string, start: number): { value: string; end: number } {
	const quote = source[start];
	let cursor = start + 1;
	let value = "";
	while (cursor < source.length) {
		const character = source[cursor++];
		if (character === quote) return { value, end: cursor };
		if (character !== "\\" || cursor >= source.length) {
			value += character;
			continue;
		}
		const escaped = source[cursor++];
		if (escaped === "n") value += "\n";
		else if (escaped === "t") value += "\t";
		else value += escaped;
	}
	return { value, end: cursor };
}

function regexMayStartAfter(previous: Lexeme | undefined): boolean {
	if (!previous) return true;
	return ![
		LexemeKind.Number,
		LexemeKind.String,
		LexemeKind.Identifier,
		LexemeKind.Regex,
		LexemeKind.RightParen,
		LexemeKind.RightBracket,
	].includes(previous.type);
}

function readRegex(source: string, start: number): { pattern: string; flags: string; end: number } | undefined {
	let cursor = start + 1;
	let escaped = false;
	let inClass = false;
	let pattern = "";

	while (cursor < source.length) {
		const character = source[cursor];
		if (character === "\n" || character === "\r") return undefined;
		if (escaped) {
			pattern += character;
			escaped = false;
			cursor++;
			continue;
		}
		if (character === "\\") {
			pattern += character;
			escaped = true;
			cursor++;
			continue;
		}
		if (character === "[") {
			inClass = true;
			pattern += character;
			cursor++;
			continue;
		}
		if (character === "]" && inClass) {
			inClass = false;
			pattern += character;
			cursor++;
			continue;
		}
		if (character === "/" && !inClass) {
			cursor++;
			const flagsStart = cursor;
			while (/[A-Za-z]/.test(source[cursor] ?? "")) cursor++;
			return { pattern, flags: source.slice(flagsStart, cursor), end: cursor };
		}
		pattern += character;
		cursor++;
	}
	return undefined;
}
