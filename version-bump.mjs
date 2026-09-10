import { readFileSync, writeFileSync } from "node:fs";

const targetVersion = process.env.npm_package_version;
if (!targetVersion) {
    throw new Error("npm_package_version is required to bump Morphic release metadata");
}

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const { minAppVersion } = manifest;
if (typeof minAppVersion !== "string" || minAppVersion.length === 0) {
    throw new Error("manifest.json must define a non-empty minAppVersion");
}

manifest.version = targetVersion;
writeFileSync("manifest.json", `${JSON.stringify(manifest, null, 4)}\n`);

const versions = JSON.parse(readFileSync("versions.json", "utf8"));
versions[targetVersion] = minAppVersion;
writeFileSync("versions.json", `${JSON.stringify(versions, null, 4)}\n`);
