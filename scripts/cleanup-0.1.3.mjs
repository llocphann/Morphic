import { readFile, writeFile } from "node:fs/promises";

async function replaceExact(path, before, after, expectedCount = 1) {
  const source = await readFile(path, "utf8");
  const count = source.split(before).length - 1;
  if (count !== expectedCount) {
    throw new Error(`${path}: expected ${expectedCount} exact matches, found ${count}`);
  }
  await writeFile(path, source.split(before).join(after));
}

async function appendUnique(path, marker, content) {
  const source = await readFile(path, "utf8");
  if (source.includes(marker)) throw new Error(`${path}: marker already exists: ${marker}`);
  await writeFile(path, `${source.trimEnd()}\n\n${content.trim()}\n`);
}

// Static capability CSS belongs in styles.css, not a runtime <style> element.
await replaceExact(
  "src/assigned-property-type-invalidation.ts",
  `\t\tregisterCapabilityStyles(lifecycle);\n`,
  ``,
);
await replaceExact(
  "src/assigned-property-type-invalidation.ts",
  `\nfunction registerCapabilityStyles(lifecycle: LifecycleRegistrar): void {\n\tconst style = activeWindow.createEl("style");\n\tstyle.setAttribute("data-morphic-cv04-capabilities", "true");\n\tstyle.textContent = \`\n.workspace-leaf-content.cv-hide-navigation > .view-header {\n\tdisplay: none;\n}\n.morphic-navigation-hold {\n\tbackground: var(--background-primary);\n}\n\`;\n\tactiveDocument.head.appendChild(style);\n\tlifecycle.register(() => style.remove());\n}\n`,
  `\n`,
);
await appendUnique(
  "styles.css",
  ".workspace-leaf-content.cv-hide-navigation > .view-header",
  `.workspace-leaf-content.cv-hide-navigation > .view-header {\n    display: none;\n}\n\n.morphic-navigation-hold {\n    background: var(--background-primary);\n}`,
);

// Keep active-window DOM creation typed through the owning Document realm.
await replaceExact(
  "src/editable-content.ts",
  `activeWindow.createDiv()`,
  `activeDocument.win.createDiv()`,
);
await replaceExact(
  "src/native-filters/api.ts",
  `activeWindow.createDiv()`,
  `activeDocument.win.createDiv()`,
);

// Apply the exact owner-document helpers requested by obsidianmd/prefer-create-el.
const replacements = [
  ["src/bases/embed-transport.ts", `this.ownerDocument.createElement("div")`, `this.ownerDocument.win.createDiv()`, 1],
  ["src/main.ts", `container.ownerDocument.createElement("div")`, `container.ownerDocument.win.createDiv()`, 3],
  ["src/native-filters/api.ts", `this.host.ownerDocument.createElement("div")`, `this.host.ownerDocument.win.createDiv()`, 1],
  ["src/native-filters/editor.ts", `document.createElement("p")`, `document.win.createEl("p")`, 1],
  ["src/native-filters/editor.ts", `document.createElement("button")`, `document.win.createEl("button")`, 1],
  ["src/render/obsidian-content-island.ts", `context.ownerDocument.createElement("div")`, `context.ownerDocument.win.createDiv()`, 1],
  ["src/render/retained-detached-generation-host.ts", `this.ownerDocument.createElement("div")`, `this.ownerDocument.win.createDiv()`, 1],
  ["src/render/retained-editable-dom-runtime.ts", `ownerDocument.createElement("div")`, `ownerDocument.win.createDiv()`, 1],
  ["src/render/retained-production-simple-structural-owner.ts", `ownerDocument.createElement("div")`, `ownerDocument.win.createDiv()`, 1],
  ["src/render/retained-production-simple-structural-owner.ts", `ownerDocument.createDocumentFragment()`, `ownerDocument.win.createFragment()`, 1],
  ["src/render/retained-slot-runtime.ts", `this.ownerDocument.createDocumentFragment()`, `this.ownerDocument.win.createFragment()`, 1],
  ["src/render/retained-slot-runtime.ts", `binding.element.ownerDocument.createElement("div")`, `binding.element.ownerDocument.win.createDiv()`, 1],
  ["src/render/retained-static-owner-surface.ts", `ownerDocument.createElement("div")`, `ownerDocument.win.createDiv()`, 1],
  ["src/render/retained-template-dom-plan.ts", `context.ownerDocument.createElement("span")`, `context.ownerDocument.win.createSpan()`, 1],
  ["src/render/retained-template-dom-plan.ts", `context.ownerDocument.createElement("div")`, `context.ownerDocument.win.createDiv()`, 1],
  ["src/render/retained-template-dom-plan.ts", `ownerDocument.createDocumentFragment()`, `ownerDocument.win.createFragment()`, 1],
  ["src/render/scoped-keyed-slot-runtime.ts", `ownerDocument.createElement("div")`, `ownerDocument.win.createDiv()`, 1],
  ["src/renderer.ts", `container.ownerDocument.createElement("div")`, `container.ownerDocument.win.createDiv()`, 1],
];
for (const [path, before, after, count] of replacements) {
  await replaceExact(path, before, after, count);
}

// Per-view CSS is dynamic user content, so keep it dynamic without injecting <style>.
await replaceExact(
  "src/renderer.ts",
  `type ScopedContainer = HTMLElement & { __cvScopeObserver?: MutationObserver | null };`,
  `type ScopedContainer = HTMLElement & {\n\t__cvScopeObserver?: MutationObserver | null;\n\t__cvStyleSheet?: CSSStyleSheet | null;\n};\n\nfunction removeAdoptedStyleSheet(ownerDocument: Document, styleSheet: CSSStyleSheet): void {\n\tconst sheets = ownerDocument.adoptedStyleSheets;\n\tif (!sheets.includes(styleSheet)) return;\n\townerDocument.adoptedStyleSheets = sheets.filter((sheet) => sheet !== styleSheet);\n}`,
);
await replaceExact(
  "src/renderer.ts",
  `\t// Disconnect any previous CSS-scoping MutationObserver from a prior render\n\tconst scoped = container as ScopedContainer;\n\tif (scoped.__cvScopeObserver) { scoped.__cvScopeObserver.disconnect(); scoped.__cvScopeObserver = null; }`,
  `\t// Disconnect resources from a prior render before replacing the container.\n\tconst scoped = container as ScopedContainer;\n\tif (scoped.__cvScopeObserver) { scoped.__cvScopeObserver.disconnect(); scoped.__cvScopeObserver = null; }\n\tif (scoped.__cvStyleSheet) {\n\t\tremoveAdoptedStyleSheet(container.ownerDocument, scoped.__cvStyleSheet);\n\t\tscoped.__cvStyleSheet = null;\n\t}`,
);
await replaceExact(
  "src/renderer.ts",
  `\t// Inject CSS from the separate CSS field (with template resolution)\n\tif (viewConfig?.css) {\n\t\tconst resolvedCss = await resolveTemplateRaw(app, viewConfig.css, file, frontmatter, bodyContent, bases, runtimeData);\n\t\tif (resolvedCss.trim()) {\n\t\t\tconst styleEl = container.ownerDocument.createElement("style");\n\t\t\tstyleEl.textContent = resolvedCss;\n\t\t\tcontainer.prepend(styleEl);\n\t\t}\n\t}`,
  `\t// Apply per-view CSS as a constructable stylesheet so dynamic user CSS stays\n\t// lifecycle-bound without injecting a forbidden <style> element.\n\tif (viewConfig?.css) {\n\t\tconst resolvedCss = await resolveTemplateRaw(app, viewConfig.css, file, frontmatter, bodyContent, bases, runtimeData);\n\t\tif (resolvedCss.trim()) {\n\t\t\tconst StyleSheetConstructor = container.ownerDocument.defaultView?.CSSStyleSheet;\n\t\t\tif (!StyleSheetConstructor) throw new Error("Constructable stylesheets are unavailable in this document");\n\t\t\tconst styleSheet = new StyleSheetConstructor();\n\t\t\tawait styleSheet.replace(resolvedCss);\n\t\t\tconst ownerDocument = container.ownerDocument;\n\t\t\townerDocument.adoptedStyleSheets = [...ownerDocument.adoptedStyleSheets, styleSheet];\n\t\t\tscoped.__cvStyleSheet = styleSheet;\n\t\t\tcomponent.register(() => removeAdoptedStyleSheet(ownerDocument, styleSheet));\n\t\t}\n\t}`,
);

console.log("0.1.3 strict source cleanup applied successfully");
