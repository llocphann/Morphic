#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const VERSION = /^\d+\.\d+\.\d+$/;
const MANIFEST_KEYS = new Set([
    "id",
    "name",
    "version",
    "minAppVersion",
    "description",
    "author",
    "authorUrl",
    "fundingUrl",
    "isDesktopOnly",
]);
const FUNDING_URL = "https://www.buymeacoffee.com/llocphann";
const PINNED_NPM = "11.6.0";

function parseArgs(argv) {
    let tag;
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === "--tag") {
            tag = argv[index + 1];
            if (!tag) throw new Error("--tag requires a value");
            index += 1;
            continue;
        }
        if (arg === "--help") {
            console.log("Usage: node scripts/check-release-metadata.mjs [--tag <version-tag>]");
            process.exit(0);
        }
        throw new Error(`Unknown argument: ${arg}`);
    }
    return { tag };
}

function readJson(path) {
    return JSON.parse(readFileSync(path, "utf8"));
}

function isHttpsUrl(value) {
    if (typeof value !== "string") return false;
    try {
        return new URL(value).protocol === "https:";
    } catch {
        return false;
    }
}

export function validateReleaseMetadata({ manifest, pkg, versions, tag }) {
    const failures = [];

    if (manifest.id !== "morphic") failures.push(`manifest id is ${String(manifest.id)}`);
    if (!/^[a-z-]+$/.test(String(manifest.id ?? ""))
        || String(manifest.id ?? "").includes("obsidian")
        || String(manifest.id ?? "").endsWith("plugin")) {
        failures.push(`manifest id violates Obsidian identifier rules: ${String(manifest.id)}`);
    }
    if (manifest.name !== "Morphic") failures.push(`manifest name is ${String(manifest.name)}`);

    if (typeof manifest.version !== "string" || !VERSION.test(manifest.version)) {
        failures.push(`manifest version must use x.y.z: ${String(manifest.version)}`);
    }
    if (manifest.version !== pkg.version) {
        failures.push(`manifest ${String(manifest.version)} != package ${String(pkg.version)}`);
    }
    if (typeof manifest.minAppVersion !== "string" || !VERSION.test(manifest.minAppVersion)) {
        failures.push(`manifest minAppVersion must use x.y.z: ${String(manifest.minAppVersion)}`);
    } else if (versions[manifest.version] !== manifest.minAppVersion) {
        failures.push(`versions.json does not map ${String(manifest.version)} to ${manifest.minAppVersion}`);
    }

    if (typeof manifest.description !== "string" || manifest.description.length === 0) {
        failures.push("manifest description is missing");
    } else {
        if (manifest.description.length > 250) failures.push("manifest description exceeds 250 characters");
        if (!manifest.description.endsWith(".")) failures.push("manifest description must end with a period");
    }
    if (typeof manifest.author !== "string" || manifest.author.length === 0) {
        failures.push("manifest author is missing");
    }
    if (!isHttpsUrl(manifest.authorUrl)) failures.push("manifest authorUrl must be an HTTPS URL");
    if (manifest.fundingUrl !== FUNDING_URL) {
        failures.push(`manifest fundingUrl is ${String(manifest.fundingUrl)}`);
    }
    if (typeof manifest.isDesktopOnly !== "boolean") {
        failures.push("manifest isDesktopOnly must be a boolean");
    }

    for (const key of Object.keys(manifest)) {
        if (!MANIFEST_KEYS.has(key)) failures.push(`unexpected manifest key: ${key}`);
    }

    if (pkg.name !== "morphic") failures.push(`package name is ${String(pkg.name)}`);
    if (pkg.private !== true) failures.push("package must remain private to prevent accidental npm publication");
    if (pkg.license !== "GPL-3.0-only") failures.push(`package license is ${String(pkg.license)}`);
    if (pkg.funding !== FUNDING_URL) failures.push(`package funding is ${String(pkg.funding)}`);
    if (pkg.engines?.node !== "22.x") failures.push(`package Node engine is ${String(pkg.engines?.node)}`);
    if (pkg.engines?.npm !== PINNED_NPM) failures.push(`package npm engine is ${String(pkg.engines?.npm)}`);
    if (pkg.packageManager !== `npm@${PINNED_NPM}`) {
        failures.push(`packageManager is ${String(pkg.packageManager)}`);
    }

    if (tag !== undefined) {
        const normalizedTag = tag.replace(/^v/, "");
        if (!VERSION.test(normalizedTag)) failures.push(`release tag must use x.y.z or vx.y.z: ${tag}`);
        if (normalizedTag !== manifest.version) {
            failures.push(`tag ${normalizedTag} != manifest ${String(manifest.version)}`);
        }
    }

    return failures;
}

function main() {
    const { tag } = parseArgs(process.argv.slice(2));
    const manifest = readJson("manifest.json");
    const pkg = readJson("package.json");
    const versions = readJson("versions.json");
    const failures = validateReleaseMetadata({ manifest, pkg, versions, tag });
    if (failures.length > 0) {
        for (const failure of failures) console.error(failure);
        process.exitCode = 1;
        return;
    }
    console.log(`Release metadata verified for Morphic ${manifest.version}${tag ? ` (${tag})` : ""}`);
}

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedUrl) {
    try {
        main();
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
