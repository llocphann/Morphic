import type { App, TFile, moment } from "obsidian";

export type ExprValueArray = ExprValue[];
export interface ExprValueRecord { [key: string]: ExprValue }

export type ExprValue =
	| string
	| number
	| boolean
	| null
	| undefined
	| ExprValueArray
	| ExprValueRecord
	| ExprFile
	| ExprLink
	| ExprDate
	| ExprRegex;

export interface ExprFile {
	__type: "file";
	name: string;
	basename: string;
	path: string;
	folder: string;
	ext: string;
	size: number;
	ctime: number;
	mtime: number;
	tags: string[];
	links: string[];
	properties: Record<string, ExprValue>;
	bases?: ExprValueArray;
	baseViews?: ExprValueArray;
	_tfile: TFile;
}

export interface ExprLink {
	__type: "link";
	target: string;
	display?: string;
}

export interface ExprDate {
	__type: "date";
	_moment: moment.Moment;
}

export interface ExprRegex {
	__type: "regex";
	pattern: string;
	flags: string;
}

export interface DeferredMarkdownStore {
	nextId: number;
	values: Record<string, ExprValue>;
}

export interface ExprContext {
	app: App;
	file: TFile;
	frontmatter: Record<string, unknown> | undefined;
	bodyContent: string;
	variables: Record<string, ExprValue>;
	bases?: ExprValueArray;
	deferredMarkdown?: DeferredMarkdownStore;
}

export type ExpressionNode =
	| { type: "number"; value: number }
	| { type: "string"; value: string }
	| { type: "regex"; pattern: string; flags: string }
	| { type: "boolean"; value: boolean }
	| { type: "null" }
	| { type: "identifier"; name: string }
	| { type: "arrayAccess"; object: ExpressionNode; index: ExpressionNode }
	| { type: "functionCall"; name: string; args: ExpressionNode[] }
	| { type: "methodCall"; object: ExpressionNode; method: string; args: ExpressionNode[] }
	| { type: "propertyAccess"; object: ExpressionNode; property: string }
	| { type: "binaryOp"; op: string; left: ExpressionNode; right: ExpressionNode }
	| { type: "unaryOp"; op: string; operand: ExpressionNode }
	| { type: "arrayLiteral"; elements: ExpressionNode[] }
	| { type: "lambda"; body: ExpressionNode; param: string };

export enum LexemeKind {
	Number,
	String,
	Identifier,
	Regex,
	LeftParen,
	RightParen,
	LeftBracket,
	RightBracket,
	Dot,
	Comma,
	Operator,
	EOF,
}

export interface Lexeme {
	type: LexemeKind;
	value: string;
	pos: number;
	flags?: string;
}
