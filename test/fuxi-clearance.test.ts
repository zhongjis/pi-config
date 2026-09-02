import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

type ModeName = "kuafu" | "fuxi" | "houtu" | "luban";
type PromptFamily = "default" | "gpt" | "gemini";

const MODE_PROMPT_FILES: Record<PromptFamily, string> = {
  default: "mode.md",
  gpt: "gpt.md",
  gemini: "gemini.md",
};
const ALL_MODES: ModeName[] = ["kuafu", "fuxi", "houtu", "luban"];

function getModePromptPath(mode: ModeName, family: PromptFamily): string {
  return join(process.cwd(), "modes", mode, MODE_PROMPT_FILES[family]);
}

function readModePrompt(mode: ModeName, family: PromptFamily): string {
  return readFileSync(getModePromptPath(mode, family), "utf-8");
}

describe("mode prompt family matrix", () => {
  it("requires default and Gemini prompt files for every mode", () => {
    for (const mode of ALL_MODES) {
      for (const family of ["default", "gemini"] as const) {
        const path = getModePromptPath(mode, family);
        expect(existsSync(path), `${mode}:${family} prompt missing`).toBe(true);
        expect(readModePrompt(mode, family).trim(), `${mode}:${family} prompt empty`).not.toBe("");
      }
    }
  });

  it("ships a dedicated gpt.md for every mode except fuxi", () => {
    // fuxi is a thin Prometheus family; its GPT variant inherits the default mode.md body.
    for (const mode of ALL_MODES) {
      const path = getModePromptPath(mode, "gpt");
      if (mode === "fuxi") {
        expect(existsSync(path), "fuxi must not ship a dedicated gpt.md").toBe(false);
        continue;
      }
      expect(existsSync(path), `${mode}:gpt prompt missing`).toBe(true);
      expect(readModePrompt(mode, "gpt").trim(), `${mode}:gpt prompt empty`).not.toBe("");
    }
  });
});
