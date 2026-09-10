import type { App, Component, TFile } from "obsidian";
import type { DependencyCollector } from "../core/dependencies";

type StringMap<T> = Record<string, T>;
type BaseSourceKind = "template" | "code-block" | "file-embed";
type BaseColumnKind = "file" | "note" | "formula" | "unknown";

type LocatedItem = {
	index: number;
	line: number;
};

type NamedColumn = {
	id: string;
	key: string;
	name: string;
};

type FileIdentity = {
	name: string;
	basename: string;
	path: string;
	folder: string;
	ext: string;
	link: string;
};

type ViewIdentity = {
	key?: string;
	name: string;
	type: string;
	index: number;
};

type RequestHost = {
	app: App;
	file: TFile;
	ownerDocument: Document;
	component: Component;
};

type RequestText = {
	templateContent: string;
	sourceContent: string;
};

export type TemplateBaseScalar = null | boolean | number | string;

export interface TemplateBaseObject {
	[key: string]: TemplateBaseValue;
}

export interface TemplateBaseList extends Array<TemplateBaseValue> {
	[index: number]: TemplateBaseValue;
}

export type TemplateBaseValue =
	| TemplateBaseScalar
	| TemplateBaseList
	| TemplateBaseObject;

export type TemplateBaseSource = LocatedItem & {
	kind: BaseSourceKind;
	path?: string;
	name?: string;
};

export type TemplateBaseColumn = NamedColumn & {
	type: BaseColumnKind;
};

export type TemplateBaseCell = TemplateBaseColumn & {
	value: TemplateBaseValue;
	text: string;
};

export type TemplateBaseFile = FileIdentity & {
	properties: StringMap<TemplateBaseValue>;
	[key: string]: TemplateBaseValue | StringMap<TemplateBaseValue>;
};

export type TemplateBaseRow = {
	file: TemplateBaseFile;
	values: StringMap<TemplateBaseValue>;
	text: StringMap<string>;
	cells: Array<TemplateBaseCell>;
};

export type TemplateBaseView = ViewIdentity & {
	source: TemplateBaseSource;
	columns: Array<TemplateBaseColumn>;
	rows: Array<TemplateBaseRow>;
	rowCount: number;
	error?: string;
};

export type TemplateBases = Array<TemplateBaseView>;

export type EmbeddedBasesRequest = RequestHost & RequestText & {
	dependencyCollector?: DependencyCollector;
	settingsViewId?: string;
};

export type BasesDataProvider = {
	getEmbeddedBases(request: EmbeddedBasesRequest): Promise<TemplateBases>;
};
