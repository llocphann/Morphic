import esbuild from "esbuild";
import { builtinModules } from "node:module";

const production = process.argv.includes("production");

const OBSIDIAN_EXTERNALS = [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
];

const NODE_EXTERNALS = [...new Set(
    builtinModules.flatMap(name => [name, name.startsWith("node:") ? name : `node:${name}`]),
)];

const options = {
    entryPoints: ["src/main.ts"],
    outfile: "main.js",
    bundle: true,
    format: "cjs",
    target: "es2018",
    treeShaking: true,
    minify: production,
    sourcemap: production ? false : "inline",
    logLevel: "info",
    external: [...OBSIDIAN_EXTERNALS, ...NODE_EXTERNALS],
    banner: {
        js: "/* Morphic bundle generated from repository source with esbuild. */",
    },
};

if (production) {
    await esbuild.build(options);
} else {
    const context = await esbuild.context(options);
    await context.watch();
}
