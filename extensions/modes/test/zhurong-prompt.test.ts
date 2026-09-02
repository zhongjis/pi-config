import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseModeAgentConfig } from "../src/config-loader.js";

const ZHURONG_DIR = join(process.cwd(), "modes", "zhurong");
const MODE_MD = join(ZHURONG_DIR, "mode.md");

describe("zhurong mode prompt", () => {
	it("ships mode.md only (GPT-only layout: no gpt.md/gemini.md)", () => {
		expect(existsSync(MODE_MD), "modes/zhurong/mode.md must exist").toBe(true);
		expect(existsSync(join(ZHURONG_DIR, "gpt.md")), "zhurong must not ship gpt.md").toBe(false);
		expect(existsSync(join(ZHURONG_DIR, "gemini.md")), "zhurong must not ship gemini.md").toBe(false);
	});

	it("binds a GPT-only model chain", () => {
		const config = parseModeAgentConfig(readFileSync(MODE_MD, "utf-8"));
		expect(config).not.toBeNull();
		expect(config?.model, "zhurong declares a model chain").toBeDefined();
		const entries = config!.model!.split(",").map((s) => s.trim()).filter(Boolean);
		expect(entries.length, "non-empty gpt-only chain").toBeGreaterThan(0);
		for (const entry of entries) {
			expect(entry.toLowerCase(), `${entry} is a gpt model`).toContain("gpt");
		}
	});

	it("exposes goal + Task* tools through the extension-tool allowlist", () => {
		const config = parseModeAgentConfig(readFileSync(MODE_MD, "utf-8"));
		const selection = config?.extensionToolNames ?? [];
		for (const tool of ["create_goal", "get_goal", "update_goal"]) {
			expect(selection, `zhurong lists ${tool}`).toContain(tool);
		}
		expect(selection, "zhurong uses the Task* selector").toContain("Task*");
	});
});
