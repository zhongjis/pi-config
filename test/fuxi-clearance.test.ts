/**
 * Fu Xi thin-prompt and discovered ulw-plan contract tests.
 *
 * The mode prompt family stays thin: planner-only guardrails plus an explicit
 * instruction to load ulw-plan, without restating the full workflow.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const FUXI_PATH = join(process.cwd(), "modes", "fuxi", "mode.md");

function getFuxiPrompt(): string {
  return readFileSync(FUXI_PATH, "utf-8");
}

const FUXI_GPT_PATH = join(process.cwd(), "modes", "fuxi", "gpt.md");
const FUXI_GEMINI_PATH = join(process.cwd(), "modes", "fuxi", "gemini.md");

function getFuxiGptPrompt(): string {
  return readFileSync(FUXI_GPT_PATH, "utf-8");
}

function getFuxiGeminiOverlays(): string {
  return readFileSync(FUXI_GEMINI_PATH, "utf-8");
}

/**
 * Compose the default body with gemini overlays injected before <critical>.
 * Mirrors the injectOverlays() logic from extensions/modes/src/hooks.ts.
 */
function composeFuxiGeminiPrompt(): string {
  const body = getFuxiPrompt();
  const overlays = getFuxiGeminiOverlays();
  const anchor = "<critical>";
  const idx = body.indexOf(anchor);
  if (idx !== -1) {
    return `${body.slice(0, idx)}${overlays}\n\n${body.slice(idx)}`;
  }
  const roleClose = "</role>";
  const roleIdx = body.indexOf(roleClose);
  if (roleIdx !== -1) {
    const insertAt = roleIdx + roleClose.length;
    return `${body.slice(0, insertAt)}\n\n${overlays}${body.slice(insertAt)}`;
  }
  return `${body}\n\n${overlays}`;
}

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
  it("requires default, GPT, and Gemini prompt files for every mode", () => {
    for (const mode of ALL_MODES) {
      for (const family of ["default", "gpt", "gemini"] as const) {
        const path = getModePromptPath(mode, family);
        expect(existsSync(path), `${mode}:${family} prompt missing`).toBe(true);
        expect(readModePrompt(mode, family).trim(), `${mode}:${family} prompt empty`).not.toBe("");
      }
    }
  });
});

describe("fuxi gpt variant", () => {
  it("contains no frontmatter", () => {
    const prompt = getFuxiGptPrompt();
    expect(prompt).not.toMatch(/^---/);
  });
});

describe("fuxi gemini composed", () => {
  it("#then should include all gemini overlays in composed prompt", () => {
    const composed = composeFuxiGeminiPrompt();
    expect(composed).toContain("<FUXI_INTENT_GATE>");
    expect(composed).toContain("<FUXI_ANTI_FALSE_FINALIZE>");
    expect(composed).toContain("<FUXI_DRAFT_MANDATE>");
    expect(composed).toContain("<FUXI_VERIFICATION_OVERRIDE>");
  });

  it("#then overlays should appear before <critical> section", () => {
    const composed = composeFuxiGeminiPrompt();
    const overlayPos = composed.indexOf("<FUXI_INTENT_GATE>");
    const criticalPos = composed.indexOf("<critical>");
    // Either both exist and overlay is before critical, OR critical doesn't exist (fallback path)
    if (criticalPos !== -1) {
      expect(overlayPos).toBeLessThan(criticalPos);
    } else {
      // fallback: overlays exist somewhere in the composed text
      expect(overlayPos).toBeGreaterThan(-1);
    }
  });

  it("#then safety clauses from base body should be preserved in composed prompt", () => {
    const composed = composeFuxiGeminiPrompt();
    // Key safety requirements from modes/fuxi/mode.md must survive composition
    expect(composed).toContain("/handoff:start-work");
    expect(composed).toContain("local://");
    expect(composed).toMatch(/ulw-plan/i);
  });
});

describe("mode frontmatter task selector wildcard", () => {
  const MODE_PATHS = [
    join(process.cwd(), "modes", "fuxi", "mode.md"),
    join(process.cwd(), "modes", "houtu", "mode.md"),
    join(process.cwd(), "modes", "kuafu", "mode.md"),
    join(process.cwd(), "modes", "luban", "mode.md"),
    join(process.cwd(), "modes", "shennong", "mode.md"),
  ];

  it("uses Task* as the sole task-tool selector in every mode frontmatter", () => {
    for (const path of MODE_PATHS) {
      const prompt = readFileSync(path, "utf-8");
      const frontmatterMatch = prompt.match(/^---\n([\s\S]*?)\n---/);
      expect(frontmatterMatch).not.toBeNull();

      const frontmatter = frontmatterMatch![1];
      const extensionLine = frontmatter
        .split("\n")
        .find((line) => line.startsWith("extension_tools:"));

      expect(extensionLine, path).toBeDefined();
      expect(extensionLine, path).toContain("Task*");
      expect((extensionLine.match(/Task\*/g) ?? []).length, path).toBe(1);
      expect(extensionLine, path).not.toContain("TaskCreate");
      expect(extensionLine, path).not.toContain("TaskGet");
      expect(extensionLine, path).not.toContain("TaskList");
      expect(extensionLine, path).not.toContain("TaskUpdate");
      expect(extensionLine, path).not.toContain("TaskExecute");
    }
  });
});
