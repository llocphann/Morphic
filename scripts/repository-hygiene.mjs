#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const FORBIDDEN_EXACT_PATHS = new Set([
    "AGENTS.md",
    "HANDOFF.md",
    "package-lock.json",
    "main.js",
    "src/wasm.d.ts",
]);

const FORBIDDEN_PREFIXES = [
    ".codex/",
    "docs/BOT3_",
    "docs/BOT4_",
    "docs/core-v2/BOT",
    "docs/core-v2/final-p7-performance-evidence/",
];

const REQUIRED_PATHS = [
    "README.md",
    "CHANGELOG.md",
    "CONTRIBUTING.md",
    "LICENSE",
    "NOTICE",
    "manifest.json",
    "package.json",
    "versions.json",
    "docs/README.md",
    "docs/CORE_V2.md",
    "docs/performance/competitive-custom-views-0.4.0.md",
    "docs/provenance/CUSTOM_VIEWS_0.4.0_AUDIT.md",
    "docs/release/FINAL_RELEASE_CHECKLIST.md",
    "scripts/competitive-benchmark.mjs",
    "scripts/provenance-audit.mjs",
    "scripts/check-release-metadata.mjs",
    "scripts/repository-hygiene.mjs",
    "scripts/pinned-npm.mjs",
];

// Construct these at runtime so the guard does not match its own source text.
const FORBIDDEN_TEXT_MARKERS = [
    "core-v2-" + "rewrite",
    "https://github.com/llocphann/" + "obsidian-custom-views",
];

const TEXT_EXTENSIONS = new Set([
    ".md",
    ".json",
    ".yml",
    ".yaml",
    ".ts",
    ".tsx",
    ".js",
    ".mjs",
    ".css",
]);

function runGit(args) {
    const result = spawnSync("git", args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status !== 0) {
        const detail = (result.stderr || result.stdout || "").trim();
        throw new Error(`git ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
    }
    return result.stdout.trim();
}

function extension(path) {
    const index = path.lastIndexOf(".");
    return index >= 0 ? path.slice(index) : "";
}

function shouldScanText(path) {
    return TEXT_EXTENSIONS.has(extension(path));
}

function main() {
    const tracked = runGit(["ls-files"]).split("\n").filter(Boolean);
    const trackedSet = new Set(tracked);
    const failures = [];

    for (const path of tracked) {
        if (FORBIDDEN_EXACT_PATHS.has(path)) {
            failures.push(`forbidden tracked path: ${path}`);
        }
        for (const prefix of FORBIDDEN_PREFIXES) {
            if (path.startsWith(prefix)) failures.push(`obsolete tracked path: ${path}`);
        }
    }

    for (const path of REQUIRED_PATHS) {
        if (!trackedSet.has(path) || !existsSync(path)) failures.push(`required repository path is missing: ${path}`);
    }

    for (const path of tracked) {
        if (!shouldScanText(path) || !existsSync(path)) continue;
        let source;
        try {
            source = readFileSync(path, "utf8");
        } catch {
            continue;
        }
        for (const marker of FORBIDDEN_TEXT_MARKERS) {
            if (source.includes(marker)) failures.push(`obsolete repository marker ${JSON.stringify(marker)} in ${path}`);
        }
    }

    if (failures.length > 0) {
        for (const failure of [...new Set(failures)]) console.error(failure);
        process.exitCode = 1;
        return;
    }

    console.log(`Repository hygiene verified (${tracked.length} tracked paths).`);
}

try {
    main();
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
}
