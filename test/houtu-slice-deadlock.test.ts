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
const FUXI_SKILL = read("modes", "fuxi", "skills", "ulw-plan", "SKILL.md");
const FUXI_WORKFLOW = read("modes", "fuxi", "skills", "ulw-plan", "references", "full-workflow.md");
const KUAFU_DEFAULT = read("modes", "kuafu", "mode.md");
const KUAFU_GPT = read("modes", "kuafu", "gpt.md");
const MODES_CONTRACT = read("modes", "AGENTS.md");

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
      expect(body).toContain("3.5 Handle failures");
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
