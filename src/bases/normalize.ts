import {
	BasesView,
	type BasesPropertyId,
	ListValue,
	NullValue,
	TFile,
	Value,
	parsePropertyId,
} from "obsidian";
import type {
	TemplateBaseCell,
	TemplateBaseColumn,
	TemplateBaseFile,
	TemplateBaseRow,
	TemplateBaseSource,
	TemplateBaseValue,
	TemplateBaseView,
} from "./types";

export interface NormalizeBaseMetadata {
	sourceKind: "template" | "code-block" | "file-embed";
	sourceIndex: number;
	sourceLine: number;
	sourcePath?: string;
	sourceName?: string;
	viewIndex: number;
	viewName: string;
	originalType: string;
}

export function normalizeBasesView(view: BasesView, metadata: NormalizeBaseMetadata): TemplateBaseView {
	const columns = makeColumns(view);
	const rows = (view.data?.data ?? []).map(entry => makeRow(view, entry, columns));

	return makeViewEnvelope(metadata, {
		columns,
		rows,
		rowCount: rows.length,
	});
}

export function createBaseErrorView(metadata: NormalizeBaseMetadata, error: string): TemplateBaseView {
	return makeViewEnvelope(metadata, {
		columns: [],
		rows: [],
		rowCount: 0,
		error,
	});
}

function makeViewEnvelope(
	metadata: NormalizeBaseMetadata,
	payload: Pick<TemplateBaseView, "columns" | "rows" | "rowCount"> & { error?: string },
): TemplateBaseView {
	return {
		key: metadata.sourceName ?? metadata.viewName,
		name: metadata.viewName,
		type: metadata.originalType,
		index: metadata.viewIndex,
		source: makeSource(metadata),
		...payload,
	};
}

function makeSource(metadata: NormalizeBaseMetadata): TemplateBaseSource {
	return {
		kind: metadata.sourceKind,
		index: metadata.sourceIndex,
		line: metadata.sourceLine,
		path: metadata.sourcePath,
		name: metadata.sourceName,
	};
}

function makeColumns(view: BasesView): TemplateBaseColumn[] {
	return (view.data?.properties ?? []).map(propertyId => {
		const parsed = describeProperty(propertyId);
		return {
			id: propertyId,
			key: parsed.key,
			name: displayNameFor(view, propertyId, parsed.key),
			type: parsed.type,
		};
	});
}

function makeRow(
	view: BasesView,
	entry: NonNullable<BasesView["data"]>["data"][number],
	columns: readonly TemplateBaseColumn[],
): TemplateBaseRow {
	const values: Record<string, TemplateBaseValue> = {};
	const text: Record<string, string> = {};
	const cells: TemplateBaseCell[] = [];

	for (const column of columns) {
		const nativeValue = entry.getValue(column.id as BasesPropertyId);
		const value = fromBasesValue(nativeValue);
		const rendered = nativeValue == null || nativeValue === NullValue.value
			? ""
			: nativeValue.toString();

		cells.push({ ...column, value, text: rendered });
		putFirst(values, column.id, value);
		putFirst(values, column.key, value);
		putFirst(text, column.id, rendered);
		putFirst(text, column.key, rendered);
	}

	return {
		file: makeFile(entry.file, frontmatterFor(view, entry.file)),
		values,
		text,
		cells,
	};
}

function describeProperty(propertyId: string): Pick<TemplateBaseColumn, "key" | "type"> {
	try {
		const parsed = parsePropertyId(propertyId as BasesPropertyId);
		return { key: parsed.name, type: parsed.type };
	} catch {
		return { key: propertyId, type: "unknown" };
	}
}

function displayNameFor(view: BasesView, propertyId: string, fallback: string): string {
	try {
		return view.config.getDisplayName(propertyId as BasesPropertyId);
	} catch {
		return fallback;
	}
}

function makeFile(file: TFile, frontmatter: Record<string, unknown> | undefined): TemplateBaseFile {
	const slash = file.path.lastIndexOf("/");
	const properties = convertFrontmatter(frontmatter);
	const result: TemplateBaseFile = {
		name: file.name,
		basename: file.basename,
		path: file.path,
		folder: slash < 0 ? "" : file.path.slice(0, slash),
		ext: file.extension,
		link: `[[${file.path.replace(/\.md$/i, "")}|${file.basename}]]`,
		properties,
	};

	for (const key of Object.keys(properties)) {
		if (!Object.prototype.hasOwnProperty.call(result, key)) result[key] = properties[key];
	}
	return result;
}

function fromBasesValue(value: Value | null): TemplateBaseValue {
	if (value == null || value === NullValue.value) return null;
	if (!(value instanceof ListValue)) return value.toString();

	const result: TemplateBaseValue[] = [];
	for (let index = 0; index < value.length(); index++) {
		result.push(fromBasesValue(value.get(index)));
	}
	return result;
}

function convertFrontmatter(frontmatter: Record<string, unknown> | undefined): Record<string, TemplateBaseValue> {
	const result: Record<string, TemplateBaseValue> = {};
	for (const [key, raw] of Object.entries(frontmatter ?? {})) {
		if (key === "position") continue;
		result[key] = convertPlainValue(raw);
	}
	return result;
}

function convertPlainValue(value: unknown): TemplateBaseValue {
	if (value == null) return null;
	switch (typeof value) {
		case "string":
		case "number":
		case "boolean":
			return value;
		case "object": {
			if (Array.isArray(value)) return value.map(convertPlainValue);
			const result: Record<string, TemplateBaseValue> = {};
			for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
				result[key] = convertPlainValue(child);
			}
			return result;
		}
		default:
			return null;
	}
}

function frontmatterFor(view: BasesView, file: TFile): Record<string, unknown> | undefined {
	const withApp = view as BasesView & { app?: BasesView["app"] };
	return withApp.app?.metadataCache.getFileCache(file)?.frontmatter;
}

function putFirst<T>(target: Record<string, T>, key: string, value: T): void {
	if (!Object.prototype.hasOwnProperty.call(target, key)) target[key] = value;
}
