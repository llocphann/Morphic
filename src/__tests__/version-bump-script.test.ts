import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const scriptPath = resolve(process.cwd(), "version-bump.mjs");
const tempDirs: string[] = [];

function createFixture(): string {
	const dir = mkdtempSync(join(tmpdir(), "morphic-version-bump-"));
	tempDirs.push(dir);
	writeFileSync(join(dir, "manifest.json"), JSON.stringify({
		id: "morphic",
		version: "0.3.2",
		minAppVersion: "1.11.10",
	}, null, 2));
	writeFileSync(join(dir, "versions.json"), JSON.stringify({
		"0.3.2": "1.11.10",
	}, null, 2));
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("version-bump.mjs", () => {
	it("records every new plugin version even when minAppVersion is unchanged", () => {
		const cwd = createFixture();
		const result = spawnSync(process.execPath, [scriptPath], {
			cwd,
			env: { ...process.env, npm_package_version: "0.4.0" },
			encoding: "utf8",
		});

		expect(result.status, result.stderr).toBe(0);
		const manifest = JSON.parse(readFileSync(join(cwd, "manifest.json"), "utf8"));
		const versions = JSON.parse(readFileSync(join(cwd, "versions.json"), "utf8"));
		expect(manifest.version).toBe("0.4.0");
		expect(versions["0.4.0"]).toBe("1.11.10");
	});

	it("fails rather than writing undefined version metadata", () => {
		const cwd = createFixture();
		const env = { ...process.env };
		delete env.npm_package_version;
		const result = spawnSync(process.execPath, [scriptPath], {
			cwd,
			env,
			encoding: "utf8",
		});

		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("npm_package_version is required");
	});
});
