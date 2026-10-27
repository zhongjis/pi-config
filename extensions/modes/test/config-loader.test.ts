import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { loadAgentConfig, parseModeAgentConfig } from "../src/config-loader.js";
import { derivePlanTitleFromMarkdown } from "../src/plan-storage.js";

describe("parseModeAgentConfig", () => {
	it("parses signed tools rules", () => {
		const config = parseModeAgentConfig(`---
prompt_mode: replace
tools: +@all, -edit, +@codegraph
delegation: +chengfeng, +yanluo, -houtu
model: anthropic/claude-sonnet-4-6:medium
---

Mode prompt.`);

		expect(config).toMatchObject({
			body: "Mode prompt.",
			toolRules: [
				{ sign: "+", selector: "@all" },
				{ sign: "-", selector: "edit" },
				{ sign: "+", selector: "@codegraph" },
			],
			delegationRules: [{ sign: "+", selector: "chengfeng" }, { sign: "+", selector: "yanluo" }, { sign: "-", selector: "houtu" }],
			model: "anthropic/claude-sonnet-4-6:medium",
		});
	});

	it("grants no tools when tools frontmatter is omitted", () => {
		const config = parseModeAgentConfig(`---
prompt_mode: replace
---

Prompt only.`);

		expect(config).toMatchObject({
			body: "Prompt only.",
			toolRules: [],
		});
	});

	it("an unsigned tools entry yields the no-prompt, no-tools errors config", () => {
		expect(parseModeAgentConfig(`---
tools: read
---

Unsigned prompt.`)).toEqual({
			body: "",
			toolRules: [],
			errors: ['unsigned entry "read": prefix + to grant or - to remove, e.g. "+read"'],
		});
	});

	it("an extensions: field is a Mode Agent error", () => {
		expect(parseModeAgentConfig(`---
extensions: +@all
tools: +read
---

Extensions prompt.`)?.errors).toEqual([
			"extensions: is not supported in Mode Agents (the main session cannot unload extensions); grant tools with tools: only.",
		]);
	});
});

describe("derivePlanTitleFromMarkdown", () => {
	it("extracts H1 title from markdown", () => {
		expect(derivePlanTitleFromMarkdown("# My Plan\n\n- item 1")).toBe("My Plan");
	});

	it("returns undefined for no heading", () => {
		expect(derivePlanTitleFromMarkdown("No heading here\n\nJust text")).toBeUndefined();
	});

	it("handles heading with trailing hashes", () => {
		expect(derivePlanTitleFromMarkdown("# Title ##\n\nBody")).toBe("Title");
	});

	it("ignores H2 and deeper headings for title", () => {
		expect(derivePlanTitleFromMarkdown("## Subtitle\n\n- items")).toBeUndefined();
	});

	it("handles leading whitespace before heading", () => {
		expect(derivePlanTitleFromMarkdown("   # Indented Title\n\nBody")).toBe("Indented Title");
	});

	it("returns undefined for empty string", () => {
		expect(derivePlanTitleFromMarkdown("")).toBeUndefined();
	});
});

describe("loadAgentConfig", () => {
	const MODE_MD = `---
prompt_mode: replace
model: anthropic/claude-sonnet-4-6:medium
---

Base mode body.`;

	let home: string;
	function stubFiles(files: Record<string, string>): void {
		for (const [name, content] of Object.entries(files)) {
			const path = join(home, ".pi/agent/modes", name.includes("/") ? name : `kuafu/${name}`);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, content);
		}
	}

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "mode-config-"));
		vi.stubEnv("HOME", home);
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(home, { recursive: true, force: true });
	});

	it("reads base config from modes/{mode}/default.md", () => {
		stubFiles({ "default.md": MODE_MD });
		const config = loadAgentConfig("kuafu");
		expect(config?.body).toBe("Base mode body.");
		expect(config?.model).toBe("anthropic/claude-sonnet-4-6:medium");
	});

	it("returns null when default.md does not exist", () => {
		expect(loadAgentConfig("kuafu")).toBeNull();
	});

	it("an invalid default.md keeps the errors config over a gpt.md body", () => {
		stubFiles({ "default.md": "---\nbuiltin_tools: read\n---\n\nBase mode body.", "gpt.md": "GPT body override.\n" });
		expect(loadAgentConfig("kuafu", "gpt")).toEqual({
			body: "",
			toolRules: [],
			errors: ["builtin_tools is obsolete; list built-in tools in tools:, e.g. `tools: +read, +bash` or `tools: +@builtin`."],
		});
	});

	it("gpt family replaces body from gpt.md, keeping default.md frontmatter", () => {
		stubFiles({ "default.md": MODE_MD, "gpt.md": "GPT body override.\n" });
		const config = loadAgentConfig("kuafu", "gpt");
		expect(config?.body).toBe("GPT body override.");
		expect(config?.model).toBe("anthropic/claude-sonnet-4-6:medium");
	});

	it("gpt family falls back to base body when gpt.md is absent", () => {
		stubFiles({ "default.md": MODE_MD });
		const config = loadAgentConfig("kuafu", "gpt");
		expect(config?.body).toBe("Base mode body.");
	});

	it("gemini family injects gemini.md into the body", () => {
		stubFiles({ "default.md": MODE_MD, "gemini.md": "Gemini overlay fragment.\n" });
		const config = loadAgentConfig("kuafu", "gemini");
		expect(config?.body).toBe("Base mode body.\n\nGemini overlay fragment.");
		expect(config?.model).toBe("anthropic/claude-sonnet-4-6:medium");
	});

	it("reads retained mode GPT/Gemini variant files when present", () => {
		for (const mode of ["kuafu", "fuxi", "houtu"] as const) {
			stubFiles({
				[`${mode}/default.md`]: `---
prompt_mode: replace
model: anthropic/claude-sonnet-4-6:medium
---

${mode} base body.`,
				[`${mode}/gpt.md`]: `${mode} GPT body.\n`,
				[`${mode}/gemini.md`]: `${mode} Gemini overlay.\n`,
			});

			const gptConfig = loadAgentConfig(mode, "gpt");
			expect(gptConfig?.body).toBe(`${mode} GPT body.`);

			const geminiConfig = loadAgentConfig(mode, "gemini");
			expect(geminiConfig?.body).toBe(`${mode} base body.\n\n${mode} Gemini overlay.`);
		}
	});

	it("gemini family falls back to base config when gemini.md is absent", () => {
		stubFiles({ "default.md": MODE_MD });
		const config = loadAgentConfig("kuafu", "gemini");
		expect(config?.body).toBe("Base mode body.");
	});

	it("default family returns the default.md body unchanged", () => {
		stubFiles({ "default.md": MODE_MD });
		const config = loadAgentConfig("kuafu", "default");
		expect(config?.body).toBe("Base mode body.");
	});

});
