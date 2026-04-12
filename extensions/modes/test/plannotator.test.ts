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
  it("queues a generic /handoff command via follow-up instead of prefilling the editor", async () => {
    vi.useFakeTimers();
    try {
      const mock = createMockPi();
      const state = new ModeStateManager(mock.pi as never);
      state.planTitle = "Ship feature";
      state.planActionPending = true;

      const ctx = createCtx();
      const result = await prepareApprovedPlanHandoff(mock.pi as never, state, ctx as never);
      await vi.runAllTimersAsync();

      expect(result.success).toBe(true);
      expect(result.details).toMatchObject({ mode: "houtu", planPath: "/tmp/PLAN.md" });
      expect(result.details?.command).toContain("/handoff -mode houtu -no-summarize");
      expect(result.details?.command).toContain("/tmp/PLAN.md");
      expect(mock.pi.sendUserMessage).toHaveBeenCalledWith(result.details?.command, { deliverAs: "followUp" });
      expect(ctx.ui.setEditorText).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("approval menu starts Hou Tu handoff automatically", async () => {
    vi.useFakeTimers();
    try {
      const mock = createMockPi();
      const state = new ModeStateManager(mock.pi as never);
      state.currentMode = "fuxi";
      state.planTitle = "Ship feature";
      state.planApproved = true;
      state.planActionPending = true;
      state.planReviewApproved = true;

      const ctx = createCtx("Start Hou Tu handoff");
      await promptPostPlanAction(mock.pi as never, state, ctx as never);
      await vi.runAllTimersAsync();

      expect(mock.pi.sendUserMessage).toHaveBeenCalledTimes(1);
      expect(String(mock.pi.sendUserMessage.mock.calls[0][0])).toContain("/handoff -mode houtu -no-summarize");
      expect(ctx.ui.setEditorText).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
