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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const widgetInstances: MockAgentWidget[] = [];
const managerInstances: MockAgentManager[] = [];
let lastOnComplete: ((record: any) => void) | undefined;
let lastOnStart: ((record: any) => void) | undefined;

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
  spawnAndWait = vi.fn();
  invokeOnComplete(record: any) { lastOnComplete?.(record); }
  invokeOnStart(record: any) { lastOnStart?.(record); }
}

vi.mock("../src/ui/agent-widget.js", () => ({
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
  registerRpcHandlers: vi.fn(() => ({
    unsubPing: vi.fn(),
    unsubSpawn: vi.fn(),
    unsubStop: vi.fn(),
  })),
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
  getDefaultAgentNames: vi.fn(() => ["general-purpose"]),
  getUserAgentNames: vi.fn(() => []),
  isValidType: vi.fn(() => agentTypeState.isValidType()),
  registerAgents: vi.fn(),
  resolveType: vi.fn((type?: string) => agentTypeState.resolveType(type)),
}));

vi.mock("@mariozechner/pi-coding-agent", () => ({
  defineTool: (opts: any) => opts,
  getAgentDir: vi.fn(() => "/tmp/mock-agent-dir"),
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
    cwd: "/repo",
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
    customAgentLoaderState.result = { agents: new Map(), diagnostics: [] };
    agentTypeState.allTypes = ["general-purpose"];
    agentTypeState.availableTypes = ["general-purpose"];
    agentTypeState.resolveType = (type?: string) => type ?? "general-purpose";
    agentTypeState.isValidType = () => true;
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

  it("does not refresh the widget for a completion nudge when wait consumes the result", async () => {
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
    };
    record.promise = Promise.resolve().then(() => {
      record.status = "completed";
      record.completedAt = Date.now();
      record.result = "done";
      return "done";
    });
    managerInstances[0]?.getRecord.mockReturnValue(record);
    widgetInstances[0]?.update.mockClear();

    const result = await mock.registeredTools.get("get_subagent_result").execute(
      "tool-1",
      { agent_id: "agent-1", wait: true },
      undefined,
      undefined,
      createCtx(),
    );

    expect(result.content[0].text).toContain("done");
    expect(record.resultConsumed).toBe(true);
    expect(widgetInstances[0]?.update).not.toHaveBeenCalled();

    vi.advanceTimersByTime(250);
    expect(mock.pi.sendMessage).not.toHaveBeenCalled();
  });
  it("suppresses completion nudge when parent polled recently via get_subagent_result", async () => {
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
    };
    managerInstances[0]?.getRecord.mockReturnValue(record);

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
    managerInstances[0]?.invokeOnComplete(record);

    vi.advanceTimersByTime(250);
    expect(mock.pi.sendMessage).not.toHaveBeenCalled();
  });

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
    managerInstances[0]?.getRecord.mockReturnValue(record);
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
    expect(collapsed).toContain("✓ Investigate blinking · ⟳ 2≤5·󱁤 3·󰾆 1.2k·4.5s");
    expect(collapsed).toContain("  ⎿ Found root cause");
    expect(collapsed).toContain("  transcript: /tmp/agent-output.md");
    expect(collapsed).toContain("  session: /tmp/session.jsonl");
    expect(collapsed).not.toContain("Second detail");

    const expanded = renderText(renderer({ details }, { expanded: true }, plainTheme));
    expect(expanded).toContain("  Found root cause");
    expect(expanded).toContain("  Second detail");
    expect(expanded).toContain("  transcript: /tmp/agent-output.md");
    expect(expanded).toContain("  session: /tmp/session.jsonl");
  });

  it("renders Agent results via summary renderer while preserving expanded details and background line", async () => {
    const mock = createMockPi();
    await initExtension(mock);
    const agentTool = mock.registeredTools.get("Agent");
    const details = {
      displayName: "Agent",
      description: "Patch renderer",
      subagentType: "jintong",
      toolUses: 2,
      tokens: "󰾆 9.8k",
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
    expect(collapsed).toContain("✓ Agent Patch renderer · ⟳ 3≤10·󱁤 2·󰾆 9.8k·1.2s");
    expect(collapsed).toContain("  ⎿ Done");
    expect(collapsed).not.toContain("Detailed result");

    const expanded = renderText(agentTool.renderResult(result, { expanded: true, isPartial: false }, plainTheme));
    expect(expanded).toContain("✓ Agent Patch renderer · ⟳ 3≤10·󱁤 2·󰾆 9.8k·1.2s");
    expect(expanded).toContain("  Agent completed in 1.2s.");
    expect(expanded).toContain("  Detailed result");

    const background = renderText(agentTool.renderResult({
      content: [{ type: "text", text: "background" }],
      details: { ...details, status: "background", agentId: "agent-bg", durationMs: 0 },
    }, { expanded: false, isPartial: false }, plainTheme));
    expect(background).toBe("  ⎿  Running in background (ID: agent-bg)");
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

});
