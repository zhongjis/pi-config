import { describe, expect, it, vi } from "vitest";

vi.mock("../../handoff/src/runtime.js", () => ({
  buildPlanExecutionGoal: (planPath: string) => [`Execute work described in approved plan at ${planPath}.`, "- Read the full plan before making changes."].join("\n"),
}));

vi.mock("../src/plan-storage.js", () => ({
  hydratePlanState: vi.fn(async () => ({
    content: "# Plan\n\n- ship feature",
    title: "Plan",
    source: "local",
  })),
}));

vi.mock("../src/plan-local.js", () => ({
  LOCAL_PLAN_URI: "local://PLAN.md",
  getLocalPlanPath: () => "/tmp/PLAN.md",
}));

vi.mock("../src/config-loader.js", () => ({
  loadAgentConfig: () => ({ body: "" }),
}));


import { ModeStateManager } from "../src/mode-state.js";
import { prepareApprovedPlanHandoff, promptPostPlanAction } from "../src/plannotator.js";

function createMockPi() {
  return {
    pi: {
      appendEntry: vi.fn(),
      getAllTools: () => [],
      setActiveTools: vi.fn(),
      setModel: vi.fn(),
      events: { emit: vi.fn() },
      sendUserMessage: vi.fn(),
    },
  };
}

function createCtx(selectResult: string | null = null) {
  return {
    hasUI: true,
    ui: {
      notify: vi.fn(),
      setEditorText: vi.fn(),
      select: vi.fn(async () => selectResult),
      editor: vi.fn(async () => undefined),
    },
  };
}

describe("plannotator handoff prep", () => {
  it("prepares a generic /handoff command instead of RPC handoff artifacts", async () => {
    const mock = createMockPi();
    const state = new ModeStateManager(mock.pi as never);
    state.planTitle = "Ship feature";
    state.planActionPending = true;

    const ctx = createCtx();
    const result = await prepareApprovedPlanHandoff(mock.pi as never, state, ctx as never);

    expect(result.success).toBe(true);
    expect(result.details).toMatchObject({ mode: "houtu", planPath: "/tmp/PLAN.md" });
    expect(result.details?.command).toContain("/handoff -mode houtu -no-summarize");
    expect(result.details?.command).toContain("/tmp/PLAN.md");
    expect(ctx.ui.setEditorText).toHaveBeenCalledWith(result.details?.command);
  });

  it("approval menu prepares Hou Tu handoff command in editor", async () => {
    const mock = createMockPi();
    const state = new ModeStateManager(mock.pi as never);
    state.currentMode = "fuxi";
    state.planTitle = "Ship feature";
    state.planApproved = true;
    state.planActionPending = true;
    state.planReviewApproved = true;

    const ctx = createCtx("Prepare Hou Tu handoff command");
    await promptPostPlanAction(mock.pi as never, state, ctx as never);

    expect(ctx.ui.setEditorText).toHaveBeenCalledTimes(1);
    expect(String(ctx.ui.setEditorText.mock.calls[0][0])).toContain("/handoff -mode houtu -no-summarize");
  });
});
