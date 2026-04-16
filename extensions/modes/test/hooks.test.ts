import { describe, expect, it, vi } from "vitest";

vi.mock("@mariozechner/pi-coding-agent", () => ({
  CustomEditor: class {
    constructor(..._args: unknown[]) {}
    handleInput(_data: string): void {}
    getText(): string { return ""; }
  },
}));

vi.mock("@mariozechner/pi-tui", () => ({
  Key: { tab: "tab" },
  matchesKey: () => false,
}));

vi.mock("../src/config-loader.js", () => ({
  loadAgentConfig: () => ({ body: "" }),
}));

vi.mock("../src/plannotator.js", () => ({
  recoverPlanReview: vi.fn(async () => {}),
}));

vi.mock("../src/plan-local.js", () => ({
  LOCAL_PLAN_URI: "local://PLAN.md",
  getLocalPlanPath: () => "/tmp/PLAN.md",
  readLocalPlanFile: vi.fn(async () => "# Plan\n\n- item"),
}));

import { registerModeHooks } from "../src/hooks.js";
import { ModeStateManager } from "../src/mode-state.js";

function createMockPi() {
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown | Promise<unknown>>>();

  return {
    pi: {
      on(event: string, handler: (event: unknown, ctx: unknown) => unknown | Promise<unknown>) {
        const next = handlers.get(event) ?? [];
        next.push(handler);
        handlers.set(event, next);
      },
      getAllTools: () => [{ name: "read" }, { name: "write" }, { name: "edit" }, { name: "bash" }, { name: "Agent" }],
      setActiveTools: vi.fn(),
      setModel: vi.fn(),
      appendEntry: vi.fn(),
      getFlag: vi.fn(() => undefined),
      sendUserMessage: vi.fn(),
    },
    async fire(event: string, payload: unknown, ctx: unknown) {
      const results: unknown[] = [];
      for (const handler of handlers.get(event) ?? []) {
        results.push(await handler(payload, ctx));
      }
      return results;
    },
  };
}

describe("mode hooks", () => {
  it("appends mode prompt during before_agent_start", async () => {
    const mock = createMockPi();
    const state = new ModeStateManager(mock.pi as never);
    state.currentMode = "fuxi";
    state.cachedConfigs.fuxi = { body: "Fu Xi prompt" };

    registerModeHooks(mock.pi as never, state);

    const [result] = await mock.fire("before_agent_start", { systemPrompt: "Base prompt" }, { hasUI: false });
    expect(result).toEqual({ systemPrompt: "Base prompt\n\nFu Xi prompt" });
  });

  it("blocks plan-mode writes outside local://PLAN.md", async () => {
    const mock = createMockPi();
    const state = new ModeStateManager(mock.pi as never);
    state.currentMode = "fuxi";
    state.cachedConfigs.fuxi = { body: "" };

    registerModeHooks(mock.pi as never, state);

    const [result] = await mock.fire(
      "tool_call",
      { toolName: "write", input: { path: "src/app.ts" } },
      { sessionManager: { getSessionId: () => "session-1" } },
    );

    expect(result).toMatchObject({
      block: true,
      reason: expect.stringContaining("local://PLAN.md"),
    });
  });
});
