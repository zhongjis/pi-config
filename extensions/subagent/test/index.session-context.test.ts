const customAgentLoaderState = vi.hoisted(() => ({
  result: {
    agents: new Map(),
    diagnostics: [] as Array<{ file: string; agentName: string; field: string; severity: "warning" | "error"; message: string }>,
  },
}));

const agentTypeState = vi.hoisted<{
  allTypes: string[];
  availableTypes: string[];
  resolveType: (type?: string) => string | undefined;
  isValidType: () => boolean;
}>(() => ({
  allTypes: ["general-purpose"],
  availableTypes: ["general-purpose"],
  resolveType: (type?: string) => type ?? "general-purpose",
  isValidType: () => true,
}));

import { writeFileSync } from "node:fs";
import type { AgentRecord, ResumeRuntimeSnapshot } from "../src/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const widgetInstances: MockAgentWidget[] = [];
const managerInstances: MockAgentManager[] = [];
let lastOnComplete: ((record: any) => void) | undefined;
let lastOnStart: ((record: any) => void) | undefined;
let lastRpcDeps: any;

class MockAgentWidget {
  setUICtx = vi.fn();
  setUsingSubscription = vi.fn();
  update = vi.fn();
  onTurnStart = vi.fn();
  ensureTimer = vi.fn();
  markFinished = vi.fn();
  dispose = vi.fn();
}

class MockAgentManager {
  clearCompleted = vi.fn();
  resetLifetimeCost = vi.fn();
  getLifetimeCost = vi.fn(() => 0);
  listAgents = vi.fn((): any[] => []);
  abortAll = vi.fn();
  abort = vi.fn();
  dispose = vi.fn();
  waitForAll = vi.fn();
  hasRunning = vi.fn(() => false);
  spawn = vi.fn(() => "agent-1");
  getRecord = vi.fn((_id: string): AgentRecord | undefined => undefined);
  spawnAndWait = vi.fn();
  resume = vi.fn();
  invokeOnComplete(record: any) { lastOnComplete?.(record); }
  invokeOnStart(record: any) { lastOnStart?.(record); }
}

vi.mock("../src/ui/agent-widget.js", () => ({
  AgentWidget: class {
    setUICtx = vi.fn();
    setUsingSubscription = vi.fn();
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

vi.mock("../src/agent-manager.js", () => ({
  AgentManager: class {
    clearCompleted = vi.fn();
    resetLifetimeCost = vi.fn();
    getLifetimeCost = vi.fn(() => 0);
    listAgents = vi.fn((): any[] => []);
    abortAll = vi.fn();
    abort = vi.fn();
    dispose = vi.fn();
    waitForAll = vi.fn();
    hasRunning = vi.fn(() => false);
    spawn = vi.fn(() => "agent-1");
    getRecord = vi.fn((_id: string): AgentRecord | undefined => undefined);
    spawnAndWait = vi.fn();
    resume = vi.fn();
    constructor(onComplete?: any, _onError?: any, onStart?: any) {
      lastOnComplete = onComplete;
      lastOnStart = onStart;
      managerInstances.push(this as unknown as MockAgentManager);
    }
    invokeOnComplete(record: any) { lastOnComplete?.(record); }
    invokeOnStart(record: any) { lastOnStart?.(record); }
  },
}));

vi.mock("../src/cross-extension-rpc.js", () => ({
  registerRpcHandlers: vi.fn((deps: any) => {
    lastRpcDeps = deps;
    return {
      unsubPing: vi.fn(),
      unsubSpawn: vi.fn(),
      unsubStop: vi.fn(),
      unsubConsume: vi.fn(),
    };
  }),
}));

vi.mock("../src/custom-agents.js", () => ({
  loadCustomAgentsWithDiagnostics: vi.fn(() => customAgentLoaderState.result),
}));

vi.mock("../src/agent-types.js", () => ({
  BUILTIN_TOOL_NAMES: [],
  getAgentConfig: vi.fn(() => ({
    description: "Mock agent",
    promptMode: "replace",
  })),
  getAllTypes: vi.fn(() => agentTypeState.allTypes),
  getAvailableTypes: vi.fn(() => agentTypeState.availableTypes),
  isValidType: vi.fn(() => agentTypeState.isValidType()),
  registerAgents: vi.fn(),
  resolveType: vi.fn((type?: string) => agentTypeState.resolveType(type)),
}));

vi.mock("../src/agent-runner.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agent-runner.js")>();
  const runtime: ResumeRuntimeSnapshot = {
    piVersion: "test",
    model: { provider: "test", id: "test", api: "test" },
    thinkingLevel: "off",
    promptMode: "replace",
    isolated: false,
    inheritContext: false,
    systemPromptHash: "1".repeat(64),
    resourcePolicyHash: "2".repeat(64),
    agentConfigHash: "3".repeat(64),
    extensionIdentities: [],
    activeToolNames: [],
  };
  return {
    ...actual,
    prepareAgentRestoreRuntime: vi.fn(async () => ({ runtime, restore: vi.fn() })),
  };
});

  vi.mock("@earendil-works/pi-coding-agent", () => ({
  defineTool: (opts: any) => opts,
  getAgentDir: vi.fn(() => "/tmp/mock-agent-dir"),
  keyHint: (_keybinding: string, description: string) => `${_keybinding} ${description}`,
}));


type LifecycleHandler = (event: unknown, ctx: any) => Promise<void> | void;

function createMockPi() {
  const lifecycleHandlers = new Map<string, LifecycleHandler[]>();
  const registeredCommands = new Map<string, any>();
  const registeredTools = new Map<string, any>();

  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((tool: any) => registeredTools.set(tool.name, tool)),
    registerCommand: vi.fn((name: string, command: any) => registeredCommands.set(name, command)),
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
    registeredCommands,
    registeredTools,
    async fire(event: string, payload: unknown, ctx: any) {
      for (const handler of lifecycleHandlers.get(event) ?? []) {
        await handler(payload, ctx);
      }
    },
  };
}

async function initExtension(mock: ReturnType<typeof createMockPi>) {
  vi.resetModules();
  const { default: init } = await import("../src/index.js");
  init(mock.pi as never);
}

function createCtx() {
  return {
    hasUI: true,
    ui: {
      setStatus: vi.fn(),
      setWidget: vi.fn(),
      select: vi.fn(),
      notify: vi.fn(),
    },
    modelRegistry: {},
    model: undefined,
    cwd: "/tmp",
    sessionManager: { getEntries: vi.fn(() => []), getSessionId: vi.fn(() => "parent-session-1") },
  };
}

const plainTheme = {
  fg: vi.fn((_color: string, text: string) => text),
  bold: vi.fn((text: string) => text),
};

function renderText(component: { render?: () => string[]; text?: string }): string {
  if (typeof component.render === "function") return component.render().join("\n");
  return component.text ?? "";
}

describe("subagent session UI rebinding", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    widgetInstances.length = 0;
    managerInstances.length = 0;
    lastOnComplete = undefined;
    lastOnStart = undefined;
    lastRpcDeps = undefined;
    customAgentLoaderState.result = { agents: new Map(), diagnostics: [] };
    agentTypeState.allTypes = ["general-purpose"];
    agentTypeState.availableTypes = ["general-purpose"];
    agentTypeState.resolveType = (type?: string) => type ?? "general-purpose";
    agentTypeState.isValidType = () => true;
  });
    const sessionJsonl = [
      { type: "session", version: 3, id: "child-session", timestamp: "2026-01-01T00:00:00Z", cwd: "/tmp" },
      { type: "model_change", id: "model", parentId: null, timestamp: "2026-01-01T00:00:01Z", provider: "test", modelId: "test" },
      { type: "thinking_level_change", id: "think", parentId: "model", timestamp: "2026-01-01T00:00:02Z", thinkingLevel: "off" },
      { type: "message", id: "leaf-1", parentId: "think", timestamp: "2026-01-01T00:00:03Z", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" } },
    ].map((row) => JSON.stringify(row)).join("\n") + "\n";
    for (const path of ["/tmp/session.jsonl", "/tmp/fresh-1.jsonl", "/tmp/fresh-2.jsonl"]) writeFileSync(path, sessionJsonl);

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

  it("activates the Agents widget for an RPC-only TaskExecute spawn and queued start", async () => {
    const mock = createMockPi();
    await initExtension(mock);
    const ctx = createCtx();
    await mock.fire("session_start", { reason: "new" }, ctx);
    const widget = widgetInstances[0]!;
    widget.ensureTimer.mockClear();
    widget.update.mockClear();

    lastRpcDeps.manager.spawn(mock.pi, ctx, "general-purpose", "execute task", {
      description: "TaskExecute worker",
      isBackground: true,
    });

    expect(widget.ensureTimer).toHaveBeenCalledTimes(1);
    expect(widget.update).toHaveBeenCalledTimes(1);

    widget.update.mockClear();
    managerInstances[0]!.invokeOnStart({
      id: "agent-1",
      type: "general-purpose",
      description: "TaskExecute worker",
      status: "running",
      isBackground: true,
    });
    expect(widget.update).toHaveBeenCalledTimes(1);
    expect(widget.setUICtx).toHaveBeenCalledTimes(1);
  });

  it("disposes the Agents widget on session shutdown", async () => {
    const mock = createMockPi();
    await initExtension(mock);
    const ctx = createCtx();
    await mock.fire("session_start", { reason: "new" }, ctx);

    await mock.fire("session_shutdown", {}, ctx);

    expect(widgetInstances[0]?.dispose).toHaveBeenCalledTimes(1);
  });

  it("surfaces custom agent diagnostics in the /agents menu", async () => {
    customAgentLoaderState.result = {
      agents: new Map(),
      diagnostics: [
        {
          file: "/repo/.pi/agents/restricted.md",
          agentName: "restricted",
          field: "disallowed_tools",
          severity: "error",
          message: "disallowed_tools is invalid/obsolete; use builtin_tools and extension_tools explicit allowlists instead.",
        },
      ],
    };
    const mock = createMockPi();
    await initExtension(mock);
    const ctx = createCtx();
    ctx.ui.select.mockResolvedValueOnce("Agent definition issues (1)");

    await mock.registeredCommands.get("agents").handler({}, ctx);

    expect(ctx.ui.select).toHaveBeenCalledWith("Agents", expect.arrayContaining(["Agent definition issues (1)"]));
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "ERROR restricted (/repo/.pi/agents/restricted.md) field \"disallowed_tools\": disallowed_tools is invalid/obsolete; use builtin_tools and extension_tools explicit allowlists instead.",
      "warning",
    );
  });

  it("reports matching diagnostics when Agent spawn requests an invalid custom agent", async () => {
    customAgentLoaderState.result = {
      agents: new Map(),
      diagnostics: [
        {
          file: "/repo/.pi/agents/restricted.md",
          agentName: "restricted",
          field: "disallow_tools",
          severity: "error",
          message: "disallow_tools is invalid/obsolete; use builtin_tools and extension_tools explicit allowlists instead.",
        },
      ],
    };
    agentTypeState.resolveType = () => undefined;
    agentTypeState.isValidType = () => false;
    const mock = createMockPi();
    await initExtension(mock);
    const ctx = createCtx();

    const result = await mock.registeredTools.get("Agent").execute(
      "tool-1",
      { prompt: "do it", description: "Do it", subagent_type: "restricted" },
      undefined,
      undefined,
      ctx,
    );

    const text = result.content[0].text;
    expect(text).toContain("Agent type \"restricted\" is unavailable because its custom definition has invalid frontmatter.");
    expect(text).toContain("ERROR restricted (/repo/.pi/agents/restricted.md) field \"disallow_tools\": disallow_tools is invalid/obsolete; use builtin_tools and extension_tools explicit allowlists instead.");
    expect(text).toContain("tools is invalid/obsolete; use builtin_tools for built-in tools and extension_tools for extension/custom tools; denylist fields are invalid/obsolete");
  });

  it("routes new subagent sessions to a separate parent-scoped directory", async () => {
    const mock = createMockPi();
    await initExtension(mock);
    const agentTool = mock.registeredTools.get("Agent");

    const result = await agentTool.execute(
      "tool-1",
      { prompt: "do it", description: "Do it", subagent_type: "general-purpose", run_in_background: true },
      undefined,
      undefined,
      createCtx(),
    );

    expect(result.content[0].text).toContain("Agent started in background.");
    expect(result.content[0].text).toContain("Session dir: /tmp/mock-agent-dir/subagent-sessions/parent-session-1");
    expect(managerInstances[0]?.spawn).toHaveBeenCalledWith(
      mock.pi,
      expect.any(Object),
      "general-purpose",
      "do it",
      expect.objectContaining({
        parentSessionId: "parent-session-1",
        sessionDir: "/tmp/mock-agent-dir/subagent-sessions/parent-session-1",
      }),
    );
  });

  it("supervises RPC-equivalent records from AgentRun activity without a UI-map entry", async () => {
    const startedAt = 1_000_000;
    vi.setSystemTime(startedAt);
    const mock = createMockPi();
    await initExtension(mock);
    const { AgentRun } = await import("../src/agent-run.js");
    const { BACKGROUND_STALE_ABORT_AFTER_MS, BACKGROUND_STALE_STEER_AFTER_MS } = await import("../src/constants.js");
    const manager = managerInstances[0]!;
    const run = new AgentRun("rpc-agent");
    run.publish({
      kind: "created",
      type: "general-purpose",
      description: "RPC worker",
      isBackground: true,
      startedAt: startedAt - BACKGROUND_STALE_ABORT_AFTER_MS * 2,
    });
    run.publish({ kind: "started", startedAt });
    expect(run.activity.lastProgressAt).toBe(startedAt);
    run.publish({ kind: "tool", phase: "start", toolName: "bash" });
    const record: any = {
      id: "rpc-agent",
      type: "general-purpose",
      description: "RPC worker",
      status: "running",
      toolUses: 0,
      startedAt,
      isBackground: true,
      run,
    };
    manager.listAgents.mockReturnValue([record]);

    await vi.advanceTimersByTimeAsync(BACKGROUND_STALE_STEER_AFTER_MS);
    expect(record.lastSupervisionSteerAt).toBeUndefined();

    await vi.advanceTimersByTimeAsync(BACKGROUND_STALE_ABORT_AFTER_MS - BACKGROUND_STALE_STEER_AFTER_MS);
    expect(manager.abort).not.toHaveBeenCalled();

    run.publish({ kind: "tool", phase: "end", toolName: "bash" });
    run.publish({ kind: "progress" });
    await vi.advanceTimersByTimeAsync(BACKGROUND_STALE_STEER_AFTER_MS);
    expect(record.lastSupervisionSteerAt).toBe(startedAt + BACKGROUND_STALE_ABORT_AFTER_MS + BACKGROUND_STALE_STEER_AFTER_MS);

    await vi.advanceTimersByTimeAsync(BACKGROUND_STALE_ABORT_AFTER_MS - BACKGROUND_STALE_STEER_AFTER_MS);
    expect(manager.abort).toHaveBeenCalledWith("rpc-agent");
  });

  it("does not send a notification at agent_end when result was consumed before idle", async () => {
    const mock = createMockPi();
    await initExtension(mock);

    const record: any = {
      id: "agent-1",
      type: "general-purpose",
      description: "Investigate blinking",
      status: "completed",
      toolUses: 0,
      startedAt: Date.now() - 1000,
      completedAt: Date.now(),
      result: "done",
      isBackground: true,
      resultConsumed: true,   // consumed via get_subagent_result wait=true
      notified: false,
      suppressNotification: false,
    };
    managerInstances[0]?.listAgents.mockReturnValue([record]);

    await mock.fire("agent_end", {}, createCtx());

    expect(mock.pi.sendMessage).not.toHaveBeenCalled();
  });
  it("suppresses completion nudge at agent_end when parent polled recently via get_subagent_result", async () => {
    const mock = createMockPi();
    await initExtension(mock);

    const record: any = {
      id: "agent-1",
      type: "general-purpose",
      description: "Investigate blinking",
      status: "running",
      toolUses: 0,
      startedAt: Date.now(),
      promise: undefined,
      isBackground: true,
      notified: false,
      suppressNotification: false,
    };
    managerInstances[0]?.getRecord.mockReturnValue(record as unknown as AgentRecord);

    // Parent polls without waiting — sets lastPolledAt
    const pollResult = await mock.registeredTools.get("get_subagent_result").execute(
      "tool-1",
      { agent_id: "agent-1", wait: false },
      undefined,
      undefined,
      createCtx(),
    );
    expect(record.lastPolledAt).toBeGreaterThan(0);
    expect(pollResult.content[0].text).toContain("running");

    // Agent completes shortly after poll
    record.status = "completed";
    record.completedAt = Date.now();
    record.result = "done";
    managerInstances[0]?.listAgents.mockReturnValue([record]);

    // Fire agent_end — should suppress because polled recently
    await mock.fire("agent_end", {}, createCtx());
    expect(mock.pi.sendMessage).not.toHaveBeenCalled();
  })

  it("stops running agents and rejects when waiting result is cancelled", async () => {
    const mock = createMockPi();
    await initExtension(mock);
    const controller = new AbortController();
    const record: any = {
      id: "agent-1",
      type: "general-purpose",
      description: "Long running",
      status: "running",
      toolUses: 0,
      startedAt: Date.now(),
      promise: new Promise(() => {}),
    };
    managerInstances[0]?.getRecord.mockReturnValue(record as unknown as AgentRecord);
    managerInstances[0]?.listAgents.mockReturnValue([record]);
    managerInstances[0]?.abortAll.mockImplementation(() => {
      record.status = "stopped";
      record.completedAt = Date.now();
      return 1;
    });

    const resultPromise = mock.registeredTools.get("get_subagent_result").execute(
      "tool-1",
      { agent_id: "agent-1", wait: true },
      undefined,
      undefined,
      { ...createCtx(), signal: controller.signal },
    );

    await Promise.resolve();
    controller.abort();

    await expect(resultPromise).rejects.toThrow("Agent wait aborted; stopped running subagents.");
    expect(record.suppressNotification).toBe(true);
    expect(record.waitingConsumers).toBe(0);
    expect(managerInstances[0]?.abortAll).toHaveBeenCalledTimes(1);
  });

  it("renders subagent notifications via summary renderer and keeps transcript links", async () => {
    const mock = createMockPi();
    await initExtension(mock);
    const renderer = mock.pi.registerMessageRenderer.mock.calls.find(([type]) => type === "subagent-notification")?.[1];

    const details = {
      id: "agent-1",
      description: "Investigate blinking",
      status: "completed",
      toolUses: 3,
      turnCount: 2,
      maxTurns: 5,
      totalTokens: 1234,
      durationMs: 4500,
      outputFile: "/tmp/agent-output.md",
      sessionFile: "/tmp/session.jsonl",
      resultPreview: "Found root cause\nSecond detail",
    };

    const collapsed = renderText(renderer({ details }, { expanded: false }, plainTheme));
    expect(collapsed).toContain("✓ Investigate blinking · ↻2≤5 · 3 tools · 1.2k · 4.5s");
    expect(collapsed).toContain("└─ Found root cause");
    expect(collapsed).toContain("  transcript: /tmp/agent-output.md");
    expect(collapsed).toContain("  session: /tmp/session.jsonl");
    expect(collapsed).not.toContain("Second detail");

    const expanded = renderText(renderer({ details }, { expanded: true }, plainTheme));
    expect(expanded).toContain("  Found root cause");
    expect(expanded).toContain("  Second detail");
    expect(expanded).toContain("  transcript: /tmp/agent-output.md");
    expect(expanded).toContain("  session: /tmp/session.jsonl");
  });

  it("renders Agent results with collapsed keyword summary and expanded raw text", async () => {
    const mock = createMockPi();
    await initExtension(mock);
    const agentTool = mock.registeredTools.get("Agent");
    const details = {
      displayName: "Agent",
      description: "Patch renderer",
      subagentType: "jintong",
      toolUses: 2,
      tokens: "9.8k",
      durationMs: 1200,
      status: "completed",
      turnCount: 3,
      maxTurns: 10,
    };
    const result = {
      content: [{ type: "text", text: "Agent completed in 1.2s.\n\nDetailed result" }],
      details,
    };

    const collapsed = renderText(agentTool.renderResult(result, { expanded: false, isPartial: false }, plainTheme));
    expect(collapsed).toContain("├─ status: completed");
    expect(collapsed).toContain("├─ model: ↻3≤10");
    expect(collapsed).toContain("├─ tools: 2");
    expect(collapsed).toContain("├─ context: 9.8k");
    expect(collapsed).toContain("└─ app.tools.expand to expand full result");
    expect(collapsed).not.toContain("Agent Patch renderer");
    expect(collapsed).not.toContain("Detailed result");

    const expanded = renderText(agentTool.renderResult(result, { expanded: true, isPartial: false }, plainTheme));
    expect(expanded).toBe("Agent completed in 1.2s.\n\nDetailed result");

    const background = renderText(agentTool.renderResult({
      content: [{ type: "text", text: "background" }],
      details: { ...details, status: "background", agentId: "agent-bg", durationMs: 0 },
    }, { expanded: false, isPartial: false }, plainTheme));
    expect(background).toContain("├─ status: started");
    expect(background).toContain("├─ agent: agent-bg");
    expect(background).toContain("├─ next: get_subagent_result wait:false");
  });

  it("uses RenderScheduler cadence for foreground progress and flushes state boundaries", async () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const mock = createMockPi();
    await initExtension(mock);
    const agentTool = mock.registeredTools.get("Agent");
    const manager = managerInstances[0]!;
    const session = { getSessionStats: vi.fn(() => ({ tokens: { total: 1234 } })), sessionFile: "/tmp/session.jsonl" };
    const record: any = {
      id: "agent-1",
      type: "general-purpose",
      description: "Run foreground",
      status: "completed",
      toolUses: 1,
      startedAt: Date.now(),
      completedAt: Date.now() + 1000,
      result: "done",
      session,
      parentSessionId: "parent-session-1",
      sessionDir: "/tmp",
    };
    let finish!: (record: any) => void;
    const finished = new Promise<any>((resolve) => { finish = resolve; });

    manager.spawnAndWait.mockImplementation(async (_pi, _ctx, _type, _prompt, options) => {
      manager.listAgents.mockReturnValue([record]);
      options.onSessionCreated(session);
      options.onTextDelta("partial", "partial");
      return await finished;
    });

    const onUpdate = vi.fn();
    const resultPromise = agentTool.execute(
      "tool-1",
      { prompt: "do it", description: "Run foreground", subagent_type: "general-purpose" },
      undefined,
      onUpdate,
      createCtx(),
    );

    await Promise.resolve();
    expect(onUpdate).toHaveBeenCalledTimes(2); // start + session boundary flush
    expect(onUpdate.mock.calls.at(-1)?.[0].details.activity).toBe("thinking…");

    vi.advanceTimersByTime(249);
    expect(onUpdate).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(1);
    expect(onUpdate).toHaveBeenCalledTimes(3);
    expect(onUpdate.mock.calls.at(-1)?.[0].details.activity).toBe("thinking…");

    finish(record);
    const result = await resultPromise;

    expect(onUpdate).toHaveBeenCalledTimes(4); // cleanup flush before final result
    vi.advanceTimersByTime(1000);
    expect(onUpdate).toHaveBeenCalledTimes(4);
    expect(widgetInstances[0]?.markFinished).toHaveBeenCalledWith("agent-1");
    expect(result.content[0].text).toContain("done");
    expect(result.details.status).toBe("completed");
    expect(setIntervalSpy).not.toHaveBeenCalledWith(expect.any(Function), 80);
  });

  it("surfaces the agent-record id in foreground completion text so resume works", async () => {
    const mock = createMockPi();
    await initExtension(mock);
    const agentTool = mock.registeredTools.get("Agent");
    const manager = managerInstances[0]!;
    const session = { getSessionStats: vi.fn(() => ({ tokens: { total: 1234 } })), sessionFile: "/tmp/session.jsonl" };
    const record: any = {
      id: "fg-record-42",
      type: "general-purpose",
      description: "Run foreground",
      status: "completed",
      toolUses: 0,
      startedAt: Date.now(),
      completedAt: Date.now() + 1000,
      result: "ACK",
      sessionFile: "/tmp/session.jsonl",
      session,
      parentSessionId: "parent-session-1",
      sessionDir: "/tmp",
    };

    manager.spawnAndWait.mockImplementation(async (_pi, _ctx, _type, _prompt, options) => {
      manager.listAgents.mockReturnValue([record]);
      options.onSessionCreated(session);
      return record;
    });

    const result = await agentTool.execute(
      "tool-1",
      { prompt: "do it", description: "Run foreground", subagent_type: "general-purpose" },
      undefined,
      vi.fn(),
      createCtx(),
    );

    const text = result.content[0].text;
    // The resumable id must be the agent-record id (getRecord lookup key), not the
    // session-log UUID — otherwise Agent(resume: ...) fails with "Agent not found".
    expect(text).toContain("Agent ID: fg-record-42");
    expect(text).toContain('Agent(resume: "fg-record-42")');
    expect(text).toContain("ACK");
    expect(result.details.agentId).toBe("fg-record-42");
  });

  it("fails closed when foreground resume-target persistence fails", async () => {
    const mock = createMockPi();
    mock.pi.appendEntry.mockImplementation((customType: string) => {
      if (customType === "subagents:resume-target-v1") throw new Error("append failed");
    });
    await initExtension(mock);
    const manager = managerInstances[0]!;
    const session = { getSessionStats: vi.fn(() => ({ tokens: { total: 0 } })), sessionFile: "/tmp/session.jsonl" };
    const record = {
      id: "fg-persist-failure", type: "general-purpose", description: "Persist target",
      status: "completed", toolUses: 0, startedAt: Date.now(), completedAt: Date.now(), result: "done",
      session, sessionFile: session.sessionFile, sessionDir: "/tmp", parentSessionId: "parent-session-1",
    };
    manager.spawnAndWait.mockImplementation(async (_pi, _ctx, _type, _prompt, options) => {
      manager.listAgents.mockReturnValue([record]);
      options.onSessionCreated(session);
      return record;
    });

    const result = await mock.registeredTools.get("Agent").execute(
      "tool-persist-failure",
      { prompt: "do it", description: "Persist target", subagent_type: "general-purpose" },
      undefined, vi.fn(), createCtx(),
    );

    expect(result.content[0].text).toBe("Agent failed to persist resume target: append failed");
    expect(result.content[0].text).not.toContain("resume with Agent");
    expect(result.details.status).toBe("error");
    expect(result.details.error).toBe("append failed");
  });

  it("does not claim background resumability before target persistence", async () => {
    const mock = createMockPi();
    await initExtension(mock);

    const result = await mock.registeredTools.get("Agent").execute(
      "tool-background",
      { prompt: "do it", description: "Background", subagent_type: "general-purpose", run_in_background: true },
      undefined, vi.fn(), createCtx(),
    );

    expect(result.content[0].text).not.toContain("resume");
    expect(result.content[0].text).toContain("get_subagent_result and steer_subagent");
  });

  it("keeps explicit no-resume calls on independent fresh-spawn paths", async () => {
    const mock = createMockPi();
    await initExtension(mock);
    const agentTool = mock.registeredTools.get("Agent");
    const manager = managerInstances[0]!;
    const makeRecord = (id: string, result: string) => ({
      id,
      type: "general-purpose",
      description: result,
      status: "completed",
      toolUses: 0,
      startedAt: Date.now(),
      completedAt: Date.now(),
      result,
      sessionFile: `/tmp/${id}.jsonl`,
      session: { getSessionStats: vi.fn(() => ({ tokens: { total: 0 } })), sessionFile: `/tmp/${id}.jsonl` },
      parentSessionId: "parent-session-1",
      sessionDir: "/tmp",
    });
    manager.spawnAndWait
      .mockResolvedValueOnce(makeRecord("fresh-1", "first"))
      .mockResolvedValueOnce(makeRecord("fresh-2", "second"));

    const first = await agentTool.execute(
      "tool-fresh-1",
      { prompt: "first independent task", description: "first", subagent_type: "general-purpose" },
      undefined,
      vi.fn(),
      createCtx(),
    );
    const second = await agentTool.execute(
      "tool-fresh-2",
      { prompt: "second independent task", description: "second", subagent_type: "general-purpose" },
      undefined,
      vi.fn(),
      createCtx(),
    );

    expect(manager.spawnAndWait).toHaveBeenCalledTimes(2);
    expect(manager.spawnAndWait.mock.calls.map((call) => call[3])).toEqual([
      "first independent task",
      "second independent task",
    ]);
    expect(manager.resume).not.toHaveBeenCalled();
    expect(first.details.agentId).toBe("fresh-1");
    expect(second.details.agentId).toBe("fresh-2");
  });

  it("does not replace a stale resume with a fresh spawn", async () => {
    const mock = createMockPi();
    await initExtension(mock);
    const agentTool = mock.registeredTools.get("Agent");
    const manager = managerInstances[0]!;
    manager.getRecord.mockReturnValue(undefined);

    const result = await agentTool.execute(
      "tool-stale",
      { prompt: "continue", description: "stale", subagent_type: "general-purpose", resume: "missing-agent" },
      undefined,
      vi.fn(),
      createCtx(),
    );

    expect(result.content[0].text).toContain('Failed to resume agent "missing-agent": target_unknown.');
    expect(manager.resume).not.toHaveBeenCalled();
    expect(manager.spawnAndWait).not.toHaveBeenCalled();
  });

  it("routes a live resume before spawn config and consumes its returned result", async () => {
    agentTypeState.resolveType = () => undefined;
    agentTypeState.isValidType = () => false;
    const mock = createMockPi();
    await initExtension(mock);
    const manager = managerInstances[0]!;
    const publish = vi.fn();
    const record = {
      id: "live-agent", type: "general-purpose", description: "Original task",
      parentSessionId: "parent-session-1", status: "completed", toolUses: 1,
      startedAt: Date.now(), completedAt: Date.now(), result: "continued",
      session: { getSessionStats: vi.fn(() => ({ tokens: { total: 0 } })) },
      run: { publish },
    };
    manager.getRecord.mockReturnValue(record as unknown as AgentRecord);
    manager.resume.mockResolvedValue({ status: "resumed_live", id: "live-agent" });

    const result = await mock.registeredTools.get("Agent").execute(
      "tool-resume",
      { prompt: "continue", description: "ignored", subagent_type: "GENERAL-PURPOSE", resume: "live-agent" },
      undefined, vi.fn(), createCtx(),
    );

    expect(manager.resume).toHaveBeenCalledWith("live-agent", "continue", expect.objectContaining({
      parentSessionId: "parent-session-1", expectedType: "general-purpose",
    }));
    expect(manager.spawn).not.toHaveBeenCalled();
    expect(manager.spawnAndWait).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledWith({ kind: "consumed" });
    expect(result.content[0].text).toContain("continued");
  });

});
