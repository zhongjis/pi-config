/**
 * Regression: Fu Xi/Hou Tu oversized-task orchestration deadlock (issue #10).
 *
 * Root cause: the Pi-only worker scope guard (">3 product files -> stop and
 * split") forced Hou Tu to carve one logical plan item into multiple
 * separately-`COMPLETED` worker slices, which collides with the inherited Atlas
 * post-delegation rule ("mark complete after EVERY verified Agent completion").
 *
 * Faithful fix (this repo's adaptation of upstream omo):
 *   - Workers no longer reject on file count; one plan item = one resumable
 *     worker session, and partial work returns BLOCKED (never COMPLETED).
 *   - Hou Tu keeps Atlas Rule A + Section 3.5 resume-in-place verbatim and does
 *     NOT re-split plan items.
 *   - Planner/orchestrator/contract size by domain/deliverable granularity, not
 *     a fixed file count.
 *
 * These assertions lock the fix so the deadlock cannot silently return.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (...p: string[]): string => readFileSync(join(process.cwd(), ...p), "utf-8");

const JINTONG = read("agents", "jintong.md");
const JULING = read("agents", "juling.md");
const HOUTU_DEFAULT = read("modes", "houtu", "mode.md");
const HOUTU_GPT = read("modes", "houtu", "gpt.md");
const HOUTU_GEMINI = read("modes", "houtu", "gemini.md");
const HOUTU_GEMINI_EFFECTIVE = `${HOUTU_DEFAULT}\n${HOUTU_GEMINI}`;
const FUXI_SKILL = read("modes", "fuxi", "skills", "ulw-plan", "SKILL.md");
const FUXI_WORKFLOW = read("modes", "fuxi", "skills", "ulw-plan", "references", "full-workflow.md");
const KUAFU_DEFAULT = read("modes", "kuafu", "mode.md");
const KUAFU_GPT = read("modes", "kuafu", "gpt.md");
const MODES_CONTRACT = read("modes", "AGENTS.md");
const ORCHESTRATION_FLOW = read("docs", "specs", "orchestration-flow.md");

// Old divergent strings that must disappear.
const OLD_WORKER_GUARD = "more than 3 expected product files";
const OLD_PLANNER_PROXY = "no more than three expected product files";
const OLD_ORCH_PROXY = "\u22643 expected product files"; // "≤3 expected product files"
const OLD_WORKER_SPLIT_ORDER = "propose a split when the prompt is too broad";
// New faithful markers.
const GRANULARITY_MARKER = "not by a fixed file count";

describe("issue #10 S1: worker scope guard no longer forces file-count splits", () => {
  for (const [name, body] of [
    ["jintong", JINTONG],
    ["juling", JULING],
  ] as const) {
    it(`${name}: drops the >3-product-files rejection`, () => {
      expect(body).not.toContain(OLD_WORKER_GUARD);
    });
    it(`${name}: keeps a genuine-ambiguity valve`, () => {
      expect(body.toLowerCase()).toContain("genuinely ambiguous");
    });
    it(`${name}: partial work returns BLOCKED, never COMPLETED`, () => {
      expect(body).toContain("never report partial work as `COMPLETED`");
    });
    it(`${name}: preserves the scope-containment rule`, () => {
      expect(body).toContain("MUST stay inside assigned scope");
    });
  }
});

describe("issue #10 S2: Hou Tu keeps the inherited Atlas rule and resumes in place", () => {
  for (const [name, body] of [
    ["houtu/mode", HOUTU_DEFAULT],
    ["houtu/gpt", HOUTU_GPT],
  ] as const) {
    it(`${name}: Atlas post-delegation Rule A stays verbatim`, () => {
      expect(body).toContain("After EVERY verified `Agent` completion");
    });
    it(`${name}: Section 3.5 resume-in-place is present`, () => {
      expect(body).toMatch(/3\.5 Handle [Ff]ailures/);
      expect(body).toContain("Agent(resume");
    });
    it(`${name}: forbids re-splitting a plan item and drops the file-count proxy`, () => {
      expect(body).toContain("Do not re-split");
      expect(body).not.toContain(OLD_PLANNER_PROXY);
      expect(body).not.toContain("propose a split");
    });
  }
});

describe("issue #10 S3: sizing is by granularity, not a fixed file count", () => {
  it("Fu Xi ulw-plan SKILL.md drops the file-count proxy and states granularity", () => {
    expect(FUXI_SKILL).not.toContain(OLD_PLANNER_PROXY);
    expect(FUXI_SKILL).toContain(GRANULARITY_MARKER);
    expect(FUXI_SKILL).toContain("5-8 todos per wave");
  });
  it("Fu Xi full-workflow.md drops the file-count proxy", () => {
    expect(FUXI_WORKFLOW).not.toContain(OLD_PLANNER_PROXY);
    expect(FUXI_WORKFLOW).toContain(GRANULARITY_MARKER);
  });
  for (const [name, body] of [
    ["kuafu/mode", KUAFU_DEFAULT],
    ["kuafu/gpt", KUAFU_GPT],
  ] as const) {
    it(`${name}: drops the file-count proxy and the worker-split order`, () => {
      expect(body).not.toContain(OLD_ORCH_PROXY);
      expect(body).not.toContain(OLD_WORKER_SPLIT_ORDER);
      expect(body).toContain(GRANULARITY_MARKER);
      expect(body).toContain("loose coupling");
      expect(body).toContain("indivisible");
    });
  }
  it("modes/AGENTS.md contract drops the file-count proxy", () => {
    expect(MODES_CONTRACT).not.toContain(OLD_ORCH_PROXY);
    expect(MODES_CONTRACT).toContain(GRANULARITY_MARKER);
  });
});

describe("Hou Tu prompt contract accepted fixes", () => {
  it("uses bare PLAN.md because /handoff:start-work supplies the actual plan path", () => {
    expect(HOUTU_DEFAULT).not.toContain("local://PLAN.md");
    expect(HOUTU_DEFAULT).toContain("Complete every task in `PLAN.md`");
    expect(HOUTU_DEFAULT).toContain("/handoff:start-work");
    expect(HOUTU_DEFAULT).toContain("buildPlanExecutionGoal(planPath)");
  });

  it("keeps notepads under the plan-specific local directory without mandating all files", () => {
    expect(HOUTU_DEFAULT).toContain("local://{plan-name}/notepads/");
    expect(HOUTU_DEFAULT).not.toContain("Read notepad files");
    expect(HOUTU_DEFAULT).not.toContain("notepads/{plan-name}/*.md");
  });

  it("uses Agent resume for failures and final-wave fixes", () => {
    expect(HOUTU_DEFAULT).not.toContain("<need-update>");
    expect(HOUTU_DEFAULT).not.toContain('subagent_type: "chengfeng", // must match original type');
    expect(HOUTU_DEFAULT).not.toContain("delegate via `task()` with `task_id`");
    expect(HOUTU_DEFAULT).toContain("subagent_type: \"[original-worker]\"");
    expect(HOUTU_DEFAULT).toContain("Agent(resume)");
  });

  it("keeps QA wording and Pi-native boundary tools exact", () => {
    expect(HOUTU_DEFAULT).toContain("Subagents lie");
    expect(HOUTU_DEFAULT).toContain("Browser via /skills:agent-browser");
    expect(HOUTU_DEFAULT).toContain("`interactive_bash`");
    expect(HOUTU_DEFAULT).toContain("real requests via `curl`");
    expect(HOUTU_DEFAULT).not.toContain("#### A. Automated verification**");
    expect(HOUTU_DEFAULT).not.toContain("#### B. Manual code review (NON-NEGOTIABLE)**");
    expect(HOUTU_DEFAULT).not.toContain("#### D. Read the plan file directly**");
    expect(HOUTU_DEFAULT).toContain("Use LSP diagnostics, rg, fd");
  });

  it("docs describe bare PLAN.md with the handoff-supplied approved plan path", () => {
    expect(MODES_CONTRACT).not.toContain("executes `local://PLAN.md`");
    expect(MODES_CONTRACT).toContain("executes `PLAN.md`");
    expect(ORCHESTRATION_FLOW).not.toContain("Hou Tu reads `local://PLAN.md`");
    expect(ORCHESTRATION_FLOW).toContain("Hou Tu reads `PLAN.md` at the approved plan path supplied by `/handoff:start-work`");
  });
});

describe("Hou Tu GPT/Gemini accepted prompt-contract parity", () => {
  for (const [name, body] of [
    ["houtu/gpt replacement", HOUTU_GPT],
    ["houtu/gemini effective prompt", HOUTU_GEMINI_EFFECTIVE],
  ] as const) {
    it(`${name}: uses the handoff-supplied bare PLAN.md path`, () => {
      expect(body).not.toContain("local://PLAN.md");
      expect(body).toContain("`PLAN.md`");
      expect(body).toContain("/handoff:start-work");
      expect(body).toContain("buildPlanExecutionGoal(planPath)");
    });

    it(`${name}: preserves strict worker prompts and exact QA language`, () => {
      expect(body).toContain("under 30 lines");
      expect(body).toContain("TOO SHORT");
      expect(body).toContain("Subagents lie");
      expect(body).toContain("/skills:agent-browser");
      expect(body).toContain("`interactive_bash`");
      expect(body).toContain("`curl`");
      expect(body).toContain("LSP diagnostics, rg, fd");
    });

    it(`${name}: uses canonical task-relevant notepads and Pi-native resume`, () => {
      expect(body).toContain("local://{plan-name}/notepads/");
      expect(body).not.toContain("local://NOTEPAD.");
      expect(body).not.toContain("notepads/{plan-name}");
      expect(body).not.toContain("<need-update>");
      expect(body).not.toContain("task_id");
      expect(body).toContain("Agent(resume)");
    });
  }

  it("Gemini overlay corrects rather than re-splitting an approved plan item", () => {
    expect(HOUTU_GEMINI).toContain("<gemini-corrective-overlay>");
    expect(HOUTU_GEMINI).not.toContain("Split multi-domain or oversized work before launch");
    expect(HOUTU_GEMINI).toContain("Do not re-split");
  });

  it("keeps Atlas GPT structure and detail while using settled Hou Tu adaptations", () => {
    expect(HOUTU_GPT.split("\n").length).toBeGreaterThanOrEqual(500);

    const orderedSections = [
      "<agent-identity>",
      "<identity>",
      "<mission>",
      "<gpt_calibration>",
      "<anti_duplication>",
      "<delegation_system>",
      "<auto_continue>",
      "<parallel_execution>",
      "<workflow>",
      "<notepad_protocol>",
      "<verification_philosophy>",
      "<boundaries>",
      "<critical_rules>",
      "<post_delegation_rule>",
      "<completion_response>",
    ];
    let previous = -1;
    for (const section of orderedSections) {
      const position = HOUTU_GPT.indexOf(section);
      expect(position, `${section} missing or out of order`).toBeGreaterThan(previous);
      previous = position;
    }

    expect(HOUTU_GPT).toContain("### Plan Owner Decision Matrix");
    expect(HOUTU_GPT).toContain("### MANDATORY: Plan Assignment Protocol");
    expect(HOUTU_GPT).toContain("### Worker Domain Matching (ZERO TOLERANCE)");
    expect(HOUTU_GPT).toContain("#### PHASE 1: READ THE CODE FIRST");
    expect(HOUTU_GPT).toContain("## When the plan completes");
  });

  it("uses canonical Hou Tu identity, handoff, task tracking, and agent lifecycle only", () => {
    expect(HOUTU_GPT).toContain('Your designated identity for this session is "Hou Tu"');
    expect(HOUTU_GPT).toContain("always identify as Hou Tu");
    expect(HOUTU_GPT).not.toContain("always identify as Atlas");
    expect(HOUTU_GPT).toContain("/handoff:start-work");
    expect(HOUTU_GPT).toContain("buildPlanExecutionGoal(planPath)");
    expect(HOUTU_GPT).toContain("TaskCreate");
    expect(HOUTU_GPT).toContain("TaskUpdate addBlockedBy");
    expect(HOUTU_GPT).toContain("TaskList");
    expect(HOUTU_GPT).toContain("get_subagent_result");
    expect(HOUTU_GPT).toContain("steer_subagent");

    for (const stale of [
      "task()",
      "task_id",
      "background_output",
      "background_cancel",
      "TodoWrite",
      ".omo/",
      "boulder.json",
      "BOULDER COMPLETE",
      "Atlas",
      "load_skills",
      "category=",
    ]) {
      expect(HOUTU_GPT, `stale OMO contract: ${stale}`).not.toContain(stale);
    }
  });
});
