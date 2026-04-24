import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const widgetInstances: MockAgentWidget[] = [];
const managerInstances: MockAgentManager[] = [];

class MockAgentWidget {
  setUICtx = vi.fn();
  update = vi.fn();
  onTurnStart = vi.fn();
  ensureTimer = vi.fn();
  markFinished = vi.fn();
  dispose = vi.fn();
}

class MockAgentManager {
  clearCompleted = vi.fn();
  listAgents = vi.fn(() => []);
  abortAll = vi.fn();
  dispose = vi.fn();
  waitForAll = vi.fn();
  hasRunning = vi.fn(() => false);
  spawn = vi.fn(() => "agent-1");
  getRecord = vi.fn(() => undefined);
}

vi.mock("./ui/agent-widget.js", () => ({
  AgentWidget: class {
    setUICtx = vi.fn();
    update = vi.fn();
    onTurnStart = vi.fn();
    ensureTimer = vi.fn();
    markFinished = vi.fn();
    dispose = vi.fn();

    constructor() {
      widgetInstances.push(this as unknown as MockAgentWidget);
    }
  },
  describeActivity: vi.fn(() => "thinking…"),
  formatDuration: vi.fn(() => "0.0s"),
  formatMs: vi.fn(() => "0.0s"),
  formatTokens: vi.fn(() => "󰾆 0"),
  formatTurns: vi.fn(() => "⟳ 1"),
  getDisplayName: vi.fn(() => "Agent"),
  getPromptModeLabel: vi.fn(() => undefined),
  SPINNER: ["⠋"],
}));

vi.mock("./agent-manager.js", () => ({
  AgentManager: class {
    clearCompleted = vi.fn();
    listAgents = vi.fn(() => []);
    abortAll = vi.fn();
    dispose = vi.fn();
    waitForAll = vi.fn();
    hasRunning = vi.fn(() => false);
    spawn = vi.fn(() => "agent-1");
    getRecord = vi.fn(() => undefined);

    constructor() {
      managerInstances.push(this as unknown as MockAgentManager);
    }
  },
}));

vi.mock("./cross-extension-rpc.js", () => ({
  registerRpcHandlers: vi.fn(() => ({
    unsubPing: vi.fn(),
    unsubSpawn: vi.fn(),
    unsubStop: vi.fn(),
  })),
}));

vi.mock("./custom-agents.js", () => ({
  loadCustomAgents: vi.fn(() => new Map()),
}));

vi.mock("./agent-types.js", () => ({
  BUILTIN_TOOL_NAMES: [],
  getAgentConfig: vi.fn(() => ({
    description: "Mock agent",
    promptMode: "replace",
  })),
  getAllTypes: vi.fn(() => ["general-purpose"]),
  getAvailableTypes: vi.fn(() => ["general-purpose"]),
  getDefaultAgentNames: vi.fn(() => ["general-purpose"]),
  getUserAgentNames: vi.fn(() => []),
  registerAgents: vi.fn(),
  resolveType: vi.fn((type?: string) => type ?? "general-purpose"),
}));

type LifecycleHandler = (event: unknown, ctx: any) => Promise<void> | void;

function createMockPi() {
  const lifecycleHandlers = new Map<string, LifecycleHandler[]>();

  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
    events: {
      emit: vi.fn(),
      on: vi.fn(() => vi.fn()),
    },
    on(event: string, handler: LifecycleHandler) {
      const handlers = lifecycleHandlers.get(event) ?? [];
      handlers.push(handler);
      lifecycleHandlers.set(event, handlers);
    },
  };

  return {
    pi,
    async fire(event: string, payload: unknown, ctx: any) {
      for (const handler of lifecycleHandlers.get(event) ?? []) {
        await handler(payload, ctx);
      }
    },
  };
}

async function initExtension(mock: ReturnType<typeof createMockPi>) {
  vi.resetModules();
  const { default: init } = await import("./index.js");
  init(mock.pi as never);
}

function createCtx() {
  return {
    hasUI: true,
    ui: {
      setStatus: vi.fn(),
      setWidget: vi.fn(),
    },
  };
}

describe("subagent session UI rebinding", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    widgetInstances.length = 0;
    managerInstances.length = 0;
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("rebinds the widget to the new session on session_start", async () => {
    const mock = createMockPi();
    await initExtension(mock);
    const ctx = createCtx();

    await mock.fire("session_start", { reason: "new" }, ctx);

    expect(managerInstances[0]?.clearCompleted).toHaveBeenCalledTimes(1);
    expect(widgetInstances[0]?.setUICtx).toHaveBeenCalledWith(ctx.ui);
    expect(widgetInstances[0]?.update).toHaveBeenCalledTimes(1);
  });

  it("rebinds the widget to the active session on session_start resume", async () => {
    const mock = createMockPi();
    await initExtension(mock);
    const ctx = createCtx();

    await mock.fire("session_start", { reason: "resume" }, ctx);

    expect(managerInstances[0]?.clearCompleted).toHaveBeenCalledTimes(1);
    expect(widgetInstances[0]?.setUICtx).toHaveBeenCalledWith(ctx.ui);
    expect(widgetInstances[0]?.update).toHaveBeenCalledTimes(1);
  });
});
