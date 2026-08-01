import { describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-ai", () => ({
  complete: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  BorderedLoader: class {},
  convertToLlm: (messages: unknown) => messages,
  serializeConversation: () => "[]",
}));

import { buildPlanExecutionGoal, parseHandoffArgs } from "../runtime.js";

describe("handoff argument parsing", () => {
  it("parses named flags and defaults", () => {
    const parsed = parseHandoffArgs('-mode houtu -no-summarize "ship feature"');
    expect(parsed).toEqual({
      ok: true,
      value: {
        goal: "ship feature",
        mode: "houtu",
        summarize: false,
      },
    });
  });

  it("decodes JSON-stringified goals for command-ready plan handoff prompts", () => {
    const goal = "Line one\nLine two";
    const parsed = parseHandoffArgs(`-mode houtu -no-summarize ${JSON.stringify(goal)}`);
    expect(parsed).toEqual({
      ok: true,
      value: {
        goal,
        mode: "houtu",
        summarize: false,
      },
    });
  });

  it("accepts explicit summarize booleans for compatibility", () => {
    const parsed = parseHandoffArgs('-mode kuafu -summarize false fix auth');
    expect(parsed).toEqual({
      ok: true,
      value: {
        goal: "fix auth",
        mode: "kuafu",
        summarize: false,
      },
    });
  });
});

describe("plan execution goal builder", () => {
  it("preserves the public Hou Tu plan-execution seam", () => {
    const goal = buildPlanExecutionGoal("/tmp/PLAN.md");
    expect(goal).toMatch(/approved plan at \/tmp\/PLAN\.md/i);
    expect(goal).toMatch(/foreground Agent calls[\s\S]*concurrent/i);
    expect(goal).toMatch(/background Agent calls[\s\S]*(?:exploration|research)/i);
    expect(goal).toMatch(
      /local:\/\/\{plan-name\}\/notepads\/[\s\S]*learnings\.md[\s\S]*decisions\.md[\s\S]*issues\.md[\s\S]*blockers\.md/i,
    );
    expect(goal).toMatch(/all workers[^\n]*read only[^\n]*relevant[^\n]*notepad/i);
    expect(goal).toMatch(
      /mutation-capable workers[^\n]*append only[^\n]*relevant findings[^\n]*preserve unrelated entries/i,
    );
    expect(goal).toMatch(
      /read-only researchers[^\n]*return findings to the parent for curation/i,
    );
    expect(goal).toMatch(
      /capability-aware shared-note instructions[^\n]*under CONTEXT/i,
    );
    expect(goal).not.toMatch(/\b(?:all|every) workers?\b[^\n]*\bappend\b/i);
    expect(goal).not.toMatch(/^\s*-\s*workers?\b[^\n]*\bappend\b/im);
    expect(goal).not.toMatch(/edit\/write/i);
    expect(goal).not.toMatch(/local:\/\/houtu\/artifacts\/|exact absolute FILE|nonce|one writer[^\n]*one file|receipt|capability grant/i);
    expect(goal).toMatch(/explicit okay/i);
  });
});
