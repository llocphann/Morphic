#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const UPSTREAM_REPOSITORY = "https://github.com/anupchavan/obsidian-custom-views.git";
const UPSTREAM_COMMIT = "1d9f2e99c3bfcc82dd9d657ead65fffadbdac0f5";
const DEFAULT_JSON = "provenance-audit.json";
const DEFAULT_MARKDOWN = "provenance-audit.md";

function usage() {
    console.log(`Morphic source provenance audit\n\nUsage:\n  node scripts/provenance-audit.mjs [options]\n\nOptions:\n  --upstream <path>   Use an existing checkout of the frozen upstream commit.\n  --output <path>     JSON output path (default: ${DEFAULT_JSON}).\n  --markdown <path>   Markdown output path (default: ${DEFAULT_MARKDOWN}).\n  --include-tests     Include test files in similarity review.\n  --strict            Exit non-zero if exact or high-similarity candidates exist.\n  --help              Show this help.\n\nWithout --upstream, the script clones the public upstream repository into a temporary directory and checks out ${UPSTREAM_COMMIT}.\n`);
}

function parseArgs(argv) {
    const options = {
        upstream: undefined,
        output: DEFAULT_JSON,
        markdown: DEFAULT_MARKDOWN,
        includeTests: false,
        strict: false,
    };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === "--help") {
            usage();
            process.exit(0);
        }
        if (arg === "--include-tests") {
            options.includeTests = true;
            continue;
        }
        if (arg === "--strict") {
            options.strict = true;
            continue;
        }
        if (["--upstream", "--output", "--markdown"].includes(arg)) {
            const value = argv[i + 1];
            if (!value) throw new Error(`${arg} requires a value`);
            i += 1;
            if (arg === "--upstream") options.upstream = value;
            if (arg === "--output") options.output = value;
            if (arg === "--markdown") options.markdown = value;
            continue;
        }
        throw new Error(`Unknown argument: ${arg}`);
    }
    return options;
}

function run(command, args, options = {}) {
    const result = spawnSync(command, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        ...options,
    });
    if (result.status !== 0) {
        const detail = (result.stderr || result.stdout || "").trim();
        throw new Error(`${command} ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
    }
    return result.stdout.trim();
}

function sha256(buffer) {
    return createHash("sha256").update(buffer).digest("hex");
}

function tokenize(source) {
    return source.match(
        /[A-Za-z_$][A-Za-z0-9_$]*|\d+(?:\.\d+)?|===|!==|=>|\?\?|\?\.|&&|\|\||<=|>=|==|!=|\+\+|--|\*\*|[{}()[\].,:;?~+\-*\/%<>=!&|^]|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g,
    ) ?? [];
}

function fnv1a(text) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
}

function shingleSet(tokens, width = 5) {
    const set = new Set();
    if (tokens.length < width) {
        if (tokens.length > 0) set.add(fnv1a(tokens.join("\u0000")));
        return set;
    }
    for (let i = 0; i <= tokens.length - width; i += 1) {
        set.add(fnv1a(tokens.slice(i, i + width).join("\u0000")));
    }
    return set;
}

function jaccard(left, right) {
    if (left.size === 0 && right.size === 0) return 1;
    if (left.size === 0 || right.size === 0) return 0;
    const smaller = left.size <= right.size ? left : right;
    const larger = smaller === left ? right : left;
    let intersection = 0;
    for (const value of smaller) if (larger.has(value)) intersection += 1;
    return intersection / (left.size + right.size - intersection);
}

function isIgnoredPath(path, includeTests) {
    const normalized = path.replaceAll("\\", "/");
    if (normalized.startsWith("node_modules/") || normalized.startsWith(".git/")) return true;
    if (!includeTests && (normalized.includes("/__tests__/") || normalized.includes("/__benchmarks__/"))) return true;
    if (normalized.startsWith("docs/") || normalized.startsWith(".github/")) return true;
    if (["LICENSE", "LICENSE-MIT-ORIGINAL", "NOTICE", "README.md", "CHANGELOG.md", "CONTRIBUTING.md", "HANDOFF.md"].includes(normalized)) return true;
    return false;
}

function isAuditableFile(path) {
    if (path === "styles.css") return true;
    if (path.startsWith("src/") || path.startsWith("__mocks__/")) {
        return [".ts", ".tsx", ".js", ".mjs", ".css"].includes(extname(path));
    }
    return ["esbuild.config.mjs", "eslint.config.mjs", "version-bump.mjs"].includes(path);
}

function walk(root, includeTests) {
    const files = [];
    const visit = (directory) => {
        for (const entry of readdirSync(directory)) {
            const absolute = join(directory, entry);
            const path = relative(root, absolute).replaceAll("\\", "/");
            if (isIgnoredPath(path, includeTests)) continue;
            const stats = statSync(absolute);
            if (stats.isDirectory()) {
                visit(absolute);
                continue;
            }
            if (!stats.isFile() || !isAuditableFile(path)) continue;
            const buffer = readFileSync(absolute);
            const source = buffer.toString("utf8");
            const tokens = tokenize(source);
            files.push({
                path,
                basename: basename(path),
                bytes: buffer.length,
                sha256: sha256(buffer),
                tokens: tokens.length,
                shingles: shingleSet(tokens),
            });
        }
    };
    visit(root);
    return files;
}

function chooseBestCandidate(file, upstreamFiles) {
    let best;
    for (const candidate of upstreamFiles) {
        if (file.sha256 === candidate.sha256) {
            return { candidate, similarity: 1, exact: true };
        }
        const larger = Math.max(file.tokens, candidate.tokens, 1);
        const smaller = Math.min(file.tokens, candidate.tokens);
        if (smaller / larger < 0.25) continue;
        const similarity = jaccard(file.shingles, candidate.shingles);
        const pathBonus = file.path === candidate.path ? 0.02 : 0;
        const basenameBonus = file.basename === candidate.basename ? 0.01 : 0;
        const score = Math.min(1, similarity + pathBonus + basenameBonus);
        if (!best || score > best.score) {
            best = { candidate, similarity, score, exact: false };
        }
    }
    return best ?? { candidate: undefined, similarity: 0, exact: false };
}

function classification(exact, similarity, tokenCount) {
    if (exact) return "EXACT";
    if (tokenCount < 20) return "TRIVIAL_REVIEW";
    if (similarity >= 0.75) return "REVIEW_HIGH";
    if (similarity >= 0.4) return "REVIEW_MEDIUM";
    return "REVIEW_LOW";
}

function round(value) {
    return Math.round(value * 10_000) / 10_000;
}

function markdown(report) {
    const lines = [
        "# Morphic provenance audit result",
        "",
        `- Morphic commit: \`${report.morphic.commit}\``,
        `- Upstream commit: \`${report.upstream.commit}\``,
        `- Generated: ${report.generatedAt}`,
        `- Files reviewed: ${report.summary.files}`,
        `- Exact candidates: ${report.summary.EXACT ?? 0}`,
        `- High-similarity candidates: ${report.summary.REVIEW_HIGH ?? 0}`,
        `- Medium-similarity candidates: ${report.summary.REVIEW_MEDIUM ?? 0}`,
        "",
        "> Similarity is a triage signal, not a legal conclusion. Every EXACT/HIGH/MEDIUM candidate still requires human source-provenance review.",
        "",
        "| Morphic file | Best upstream candidate | Similarity | Classification |",
        "| --- | --- | ---: | --- |",
    ];
    for (const item of report.files) {
        lines.push(`| \`${item.path}\` | ${item.upstreamPath ? `\`${item.upstreamPath}\`` : "—"} | ${item.similarity.toFixed(4)} | **${item.classification}** |`);
    }
    lines.push("");
    return `${lines.join("\n")}\n`;
}

function resolveUpstream(options) {
    if (options.upstream) {
        const path = resolve(options.upstream);
        const commit = run("git", ["-C", path, "rev-parse", "HEAD"]);
        if (commit !== UPSTREAM_COMMIT) {
            throw new Error(`--upstream must be checked out at ${UPSTREAM_COMMIT}; got ${commit}`);
        }
        return { path, cleanup: undefined };
    }

    const tempRoot = mkdtempSync(join(tmpdir(), "morphic-provenance-"));
    const path = join(tempRoot, "custom-views");
    run("git", ["clone", "--quiet", "--filter=blob:none", "--no-checkout", UPSTREAM_REPOSITORY, path]);
    run("git", ["-C", path, "checkout", "--quiet", UPSTREAM_COMMIT]);
    return { path, cleanup: () => rmSync(tempRoot, { recursive: true, force: true }) };
}

function main() {
    const options = parseArgs(process.argv.slice(2));
    const morphicRoot = resolve(process.cwd());
    const morphicCommit = run("git", ["-C", morphicRoot, "rev-parse", "HEAD"]);
    const upstream = resolveUpstream(options);

    try {
        const morphicFiles = walk(morphicRoot, options.includeTests);
        const upstreamFiles = walk(upstream.path, options.includeTests);
        const files = morphicFiles.map((file) => {
            const best = chooseBestCandidate(file, upstreamFiles);
            const similarity = best.exact ? 1 : best.similarity;
            return {
                path: file.path,
                sha256: file.sha256,
                bytes: file.bytes,
                tokens: file.tokens,
                upstreamPath: best.candidate?.path ?? null,
                upstreamSha256: best.candidate?.sha256 ?? null,
                similarity: round(similarity),
                classification: classification(best.exact, similarity, file.tokens),
            };
        }).sort((left, right) => {
            const rank = { EXACT: 0, REVIEW_HIGH: 1, REVIEW_MEDIUM: 2, TRIVIAL_REVIEW: 3, REVIEW_LOW: 4 };
            return (rank[left.classification] ?? 99) - (rank[right.classification] ?? 99)
                || right.similarity - left.similarity
                || left.path.localeCompare(right.path);
        });

        const summary = { files: files.length };
        for (const file of files) summary[file.classification] = (summary[file.classification] ?? 0) + 1;
        const report = {
            schema: 1,
            generatedAt: new Date().toISOString(),
            morphic: { commit: morphicCommit },
            upstream: {
                repository: UPSTREAM_REPOSITORY,
                commit: UPSTREAM_COMMIT,
            },
            parameters: {
                includeTests: options.includeTests,
                shingleWidth: 5,
                highThreshold: 0.75,
                mediumThreshold: 0.4,
            },
            summary,
            files,
        };

        writeFileSync(resolve(options.output), `${JSON.stringify(report, null, 2)}\n`);
        writeFileSync(resolve(options.markdown), markdown(report));
        console.log(markdown(report));

        if (options.strict && ((summary.EXACT ?? 0) > 0 || (summary.REVIEW_HIGH ?? 0) > 0)) {
            process.exitCode = 2;
        }
    } finally {
        upstream.cleanup?.();
    }
}

try {
    main();
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
}
