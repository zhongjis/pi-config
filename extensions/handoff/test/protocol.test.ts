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
  it("produces Hou Tu-aligned execution guidance without handoff protocol details", () => {
    const goal = buildPlanExecutionGoal("/tmp/PLAN.md");
    expect(goal).toContain("/tmp/PLAN.md");
    expect(goal).toContain("Read the full plan before making changes.");
    expect(goal).toContain("one pi-task per top-level plan task plus final verification gates");
    expect(goal).toContain("Treat waves as labels; derive runnable work from the dependency graph.");
    expect(goal).toContain("batch all independent runnable tasks in one TaskExecute call");
    expect(goal).toContain("If running fewer than all runnable tasks, record the specific dependency or file/path conflict");
    expect(goal).toContain("pi-task completed is not proof");
    expect(goal).toContain("every Final Verification Wave verdict is APPROVE");
    expect(goal).not.toContain("Execute step by step");
    expect(goal).not.toContain("HANDOFF.json");
    expect(goal).not.toContain("__PI_HANDOFF_EXECUTE__");
  });
});
