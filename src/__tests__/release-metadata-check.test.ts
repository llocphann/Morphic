import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const scriptPath = resolve(process.cwd(), "scripts/check-release-metadata.mjs");
const tempDirs: string[] = [];
const fundingUrl = "https://www.buymeacoffee.com/llocphann";

function validManifest(): Record<string, unknown> {
	return {
		id: "morphic",
		name: "Morphic",
		version: "0.3.2",
		minAppVersion: "1.11.10",
		description: "Transform Markdown notes into fast programmable views.",
		author: "Lộc Phan",
		authorUrl: "https://github.com/llocphann",
		fundingUrl,
		isDesktopOnly: false,
	};
}

function validPackage(): Record<string, unknown> {
	return {
		name: "morphic",
		version: "0.3.2",
		private: true,
		license: "GPL-3.0-only",
		funding: fundingUrl,
		packageManager: "npm@11.6.0",
		engines: { node: "22.x", npm: "11.6.0" },
	};
}

function createFixture({
	manifest = validManifest(),
	pkg = validPackage(),
	versions = { "0.3.2": "1.11.10" },
}: {
	manifest?: Record<string, unknown>;
	pkg?: Record<string, unknown>;
	versions?: Record<string, string>;
} = {}): string {
	const dir = mkdtempSync(join(tmpdir(), "morphic-release-metadata-"));
	tempDirs.push(dir);
	writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
	writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2));
	writeFileSync(join(dir, "versions.json"), JSON.stringify(versions, null, 2));
	return dir;
}

function run(cwd: string, ...args: string[]) {
	return spawnSync(process.execPath, [scriptPath, ...args], {
		cwd,
		encoding: "utf8",
	});
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("release metadata validation", () => {
	it("accepts aligned Obsidian, package and versions metadata", () => {
		const result = run(createFixture());
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toContain("Release metadata verified for Morphic 0.3.2");
	});

	it("accepts either plain or v-prefixed matching tags", () => {
		const cwd = createFixture();
		expect(run(cwd, "--tag", "0.3.2").status).toBe(0);
		expect(run(cwd, "--tag", "v0.3.2").status).toBe(0);
	});

	it("rejects inconsistent identity, version mapping and release tag", () => {
		const manifest = validManifest();
		manifest.id = "custom-views";
		manifest.version = "0.4.0";
		manifest.minAppVersion = "1.13.0";
		const cwd = createFixture({
			manifest,
			pkg: validPackage(),
			versions: { "0.4.0": "1.11.10" },
		});
		const result = run(cwd, "--tag", "v0.3.2");

		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("manifest id is custom-views");
		expect(result.stderr).toContain("manifest 0.4.0 != package 0.3.2");
		expect(result.stderr).toContain("versions.json does not map 0.4.0 to 1.13.0");
		expect(result.stderr).toContain("tag 0.3.2 != manifest 0.4.0");
	});

	it("rejects Community directory manifest policy violations", () => {
		const manifest = validManifest();
		manifest.description = "No trailing period";
		manifest.authorUrl = "not-a-url";
		manifest.isDesktopOnly = "false";
		manifest.extra = true;
		const pkg = validPackage();
		pkg.private = false;
		pkg.engines = { node: ">=20", npm: "10.9.8" };
		pkg.packageManager = "npm@10.9.8";
		const result = run(createFixture({ manifest, pkg }));

		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("manifest description must end with a period");
		expect(result.stderr).toContain("manifest authorUrl must be an HTTPS URL");
		expect(result.stderr).toContain("manifest isDesktopOnly must be a boolean");
		expect(result.stderr).toContain("unexpected manifest key: extra");
		expect(result.stderr).toContain("package must remain private");
		expect(result.stderr).toContain("package Node engine is >=20");
		expect(result.stderr).toContain("package npm engine is 10.9.8");
		expect(result.stderr).toContain("packageManager is npm@10.9.8");
	});

	it("rejects non-x.y.z versions and tags", () => {
		const manifest = validManifest();
		manifest.version = "0.4.0-beta.1";
		const pkg = validPackage();
		pkg.version = "0.4.0-beta.1";
		const result = run(createFixture({
			manifest,
			pkg,
			versions: { "0.4.0-beta.1": "1.11.10" },
		}), "--tag", "v0.4.0-beta.1");

		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("manifest version must use x.y.z");
		expect(result.stderr).toContain("release tag must use x.y.z or vx.y.z");
	});
});
