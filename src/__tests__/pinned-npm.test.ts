import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const scriptPath = resolve(process.cwd(), "scripts/pinned-npm.mjs");

describe("pinned npm runner", () => {
	it("reports the certified npm version without network access", () => {
		const result = spawnSync(process.execPath, [scriptPath, "--help"], {
			encoding: "utf8",
		});

		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toContain("Pinned npm: 11.6.0");
	});
});
