// eslint-disable-next-line no-restricted-imports
import momentLibrary from "moment";

function installObsidianDomHelpers(): void {
	if (typeof window === "undefined" || typeof document === "undefined") return;

	const windowPrototype = Window.prototype;
	if (typeof windowPrototype.createDiv !== "function") {
		windowPrototype.createDiv = function (): HTMLDivElement {
			return this.document.createElement("div");
		};
	}
	if (typeof windowPrototype.createSpan !== "function") {
		windowPrototype.createSpan = function (): HTMLSpanElement {
			return this.document.createElement("span");
		};
	}
	if (typeof windowPrototype.createEl !== "function") {
		windowPrototype.createEl = function <K extends keyof HTMLElementTagNameMap>(
			tagName: K,
		): HTMLElementTagNameMap[K] {
			return this.document.createElement(tagName);
		};
	}
	if (typeof windowPrototype.createFragment !== "function") {
		windowPrototype.createFragment = function (): DocumentFragment {
			return this.document.createDocumentFragment();
		};
	}

	const detachedDocumentWindows = new WeakMap<Document, Window>();
	const getDocumentWindow = (ownerDocument: Document): Window => {
		if (ownerDocument.defaultView) return ownerDocument.defaultView;
		const cached = detachedDocumentWindows.get(ownerDocument);
		if (cached) return cached;

		const facade = Object.create(window) as Window;
		Object.defineProperty(facade, "document", {
			configurable: true,
			value: ownerDocument,
		});
		detachedDocumentWindows.set(ownerDocument, facade);
		return facade;
	};

	if (Object.getOwnPropertyDescriptor(Document.prototype, "win") === undefined) {
		Object.defineProperty(Document.prototype, "win", {
			configurable: true,
			get(this: Document): Window {
				return getDocumentWindow(this);
			},
		});
	}
}

installObsidianDomHelpers();

export const moment = momentLibrary;

export class App {}

export class Plugin {
	app = new App();
	registerBasesView(): boolean { return true; }
}

interface ParentShape { path: string }
interface FileStatShape { ctime: number; mtime: number; size: number }

class AbstractPathItem {
	path = "";
	name = "";
	parent: ParentShape | null = null;
}

export class TAbstractFile extends AbstractPathItem {}

export class TFile extends AbstractPathItem {
	basename = "";
	extension = "md";
	stat: FileStatShape = { ctime: 0, mtime: 0, size: 0 };
}

export class TFolder extends AbstractPathItem {
	children: unknown[] = [];
	isRoot(): boolean { return false; }
}

export class Component {
	private cleanupStack: Array<() => void> = [];
	private disposed = false;

	load(): void {}
	onload(): void {}
	onunload(): void {}

	unload(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const dispose of this.cleanupStack.splice(0).reverse()) dispose();
		this.onunload();
	}

	addChild<T extends Component>(component: T): T { return component; }
	removeChild<T extends Component>(component: T): T { return component; }

	register(dispose: () => void): void {
		if (this.disposed) dispose();
		else this.cleanupStack.push(dispose);
	}

	registerDomEvent(
		target: EventTarget,
		type: string,
		listener: EventListenerOrEventListenerObject,
		options?: boolean | AddEventListenerOptions,
	): void {
		target.addEventListener(type, listener, options);
		this.register(() => target.removeEventListener(type, listener, options));
	}
}

export const MarkdownRenderer = {
	async render(_app: unknown, markdown: string, element: HTMLElement): Promise<void> {
		element.textContent = markdown;
	},
};

export class MarkdownView {}
export class PluginSettingTab {}
export class Setting {}
export class Modal {}
export class Notice {}
export class FuzzySuggestModal {}
export class ButtonComponent {}
export class TextComponent {}
export class WorkspaceLeaf {}

export class AbstractInputSuggest {
	limit = 100;
	constructor(_app: unknown, _input: unknown) {}
	close(): void {}
	onSelect(_callback: unknown): this { return this; }
}

export class QueryController extends Component {}

export abstract class Value {
	static equals(left: Value | null, right: Value | null): boolean { return left === right; }
	static looseEquals(left: Value | null, right: Value | null): boolean { return left === right; }
	abstract toString(): string;
	abstract isTruthy(): boolean;
	renderTo(element: HTMLElement): void { element.textContent = this.toString(); }
}

export class NullValue extends Value {
	static value = new NullValue();
	toString(): string { return ""; }
	isTruthy(): boolean { return false; }
}

export class StringValue extends Value {
	constructor(private readonly value: string) { super(); }
	toString(): string { return this.value; }
	isTruthy(): boolean { return this.value.length > 0; }
}

export class ListValue extends Value {
	constructor(private readonly values: unknown[]) { super(); }
	toString(): string { return this.values.map(stringifyMockValue).join(", "); }
	isTruthy(): boolean { return this.values.length > 0; }
	length(): number { return this.values.length; }
	get(index: number): Value { return asValue(this.values[index]); }
}

export abstract class BasesView extends Component {
	abstract type: string;
	app = new App();
	config = {
		name: "",
		get: () => null,
		getDisplayName: (propertyId: string) => propertyId,
	};
	allProperties: string[] = [];
	data = { data: [], properties: [] };
	protected constructor(_controller: QueryController) { super(); }
	abstract onDataUpdated(): void;
}

export class Menu {
	static forEvent(_event: unknown): Menu { return new Menu(); }
	addItem(): this { return this; }
	addSeparator(): this { return this; }
	showAtMouseEvent(): this { return this; }
	showAtPosition(): this { return this; }
}

export const Keymap = { isModEvent: () => false };
export function setIcon(): void {}
export function getAllTags(): never[] { return []; }
export function prepareFuzzySearch(): () => null { return () => null; }
export function renderResults(): void {}

export function parsePropertyId(propertyId: string): { type: "file" | "note" | "formula"; name: string } {
	const separator = propertyId.indexOf(".");
	const type = separator < 0 ? propertyId : propertyId.slice(0, separator);
	if (type !== "file" && type !== "note" && type !== "formula") {
		throw new Error("Invalid property ID");
	}
	return {
		type,
		name: separator < 0 ? "" : propertyId.slice(separator + 1),
	};
}

export function stringifyYaml(value: unknown): string {
	return JSON.stringify(value);
}

export function parseYaml(source: string): unknown {
	const text = source.trim();
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return text === "views: []" ? { views: [] } : {};
	}
}

function asValue(value: unknown): Value {
	if (value instanceof Value) return value;
	if (value == null) return NullValue.value;
	return new StringValue(stringifyPrimitive(value));
}

function stringifyMockValue(value: unknown): string {
	return value instanceof Value ? value.toString() : stringifyPrimitive(value);
}

function stringifyPrimitive(value: unknown): string {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return "";
}
