#!/usr/bin/env node

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export const PINNED_NPM_VERSION = "11.6.0";
const TARBALL_URL = `https://registry.npmjs.org/npm/-/npm-${PINNED_NPM_VERSION}.tgz`;

function fail(message) {
    console.error(message);
    process.exitCode = 1;
}

async function ensurePinnedNpm() {
    const home = process.env.MORPHIC_PINNED_NPM_HOME
        ?? join(tmpdir(), `morphic-pinned-npm-${PINNED_NPM_VERSION}`);
    const npmCli = join(home, "package", "bin", "npm-cli.js");
    if (existsSync(npmCli)) return npmCli;

    mkdirSync(home, { recursive: true });
    const tarball = join(home, `npm-${PINNED_NPM_VERSION}.tgz`);

    const response = await fetch(TARBALL_URL, { redirect: "follow" });
    if (!response.ok) {
        throw new Error(`Failed to download npm ${PINNED_NPM_VERSION}: HTTP ${response.status}`);
    }
    writeFileSync(tarball, Buffer.from(await response.arrayBuffer()));

    const extractedPackage = join(home, "package");
    rmSync(extractedPackage, { recursive: true, force: true });
    const result = spawnSync("tar", ["-xzf", tarball, "-C", home], {
        stdio: "inherit",
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        throw new Error(`Failed to extract npm ${PINNED_NPM_VERSION} (tar exit ${result.status})`);
    }
    if (!existsSync(npmCli)) {
        throw new Error(`npm CLI missing after extraction: ${npmCli}`);
    }
    return npmCli;
}

async function main() {
    const args = process.argv.slice(2);
    if (args.length === 0 || args[0] === "--help") {
        console.log(`Usage: node scripts/pinned-npm.mjs <npm-args...>\nPinned npm: ${PINNED_NPM_VERSION}`);
        return;
    }

    const npmCli = await ensurePinnedNpm();
    const result = spawnSync(process.execPath, [npmCli, ...args], {
        stdio: "inherit",
        env: process.env,
    });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
}

try {
    await main();
} catch (error) {
    fail(error instanceof Error ? error.stack ?? error.message : String(error));
}
