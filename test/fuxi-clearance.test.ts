/**
 * Fu Xi thin-prompt and discovered ulw-plan contract tests.
 *
 * The mode prompt family stays thin: planner-only guardrails plus an explicit
 * instruction to load ulw-plan, without restating the full workflow.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseModeAgentConfig } from "../extensions/modes/src/config-loader.js";

const FUXI_PATH = join(process.cwd(), "modes", "fuxi", "mode.md");
const FUXI_PLAN_SKILL_PATH = join(process.cwd(), "modes", "fuxi", "skills", "ulw-plan", "SKILL.md");
const FUXI_PLAN_REFERENCE_PATHS = [
  join(process.cwd(), "modes", "fuxi", "skills", "ulw-plan", "references", "intent-clear.md"),
  join(process.cwd(), "modes", "fuxi", "skills", "ulw-plan", "references", "intent-unclear.md"),
  join(process.cwd(), "modes", "fuxi", "skills", "ulw-plan", "references", "full-workflow.md"),
] as const;
const FUXI_PLAN_INVENTORY = [
  "SKILL.md",
  "agents/openai.yaml",
  "references/full-workflow.md",
  "references/intent-clear.md",
  "references/intent-unclear.md",
  "scripts/scaffold-plan.mjs",
] as const;

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
    default: [
      "You are a PLANNER.",
      "Plan mode is sticky",
      "separate worker session that only the user starts",
      "ulw-plan",
      "LOAD the ulw-plan skill",
      "local://",
      "/handoff:start-work",
    ],
    gpt: [
      "You are a PLANNER.",
      "Plan mode is sticky",
      "separate worker session that only the user starts",
      "ulw-plan",
      "LOAD the ulw-plan skill",
      "local://",
      "/handoff:start-work",
    ],
    geminiOverlay: [
      "<FUXI_INTENT_GATE>",
      "<FUXI_APPROVAL_GATE>",
      "<FUXI_VERIFICATION_OVERRIDE>",
    ],
    geminiComposed: [
      "You are a PLANNER.",
      "ulw-plan",
      "<FUXI_INTENT_GATE>",
      "/handoff:start-work",
    ],
    defaultOnlyInGptReplacement: "MANDATORY PLAN GENERATION SEQUENCE",
  },
  houtu: {
    default: [
      "Complete every task in `PLAN.md`",
      "TaskCreate",
      "Agent",
      "orchestrator-owned code-quality gate",
      "`## Todos`",
      "`## Final verification wave`",
      "legacy `## TODOs`",
      "legacy `## Final Verification Wave`",
    ],
    gpt: [
      "Read `PLAN.md` before doing anything else",
      "buildPlanExecutionGoal(planPath)",
      "Pi-tasks: `TaskCreate` one task per top-level PLAN item",
      "Agent lifecycle: launch plan work with `Agent`",
      "Use pi-tasks for logical tracking; use Agent/get_subagent_result/steer_subagent for agent lifecycle",
      "`## Todos`",
      "`## Final verification wave`",
      "legacy `## TODOs`",
      "legacy `## Final Verification Wave`",
      "APPROVE",
    ],
    geminiOverlay: [
      "<gemini-corrective-overlay>",
      "Hou Tu coordinates only",
      "Pi-tasks track logical PLAN work only",
      "Delegate one bounded plan task per `Agent` session",
      "`## Todos`",
      "`## Final verification wave`",
      "legacy `## TODOs`",
      "legacy `## Final Verification Wave`",
    ],
    geminiComposed: [
      "Complete every task in `PLAN.md`",
      "Hou Tu coordinates only",
      "Agent",
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
  it("maps the GPT slot to GPT-5.6-terra medium", () => {
    expect(readModePrompt("houtu", "default")).toContain("openai-codex/gpt-5.6-terra:medium");
  });
});

  it("parses canonical upstream plan headings while retaining legacy compatibility", () => {
    for (const family of ["default", "gpt", "gemini"] as const) {
      const prompt = readModePrompt("houtu", family);
      expectContainsAll(prompt, [
        "`## Todos`",
        "`## Final verification wave`",
        "legacy `## TODOs`",
        "legacy `## Final Verification Wave`",
      ]);
    }
  });

describe("fuxi thin prompt contract", () => {
  it("keeps the default prompt thin and delegates workflow mechanics to discovered ulw-plan", () => {
    const prompt = getFuxiPrompt();

    expectContainsAll(prompt, MODE_PROMPT_INVARIANTS.fuxi.default);
    expect(prompt).not.toContain("~/.pi/agent/modes/fuxi/references/");
    expect(prompt).not.toContain("modes/fuxi/references");
    expect(prompt).not.toContain("MANDATORY PLAN GENERATION SEQUENCE");
    expect(prompt).not.toContain("ADVISORY SUBPLAN MODE");
    expect(prompt).not.toContain("PHASE 1: INTERVIEW MODE");
    expect(prompt).not.toContain("PHASE 2: PLAN GENERATION");
  });

  it("keeps the GPT prompt thin and self-contained", () => {
    const prompt = getFuxiGptPrompt();

    expect(prompt).not.toMatch(/^---/);
    expectContainsAll(prompt, MODE_PROMPT_INVARIANTS.fuxi.gpt);
    expect(prompt).not.toContain("~/.pi/agent/modes/fuxi/references/");
    expect(prompt).not.toContain("modes/fuxi/references");
    expect(prompt).not.toContain("MANDATORY PLAN GENERATION SEQUENCE");
    expect(prompt).not.toContain("ADVISORY SUBPLAN MODE");
  });

  it("preserves the canonical upstream plan contract with Pi-native bindings", () => {
    expect(existsSync(FUXI_PLAN_SKILL_PATH), "ulw-plan skill missing").toBe(true);
    for (const path of FUXI_PLAN_REFERENCE_PATHS) {
      expect(existsSync(path), `${path} missing`).toBe(true);
    }
    for (const relativePath of FUXI_PLAN_INVENTORY) {
      expect(
        existsSync(join(process.cwd(), "modes", "fuxi", "skills", "ulw-plan", relativePath)),
        `${relativePath} missing`,
      ).toBe(true);
    }

    const skill = readFileSync(FUXI_PLAN_SKILL_PATH, "utf-8");
    const references = FUXI_PLAN_REFERENCE_PATHS.map((path) => readFileSync(path, "utf-8"));
    const combined = [skill, ...references].join("\n");
    const fullWorkflow = references[2];
    const clearIntent = references[0];
    const unclearIntent = references[1];
    const openAiMetadata = readFileSync(
      join(process.cwd(), "modes", "fuxi", "skills", "ulw-plan", "agents", "openai.yaml"),
      "utf-8",
    );

    expectContainsAll(skill, [
      "upstream-commit: 14083b89f1cbf4680be13493a6c4afd67c957e8a",
      "upstream-version: 4.19.0",
      "upstream-path: packages/shared-skills/skills/ulw-plan/",
      "license: SUL-1.0",
      "adaptation: Fu Xi identity and Pi runtime mechanics",
    ]);
    expect(fullWorkflow.split("\n").length).toBeGreaterThanOrEqual(210);
    expectContainsAll(fullWorkflow, [
      "ulw-plan-review-request-state-contract",
      "ulw-plan-review-round-state-contract",
      "ulw-plan-review-lifecycle-state-contract",
      "completion_cas",
      "launch_interrupted",
      "resume_after_compaction",
      "rejected_completions",
      "receipt_identity=session",
      "live_plan_sha256=plan_sha256",
      "complete literal PLAN content",
      "backing path `local://PLAN.md`",
      "get_subagent_result",
      "steer_subagent",
      "Agent(resume",
    ]);
    expectContainsAll(clearIntent, ["TOPOLOGY LOCK", "FOGGIEST-GAP targeting", "ASK WITH WHY"]);
    expectContainsAll(unclearIntent, [
      "WIDER fan-out than the clear path",
      "contrarian self-grill",
      "chengfeng",
      "wenchang",
      "direnjie",
      "yanluo",
      "taishang",
    ]);
    expectContainsAll(openAiMetadata, [
      "display_name: \"ulw-plan (omo)\"",
      "Use $ulw-plan",
    ]);

    expectContainsAll(combined, [
      "You are **Fu Xi 伏羲**",
      "local://DRAFT.md",
      "local://PLAN.md",
      "plan_scaffold",
      "plan_approve",
      "/handoff:start-work",
      "## TL;DR (For humans)",
      "## Scope",
      "## Verification strategy",
      "## Execution strategy",
      "## Todos",
      "## Final verification wave",
      "## Commit strategy",
      "## Success criteria",
      "- [ ] N. <title>",
      "- [ ] F<number>. <title>",
      "**CodeGraph first when present.** Use `codegraph_explore` for repo how/where/what/flow questions before wider reads; if codegraph_* tools are absent, inactive/uninitialized, or cold-start unavailable, continue with Read/Grep/Glob/LSP and the ast-grep skill.",
      "**Explore to sufficiency, then STOP.** One research wave per open question; stop when the clearance check is answerable; never re-explore to double-check.",
      "**Parallel-dispatch** independent research in ONE turn and keep working while it runs. Subagent outputs are CLAIMS until you independently verify them.",
      "**Agent-executed QA per todo** (happy + failure, exact tool + invocation, evidence path).",
      "Agent",
      "get_subagent_result",
      "steer_subagent",
      "chengfeng",
      "wenchang",
      "direnjie",
      "yanluo",
      "taishang",
      "orchestrator-owned code-quality gate",
      "complete literal PLAN content",
      "backing path `local://PLAN.md`",
    ]);

    expect(combined).not.toContain("task(subagent_type=");
    expect(combined).not.toContain(".omo/drafts/");
    expect(combined).not.toContain(".omo/plans/");
    expect(combined).not.toContain("$start-work");
  });

  it("keeps old modes/fuxi/references from being the authoritative runtime source", () => {
    const prompt = getFuxiPrompt();

    expect(prompt).not.toContain("~/.pi/agent/modes/fuxi/references/");
    expect(prompt).not.toContain("modes/fuxi/references");
  });
});

describe("fuxi gpt variant", () => {
  it("stays thin and points at discovered ulw-plan mechanics", () => {
    const prompt = getFuxiGptPrompt();

    expectContainsAll(prompt, MODE_PROMPT_INVARIANTS.fuxi.gpt);
    expect(prompt).not.toContain("MANDATORY PLAN GENERATION SEQUENCE");
    expect(prompt).not.toContain("ADVISORY SUBPLAN MODE");
    expect(prompt).not.toContain("~/.pi/agent/modes/fuxi/references/");
  });

  it("contains no frontmatter", () => {
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
