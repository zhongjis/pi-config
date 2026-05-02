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

    constructor() {
      managerInstances.push(this as unknown as MockAgentManager);
    }
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
    sessionManager: { getEntries: vi.fn(() => []) },
  };
}

describe("subagent session UI rebinding", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    widgetInstances.length = 0;
    managerInstances.length = 0;
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
});
