// Derived from L2ncE/pi-recap at commit 02057d0; modified by Panda Harness. See README.md and LICENSE.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRecapConfig } from "./settings.js";

describe("recap settings", () => {
	let root = "";
	let agentDir = "";
	let cwd = "";
	let originalAgentDir: string | undefined;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "recap-settings-test-"));
		agentDir = join(root, "agent");
		cwd = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		originalAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
	});

	afterEach(() => {
		if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		rmSync(root, { force: true, recursive: true });
		vi.restoreAllMocks();
	});

	it("warns once when a settings file is malformed", () => {
		writeFileSync(join(agentDir, "settings.json"), "{ malformed");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

		getRecapConfig(cwd);

		expect(warn).toHaveBeenCalledTimes(1);
	});
});
