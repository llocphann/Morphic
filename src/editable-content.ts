import {
	RangeSet,
	RangeSetBuilder,
	StateField,
	type Extension,
	type Transaction,
} from "@codemirror/state";
import {
	Decoration,
	EditorView,
	WidgetType,
	type DecorationSet,
} from "@codemirror/view";

interface LineDocument {
	lines: number;
	line(number: number): { text: string; from: number; to: number };
}

export interface FrontmatterRange {
	from: number;
	to: number;
}

export function detectFrontmatterRange(doc: LineDocument): FrontmatterRange | null {
	if (doc.lines < 2 || !isDelimiter(doc.line(1).text)) return null;

	let closingLine = 2;
	while (closingLine <= doc.lines) {
		const line = doc.line(closingLine);
		if (isDelimiter(line.text)) {
			return {
				from: 0,
				to: closingLine < doc.lines ? line.to + 1 : line.to,
			};
		}
		closingLine++;
	}
	return null;
}

class HiddenFrontmatterWidget extends WidgetType {
	eq(other: HiddenFrontmatterWidget): boolean {
		return other instanceof HiddenFrontmatterWidget;
	}

	toDOM(): HTMLElement {
		const node = activeDocument.win.createDiv();
		node.classList.add("cv-frontmatter-hidden");
		return node;
	}
}

function frontmatterReplacements(doc: LineDocument): DecorationSet {
	const range = detectFrontmatterRange(doc);
	if (range === null) return Decoration.none;
	const ranges = new RangeSetBuilder<Decoration>();
	ranges.add(
		range.from,
		range.to,
		Decoration.replace({ block: true, widget: new HiddenFrontmatterWidget() }),
	);
	return ranges.finish();
}

export const frontmatterHideField: StateField<DecorationSet> = StateField.define({
	create(state) {
		return frontmatterReplacements(state.doc);
	},
	update(previous, transaction: Transaction) {
		return transaction.docChanged
			? frontmatterReplacements(transaction.newDoc)
			: previous;
	},
	provide(field) {
		return EditorView.decorations.from(field);
	},
});

export const frontmatterAtomicRanges = EditorView.atomicRanges.of(view => {
	const range = detectFrontmatterRange(view.state.doc);
	if (range === null) return RangeSet.empty;
	const ranges = new RangeSetBuilder<Decoration>();
	ranges.add(range.from, range.to, Decoration.mark({}));
	return ranges.finish();
});

export const editableContentTheme = EditorView.theme({
	"&": { height: "auto !important", maxHeight: "none !important" },
	".cm-scroller": { overflow: "visible !important" },
});

const EDITABLE_CONTENT_EXTENSIONS: readonly Extension[] = [
	frontmatterHideField,
	frontmatterAtomicRanges,
	editableContentTheme,
];

export function createEditableContentExtensions(): Extension[] {
	return [...EDITABLE_CONTENT_EXTENSIONS];
}

function isDelimiter(line: string): boolean {
	return line.trim() === "---";
}
