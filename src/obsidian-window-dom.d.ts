export {};

declare global {
    interface Window {
        createDiv(): HTMLDivElement;
        createSpan(): HTMLSpanElement;
        createEl<K extends keyof HTMLElementTagNameMap>(tagName: K): HTMLElementTagNameMap[K];
        createFragment(): DocumentFragment;
    }
}
