/**
 * Fuxi clearance sequence tests
 *
 * Mirrors prometheus/system-prompt.test.ts structure.
 * Validates that agents/fuxi.md contains the required clearance sequence
 * patterns after the Prometheus-style refactor: TaskCreate-based step
 * registration, direnjie gap check, ask final choice, yanluo loop,
 * and absence of the removed tools.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseModeAgentConfig } from "../extensions/modes/src/config-loader.js";

const FUXI_PATH = join(process.cwd(), "modes", "fuxi", "mode.md");

function getFuxiPrompt(): string {
  return readFileSync(FUXI_PATH, "utf-8");
}

const FUXI_GPT_PATH = join(process.cwd(), "modes", "fuxi", "gpt.md");
const FUXI_GEMINI_PATH = join(process.cwd(), "modes", "fuxi", "gemini.md");
const KUAFU_GPT_PATH = join(process.cwd(), "modes", "kuafu", "gpt.md");
const YANLUO_PATH = join(process.cwd(), "agents", "yanluo.md");

function getFuxiGptPrompt(): string {
  return readFileSync(FUXI_GPT_PATH, "utf-8");
}

function getFuxiGeminiOverlays(): string {
  return readFileSync(FUXI_GEMINI_PATH, "utf-8");
}

function getKuafuGptPrompt(): string {
  return readFileSync(KUAFU_GPT_PATH, "utf-8");
}

function getYanluoPrompt(): string {
  return readFileSync(YANLUO_PATH, "utf-8");
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

type ModePromptInvariants = {
  default: string[];
  gpt: string[];
  geminiOverlay: string[];
  geminiComposed: string[];
  defaultOnlyInGptReplacement: string;
};

const MODE_PROMPT_FILES: Record<PromptFamily, string> = {
  default: "mode.md",
  gpt: "gpt.md",
  gemini: "gemini.md",
};
const ALL_MODES: ModeName[] = ["kuafu", "fuxi", "houtu", "luban"];

const MODE_PROMPT_INVARIANTS: Record<ModeName, ModePromptInvariants> = {
  kuafu: {
    default: ["Implementation authorization gate", "Orchestrate first", "No evidence = not complete"],
    gpt: ["Implementation authorization gate", "codegraph_*", "Subagent self-report is never evidence"],
    geminiOverlay: ["<KUAFU_INTENT_GATE>", "<KUAFU_VERIFICATION_OVERRIDE>"],
    geminiComposed: ["Implementation authorization gate", "<KUAFU_TOOL_MANDATE>", "No evidence = not complete"],
    defaultOnlyInGptReplacement: "Turn-local intent gate controls every response.",
  },
  fuxi: {
    default: ["Plan only. MUST NOT implement", "local://DRAFT.md", "plan_approve"],
    gpt: ["Plan mode is sticky", "local://DRAFT.md", "Di Renjie", "plan_approve", "No product-code patches"],
    geminiOverlay: ["<FUXI_DRAFT_MANDATE>", "<FUXI_APPROVAL_GATE>"],
    geminiComposed: ["Plan only. MUST NOT implement", "<FUXI_ANTI_FALSE_FINALIZE>", "plan_approve"],
    defaultOnlyInGptReplacement: "ADVISORY SUBPLAN MODE",
  },
  houtu: {
    default: [
      "You execute by coordinating, delegating, and verifying",
      "Pi-tasks track plan identity, dependencies, and verified status only",
      "Delegate all plan work directly with `Agent`",
      "Never use `TaskExecute`, `TaskOutput`, or `TaskStop`",
      "Final Verification Wave gate",
    ],
    gpt: [
      "Read `local://PLAN.md` before doing anything else",
      "Use pi-tasks only for logical tracking",
      "Launch plan work with `Agent`",
      "Never use `TaskExecute`, `TaskOutput`, or `TaskStop`",
      "Final Verification Wave is a mandatory approval gate",
      "APPROVE",
    ],
    geminiOverlay: [
      "<gemini-corrective-overlay>",
      "Hou Tu coordinates only",
      "Pi-tasks track logical PLAN work only",
      "Delegate one bounded plan task per `Agent` session",
      "Final Verification Wave reviewer returns explicit `APPROVE`",
    ],
    geminiComposed: [
      "You execute by coordinating, delegating, and verifying",
      "Hou Tu coordinates only",
      "Delegate all plan work directly with `Agent`",
    ],
    defaultOnlyInGptReplacement: "<tracking_contract>",
  },
  luban: {
    default: [
      "Skill-first is mandatory",
      "Do not claim Sisyphus, Prometheus, Atlas, or upstream agent-profile parity",
      "Parallelism is safety-gated, not maximized",
    ],
    gpt: [
      "Before any response or action, run the skill gate",
      "1% chance a skill applies",
      "Do not claim Sisyphus, Prometheus, Atlas",
      "verification-before-completion",
    ],
    geminiOverlay: ["<LUBAN_GEMINI_CORRECTIVE_OVERLAY>", "Do not skip skill loading", "verify with readback"],
    geminiComposed: ["Skill-first is mandatory", "Do not skip skill loading", "explicit user/project instructions override active skill text"],
    defaultOnlyInGptReplacement: "Consult the grain before the first cut",
  },
};

function getModePromptPath(mode: ModeName, family: PromptFamily): string {
  return join(process.cwd(), "modes", mode, MODE_PROMPT_FILES[family]);
}

function readModePrompt(mode: ModeName, family: PromptFamily): string {
  return readFileSync(getModePromptPath(mode, family), "utf-8");
}

function getModeDefaultBody(mode: ModeName): string {
  const parsed = parseModeAgentConfig(readModePrompt(mode, "default"));
  if (!parsed) throw new Error(`invalid mode.md prompt for ${mode}`);
  return parsed.body;
}

function getBodyOnlyVariant(mode: ModeName, family: Exclude<PromptFamily, "default">): string {
  return readModePrompt(mode, family).trim();
}

function injectOverlaysForTest(body: string, overlays: string): string {
  const criticalIdx = body.indexOf("<critical>");
  if (criticalIdx !== -1) {
    return `${body.slice(0, criticalIdx)}${overlays}\n\n${body.slice(criticalIdx)}`;
  }

  const roleClose = "</role>";
  const roleIdx = body.indexOf(roleClose);
  if (roleIdx !== -1) {
    const insertAt = roleIdx + roleClose.length;
    return `${body.slice(0, insertAt)}\n\n${overlays}${body.slice(insertAt)}`;
  }

  return `${body}\n\n${overlays}`;
}

function renderInjectedModePrompt(mode: ModeName, family: PromptFamily): string {
  const defaultBody = getModeDefaultBody(mode);
  const body = family === "gpt"
    ? getBodyOnlyVariant(mode, "gpt")
    : family === "gemini"
      ? injectOverlaysForTest(defaultBody, getBodyOnlyVariant(mode, "gemini"))
      : defaultBody;

  return `Base prompt\n\n<!-- mode:${mode} -->\n${body}\n<!-- /mode:${mode} -->`;
}

function expectContainsAll(text: string, snippets: string[]): void {
  for (const snippet of snippets) {
    expect(text).toContain(snippet);
  }
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

  for (const mode of ALL_MODES) {
    describe(`${mode} injected prompt variants`, () => {
      it("renders default prompt with mode-critical invariants", () => {
        const rendered = renderInjectedModePrompt(mode, "default");
        expect(rendered).toContain(`<!-- mode:${mode} -->`);
        expectContainsAll(rendered, MODE_PROMPT_INVARIANTS[mode].default);
      });

      it("renders GPT as body-only replacement with self-contained invariants", () => {
        const gptBody = getBodyOnlyVariant(mode, "gpt");
        const rendered = renderInjectedModePrompt(mode, "gpt");

        expect(gptBody).not.toMatch(/^---/);
        expect(rendered).toContain(`<!-- mode:${mode} -->`);
        expectContainsAll(rendered, MODE_PROMPT_INVARIANTS[mode].gpt);
        expect(rendered).not.toContain(MODE_PROMPT_INVARIANTS[mode].defaultOnlyInGptReplacement);
      });

      it("renders Gemini as overlay while preserving default invariants", () => {
        const defaultBody = getModeDefaultBody(mode);
        const overlay = getBodyOnlyVariant(mode, "gemini");
        const rendered = renderInjectedModePrompt(mode, "gemini");
        const overlayPos = rendered.indexOf(MODE_PROMPT_INVARIANTS[mode].geminiOverlay[0]);

        expect(overlay).not.toMatch(/^---/);
        expectContainsAll(rendered, MODE_PROMPT_INVARIANTS[mode].default);
        expectContainsAll(rendered, MODE_PROMPT_INVARIANTS[mode].geminiOverlay);
        expectContainsAll(rendered, MODE_PROMPT_INVARIANTS[mode].geminiComposed);
        expect(overlayPos).toBeGreaterThan(-1);

        if (defaultBody.includes("<critical>")) {
          expect(overlayPos).toBeLessThan(rendered.indexOf("<critical>"));
        } else if (defaultBody.includes("</role>")) {
          expect(overlayPos).toBeGreaterThan(rendered.indexOf("</role>"));
        } else {
          expect(rendered).toContain(`${overlay}\n<!-- /mode:${mode} -->`);
        }
      });
    });
  }
});

describe("houtu Atlas parity", () => {
  it("maps the GPT slot to GPT-5.5 medium", () => {
    expect(readModePrompt("houtu", "default")).toContain("openai-codex/gpt-5.5:medium");
  });
});

describe("fuxi clearance sequence", () => {
  describe("#given the mandatory plan generation sequence", () => {
    it("#then should require TaskCreate for step registration immediately on trigger", () => {
      const prompt = getFuxiPrompt();
      expect(prompt).toContain("TaskCreate");
      expect(prompt).toContain("IMMEDIATELY");
    });

    it("#then should register exactly 7 planning steps", () => {
      const prompt = getFuxiPrompt();
      // The 7 step labels that must be registered as tasks
      expect(prompt).toContain("Consult Di Renjie for gap analysis");
      expect(prompt).toContain("Generate work plan to local://PLAN.md");
      expect(prompt).toContain("Self-review: classify gaps");
      expect(prompt).toContain("Present summary with auto-resolved items");
      expect(prompt).toContain("If decisions needed: wait for user, update plan");
      expect(prompt).toContain("Run plan approval flow (plan_approve tool)");
      expect(prompt).toContain("If high accuracy: Submit to Yan Luo and iterate until OKAY");
    });

    it("#then should require marking tasks in_progress before starting and completed after", () => {
      const prompt = getFuxiPrompt();
      expect(prompt).toContain("in_progress");
      expect(prompt).toContain("completed");
      expect(prompt).toContain("TaskUpdate");
    });
  });

  describe("#given the direnjie gap check step", () => {
    it("#then should auto-proceed after direnjie result without asking additional user questions", () => {
      const prompt = getFuxiPrompt();
      expect(prompt).toContain("direnjie");
      expect(prompt).toContain("Auto-proceed after result without asking additional user questions");
    });

    it("#then should specify what to send direnjie", () => {
      const prompt = getFuxiPrompt();
      // Direnjie needs: goal, what was discussed, interpretation, research findings
      expect(prompt).toContain("user's goal");
      expect(prompt).toContain("research findings");
      expect(prompt).toContain("questions you should have asked but didn't");
      expect(prompt).toContain("guardrails");
    });
  });

  describe("#given the plan generation step", () => {
    it("#then should save plan to local://PLAN.md", () => {
      const prompt = getFuxiPrompt();
      expect(prompt).toContain("local://PLAN.md");
    });

    it("#then should include incremental write protocol for large plans", () => {
      const prompt = getFuxiPrompt();
      expect(prompt).toContain("incremental write protocol");
      expect(prompt).toContain("skeleton");
      expect(prompt).toContain("edit");
    });
  });

  describe("#given the final choice presentation", () => {
    it("#then should use /plan:approve command for final choice", () => {
      const prompt = getFuxiPrompt();
      expect(prompt).toContain("plan_approve");
    });

    it("#then should present High Accuracy Review and Approve options", () => {
      const prompt = getFuxiPrompt();
      expect(prompt).toContain("Approve");
      expect(prompt).toContain("High Accuracy Review");
    });

    it("#then should present post-high-accuracy variant after yanluo", () => {
      const prompt = getFuxiPrompt();
      expect(prompt).toContain("variant: \"post-high-accuracy\"");
    });
  });

  describe("#given the high accuracy review path", () => {
    it("#then should run yanluo in a loop until OKAY", () => {
      const prompt = getFuxiPrompt();
      expect(prompt).toContain("yanluo");
      expect(prompt).toContain("while (true)");
      expect(prompt).toContain("OKAY");
    });

    it("#then should pass local://PLAN.md to yanluo", () => {
      const prompt = getFuxiPrompt();
      // yanluo invocation uses the plan path
      expect(prompt).toMatch(/yanluo.*local:\/\/PLAN\.md|local:\/\/PLAN\.md.*yanluo/s);
    });

    it("#then should prohibit shortcuts in the loop", () => {
      const prompt = getFuxiPrompt();
      expect(prompt).toContain("NO EXCUSES");
      expect(prompt).toContain("NO SHORTCUTS");
    });
  });

  describe("#given removed tools", () => {
    it("#then should not reference gap_review_complete", () => {
      const prompt = getFuxiPrompt();
      expect(prompt).not.toContain("gap_review_complete");
    });

    it("#then should not reference finalize_plan", () => {
      const prompt = getFuxiPrompt();
      expect(prompt).not.toContain("finalize_plan");
    });

    it("#then should not reference exit_plan_mode", () => {
      const prompt = getFuxiPrompt();
      expect(prompt).not.toContain("exit_plan_mode");
    });

    it("#then should not reference high_accuracy_review_complete", () => {
      const prompt = getFuxiPrompt();
      expect(prompt).not.toContain("high_accuracy_review_complete");
    });
  });

  describe("#given extensions frontmatter", () => {
    it("#then should not list removed tools in extensions", () => {
      const prompt = getFuxiPrompt();
      const frontmatterMatch = prompt.match(/^---\n([\s\S]*?)\n---/);
      expect(frontmatterMatch).not.toBeNull();
      const frontmatter = frontmatterMatch![1];
      expect(frontmatter).not.toContain("gap_review_complete");
      expect(frontmatter).not.toContain("finalize_plan");
      expect(frontmatter).not.toContain("exit_plan_mode");
      expect(frontmatter).not.toContain("high_accuracy_review_complete");
    });

    it("#then should list TaskCreate and TaskUpdate in extensions", () => {
      const prompt = getFuxiPrompt();
      const frontmatterMatch = prompt.match(/^---\n([\s\S]*?)\n---/);
      expect(frontmatterMatch).not.toBeNull();
      const frontmatter = frontmatterMatch![1];
      expect(frontmatter).toContain("TaskCreate");
      expect(frontmatter).toContain("TaskUpdate");
    });

    it("#then should list ask in extensions (needed for user interview/clarification)", () => {
      const prompt = getFuxiPrompt();
      const frontmatterMatch = prompt.match(/^---\n([\s\S]*?)\n---/);
      expect(frontmatterMatch).not.toBeNull();
      const frontmatter = frontmatterMatch![1];
      // ask is required for clarifying plan requirements with the user
      expect(frontmatter).toMatch(/\bask\b/);
    });
  });
});

describe("fuxi gpt variant", () => {
  it("#then should require Di Renjie consultation requirement", () => {
    const prompt = getFuxiGptPrompt();
    expect(prompt).toMatch(/direnjie|Di Renjie/i);
  });

  it("#then should require plan approval flow", () => {
    const prompt = getFuxiGptPrompt();
    expect(prompt).toMatch(/plan_approve/);
  });

  it("#then should require draft management", () => {
    const prompt = getFuxiGptPrompt();
    expect(prompt).toMatch(/DRAFT\.md|local:\/\/DRAFT/);
  });

  it("#then should enforce scope boundary (plan only, no implementation)", () => {
    const prompt = getFuxiGptPrompt();
    expect(prompt).toMatch(/PLAN ONLY|plan only|NOT implement|no implementation|read.only/i);
  });

  it("#then should require interview phase", () => {
    const prompt = getFuxiGptPrompt();
    expect(prompt).toMatch(/interview|ask.*tool|Interview Phase/i);
  });

  it("#then should contain no frontmatter", () => {
    const prompt = getFuxiGptPrompt();
    expect(prompt).not.toMatch(/^---/);
  });
});

describe("audited omo prompt contracts", () => {
  it("requires Yan Luo's Momus-compatible terminal verdicts", () => {
    const prompt = getYanluoPrompt();

    expect(prompt).toContain("**[OKAY]**");
    expect(prompt).toContain("**[REJECT]**");
    expect(prompt).toContain("maximum 3");
    expect(prompt).toContain("Default to **[OKAY]** when no verified blocker exists");
    expect(prompt).toContain("**[BLOCKED]**");
    expect(prompt).toContain("Missing evidence:");
    expect(prompt).not.toContain("**APPROVED**");
    expect(prompt).not.toContain("**REVISE**");
  });

  it("requires Kua Fu GPT to continue through verified completion", () => {
    const prompt = getKuafuGptPrompt();

    expect(prompt).toContain("Continue until the authorized task is complete and verified");
    expect(prompt).toContain("Orchestrate first");
    expect(prompt).toContain("Implementation authorization gate");
  });

  it("keeps Fu Xi's dual-review sentence well formed", () => {
    const prompt = getFuxiGptPrompt();

    expect(prompt).toContain("one independent `taishang` (`inherit_context=false`), dispatched together");
    expect(prompt).toContain("until BOTH return `[OKAY]`");
    expect(prompt).not.toContain("`inherit_context=false`) dispatched together");
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
    expect(composed).toContain("plan_approve");
    expect(composed).toMatch(/DRAFT\.md|local:\/\/DRAFT/);
    expect(composed).toMatch(/direnjie|Di Renjie/i);
  });
});
