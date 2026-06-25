/**
 * context-percent.test.ts — verifies contextPercent is surfaced in event payloads.
 *
 * Uses the same AgentManager mock pattern as agent-end-notification.test.ts:
 * captures the real onComplete callback from registerSubagentRuntime, then invokes
 * it with mock records to verify buildEventData includes contextPercent.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---- Hoisted module state ----
const managerInstances: any[] = [];
let lastOnComplete: ((record: any) => void) | undefined;

vi.mock("../src/ui/agent-widget.js", () => ({
  AgentWidget: class {
    setUICtx = vi.fn();
    update = vi.fn();
    onTurnStart = vi.fn();
    ensureTimer = vi.fn();
    markFinished = vi.fn();
    dispose = vi.fn();
  },
  describeActivity: vi.fn(() => "thinking…"),
  formatDuration: vi.fn(() => "0.0s"),
  formatMs: vi.fn(() => "0.0s"),
  formatTokens: vi.fn(() => "󰾆 0"),
  formatTurns: vi.fn(() => "⟳ 1"),
  getDisplayName: vi.fn((t: string) => t),
  getPromptModeLabel: vi.fn(() => undefined),
  SPINNER: ["⠋"],
}));

vi.mock("../src/agent-manager.js", () => ({
  AgentManager: class {
    clearCompleted = vi.fn();
    listAgents = vi.fn(() => []);
    abortAll = vi.fn();
    dispose = vi.fn();
    waitForAll = vi.fn();
    hasRunning = vi.fn(() => false);
    spawn = vi.fn(() => "agent-1");
    getRecord = vi.fn(() => undefined);
    spawnAndWait = vi.fn();
    setMaxConcurrent = vi.fn();
    constructor(onComplete?: any) {
      lastOnComplete = onComplete;
      managerInstances.push(this);
    }
    invokeOnComplete(record: any) { lastOnComplete?.(record); }
  },
}));

vi.mock("../src/cross-extension-rpc.js", () => ({
  registerRpcHandlers: vi.fn(() => ({
    unsubPing: vi.fn(),
    unsubSpawn: vi.fn(),
    unsubStop: vi.fn(),
    unsubConsume: vi.fn(),
  })),
}));

vi.mock("../src/custom-agents.js", () => ({
  loadCustomAgentsWithDiagnostics: vi.fn(() => ({ agents: new Map(), diagnostics: [] })),
}));

vi.mock("../src/agent-types.js", () => ({
  BUILTIN_TOOL_NAMES: [],
  getAgentConfig: vi.fn(() => ({ description: "Mock agent", promptMode: "replace" })),
  getAllTypes: vi.fn(() => ["general-purpose"]),
  getAvailableTypes: vi.fn(() => ["general-purpose"]),
  isValidType: vi.fn(() => true),
  registerAgents: vi.fn(),
  resolveType: vi.fn((type?: string) => type ?? "general-purpose"),
}));

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<any>("../src/agent-runner.js");
  return { ...actual, steerAgent: vi.fn() };
});

vi.mock("@earendil-works/pi-coding-agent", () => ({
  defineTool: (opts: any) => opts,
  getAgentDir: vi.fn(() => "/tmp/mock-agent-dir"),
}));

// ---- Test infrastructure ----
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
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
    on(event: string, handler: LifecycleHandler) {
      const handlers = lifecycleHandlers.get(event) ?? [];
      handlers.push(handler);
      lifecycleHandlers.set(event, handlers);
    },
  };
  return { pi };
}

async function initExtension(mock: ReturnType<typeof createMockPi>) {
  vi.resetModules();
  const { default: init } = await import("../src/index.js");
  init(mock.pi as never);
}

function makeRecord(id: string, sessionOverrides?: Record<string, unknown>): any {
  return {
    id,
    type: "general-purpose",
    description: `agent ${id}`,
    status: "completed",
    toolUses: 0,
    startedAt: Date.now() - 5000,
    completedAt: Date.now(),
    result: "done",
    isBackground: true,
    resultConsumed: false,
    suppressNotification: false,
    notified: false,
    session: {
      getSessionStats: vi.fn(() => ({ tokens: { input: 10, output: 5, total: 15 }, ...sessionOverrides })),
    },
  };
}

describe("context-percent in event payload", () => {
  beforeEach(() => {
    managerInstances.length = 0;
    lastOnComplete = undefined;
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("includes contextPercent when contextUsage.percent is available", async () => {
    const mock = createMockPi();
    await initExtension(mock);

    const record = makeRecord("a1", { contextUsage: { percent: 72 } });
    lastOnComplete?.(record);

    const emitCalls = (mock.pi.events.emit as ReturnType<typeof vi.fn>).mock.calls;
    const completedCall = emitCalls.find(([name]: [string]) => name === "subagents:completed");
    expect(completedCall).toBeDefined();
    expect(completedCall![1]).toMatchObject({ id: "a1", contextPercent: 72 });
  });

  it("sets contextPercent to null when contextUsage is undefined", async () => {
    const mock = createMockPi();
    await initExtension(mock);

    const record = makeRecord("a2", { contextUsage: undefined });
    lastOnComplete?.(record);

    const emitCalls = (mock.pi.events.emit as ReturnType<typeof vi.fn>).mock.calls;
    const completedCall = emitCalls.find(([name]: [string]) => name === "subagents:completed");
    expect(completedCall).toBeDefined();
    expect(completedCall![1]).toMatchObject({ id: "a2", contextPercent: null });
  });

  it("sets contextPercent to null when getSessionStats throws", async () => {
    const mock = createMockPi();
    await initExtension(mock);

    const record = makeRecord("a3");
    record.session.getSessionStats = vi.fn(() => { throw new Error("stats unavailable"); });
    lastOnComplete?.(record);

    const emitCalls = (mock.pi.events.emit as ReturnType<typeof vi.fn>).mock.calls;
    const completedCall = emitCalls.find(([name]: [string]) => name === "subagents:completed");
    expect(completedCall).toBeDefined();
    expect(completedCall![1]).toMatchObject({ id: "a3", contextPercent: null });
  });
});
