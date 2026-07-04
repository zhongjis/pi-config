import { beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";

vi.mock("node:fs", async () => {
	const actual = await vi.importActual<typeof fs>("node:fs");
	return { ...actual, existsSync: vi.fn(), readFileSync: vi.fn() };
});

import { loadAgentConfig, parseModeAgentConfig } from "../src/config-loader.js";
import { derivePlanTitleFromMarkdown } from "../src/plan-storage.js";

describe("parseModeAgentConfig", () => {
	it("parses migrated builtin and extension tool frontmatter", () => {
		const config = parseModeAgentConfig(`---
prompt_mode: replace
builtin_tools: read,write,edit
extension_tools: ask,Agent,readonly_bash
extensions: clauderock
allow_delegation_to: chengfeng,yanluo
disallow_delegation_to: houtu
allow_nesting: true
model: anthropic/claude-sonnet-4-6:medium
---

Mode prompt.`);

		expect(config).toMatchObject({
			body: "Mode prompt.",
			promptMode: "replace",
			builtinToolNames: ["read", "write", "edit"],
			extensionToolNames: ["ask", "Agent", "readonly_bash"],
			extensions: ["clauderock"],
			allowDelegationTo: ["chengfeng", "yanluo"],
			disallowDelegationTo: ["houtu"],
			allowNesting: true,
			model: "anthropic/claude-sonnet-4-6:medium",
		});
	});

	it("leaves tool policy unset when tool frontmatter is absent", () => {
		const config = parseModeAgentConfig(`---
prompt_mode: append
---

Prompt only.`);

		expect(config).toMatchObject({
			body: "Prompt only.",
			promptMode: "append",
		});
		expect(config?.builtinToolNames).toBeUndefined();
		expect(config?.extensionToolNames).toBeUndefined();
		expect(config?.extensions).toBeUndefined();
	});

	it("rejects obsolete tools frontmatter", () => {
		expect(parseModeAgentConfig(`---
tools: read,bash
---

Legacy prompt.`)).toBeNull();
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

	function stubFiles(files: Record<string, string>): void {
		vi.mocked(fs.existsSync).mockImplementation((p) =>
			Object.keys(files).some((suffix) => String(p).endsWith(suffix)));
		vi.mocked(fs.readFileSync).mockImplementation(((p: unknown) => {
			const suffix = Object.keys(files).find((s) => String(p).endsWith(s));
			if (suffix === undefined) throw new Error(`unexpected read: ${String(p)}`);
			return files[suffix];
		}) as unknown as typeof fs.readFileSync);
	}

	beforeEach(() => {
		vi.mocked(fs.existsSync).mockReset();
		vi.mocked(fs.readFileSync).mockReset();
	});

	it("reads base config from modes/{mode}/mode.md", () => {
		stubFiles({ "mode.md": MODE_MD });
		const config = loadAgentConfig("kuafu");
		expect(config?.body).toBe("Base mode body.");
		expect(config?.model).toBe("anthropic/claude-sonnet-4-6:medium");
	});

	it("returns null when mode.md does not exist", () => {
		vi.mocked(fs.existsSync).mockReturnValue(false);
		expect(loadAgentConfig("kuafu")).toBeNull();
	});

	it("gpt family replaces body from gpt.md, keeping mode.md frontmatter", () => {
		stubFiles({ "mode.md": MODE_MD, "gpt.md": "GPT body override.\n" });
		const config = loadAgentConfig("kuafu", "gpt");
		expect(config?.body).toBe("GPT body override.");
		expect(config?.model).toBe("anthropic/claude-sonnet-4-6:medium");
		expect(config?.promptMode).toBe("replace");
	});

	it("gpt family falls back to base body when gpt.md is absent", () => {
		stubFiles({ "mode.md": MODE_MD });
		const config = loadAgentConfig("kuafu", "gpt");
		expect(config?.body).toBe("Base mode body.");
		expect(config?.overlays).toBeUndefined();
	});

	it("gemini family loads gemini.md into overlays", () => {
		stubFiles({ "mode.md": MODE_MD, "gemini.md": "Gemini overlay fragment.\n" });
		const config = loadAgentConfig("kuafu", "gemini");
		expect(config?.overlays).toBe("Gemini overlay fragment.");
		expect(config?.body).toBe("Base mode body.");
		expect(config?.model).toBe("anthropic/claude-sonnet-4-6:medium");
	});

	it("reads Houtu, Luban and Shennong GPT/Gemini variant files when present", () => {
		for (const mode of ["houtu", "luban", "shennong"] as const) {
			stubFiles({
				[`${mode}/mode.md`]: `---
prompt_mode: replace
model: anthropic/claude-sonnet-4-6:medium
---

${mode} base body.`,
				[`${mode}/gpt.md`]: `${mode} GPT body.\n`,
				[`${mode}/gemini.md`]: `${mode} Gemini overlay.\n`,
			});

			const gptConfig = loadAgentConfig(mode, "gpt");
			expect(gptConfig?.body).toBe(`${mode} GPT body.`);
			expect(gptConfig?.overlays).toBeUndefined();

			const geminiConfig = loadAgentConfig(mode, "gemini");
			expect(geminiConfig?.body).toBe(`${mode} base body.`);
			expect(geminiConfig?.overlays).toBe(`${mode} Gemini overlay.`);
		}
	});

	it("gemini family falls back to base config when gemini.md is absent", () => {
		stubFiles({ "mode.md": MODE_MD });
		const config = loadAgentConfig("kuafu", "gemini");
		expect(config?.overlays).toBeUndefined();
		expect(config?.body).toBe("Base mode body.");
	});

	it("default family returns the mode.md body unchanged", () => {
		stubFiles({ "mode.md": MODE_MD });
		const config = loadAgentConfig("kuafu", "default");
		expect(config?.body).toBe("Base mode body.");
		expect(config?.overlays).toBeUndefined();
	});

	it("unsupported runtime family returns the mode.md body unchanged", () => {
		stubFiles({ "mode.md": MODE_MD, "gpt.md": "GPT body override.\n", "gemini.md": "Gemini overlay fragment.\n" });
		const config = loadAgentConfig("kuafu", "opus" as never);
		expect(config?.body).toBe("Base mode body.");
		expect(config?.overlays).toBeUndefined();
	});
});

describe("ModeConfig overlays field", () => {
	it("accepts an overlays field on a parsed config", () => {
		const config = parseModeAgentConfig("---\n---\n\nBody text.");
		expect(config).not.toBeNull();
		if (config) {
			const withOverlays: typeof config = { ...config, overlays: "some overlay" };
			expect(withOverlays.overlays).toBe("some overlay");
		}
	});
});
