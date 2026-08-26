import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseModeAgentConfig } from "../src/config-loader.js";

// Zhu Rong 祝融 is a GPT-only autonomous deep-worker mode derived from
// hephaestus/gpt-5-6.md. It ships mode.md ONLY (no gpt.md/gemini.md), binds a
// GPT-only model chain, and its injected body must be fully Pi-adapted: no
// leaked upstream tool names and no source attribution (attribution is noise
// the model should never see).

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

	it("contains no leaked upstream tokens or source attribution", () => {
		const body = readFileSync(MODE_MD, "utf-8");
		const forbidden = [
			"background_output",
			"background_cancel",
			"apply_patch",
			"lsp_diagnostics",
			"update_plan",
			"todowrite",
			"interactive_bash",
			"playwright",
			"task_id=",
			"OhMyOpenCode",
			"OhMyOpenAgent",
			"Hephaestus",
		];
		for (const token of forbidden) {
			expect(body, `must not leak "${token}"`).not.toContain(token);
		}
	});

	it("identifies as Zhu Rong 祝融", () => {
		const body = readFileSync(MODE_MD, "utf-8");
		expect(body).toContain("祝融");
	});
});
