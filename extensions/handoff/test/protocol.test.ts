import { describe, expect, it, vi } from "vitest";

vi.mock("@mariozechner/pi-ai", () => ({
  complete: vi.fn(),
}));

vi.mock("@mariozechner/pi-coding-agent", () => ({
  BorderedLoader: class {},
  convertToLlm: (messages: unknown) => messages,
  serializeConversation: () => "[]",
}));

import { buildPlanExecutionGoal, parseHandoffArgs } from "../src/runtime.js";

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
  it("produces execution guidance without handoff protocol details", () => {
    const goal = buildPlanExecutionGoal("/tmp/PLAN.md");
    expect(goal).toContain("/tmp/PLAN.md");
    expect(goal).toContain("Read the full plan before making changes.");
    expect(goal).toContain("Break each unchecked plan item into concrete implementation tasks");
    expect(goal).not.toContain("HANDOFF.json");
    expect(goal).not.toContain("__PI_HANDOFF_EXECUTE__");
  });
});
