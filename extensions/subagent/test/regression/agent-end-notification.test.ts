/**
 * agent-end-notification.test.ts — regression for agent_end-gated consolidated
 * completion notifications (Slice 2 of the subagent notification fix).
 *
 * Fires the agent_end lifecycle event and asserts that pi.sendMessage is/is not
 * called exactly once with the right shape for each scenario.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---- Hoisted module state ----
const widgetInstances: any[] = [];
const managerInstances: any[] = [];
let lastOnComplete: ((record: any) => void) | undefined;

vi.mock("../../src/ui/agent-widget.js", () => ({
  AgentWidget: class {
    setUICtx = vi.fn();
    update = vi.fn();
    onTurnStart = vi.fn();
    ensureTimer = vi.fn();
    markFinished = vi.fn();
    dispose = vi.fn();
    constructor() { widgetInstances.push(this); }
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

vi.mock("../../src/agent-manager.js", () => ({
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

vi.mock("../../src/cross-extension-rpc.js", () => ({
  registerRpcHandlers: vi.fn(() => ({
    unsubPing: vi.fn(),
    unsubSpawn: vi.fn(),
    unsubStop: vi.fn(),
  })),
}));

vi.mock("../../src/custom-agents.js", () => ({
  loadCustomAgentsWithDiagnostics: vi.fn(() => ({ agents: new Map(), diagnostics: [] })),
}));

vi.mock("../../src/agent-types.js", () => ({
  BUILTIN_TOOL_NAMES: [],
  getAgentConfig: vi.fn(() => ({ description: "Mock agent", promptMode: "replace" })),
  getAllTypes: vi.fn(() => ["general-purpose"]),
  getAvailableTypes: vi.fn(() => ["general-purpose"]),
  getDefaultAgentNames: vi.fn(() => ["general-purpose"]),
  getUserAgentNames: vi.fn(() => []),
  isValidType: vi.fn(() => true),
  registerAgents: vi.fn(),
  resolveType: vi.fn((type?: string) => type ?? "general-purpose"),
}));

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
  return {
    pi,
    async fire(event: string, payload: unknown, ctx: any) {
      for (const handler of lifecycleHandlers.get(event) ?? []) {
        await handler(payload, ctx);
      }
    },
  };
}

function createCtx() {
  return {
    hasUI: true,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), select: vi.fn(), notify: vi.fn() },
    modelRegistry: {},
    model: undefined,
    cwd: "/repo",
    sessionManager: { getEntries: vi.fn(() => []), getSessionId: vi.fn(() => "s1") },
  };
}

async function initExtension(mock: ReturnType<typeof createMockPi>) {
  vi.resetModules();
  const { default: init } = await import("../../src/index.js");
  init(mock.pi as never);
}

function bgRecord(id: string, overrides: Record<string, unknown> = {}): any {
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
    ...overrides,
  };
}

describe("agent_end-gated consolidated notifications", () => {
  beforeEach(() => {
    widgetInstances.length = 0;
    managerInstances.length = 0;
    lastOnComplete = undefined;
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("collect-before-idle: no notification when agent not yet completed", async () => {
    const mock = createMockPi();
    await initExtension(mock);
    const record = bgRecord("a1", { completedAt: undefined, status: "running" });
    managerInstances[0].listAgents.mockReturnValue([record]);

    await mock.fire("agent_end", {}, createCtx());

    expect(mock.pi.sendMessage).not.toHaveBeenCalled();
  });

  it("fire-and-forget: exactly ONE consolidated follow-up for a bg terminal+unconsumed agent", async () => {
    const mock = createMockPi();
    await initExtension(mock);
    const record = bgRecord("a1");
    managerInstances[0].listAgents.mockReturnValue([record]);

    await mock.fire("agent_end", {}, createCtx());

    expect(mock.pi.sendMessage).toHaveBeenCalledTimes(1);
    const [msg, opts] = mock.pi.sendMessage.mock.calls[0];
    expect(msg.customType).toBe("subagent-notification");
    expect(opts.deliverAs).toBe("followUp");
    expect(opts.triggerTurn).toBe(true);
  });

  it("mixed: consume 1 of 2 → only 1 notification for unconsumed agent", async () => {
    const mock = createMockPi();
    await initExtension(mock);
    const consumed = bgRecord("a1", { resultConsumed: true });
    const unconsumed = bgRecord("a2");
    managerInstances[0].listAgents.mockReturnValue([consumed, unconsumed]);

    await mock.fire("agent_end", {}, createCtx());

    expect(mock.pi.sendMessage).toHaveBeenCalledTimes(1);
    const [msg] = mock.pi.sendMessage.mock.calls[0];
    expect(msg.details.id).toBe("a2");
  });

  it("foreground: no notification for non-background agent", async () => {
    const mock = createMockPi();
    await initExtension(mock);
    const record = bgRecord("a1", { isBackground: false });
    managerInstances[0].listAgents.mockReturnValue([record]);

    await mock.fire("agent_end", {}, createCtx());

    expect(mock.pi.sendMessage).not.toHaveBeenCalled();
  });

  it("idempotency: 2nd agent_end fires 0 notifications because notified=true after 1st", async () => {
    const mock = createMockPi();
    await initExtension(mock);

    // Simulate AgentRun.publish({kind:"notified"}) setting record.notified
    const record = bgRecord("a1");
    record.run = {
      publish: (event: any) => {
        if (event.kind === "notified") record.notified = true;
      },
    };
    managerInstances[0].listAgents.mockReturnValue([record]);

    // First agent_end — should send one notification and mark notified
    await mock.fire("agent_end", {}, createCtx());
    expect(mock.pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(record.notified).toBe(true);

    // Second agent_end — notified=true → filter excludes the record → no message
    mock.pi.sendMessage.mockClear();
    await mock.fire("agent_end", {}, createCtx());
    expect(mock.pi.sendMessage).not.toHaveBeenCalled();
  });

  it("idle flush: supervision timer surfaces completion when parent is idle (parentBusy=false)", async () => {
    vi.useFakeTimers();
    const mock = createMockPi();
    await initExtension(mock);
    const record = bgRecord("a1");
    record.run = { publish: (e: any) => { if (e.kind === "notified") record.notified = true; } };
    managerInstances[0].listAgents.mockReturnValue([record]);

    // No agent_start fired → parentBusy stays false → timer flush emits once (notified-gated).
    await vi.advanceTimersByTimeAsync(300_000);

    expect(mock.pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(record.notified).toBe(true);
  });

  it("idle flush suppressed while the parent prompt is active (parentBusy=true)", async () => {
    vi.useFakeTimers();
    const mock = createMockPi();
    await initExtension(mock);
    const record = bgRecord("a1");
    managerInstances[0].listAgents.mockReturnValue([record]);

    await mock.fire("agent_start", {}, createCtx()); // parentBusy = true
    await vi.advanceTimersByTimeAsync(300_000);

    expect(mock.pi.sendMessage).not.toHaveBeenCalled();
  });
});
