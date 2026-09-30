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
});

describe("plan execution goal builder", () => {
  it("inserts the plan path into the goal", () => {
    const goal = buildPlanExecutionGoal("/tmp/PLAN.md");
    expect(goal).toMatch(/\/tmp\/PLAN\.md/);
  });
});
