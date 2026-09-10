function createDetachedDomFactory(ownerDocument: Document) {
	return {
		createDiv(): HTMLDivElement {
			return ownerDocument.createElement("div");
		},
		createSpan(): HTMLSpanElement {
			return ownerDocument.createElement("span");
		},
		createEl<K extends keyof HTMLElementTagNameMap>(tagName: K): HTMLElementTagNameMap[K] {
			return ownerDocument.createElement(tagName);
		},
		createFragment(): DocumentFragment {
			return ownerDocument.createDocumentFragment();
		},
	};
}

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

	const detachedDocumentFactories = new WeakMap<
		Document,
		ReturnType<typeof createDetachedDomFactory>
	>();

	if (Object.getOwnPropertyDescriptor(Document.prototype, "win") === undefined) {
		Object.defineProperty(Document.prototype, "win", {
			configurable: true,
			get(this: Document) {
				if (this.defaultView) return this.defaultView;
				const cached = detachedDocumentFactories.get(this);
				if (cached) return cached;
				const factory = createDetachedDomFactory(this);
				detachedDocumentFactories.set(this, factory);
				return factory;
			},
		});
	}
}

installObsidianDomHelpers();
