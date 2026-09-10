import { readFile, writeFile } from "node:fs/promises";

async function replaceExact(path, before, after, expectedCount = 1) {
  const source = await readFile(path, "utf8");
  const count = source.split(before).length - 1;
  if (count !== expectedCount) {
    throw new Error(`${path}: expected ${expectedCount} exact matches, found ${count}`);
  }
  await writeFile(path, source.split(before).join(after));
}

await replaceExact(
  "src/render/keyed-dom-reconciler.ts",
  `function normalizeNodes(value: Node | readonly Node[] | null | undefined): Node[] {\n\tif (value === null || value === undefined) return [];\n\tif (Array.isArray(value)) return Array.from(value);\n\treturn [value as Node];\n}`,
  `function normalizeNodes(value: Node | readonly Node[] | null | undefined): Node[] {\n\tif (value === null || value === undefined) return [];\n\tif (isNodeArray(value)) return Array.from(value);\n\treturn [value];\n}\n\nfunction isNodeArray(value: Node | readonly Node[]): value is readonly Node[] {\n\treturn Array.isArray(value);\n}`,
);

await replaceExact(
  "src/renderer.ts",
  `import type { ExprContext, ExprValueArray } from "./expression";`,
  `import type { ExprContext } from "./expression";`,
);

await replaceExact(
  "src/renderer.ts",
  `\t\tbases: bases as unknown as ExprValueArray,`,
  `\t\tbases,`,
  2,
);

console.log("0.1.3 strict source transform applied successfully");
