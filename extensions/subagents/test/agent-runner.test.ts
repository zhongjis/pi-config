import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  createAgentSession,
  defaultResourceLoaderCtor,
  loaderExtensionsRef,
  getAgentDir,
  sessionManagerAppendCustomEntry,
  sessionManagerInMemory,
  sessionManagerCreate,
  sessionManagerOpen,
  settingsManagerCreate,
  settingsManagerGetSessionDir,
} = vi.hoisted(() => {
  const sessionManagerAppendCustomEntry = vi.fn(() => "scope-entry");
  const createSessionManager = (kind: string) => ({
    kind,
    getSessionId: () => "child-session",
    getBranch: () => [],
    appendCustomEntry: sessionManagerAppendCustomEntry,
  });

  return {
    createAgentSession: vi.fn(),
    defaultResourceLoaderCtor: vi.fn(),
    loaderExtensionsRef: {
      current: { extensions: [], errors: [], runtime: {} } as {
        extensions: Array<{ path: string; tools: Map<string, unknown>; hidden?: boolean }>;
        errors: Array<{ path: string; error: string }>;
        runtime: Record<string, unknown>;
      },
    },
    getAgentDir: vi.fn(() => "/mock/agent-dir"),
    sessionManagerAppendCustomEntry,
    sessionManagerInMemory: vi.fn((_cwd?: string) => createSessionManager("memory-session-manager")),
    sessionManagerCreate: vi.fn((_cwd?: string, _sessionDir?: string, _options?: unknown) =>
      createSessionManager("persistent-session-manager"),
    ),
    sessionManagerOpen: vi.fn((_path: string): unknown => {
      throw new Error("SessionManager.open not configured");
    }),
    settingsManagerGetSessionDir: vi.fn(() => undefined as string | undefined),
    settingsManagerCreate: vi.fn(() => ({ kind: "settings-manager", getSessionDir: settingsManagerGetSessionDir })),
  };
});

const { createCodemodeExtension, createMcpExtension, createToolSearchExtension } = vi.hoisted(() => ({
  createCodemodeExtension: vi.fn((_options?: unknown) => () => {}),
  createMcpExtension: vi.fn(() => () => {}),
  createToolSearchExtension: vi.fn(() => () => {}),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  CONFIG_DIR_NAME: ".pi",
  createAgentSession,
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  isToolCallEventType: (toolName: string, event: { toolName?: string }) => event.toolName === toolName,
  // Mock loader simulates pi-mono: reload() loads discovered extensions, then
  // `builtin: true` factories as `builtin:<name>` paths, then named inline
  // factories, and runs extensionsOverride over the result.
  DefaultResourceLoader: class {
    opts: any;
    constructor(options: any) {
      this.opts = options;
      defaultResourceLoaderCtor(options);
    }

    async reload() {
      // Mirror the real loader: noExtensions suppresses discovered and built-in
      // extensions, but named inline factories still load and then flow through
      // the override.
      type Factory = { name: string; hidden?: boolean; builtin?: boolean };
      const factories: Factory[] = this.opts.extensionFactories ?? [];
      const discovered = this.opts.noExtensions
        ? []
        : loaderExtensionsRef.current.extensions.filter((extension) => !extension.path.startsWith("<inline:"));
      const builtins = this.opts.noExtensions
        ? []
        : factories.filter((input) => input.builtin).map((input) => ({
          path: `builtin:${input.name}`,
          tools: new Map<string, unknown>(),
          hidden: true,
        }));
      const inline = factories.filter((input) => !input.builtin).map((input) => ({
        path: `<inline:${input.name}>`,
        tools: new Map<string, unknown>(),
        hidden: input.hidden,
      }));
      loaderExtensionsRef.current = {
        ...loaderExtensionsRef.current,
        extensions: [...discovered, ...builtins, ...inline],
      };
      if (this.opts.extensionsOverride) {
        loaderExtensionsRef.current = this.opts.extensionsOverride(loaderExtensionsRef.current);
      }
    }

    getExtensions() {
      return loaderExtensionsRef.current;
    }
  },
  getAgentDir,
  SessionManager: { inMemory: sessionManagerInMemory, create: sessionManagerCreate, open: sessionManagerOpen },
  SettingsManager: { create: settingsManagerCreate },
}));

vi.mock("../src/agent-types.js", () => ({
  getConfig: vi.fn(() => ({
    displayName: "Explore",
    description: "Explore",
    extensionRules: [],
    toolRules: [{ sign: "+", selector: "read" }],
    discoverSkills: true,
    preloadSkills: [],
    promptMode: "replace",
  })),
  getAgentConfig: vi.fn(() => ({
    name: "Explore",
    description: "Explore",
    extensionRules: [],
    toolRules: [{ sign: "+", selector: "read" }],
    discoverSkills: true,
    preloadSkills: [],
    systemPrompt: "You are Explore.",
    promptMode: "replace",
    inheritContext: false,
    runInBackground: false,
    isolated: false,
  })),
  resolveType: vi.fn((name: string) => name.toLowerCase()),
}));

vi.mock("../src/env.js", () => ({
  detectEnv: vi.fn(async () => ({ isGitRepo: false, branch: "", platform: "linux" })),
}));

vi.mock("../src/prompts.js", () => ({
  buildAgentPrompt: vi.fn(() => "system prompt"),
}));

vi.mock("../src/skill-loader.js", () => ({
  preloadSkills: vi.fn(() => []),
}));

import {
  type AccessRule,
  type AccessRuleField,
  createToolCeilingTool,
  parseAccessRules,
  resolveToolAccess,
  type ToolAccessGates,
  toolCandidates,
} from "../../lib/active-tools.js";
import smartToolGuards from "../../smart-tool-guards/index.js";
import {
  getAgentConversation,
  resumeAgent,
  runAgent,
  SUBAGENT_LAUNCH_ENTRY,
  SUBAGENT_TOOL_NAMES,
} from "../src/agent-runner.js";
import { preloadSkills as _preloadSkills } from "../src/skill-loader.js";

/** The most recent session built by `createSession` — read by `lastToolsPassed()`. */
let lastSession: ReturnType<typeof createSession>["session"] | undefined;

function createSession(finalText: string) {
  const listeners: Array<(event: any) => void> = [];
  // Pi — not `tools:` — owns activation: it auto-activates its default
  // built-ins (agent-session.js's `defaultActiveToolNames`: read/bash/edit/write)
  // plus every direct/model-only extension or SDK tool (including the runner's
  // ceiling tool) as soon as it observes the tool in the live registry. Default-off
  // built-ins (grep/find/ls) never auto-activate — no `tools:` rule can turn them
  // on. Activation is sticky: once seen, a tool stays active.
  const DEFAULT_ACTIVE_BUILTINS = new Set(["read", "bash", "edit", "write"]);
  const activated = new Set<string>();
  let activeToolNames: string[] = [];
  const refreshActivation = () => {
    for (const { name } of session.getAllTools()) {
      if (activated.has(name)) continue;
      activated.add(name);
      if (BUILTINS_7.includes(name) && !DEFAULT_ACTIVE_BUILTINS.has(name)) continue;
      activeToolNames.push(name);
    }
  };
  const session = {
    messages: [] as any[],
    waitForIdle: vi.fn(async () => {}),
    subscribe: vi.fn((listener: (event: any) => void) => {
      listeners.push(listener);
      return () => {};
    }),
    prompt: vi.fn(async () => {
      session.messages.push({
        role: "assistant",
        content: [{ type: "text", text: finalText }],
      });
    }),
    abort: vi.fn(),
    steer: vi.fn(),
    // Live-refreshed on every read, so newly-registered tools (late MCP/context-mode
    // tools, the ceiling) are picked up the moment anything queries the registry —
    // matching Pi activating a tool the instant it registers.
    getActiveToolNames: vi.fn(() => {
      refreshActivation();
      return [...activeToolNames];
    }),
    setActiveToolsByName: vi.fn((names: string[]) => {
      activeToolNames = [...names];
      for (const name of names) activated.add(name);
    }),
    // pi's tool REGISTRY (`_toolDefinitions`), read live so tests can simulate an
    // extension registering after bind by mutating `loaderExtensionsRef`.
    getAllTools: vi.fn(() => {
      const opts = createAgentSession.mock.calls[0]?.[0];
      return opts ? mockRegistry(opts).map(({ name, path }) => ({ name, sourceInfo: { path } })) : [];
    }),
    // pi's Agent; `beforeToolCall` is an optional, assignable hook the scope
    // installer wraps to block out-of-scope calls on turn 1.
    agent: { beforeToolCall: undefined } as {
      beforeToolCall?: (context: any, signal?: any) => Promise<any>;
    },
    setSessionName: vi.fn(),
    bindExtensions: vi.fn(async () => {}),
  };
  lastSession = session;
  return { session, listeners };
}

const ctx = {
  cwd: "/tmp",
  model: undefined,
  modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
  getSystemPrompt: vi.fn(() => "parent prompt"),
  sessionManager: {
    getSessionId: vi.fn(() => "parent-session"),
    getBranch: vi.fn(() => []),
  },
} as any;

const pi = { getAllTools: () => [] } as any;

beforeEach(() => {
  createAgentSession.mockReset();
  defaultResourceLoaderCtor.mockClear();
  getAgentDir.mockClear();
  sessionManagerInMemory.mockClear();
  sessionManagerCreate.mockClear();
  sessionManagerOpen.mockClear();
  sessionManagerAppendCustomEntry.mockClear();
  settingsManagerGetSessionDir.mockReset();
  settingsManagerGetSessionDir.mockReturnValue(undefined);
  settingsManagerCreate.mockClear();
  loaderExtensionsRef.current = { extensions: [], errors: [], runtime: {} };
  lastSession = undefined;
});

describe("agent-runner final output capture", () => {
  it.each([
    ["spawn", false], ["spawn", true], ["resume", false], ["resume", true],
  ] as const)("%s drains rejected prompts and retains only execution-local partial text (abort=%s)", async (kind, abort) => {
    const controller = new AbortController();
    const { session, listeners } = createSession("unused");
    createAgentSession.mockResolvedValue({ session });
    const { session: sdkSession } = await runAgent(ctx, "Explore", "prior", { pi });
    session.prompt.mockClear();
    session.messages.push({ role: "assistant", content: [{ type: "text", text: "PRIOR" }] });
    let releaseIdle: (() => void) | undefined;
    const idle = new Promise<void>(resolve => { releaseIdle = resolve; });
    if (!releaseIdle) throw new Error("Missing idle resolver");
    session.waitForIdle.mockImplementation(() => idle);
    session.prompt.mockImplementation(async () => {
      for (const listener of listeners) listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "PARTIAL" } });
      if (abort) controller.abort();
      throw new Error("prompt failed");
    });
    createAgentSession.mockResolvedValue({ session });
    const onTextDelta = vi.fn();
    const pending = kind === "spawn"
      ? runAgent(ctx, "Explore", "go", { pi, signal: controller.signal, onTextDelta }).then(result => ({ text: result.responseText, failure: result.failure }))
      : resumeAgent(sdkSession, "go", { signal: controller.signal, onTextDelta });
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await vi.waitFor(() => expect(session.prompt).toHaveBeenCalled());
    try {
      expect(settled).toBe(false);
      expect(session.waitForIdle).toHaveBeenCalled();
      for (const listener of listeners) listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: " DRAIN" } });
    } finally {
      releaseIdle();
    }
    await expect(pending).resolves.toMatchObject({ text: "PARTIAL DRAIN", failure: "prompt failed" });
    expect(onTextDelta.mock.calls).toEqual([["PARTIAL", "PARTIAL"], [" DRAIN", "PARTIAL DRAIN"]]);
    if (abort) expect(session.abort).toHaveBeenCalledOnce();
    session.prompt.mockRejectedValueOnce(new Error("empty failure"));
    await expect(resumeAgent(sdkSession, "again"))
      .resolves.toMatchObject({ text: "", failure: "empty failure" });
  });

  it("retains execution-local completed text across compaction and an empty aborted message", async () => {
    const { session, listeners } = createSession("unused");
    createAgentSession.mockResolvedValue({ session });
    const { session: sdkSession } = await runAgent(ctx, "Explore", "prior", { pi });
    session.prompt.mockClear();
    session.messages.push({ role: "assistant", content: [{ type: "text", text: "PRIOR" }] });
    session.prompt.mockImplementation(async () => {
      for (const listener of listeners) listener({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "PARTIAL" }] } });
      session.messages.length = 0;
      for (const listener of listeners) listener({ type: "message_start", message: { role: "assistant", content: [] } });
      throw new Error("aborted");
    });
    await expect(resumeAgent(sdkSession, "go"))
      .resolves.toMatchObject({ text: "PARTIAL", failure: "aborted" });
  });

  it("returns the final assistant text even when no text_delta events were streamed", async () => {
    const { session } = createSession("LOCKED");
    createAgentSession.mockResolvedValue({ session });

    const result = await runAgent(ctx, "Explore", "Say LOCKED", { pi });

    expect(result.responseText).toBe("LOCKED");
  });

  it.each([false, true])("A04 does not steer a final answer or terminating tool completion (%s)", async (terminatingTool) => {
    const { session, listeners } = createSession("DONE");
    session.prompt.mockImplementation(async () => {
      if (terminatingTool) for (const listener of listeners) listener({ type: "tool_execution_end", toolName: "read", result: { terminate: true } });
      for (const listener of listeners) listener({ type: "turn_end", message: {
        role: "assistant", stopReason: terminatingTool ? "toolUse" : "stop",
        content: terminatingTool ? [{ type: "toolCall", name: "read" }] : [{ type: "text", text: "DONE" }],
      }, toolResults: [] });
    });
    createAgentSession.mockResolvedValue({ session });
    const result = await runAgent(ctx, "Explore", "go", { pi, maxTurns: 1 });
    expect(session.steer).not.toHaveBeenCalled();
    expect(session.abort).not.toHaveBeenCalled();
    expect(result.steered).toBe(false);
  });

  it("A04 unfinished tool turns retain the soft warning and hard abort", async () => {
    const { session, listeners } = createSession("DONE");
    session.prompt.mockImplementation(async () => {
      for (let turn = 0; turn < 10; turn++) {
        for (const listener of listeners) listener({ type: "tool_execution_end", toolName: "read", result: {} });
        for (const listener of listeners) listener({ type: "turn_end", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", name: "read" }] }, toolResults: [] });
        if (session.abort.mock.calls.length) break;
      }
    });
    createAgentSession.mockResolvedValue({ session });
    const result = await runAgent(ctx, "Explore", "go", { pi, maxTurns: 1 });
    expect(session.steer).toHaveBeenCalledTimes(1);
    expect(session.abort).toHaveBeenCalledTimes(1);
    expect(result.aborted).toBe(true);
  });

  it("A05 reports warnings separately from real tool completions", async () => {
    vi.mocked(getConfig).mockReturnValueOnce(makeConfig());
    vi.mocked(getAgentConfig).mockReturnValueOnce(makeAgentConfig({ toolRules: rules("tools", "+read, +@missing-extension") }));
    const { session, listeners } = createSession("DONE");
    session.prompt.mockImplementation(async () => {
      for (const listener of listeners) listener({ type: "tool_execution_end", toolName: "read", result: {} });
    });
    createAgentSession.mockResolvedValue({ session });
    const activities: Array<{ type: string; toolName: string }> = [];
    await runAgent(ctx, "Explore", "go", { pi, onToolActivity: (activity) => activities.push(activity) });
    expect(activities.filter((activity) => activity.type === "end")).toEqual([{ type: "end", toolName: "read" }]);
    expect(activities.some((activity) => activity.type === "diagnostic" && activity.toolName.startsWith("tools-warning:"))).toBe(true);
  });

  it("binds extensions before prompting", async () => {
    const { session } = createSession("BOUND");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "Say BOUND", { pi });

    expect(session.bindExtensions).toHaveBeenCalledTimes(1);
    expect(session.bindExtensions).toHaveBeenCalledWith(
      expect.objectContaining({ onError: expect.any(Function) }),
    );

    const bindOrder = session.bindExtensions.mock.invocationCallOrder[0];
    const promptOrder = session.prompt.mock.invocationCallOrder[0];
    expect(bindOrder).toBeLessThan(promptOrder);
  });

  it("passes effective cwd and agentDir to the loader and settings manager", async () => {
    const { session } = createSession("CONFIGURED");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "Say CONFIGURED", { pi, cwd: "/tmp/worktree" });

    expect(getAgentDir).toHaveBeenCalledTimes(1);
    expect(defaultResourceLoaderCtor).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "/tmp/worktree",
      agentDir: "/mock/agent-dir",
    }));
    expect(settingsManagerCreate).toHaveBeenCalledWith("/tmp/worktree", "/mock/agent-dir");
    expect(sessionManagerCreate).toHaveBeenCalledWith("/tmp/worktree", undefined, undefined);
    expect(createAgentSession).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "/tmp/worktree",
      agentDir: "/mock/agent-dir",
    }));
  });

  it.each([undefined, "faux/selected"])("omitted_thinking_direct_runner_leaves_sdk_default (%s)", async (modelConfig) => {
    const { session } = createSession("DONE");
    createAgentSession.mockResolvedValue({ session });
    const model = { provider: "faux", id: "selected", name: "Selected" };
    const context = { ...ctx, model, modelRegistry: { find: () => model, getAll: () => [model], getAvailable: () => [model] } };
    vi.mocked(getAgentConfig).mockReturnValueOnce(makeAgentConfig({ model: modelConfig }));
    await runAgent(context, "Explore", "go", { pi: { ...pi, getThinkingLevel: () => "high" } });
    expect(createAgentSession.mock.calls[0][0]).not.toHaveProperty("thinkingLevel");
  });

  it("A03 direct runner resolves configured chains and does not bypass frontmatter with direct options", async () => {
    const { session } = createSession("DONE");
    createAgentSession.mockResolvedValue({ session });
    const model = { provider: "faux", id: "selected", name: "Selected" };
    const context = { ...ctx, modelRegistry: { find: () => model, getAll: () => [model], getAvailable: () => [model] } };
    vi.mocked(getAgentConfig).mockReturnValueOnce(makeAgentConfig({ model: "missing/nope,faux/selected:high" }));
    await runAgent(context, "Explore", "go", { pi });
    expect(createAgentSession.mock.calls[0][0].model).toBe(model);
    expect(createAgentSession.mock.calls[0][0].thinkingLevel).toBe("high");
    vi.mocked(getAgentConfig).mockReturnValueOnce(makeAgentConfig({ model: "missing/nope" }));
    const override = createAgentSession.mock.calls[0][0].model;
    await expect(runAgent(context, "Explore", "go", { pi, model: override, thinkingLevel: "low" })).rejects.toThrow("No available model");
    expect(createAgentSession).toHaveBeenCalledTimes(1);
  });

  it("A02 direct runner rejects exhausted configuration and inherits only when absent", async () => {
    vi.mocked(getAgentConfig).mockReturnValueOnce(makeAgentConfig({ model: "missing/nope" }));
    await expect(runAgent(ctx, "Explore", "go", { pi })).rejects.toThrow("No available model in configured chain");
    expect(createAgentSession).not.toHaveBeenCalled();
    const { session } = createSession("DONE");
    createAgentSession.mockResolvedValue({ session });
    const parent = { provider: "parent", id: "parent" };
    await runAgent({ ...ctx, model: parent }, "Explore", "go", { pi });
    expect(createAgentSession.mock.calls[0][0].model).toBe(parent);
  });

  it("forwards the parent model runtime", async () => {
    const { session } = createSession("AUTHENTICATED");
    createAgentSession.mockResolvedValue({ session });
    const modelRuntime = { getAuth: vi.fn(), hasConfiguredAuth: vi.fn() };
    const context = {
      ...ctx,
      modelRegistry: { ...ctx.modelRegistry, runtime: modelRuntime },
    };

    await runAgent(context, "Explore", "Say AUTHENTICATED", { pi });

    expect(createAgentSession).toHaveBeenCalledWith(expect.objectContaining({
      modelRuntime,
    }));
  });

  it("suppresses AGENTS.md/CLAUDE.md/APPEND_SYSTEM.md for subagents", async () => {
    const { session } = createSession("ISOLATED");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "Say ISOLATED", { pi });

    // noContextFiles skips AGENTS.md/CLAUDE.md at the loader source;
    // appendSystemPromptOverride suppresses APPEND_SYSTEM.md (no flag equivalent).
    expect(defaultResourceLoaderCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        noContextFiles: true,
        appendSystemPromptOverride: expect.any(Function),
      }),
    );
    // The override returns an empty list so any loaded sources are discarded.
    const ctorArgs = defaultResourceLoaderCtor.mock.calls[0][0];
    expect(ctorArgs.appendSystemPromptOverride(["would-be-loaded"])).toEqual([]);
  });

  it("prompt_mode: system_instructions lets pi inject AGENTS.md as Project Context (noContextFiles: false)", async () => {
    vi.mocked(getConfig).mockReturnValueOnce(makeConfig({ extensionRules: [] }));
    vi.mocked(getAgentConfig).mockReturnValueOnce(
      makeAgentConfig({ extensionRules: [], promptMode: "system_instructions" }),
    );
    const { session } = createSession("CTX");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    expect(defaultResourceLoaderCtor).toHaveBeenCalledWith(
      expect.objectContaining({ noContextFiles: false }),
    );
  });

  it("prompt_mode: system_instructions under isolated keeps noContextFiles true", async () => {
    vi.mocked(getConfig).mockReturnValueOnce(makeConfig({ extensionRules: [] }));
    vi.mocked(getAgentConfig).mockReturnValueOnce(
      makeAgentConfig({ extensionRules: [], promptMode: "system_instructions" }),
    );
    const { session } = createSession("CTX");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi, isolated: true });

    expect(defaultResourceLoaderCtor).toHaveBeenCalledWith(
      expect.objectContaining({ noContextFiles: true }),
    );
  });

  it("resumeAgent also falls back to the final assistant message text", async () => {
    const { session } = createSession("RESUMED");

    const result = await resumeAgent(session as any, "Continue");

    expect(result.text).toBe("RESUMED");
    expect(result.failure).toBeUndefined();
  });

  it("sets the agent name as session name before binding extensions", async () => {
    const { session } = createSession("NAMED");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    expect(session.setSessionName).toHaveBeenCalledWith("Explore");
    const setOrder = session.setSessionName.mock.invocationCallOrder[0];
    const bindOrder = session.bindExtensions.mock.invocationCallOrder[0];
    expect(setOrder).toBeLessThan(bindOrder);
  });

  it("suffixes the session name with a short agentId so parallel spawns are distinguishable", async () => {
    const { session } = createSession("NAMED");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi, agentId: "a1b2c3d4e5f6" });

    expect(session.setSessionName).toHaveBeenCalledWith("Explore#a1b2c3d4");
  });
});

// #144 — a failed FINAL assistant turn (stopReason "error") must surface as
// `failure`; how the turn STOPPED decides, never whether it produced text.
describe("agent-runner failed-final-turn detection (#144)", () => {
  /** Session whose prompt() appends the given messages to history. */
  function sessionEnding(...messages: any[]) {
    const { session } = createSession("");
    session.prompt = vi.fn(async () => {
      session.messages.push(...messages);
    }) as any;
    return session;
  }

  const errorFinal = {
    role: "assistant",
    content: [],
    stopReason: "error",
    errorMessage: "retries exhausted: 529 overloaded",
  };

  it("propagates SDK abort without a controller as unknown on fresh and resumed runs", async () => {
    const session = sessionEnding({ role: "assistant", content: [{ type: "text", text: "checkpoint" }], stopReason: "aborted" });
    createAgentSession.mockResolvedValue({ session });
    const result = await runAgent(ctx, "Explore", "go", { pi });
    expect(result).toMatchObject({ interruptionCause: "unknown", aborted: true, responseText: "checkpoint" });
    const resumed = await resumeAgent(result.session, "continue");
    expect(resumed).toMatchObject({ interruptionCause: "unknown", text: "checkpoint" });
  });

  it("flags a run whose final turn is an empty provider error", async () => {
    const session = sessionEnding(errorFinal);
    createAgentSession.mockResolvedValue({ session });

    const result = await runAgent(ctx, "Explore", "go", { pi });

    expect(result.failure).toBe("retries exhausted: 529 overloaded");
  });

  it("flags the failure even when an EARLIER turn produced text (no masking)", async () => {
    const session = sessionEnding(
      { role: "assistant", content: [{ type: "text", text: "partial progress" }] },
      { role: "toolResult", content: [] },
      errorFinal,
    );
    createAgentSession.mockResolvedValue({ session });

    const result = await runAgent(ctx, "Explore", "go", { pi });

    expect(result.failure).toBe("retries exhausted: 529 overloaded");
    // The earlier text stays available as context — status honesty, not data loss.
    expect(result.responseText).toBe("partial progress");
  });

  it("flags a provider error that left partial text in the SAME final message", async () => {
    const session = sessionEnding({
      role: "assistant",
      content: [{ type: "text", text: "truncated answ" }],
      stopReason: "error",
      errorMessage: "stream ended before message_stop",
    });
    createAgentSession.mockResolvedValue({ session });

    const result = await runAgent(ctx, "Explore", "go", { pi });

    expect(result.failure).toBe("stream ended before message_stop");
    expect(result.responseText).toBe("truncated answ");
  });

  it.each([undefined, "", " \n\t"])("flags empty length output %j on fresh and resumed runs (#144)", async (text) => {
    // stopReason "length" with empty content is a silent max-token death — it
    // reproduces the #144 "completed with No output." symptom, so it must fail.
    const session = sessionEnding({ role: "assistant", content: text === undefined ? [] : [{ type: "text", text }], stopReason: "length" });
    createAgentSession.mockResolvedValue({ session });

    const result = await runAgent(ctx, "Explore", "go", { pi });

    expect(result.failure).toBe("run hit the output token limit before producing any text");
    expect(result.responseText).toBe("");
    expect(result.aborted).toBe(false);
    expect(result.interruptionCause).toBeUndefined();
    session.messages.push({ role: "assistant", content: [{ type: "text", text: "PRIOR ANSWER" }] });
    const resumed = await resumeAgent(result.session, "continue");
    expect(resumed.failure).toBe(result.failure);
    expect(resumed.text).toBe("");
    expect(resumed.interruptionCause).toBeUndefined();
  });

  it("completes fresh and resumed length stops that produced text", async () => {
    const session = sessionEnding({
      role: "assistant",
      content: [{ type: "text", text: "truncated but useful answer" }],
      stopReason: "length",
    });
    createAgentSession.mockResolvedValue({ session });

    const result = await runAgent(ctx, "Explore", "go", { pi });

    expect(result.failure).toBeUndefined();
    expect(result.responseText).toBe("truncated but useful answer");
    expect(result.interruptionCause).toBeUndefined();
    expect(result.aborted).toBe(false);
    const resumed = await resumeAgent(result.session, "continue");
    expect(resumed.text).toBe("truncated but useful answer");
    expect(resumed.failure).toBeUndefined();
    expect(resumed.interruptionCause).toBeUndefined();
  });

  it("does NOT flag an empty final turn that stopped cleanly (no false failures)", async () => {
    const session = sessionEnding(
      { role: "assistant", content: [{ type: "text", text: "did the work" }] },
      { role: "toolResult", content: [] },
      { role: "assistant", content: [], stopReason: "stop" },
    );
    createAgentSession.mockResolvedValue({ session });

    const result = await runAgent(ctx, "Explore", "go", { pi });

    expect(result.failure).toBeUndefined();
    expect(result.responseText).toBe("did the work"); // walk-back fallback preserved
  });

  it("resumeAgent applies the same rule", async () => {
    const { session } = createSession("");
    session.prompt = vi.fn(async () => {
      session.messages.push(errorFinal);
    }) as any;

    const result = await resumeAgent(session as any, "Continue");

    expect(result.failure).toBe("retries exhausted: 529 overloaded");
  });

  it("resume whose new turn fails empty does NOT return the previous turn's answer (#144)", async () => {
    // The session already carries a completed prior turn; the resume prompt then
    // fails empty. The walk-back must be bounded to this resume — result "".
    const { session } = createSession("");
    session.messages.push(
      { role: "user", content: "first question" },
      { role: "assistant", content: [{ type: "text", text: "PREVIOUS ANSWER" }], stopReason: "stop" },
    );
    session.prompt = vi.fn(async () => {
      session.messages.push({ role: "user", content: "follow-up" }, errorFinal);
    }) as any;

    const result = await resumeAgent(session as any, "follow-up");

    expect(result.failure).toBe("retries exhausted: 529 overloaded");
    expect(result.text).toBe(""); // NOT "PREVIOUS ANSWER"
  });

  it("resume that produces partial text before failing returns only THIS resume's text", async () => {
    const { session } = createSession("");
    session.messages.push(
      { role: "assistant", content: [{ type: "text", text: "PREVIOUS ANSWER" }], stopReason: "stop" },
    );
    session.prompt = vi.fn(async () => {
      session.messages.push(
        { role: "assistant", content: [{ type: "text", text: "new partial" }] },
        { role: "toolResult", content: [] },
        errorFinal,
      );
    }) as any;

    const result = await resumeAgent(session as any, "go");

    expect(result.failure).toBe("retries exhausted: 529 overloaded");
    expect(result.text).toBe("new partial"); // this resume's progress, not the prior answer
  });

  it("collector: a toolResult/user message_start no longer wipes collected assistant text", async () => {
    const { session, listeners } = createSession("");
    createAgentSession.mockResolvedValue({ session });
    session.prompt = vi.fn(async () => {
      for (const l of listeners) {
        l({ type: "message_start", message: { role: "assistant" } });
        l({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "STREAMED" } });
        // pi emits message_start for tool results and queued user messages too.
        l({ type: "message_start", message: { role: "toolResult" } });
        l({ type: "message_start", message: { role: "user" } });
      }
    }) as any;

    const result = await runAgent(ctx, "Explore", "go", { pi });

    expect(result.responseText).toBe("STREAMED");
  });
});

// ─── message_end → onAssistantUsage wiring (issue #38) ─────────────────
// Both runAgent and resumeAgent dispatch usage to the caller via this
// callback. The callback feeds the AgentRecord lifetime accumulator, which
// is the source of truth for total tokens (survives compaction).
describe("agent-runner usage callback wiring", () => {
  function emitMessageEnd(listeners: Array<(e: any) => void>, usage: any) {
    const event = { type: "message_end", message: { role: "assistant", usage } };
    for (const l of listeners) l(event);
  }

  it("runAgent forwards full usage from message_end events", async () => {
    const { session, listeners } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    const seen: Array<{ input: number; output: number; cacheWrite: number }> = [];
    session.prompt = vi.fn(async () => {
      // Two assistant messages over the run
      emitMessageEnd(listeners, { input: 100, output: 50, cacheWrite: 10, cacheRead: 500, cost: { total: 0.25 } });
      emitMessageEnd(listeners, { input: 200, output: 80, cacheWrite: 20 });
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "OK" }] });
    });

    await runAgent(ctx, "Explore", "go", {
      pi,
      onAssistantUsage: (u) => seen.push(u),
    });

    expect(seen).toEqual([
      { input: 100, output: 50, cacheWrite: 10, cacheRead: 500, cost: 0.25 },
      { input: 200, output: 80, cacheWrite: 20, cacheRead: 0, cost: 0 },
    ]);
  });

  it("runAgent normalizes partial usage objects to 0 for missing fields", async () => {
    const { session, listeners } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    const seen: any[] = [];
    session.prompt = vi.fn(async () => {
      emitMessageEnd(listeners, { input: 50 }); // output, cacheWrite missing
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "OK" }] });
    });

    await runAgent(ctx, "Explore", "go", {
      pi,
      onAssistantUsage: (u) => seen.push(u),
    });

    expect(seen).toEqual([{ input: 50, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 }]);
  });

  it("runAgent skips the callback when message_end has no usage field", async () => {
    const { session, listeners } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    const cb = vi.fn();
    session.prompt = vi.fn(async () => {
      emitMessageEnd(listeners, undefined);
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "OK" }] });
    });

    await runAgent(ctx, "Explore", "go", { pi, onAssistantUsage: cb });

    expect(cb).not.toHaveBeenCalled();
  });

  it("resume reports completed turn_end separately from assistant usage", async () => {
    const { session, listeners } = createSession("RESUMED");
    const onTurnEnd = vi.fn();
    const onAssistantUsage = vi.fn();
    session.prompt = vi.fn(async () => {
      emitMessageEnd(listeners, { input: 10 });
      emitMessageEnd(listeners, { input: 20 });
      expect(onTurnEnd).not.toHaveBeenCalled();
      for (const listener of listeners) listener({ type: "turn_end" });
    });
    await resumeAgent(session as unknown as Parameters<typeof resumeAgent>[0], "continue", { onTurnEnd, onAssistantUsage });
    expect(onAssistantUsage).toHaveBeenCalledTimes(2);
    expect(onTurnEnd).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("resumeAgent forwards usage on message_end the same way", async () => {
    const { session, listeners } = createSession("RESUMED");
    const seen: any[] = [];

    session.prompt = vi.fn(async () => {
      emitMessageEnd(listeners, { input: 10, output: 20, cacheWrite: 5, cacheRead: 50, cost: { total: 0.5 } });
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "RESUMED" }] });
    });

    await resumeAgent(session as any, "continue", {
      onAssistantUsage: (u) => seen.push(u),
    });

    expect(seen).toEqual([{ input: 10, output: 20, cacheWrite: 5, cacheRead: 50, cost: 0.5 }]);
  });

  it("forwards compaction_end events to onCompaction (only when not aborted)", async () => {
    const { session, listeners } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    const seen: any[] = [];
    session.prompt = vi.fn(async () => {
      // Successful compaction — should fire
      for (const l of listeners) l({
        type: "compaction_end",
        aborted: false,
        reason: "threshold",
        result: { tokensBefore: 12345 },
      });
      // Aborted compaction — should NOT fire
      for (const l of listeners) l({
        type: "compaction_end",
        aborted: true,
        reason: "manual",
        result: { tokensBefore: 99999 },
      });
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "OK" }] });
    });

    await runAgent(ctx, "Explore", "go", {
      pi,
      onCompaction: (info) => seen.push(info),
    });

    expect(seen).toEqual([{ reason: "threshold", tokensBefore: 12345 }]);
  });
});

// getAgentConversation renders the subagent transcript shown in the /agents
// inspect overlay. Pure function over session.messages — no mocks needed
// beyond a literal-object session.
describe("getAgentConversation", () => {
  function fakeSession(messages: unknown[]) {
    return { messages } as never;
  }

  it("returns an empty string for a session with no messages", () => {
    expect(getAgentConversation(fakeSession([]))).toBe("");
  });

  it("formats a user-then-assistant exchange with role-prefixed lines joined by blank lines", () => {
    const out = getAgentConversation(
      fakeSession([
        { role: "user", content: "hi" },
        { role: "assistant", content: [{ type: "text", text: "hello" }] },
      ]),
    );
    expect(out).toBe("[User]: hi\n\n[Assistant]: hello");
  });

  it("accepts user content as content-blocks (not just strings)", () => {
    const out = getAgentConversation(
      fakeSession([{ role: "user", content: [{ type: "text", text: "from blocks" }] }]),
    );
    expect(out).toBe("[User]: from blocks");
  });

  it("emits a [Tool Calls] block listing each toolCall by name or toolName, falling back to 'unknown'", () => {
    const out = getAgentConversation(
      fakeSession([
        {
          role: "assistant",
          content: [
            { type: "text", text: "calling tools" },
            { type: "toolCall", name: "search" },
            { type: "toolCall", toolName: "edit" },
            { type: "toolCall" },
          ],
        },
      ]),
    );
    expect(out).toContain("[Assistant]: calling tools");
    expect(out).toContain("[Tool Calls]:\n  Tool: search\n  Tool: edit\n  Tool: unknown");
  });

  it("truncates toolResult content beyond 200 chars and tags it with the tool name", () => {
    const longText = "x".repeat(300);
    const out = getAgentConversation(
      fakeSession([
        {
          role: "toolResult",
          toolName: "bash",
          content: [{ type: "text", text: longText }],
        },
      ]),
    );
    expect(out.startsWith("[Tool Result (bash)]: ")).toBe(true);
    expect(out.endsWith("...")).toBe(true);
    // prefix + 200 chars + "..."
    expect(out.length).toBe("[Tool Result (bash)]: ".length + 200 + 3);
  });

  it("emits [Tool Calls] but no [Assistant] when the assistant only made tool calls", () => {
    const out = getAgentConversation(
      fakeSession([
        { role: "user", content: "do it" },
        { role: "assistant", content: [{ type: "toolCall", name: "search" }] },
      ]),
    );
    expect(out).toContain("[User]: do it");
    expect(out).not.toContain("[Assistant]:");
    expect(out).toContain("[Tool Calls]:\n  Tool: search");
  });
});

// ─── tool scoping (issues #47, #125) ─────────────────────────────────────
// runAgent scopes a subagent's tools in one of two ways:
//   • Static allowlist (`tools:` session option) — ONLY when no extension loads
//     (no `+` extensions: rule, or isolated). Nothing can register
//     asynchronously there, so pi-mono's `allowedToolNames` gating both
//     registration and the initial active set is exactly right; it carries the
//     granted built-ins.
//   • Live scoping — whenever extensions load. The session `tools:` option is
//     left unset so pi's live `isAllowedTool` admits tools whenever they register
//     (pi-mcp registers on session_start, context-mode on before_agent_start);
//     `excludeTools:` carries the name-stable permanent scope; and
//     `installExtensionToolScope` narrows the ACTIVE set to the `tools:` rules,
//     re-deriving on every turn_end so late arrivals are judged too.
// `lastToolsPassed()` returns what the LLM can actually call under either shape.

import {
  getAgentConfig,
  getConfig,
  resolveType,
} from "../src/agent-types.js";

const BUILTINS_7 = ["read", "bash", "edit", "write", "grep", "find", "ls"];

const rules = (field: AccessRuleField, value: string) => parseAccessRules(field, value).rules;

function makeAgentConfig(overrides: Record<string, unknown> = {}) {
  return {
    name: "test-agent",
    description: "Test",
    extensionRules: rules("extensions", "+@all, -@builtin"),
    toolRules: rules("tools", "+@all"),
    discoverSkills: true,
    preloadSkills: [] as string[],
    systemPrompt: "Test.",
    promptMode: "replace" as const,
    inheritContext: false,
    runInBackground: false,
    isolated: false,
    ...overrides,
  };
}

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    displayName: "test-agent",
    description: "Test",
    extensionRules: rules("extensions", "+@all, -@builtin"),
    toolRules: rules("tools", "+@all"),
    discoverSkills: true,
    preloadSkills: [] as string[],
    promptMode: "replace" as const,
    ...overrides,
  };
}

/** Configure the next runAgent call with `extensions:` / `tools:` rules (plus extra agent fields). */
function setupRules(extensions: string, tools: string, overrides: Record<string, unknown> = {}) {
  const access = { extensionRules: rules("extensions", extensions), toolRules: rules("tools", tools) };
  vi.mocked(getConfig).mockReturnValueOnce(makeConfig(access));
  vi.mocked(getAgentConfig).mockReturnValueOnce(makeAgentConfig({ ...access, ...overrides }));
}

/** Register extensions for the mock loader, keyed by extension path → tool names. */
function withExtensions(spec: Record<string, string[]>) {
  loaderExtensionsRef.current = {
    extensions: Object.entries(spec).map(([path, tools]) => ({
      path,
      tools: new Map(tools.map((n) => [n, {}])),
    })),
    errors: [],
    runtime: {},
  };
}

/** Name of the runner's trusted ceiling tool (`TOOL_CEILING_TOOL_NAME` in agent-runner.ts). */
const TOOL_CEILING_TOOL_NAME = "subagent_tool_ceiling";

/**
 * The tool REGISTRY pi would build for a given `createAgentSession` call —
 * mirroring `_refreshToolRegistry`'s `isAllowedTool` — as tool names with
 * their `sourceInfo.path`:
 *   - `tools:` set   → the allowlist gates the registry (nothing else registers).
 *   - `tools:` unset → every built-in plus every loaded extension tool, minus
 *     `excludeTools`, plus the runner's ceiling tool; it keeps growing as
 *     extensions register later.
 * SDK `customTools` (StructuredOutput) carry a trusted `<sdk:name>` source.
 * Read live from `loaderExtensionsRef`, so a test can simulate late registration.
 */
function mockRegistry(opts: Record<string, any>): Array<{ name: string; path: string }> {
  const excluded = new Set<string>(opts.excludeTools ?? []);
  const sdk = new Set<string>((opts.customTools ?? []).map((tool: { name: string }) => tool.name));
  const pathOf = (name: string) => (sdk.has(name) ? `<sdk:${name}>` : `builtin:${name}`);
  const all: Array<{ name: string; path: string }> = opts.tools
    ? opts.tools.map((name: string) => ({ name, path: pathOf(name) }))
    : [
        ...BUILTINS_7.map((name) => ({ name, path: `builtin:${name}` })),
        ...loaderExtensionsRef.current.extensions.flatMap((e) => [...e.tools.keys()].map((name) => ({ name, path: e.path }))),
        ...[...sdk].map((name) => ({ name, path: `<sdk:${name}>` })),
        { name: TOOL_CEILING_TOOL_NAME, path: "<inline:subagent-nested-tool-scope>" },
      ];
  const seen = new Set<string>();
  return all.filter(({ name }) => {
    if (excluded.has(name) || seen.has(name)) return false;
    seen.add(name);
    return true;
  });
}

/**
 * What the LLM can actually call.
 *
 * Under the static allowlist (no extensions) that is `tools:` verbatim. Otherwise
 * it is the live ACTIVE set (what Pi itself activates — `tools:` never adds or
 * removes from it) minus whatever the REAL ceiling tool's `prepareLoadout` hides,
 * applied only while the ceiling is itself active — mirroring `installExtensionToolScope`
 * and the runner's ceiling tool (see agent-tool-scope.ts, agent-runner.ts).
 */
function lastToolsPassed(): string[] {
  const opts = createAgentSession.mock.calls[0][0];
  if (opts.tools) return opts.tools;
  const active = lastSession?.getActiveToolNames() ?? [];
  if (!active.includes(TOOL_CEILING_TOOL_NAME)) return active;

  const agentConfigResult = vi.mocked(getAgentConfig).mock.results.at(-1)?.value as
    | { toolRules?: readonly AccessRule[]; allowNesting?: boolean }
    | undefined;
  const configResult = vi.mocked(getConfig).mock.results.at(-1)?.value as
    | { toolRules?: readonly AccessRule[] }
    | undefined;
  const toolRules = agentConfigResult?.toolRules ?? configResult?.toolRules ?? [];
  const gates: ToolAccessGates = { allowNesting: agentConfigResult?.allowNesting };
  const allowed = resolveToolAccess(toolRules, toolCandidates(lastSession!.getAllTools()), gates).allowed;
  const ceiling = createToolCeilingTool(TOOL_CEILING_TOOL_NAME, () => allowed);
  const hidden = new Set(ceiling.prepareLoadout?.({ declared: active.map((name) => ({ name })) })?.hiddenDeclarations ?? []);
  return active.filter((name) => !hidden.has(name));
}

function lastLoaderOpts(): Record<string, unknown> {
  return defaultResourceLoaderCtor.mock.calls[0][0];
}

/** Diagnostics reported through onToolActivity whose text starts with `prefix`. */
function diagnosticsOf(onToolActivity: ReturnType<typeof vi.fn>, prefix: string): string[] {
  return onToolActivity.mock.calls
    .map((c) => c[0]?.toolName)
    .filter((n): n is string => typeof n === "string" && n.startsWith(prefix));
}

describe("agent-runner session persistence", () => {
  it("S1 persists an agent without any persistence field through SessionManager.create", async () => {
    vi.mocked(getAgentConfig).mockReturnValueOnce(makeAgentConfig());
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    expect(sessionManagerInMemory).not.toHaveBeenCalled();
    expect(createAgentSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionManager: expect.objectContaining({ kind: "persistent-session-manager" }),
    }));
  });

  it("S1 uses pi's normal session location without session_dir or a parent session id", async () => {
    vi.mocked(getAgentConfig).mockReturnValueOnce(makeAgentConfig());
    settingsManagerGetSessionDir.mockReturnValue("/normal/pi/sessions");
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    expect(sessionManagerCreate).toHaveBeenCalledWith("/tmp", "/normal/pi/sessions", undefined);
  });

  it("S1 resolves a relative session_dir against the working directory", async () => {
    vi.mocked(getAgentConfig).mockReturnValueOnce(makeAgentConfig({ sessionDir: ".seams/pi-sessions/seam-plan-reviewer" }));
    settingsManagerGetSessionDir.mockReturnValue("/normal/pi/sessions");
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi, cwd: "/repo" });

    expect(sessionManagerCreate).toHaveBeenCalledWith("/repo", "/repo/.seams/pi-sessions/seam-plan-reviewer", undefined);
  });

  it("S1 stores children of a known parent under subagent-sessions/<parentSessionId>", async () => {
    vi.mocked(getAgentConfig).mockReturnValueOnce(makeAgentConfig());
    settingsManagerGetSessionDir.mockReturnValue("/normal/pi/sessions");
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi, parentSessionId: "P" });

    expect(sessionManagerCreate).toHaveBeenCalledWith("/tmp", join("/mock/agent-dir", "subagent-sessions", "P"), undefined);
  });

  it("S1 session_dir wins over the subagent-sessions directory", async () => {
    vi.mocked(getAgentConfig).mockReturnValueOnce(makeAgentConfig({ sessionDir: "/explicit/session/path" }));
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi, parentSessionId: "P", cwd: "/repo" });

    expect(sessionManagerCreate).toHaveBeenCalledWith("/repo", "/explicit/session/path", undefined);
  });

  it("passes the parent session file as native parentSession lineage", async () => {
    vi.mocked(getAgentConfig).mockReturnValueOnce(makeAgentConfig());
    settingsManagerGetSessionDir.mockReturnValue("/normal/pi/sessions");
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });
    await runAgent({
      ...ctx,
      sessionManager: { ...ctx.sessionManager, getSessionFile: () => "/tmp/parent.jsonl" },
    }, "Explore", "go", { pi });
    expect(sessionManagerCreate).toHaveBeenCalledWith("/tmp", "/normal/pi/sessions", { parentSession: "/tmp/parent.jsonl" });
  });

  it("S10 a fresh spawn appends a launch entry with its per-call values", async () => {
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi, agentId: "agent-1", isolated: true, skills: ["call-skill"], maxTurns: 7 });

    expect(sessionManagerAppendCustomEntry).toHaveBeenCalledWith(SUBAGENT_LAUNCH_ENTRY, {
      version: 1, agentId: "agent-1", type: "explore", isolated: true, skills: ["call-skill"],
    });
  });
});

describe("agent-runner session reopen", () => {
  let dir: string;
  let file: string;
  let childCwd: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agent-runner-reopen-"));
    file = join(dir, "child.jsonl");
    writeFileSync(file, "synthetic\n");
    childCwd = join(dir, "child-cwd");
    mkdirSync(childCwd);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** Configure SessionManager.open to return a validated child session with this launch entry. */
  function reopenWith(launch: Record<string, unknown> = {}) {
    const reopened = {
      kind: "reopened-session-manager",
      getCwd: () => childCwd,
      getHeader: () => ({ type: "session", id: "child-session", cwd: childCwd }),
      buildSessionContext: () => ({ messages: [{ role: "user", content: "earlier" }] }),
      getEntries: () => [{
        type: "custom",
        customType: SUBAGENT_LAUNCH_ENTRY,
        data: { version: 1, agentId: "agent-1", type: "explore", ...launch },
      }],
      getSessionId: () => "child-session",
      getBranch: () => [],
      appendCustomEntry: vi.fn(() => "entry"),
    };
    sessionManagerOpen.mockReturnValueOnce(reopened);
    return reopened;
  }

  it("S10 reopens the given file instead of creating a session", async () => {
    const reopened = reopenWith();
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi, agentId: "agent-1", resumeSessionFile: file });

    expect(createAgentSession).toHaveBeenCalledWith(expect.objectContaining({ sessionManager: reopened }));
    expect(sessionManagerCreate).not.toHaveBeenCalled();
  });

  it("S10 reopen works in the session cwd with config from the parent cwd", async () => {
    reopenWith();
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi, agentId: "agent-1", resumeSessionFile: file });

    expect([createAgentSession.mock.calls[0][0].cwd, lastLoaderOpts().cwd]).toEqual([childCwd, "/tmp"]);
  });

  it("S10 reopen applies the launch isolated value over the per-call option", async () => {
    setupRules("+@all", "+read");
    reopenWith({ isolated: true });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi, agentId: "agent-1", resumeSessionFile: file, isolated: false });

    expect(lastLoaderOpts().noExtensions).toBe(true);
  });

  it("S10 reopen applies the launch skills over the per-call skills", async () => {
    reopenWith({ skills: ["launch-skill"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi, agentId: "agent-1", resumeSessionFile: file, skills: ["call-skill"] });

    expect(_preloadSkills).toHaveBeenLastCalledWith(["launch-skill"], "/tmp");
  });

  it("reopen enforces no turn limit even when frontmatter max_turns is set", async () => {
    reopenWith();
    vi.mocked(getAgentConfig).mockReturnValueOnce(makeAgentConfig({ maxTurns: 1 }));
    const { session, listeners } = createSession("DONE");
    session.prompt.mockImplementation(async () => {
      for (const listener of listeners) listener({ type: "tool_execution_end", toolName: "read", result: {} });
      for (const listener of listeners) listener({ type: "turn_end", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", name: "read" }] }, toolResults: [] });
    });
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi, agentId: "agent-1", resumeSessionFile: file });

    expect(session.steer).not.toHaveBeenCalled();
  });

  it("S10 reopen re-seeds the parent's Agent-tree scope", async () => {
    const reopened = reopenWith();
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });
    const context = {
      ...ctx,
      sessionManager: {
        getSessionId: () => "parent-session",
        getBranch: () => [{ type: "custom", customType: "session-local:scope", data: { version: 1, rootScopeId: "root-session" } }],
      },
    };

    await runAgent(context, "Explore", "go", { pi, agentId: "agent-1", resumeSessionFile: file });

    expect(reopened.appendCustomEntry).toHaveBeenCalledWith("session-local:scope", { version: 1, rootScopeId: "root-session" });
  });

  it("S10 reopen does not prepend the parent conversation", async () => {
    reopenWith();
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });
    const context = {
      ...ctx,
      sessionManager: {
        getSessionId: () => "parent-session",
        getBranch: () => [{ type: "message", message: { role: "user", content: "parent conversation" } }],
      },
    };

    await runAgent(context, "Explore", "continue", { pi, agentId: "agent-1", resumeSessionFile: file, inheritContext: true });

    expect(session.prompt).toHaveBeenCalledWith("continue");
  });
});

describe("agent-runner session-local Agent-tree scope", () => {
  it("seeds inherited scope metadata before createAgentSession", async () => {
    const context = {
      ...ctx,
      sessionManager: {
        getSessionId: () => "child-parent-session",
        getBranch: () => [{
          type: "custom",
          customType: "session-local:scope",
          data: { version: 1, rootScopeId: "root-session" },
        }],
      },
    };
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(context, "Explore", "go", { pi });

    expect(sessionManagerAppendCustomEntry).toHaveBeenNthCalledWith(
      1,
      "session-local:scope",
      { version: 1, rootScopeId: "root-session" },
    );
    expect(sessionManagerAppendCustomEntry.mock.invocationCallOrder[0]).toBeLessThan(
      createAgentSession.mock.invocationCallOrder[0],
    );
  });

  it("resume reuses the existing session without reseeding scope metadata", async () => {
    const { session } = createSession("RESUMED");

    await resumeAgent(session as any, "continue");

    expect(sessionManagerAppendCustomEntry).not.toHaveBeenCalled();
  });
});

describe("agent-runner trusted session-local binding", () => {
  function trustedFactory() {
    const factories = lastLoaderOpts().extensionFactories as Array<{
      name: string;
      hidden?: boolean;
      factory(pi: unknown): void | Promise<void>;
    }> | undefined;
    const factory = factories?.find(({ name }) => name === "session-local");
    expect(factory).toMatchObject({ name: "session-local", hidden: true });
    return factory;
  }

  it("loads one hidden hook-only factory without extension rules or widened tools", async () => {
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    const inline = trustedFactory();
    expect(loaderExtensionsRef.current.extensions.map((extension) => extension.path)).toEqual([
      "<inline:subagent-model-fallback>",
      "<inline:subagent-fast>",
      "<inline:session-local>",
    ]);
    expect(lastToolsPassed()).toEqual(["read"]);

    const hookPi = { on: vi.fn(), registerTool: vi.fn() };
    await inline?.factory(hookPi);
    expect(hookPi.on).toHaveBeenCalledTimes(4);
    expect(hookPi.registerTool).not.toHaveBeenCalled();
  });

  it("keeps only the hidden factory under isolated mode", async () => {
    setupRules("+@all", "+read");
    withExtensions({ "/ext/unrelated.ts": ["unrelated_tool"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi, isolated: true });

    trustedFactory();
    expect(loaderExtensionsRef.current.extensions.map((extension) => extension.path)).toEqual([
      "<inline:subagent-model-fallback>",
      "<inline:subagent-fast>",
      "<inline:session-local>",
    ]);
    expect(lastToolsPassed()).toEqual(["read"]);
  });

  it("retains the hidden factory once and filters a discovered duplicate that the rules select", async () => {
    setupRules("+@all, -@builtin, -unrelated", "+read, +@all");
    withExtensions({
      "/ext/session-local/index.ts": [],
      "/ext/mcp.ts": ["mcp_tool"],
      "/ext/unrelated.ts": ["unrelated_tool"],
    });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });
    const onToolActivity = vi.fn();

    await runAgent(ctx, "Explore", "go", { pi, onToolActivity });

    trustedFactory();
    expect(loaderExtensionsRef.current.extensions.map((extension) => extension.path)).toEqual([
      "/ext/mcp.ts",
      "<inline:subagent-model-fallback>",
      "<inline:subagent-fast>",
      "<inline:session-local>",
      "<inline:subagent-nested-tool-scope>",
    ]);
    expect(lastToolsPassed()).toContain("mcp_tool");
    expect(lastToolsPassed()).not.toContain("unrelated_tool");
    expect(diagnosticsOf(onToolActivity, "extension-")).toEqual([]);
  });

  it("retains the hidden factory when a rule removes session-local", async () => {
    setupRules("+@all, -@builtin, -session-local", "+read");
    withExtensions({
      "/ext/session-local/index.ts": [],
      "/ext/mcp.ts": ["mcp_tool"],
    });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    trustedFactory();
    expect(loaderExtensionsRef.current.extensions.map((extension) => extension.path)).toEqual([
      "/ext/mcp.ts",
      "<inline:subagent-model-fallback>",
      "<inline:subagent-fast>",
      "<inline:session-local>",
      "<inline:subagent-nested-tool-scope>",
    ]);
  });
});

describe("agent-runner trusted smart-tool-guards binding", () => {
  function factories() {
    return lastLoaderOpts().extensionFactories as Array<{
      name: string;
      hidden?: boolean;
      factory(pi: unknown): void | Promise<void>;
    }>;
  }

  it.each(["chengfeng", "direnjie", "taishang", "xuannv", "yanluo", "huayan"] as const)(
    "guards canonical type %s through registry resolution without extension rules",
    async (canonicalType) => {
      vi.mocked(resolveType).mockReturnValueOnce(canonicalType);
      const { session } = createSession("OK");
      createAgentSession.mockResolvedValue({ session });

      await runAgent(ctx, canonicalType, "go", { pi });

      expect(factories()).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "session-local", hidden: true }),
        expect.objectContaining({ name: "smart-tool-guards", hidden: true }),
      ]));
      expect(loaderExtensionsRef.current.extensions.map(({ path }) => path)).toEqual([
        "<inline:subagent-model-fallback>",
        "<inline:subagent-fast>",
        "<inline:session-local>",
        "<inline:smart-tool-guards>",
      ]);
      expect(lastToolsPassed()).toEqual(["read"]);
    },
  );

  it.each(["jintong", "yunu"] as const)("leaves adjacent canonical type %s unguarded", async (canonicalType) => {
    vi.mocked(resolveType).mockReturnValueOnce(canonicalType);
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, canonicalType, "go", { pi });

    expect(factories().map(({ name }) => name)).toEqual(["subagent-model-fallback", "subagent-fast", "session-local"]);
  });

  it("survives isolation without widening tools", async () => {
    vi.mocked(resolveType).mockReturnValueOnce("chengfeng");
    setupRules("+@all", "+read");
    withExtensions({ "/ext/unrelated.ts": ["unrelated_tool"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "chengfeng", "go", { pi, isolated: true });

    expect(factories().map(({ name }) => name)).toEqual(["subagent-model-fallback", "subagent-fast", "session-local", "smart-tool-guards"]);
    expect(loaderExtensionsRef.current.extensions.map(({ path }) => path)).toEqual([
      "<inline:subagent-model-fallback>",
      "<inline:subagent-fast>",
      "<inline:session-local>",
      "<inline:smart-tool-guards>",
    ]);
    expect(lastToolsPassed()).toEqual(["read"]);
  });

  it("survives rule filtering while discovered smart-tool-guards coexists", async () => {
    vi.mocked(resolveType).mockReturnValueOnce("chengfeng");
    setupRules("+mcp, +smart-tool-guards, -smart-tool-guards", "+read, +@all");
    withExtensions({
      "/ext/mcp.ts": ["mcp_tool"],
      "/ext/smart-tool-guards/index.ts": [],
      "/ext/unrelated.ts": ["unrelated_tool"],
    });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "chengfeng", "go", { pi });

    expect(loaderExtensionsRef.current.extensions.map(({ path }) => path)).toEqual([
      "/ext/mcp.ts",
      "<inline:subagent-model-fallback>",
      "<inline:subagent-fast>",
      "<inline:session-local>",
      "<inline:smart-tool-guards>",
      "<inline:subagent-nested-tool-scope>",
    ]);
    expect(lastToolsPassed()).toContain("mcp_tool");
    expect(lastToolsPassed()).not.toContain("unrelated_tool");
  });

  it.each(["chengfeng", "huayan"] as const)(
    "coexists with repeated auto registration as one effective bash hook for %s",
    async (canonicalType) => {
      vi.mocked(resolveType).mockReturnValueOnce(canonicalType);
      const { session } = createSession("OK");
      createAgentSession.mockResolvedValue({ session });
      await runAgent(ctx, canonicalType, "go", { pi });
      const inline = factories().find(({ name }) => name === "smart-tool-guards");
      const eventListeners = new Map<string, Set<(data: unknown) => void>>();
      const handlers: Array<(event: unknown, ctx: unknown) => unknown | Promise<unknown>> = [];
      const hookPi = {
        events: {
          emit(channel: string, data: unknown) {
            for (const listener of [...(eventListeners.get(channel) ?? [])]) listener(data);
          },
          on(channel: string, listener: (data: unknown) => void) {
            const listeners = eventListeners.get(channel) ?? new Set<(data: unknown) => void>();
            listeners.add(listener);
            eventListeners.set(channel, listeners);
            return () => listeners.delete(listener);
          },
        },
        on: vi.fn((event: string, handler: (event: unknown, ctx: unknown) => unknown | Promise<unknown>) => {
          if (event === "tool_call") handlers.push(handler);
        }),
      };

      smartToolGuards(hookPi as never);
      await inline?.factory(hookPi);
      await inline?.factory(hookPi);

      expect(handlers).toHaveLength(1);
      await expect(handlers[0](
        { type: "tool_call", toolCallId: "call-1", toolName: "bash", input: { command: "rm out" } },
        { cwd: "/tmp" },
      )).resolves.toEqual({
        block: true,
        reason: [
          "[Smart Guard][BLOCK][source=policy][profile=bash-read-only-v1][scope=subagents:guarded]",
          "Bash not run: Read-only policy matched: filesystem-mutation. Guard active: This guarded subagent requires read-only Bash.",
        ].join("\n"),
      });
    },
  );
});

describe("agent-runner master tool allowlist", () => {
  it("tools: +@all with loaded extensions — the four default built-ins plus extension tools land in the active set", async () => {
    setupRules("+@all, -@builtin", "+@all");
    withExtensions({ "/ext/mcp.ts": ["mcp", "mcp_call"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    // `tools: +@all` grants grep/find/ls too, but Pi only auto-activates its
    // four default built-ins — no `tools:` rule can turn on a default-off tool.
    const tools = lastToolsPassed();
    expect(new Set(tools)).toEqual(new Set(["read", "bash", "edit", "write", "mcp", "mcp_call"]));
    expect(tools).not.toContain("grep");
    expect(tools).not.toContain("find");
    expect(tools).not.toContain("ls");
  });

  it("enumerates tools across multiple loaded extensions", async () => {
    setupRules("+@all, -@builtin", "+@all");
    withExtensions({ "/ext/a.ts": ["tool_a"], "/ext/b.ts": ["tool_b"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    const tools = lastToolsPassed();
    expect(tools).toContain("tool_a");
    expect(tools).toContain("tool_b");
  });

  it("a named tool rule keeps only that extension tool, mutes the rest", async () => {
    setupRules("+@all, -@builtin", "+@builtin, +mcp_call");
    withExtensions({ "/ext/mcp.ts": ["mcp", "mcp_call"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    const tools = lastToolsPassed();
    expect(tools).not.toContain("mcp");     // not granted
    expect(tools).toContain("mcp_call");    // granted by name
    expect(tools).toContain("read");        // @builtin grant
    expect(tools).toContain("bash");        // @builtin grant
  });

  it("EXCLUDED_TOOL_NAMES never reach the active set even if an extension registers them", async () => {
    setupRules("+@all, -@builtin", "+@all", { allowNesting: true });
    withExtensions({
      "/ext/evil.ts": ["agent", "get_agent_result", "steer_subagent", "ok_ext"],
    });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    const tools = lastToolsPassed();
    expect(tools).not.toContain("agent");
    expect(tools).not.toContain("get_agent_result");
    expect(tools).not.toContain("steer_subagent");
    expect(tools).toContain("ok_ext");
  });

  it("without extension rules the granted built-ins are the static tools allowlist", async () => {
    setupRules("", "+read, +grep, +find, +ls, +mcp_call");
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    expect(lastToolsPassed()).toEqual(["read", "grep", "find", "ls"]);
  });

  it("dynamic mode: leaves the allowlist unset, denies via excludeTools, activates post-bind", async () => {
    setupRules("+@all, -@builtin", "+@all");
    withExtensions({ "/ext/mcp.ts": ["mcp"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    // Allowlist unset so async tools (e.g. MCP on session_start) can register;
    // scope is a denylist of our orchestration tools (every built-in is granted).
    const opts = createAgentSession.mock.calls[0][0];
    expect(opts.tools).toBeUndefined();
    expect(new Set(opts.excludeTools)).toEqual(
      new Set(Object.values(SUBAGENT_TOOL_NAMES)),
    );

    // `tools:` only permits now — activation is Pi's job (and the extension's,
    // for the mcp tool), so the scope installer does not call setActiveToolsByName
    // for policy. It only re-adds the ceiling if something else dropped it, which
    // nothing does here (Pi activates the ceiling on registration), so no call at all.
    expect(session.setActiveToolsByName).not.toHaveBeenCalled();
    expect(lastToolsPassed()).toContain("mcp");
    expect(lastToolsPassed()).toContain("read");
  });

  it("dynamic mode: ungranted built-ins join excludeTools by name", async () => {
    setupRules("+@all, -@builtin", "+@all, -@builtin, +read");
    withExtensions({ "/ext/mcp.ts": ["mcp"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    expect(new Set(createAgentSession.mock.calls[0][0].excludeTools)).toEqual(new Set([
      ...Object.values(SUBAGENT_TOOL_NAMES),
      "bash", "powershell", "edit", "write", "grep", "find", "ls",
    ]));
  });
});

// ─── asynchronously-registered extension tools (issue #125) ──────────────
// pi-mcp calls registerTool from `session_start`, context-mode from
// `before_agent_start` — both long after loader.reload(). `registerTool` writes
// into the live `extension.tools` map, which is what these tests simulate.
describe("agent-runner async extension tool registration", () => {
  /** Simulate `pi.registerTool` on an already-loaded extension. */
  function registerLate(extPath: string, toolName: string) {
    const ext = loaderExtensionsRef.current.extensions.find((e) => e.path === extPath);
    if (!ext) throw new Error(`no loaded extension at ${extPath}`);
    ext.tools.set(toolName, {});
  }

  function setup(tools = "+read, +@all, -@builtin, +read") {
    setupRules("+@all, -@builtin", tools);
  }

  it("a tool registered during session_start reaches the active set", async () => {
    setup();
    withExtensions({ "/ext/mcp.ts": [] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });
    // pi-mcp's real shape: nothing at load, tools appear when bindExtensions
    // fires session_start and the MCP servers connect.
    session.bindExtensions.mockImplementation(async () => {
      registerLate("/ext/mcp.ts", "mcp_search");
    });

    await runAgent(ctx, "Explore", "go", { pi });

    expect(lastToolsPassed()).toContain("mcp_search");
  });

  it("a tool registered after bind is picked up on the next turn_end", async () => {
    setup();
    withExtensions({ "/ext/mcp.ts": [] });
    const { session, listeners } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });
    expect(session.getActiveToolNames()).not.toContain("mcp_search");

    // A lazy MCP server connects mid-conversation (context-mode registers at
    // before_agent_start, i.e. after runAgent already installed the scope).
    registerLate("/ext/mcp.ts", "mcp_search");
    for (const l of listeners) l({ type: "turn_end", message: { role: "assistant", stopReason: "stop", content: [] }, toolResults: [] });

    expect(session.getActiveToolNames()).toContain("mcp_search");
  });

  it("a name rule admits a late matching tool but not a non-matching one", async () => {
    setup("+read, +foo_late");
    withExtensions({ "/ext/foo.ts": [], "/ext/bar.ts": [] });
    const { session, listeners } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    registerLate("/ext/foo.ts", "foo_late");
    registerLate("/ext/bar.ts", "bar_late");
    for (const l of listeners) l({ type: "turn_end", message: { role: "assistant", stopReason: "stop", content: [] }, toolResults: [] });

    // Pi activates every extension tool it observes, regardless of `tools:`.
    const active = session.getActiveToolNames();
    expect(active).toContain("foo_late");
    expect(active).toContain("bar_late");
    // The model only sees what the rules grant; the ceiling hides the rest.
    const declared = lastToolsPassed();
    expect(declared).toContain("foo_late");
    expect(declared).not.toContain("bar_late");
    await expect(
      session.agent.beforeToolCall?.({ toolCall: { name: "bar_late" } }),
    ).resolves.toMatchObject({ block: true });
  });

  it("an @<extension> group admits late tools from that extension only", async () => {
    setup("+read, +@foo");
    withExtensions({ "/ext/foo.ts": ["foo_early"], "/ext/bar.ts": [] });
    const { session, listeners } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    registerLate("/ext/foo.ts", "foo_late");
    registerLate("/ext/bar.ts", "bar_late");
    for (const l of listeners) l({ type: "turn_end", message: { role: "assistant", stopReason: "stop", content: [] }, toolResults: [] });

    // Pi activates every extension tool it observes, regardless of `tools:`.
    expect(session.getActiveToolNames()).toContain("bar_late");
    // The model only sees what the `@foo` rule grants.
    expect([...lastToolsPassed()].sort()).toEqual(["foo_early", "foo_late", "read"]);
  });

  it("beforeToolCall blocks an out-of-scope tool and delegates otherwise", async () => {
    // Pi activates tools registered inside prompt() (before_agent_start) after
    // the install-time narrow, so a call-time guard enforces the rules there.
    setup("+read, +foo_tool");
    withExtensions({ "/ext/foo.ts": ["foo_tool"], "/ext/bar.ts": ["bar_tool"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    await expect(
      session.agent.beforeToolCall?.({ toolCall: { name: "bar_tool" } }),
    ).resolves.toMatchObject({ block: true });
    await expect(
      session.agent.beforeToolCall?.({ toolCall: { name: "foo_tool" } }),
    ).resolves.toBeUndefined();
  });

  it("beforeToolCall preserves a hook pi installed before us", async () => {
    setup();
    withExtensions({ "/ext/foo.ts": ["foo_tool"] });
    const { session } = createSession("OK");
    const prior = vi.fn(async () => undefined);
    session.agent.beforeToolCall = prior;
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });
    await session.agent.beforeToolCall?.({ toolCall: { name: "foo_tool" } });

    expect(prior).toHaveBeenCalledTimes(1);
  });

  it("scope outlives runAgent so resumed turns stay narrowed", async () => {
    // runAgent tears down its own turn subscription in `finally`; the scope
    // hooks must NOT be torn down with it, or resume/steer would drift.
    setup("+read, +foo_late");
    withExtensions({ "/ext/foo.ts": [], "/ext/bar.ts": [] });
    const { session, listeners } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });
    await resumeAgent(session as any, "keep going");

    registerLate("/ext/foo.ts", "foo_late");
    registerLate("/ext/bar.ts", "bar_late");
    for (const l of listeners) l({ type: "turn_end", message: { role: "assistant", stopReason: "stop", content: [] }, toolResults: [] });

    // Pi activated both; the ceiling + veto hold bar_late back.
    expect(session.getActiveToolNames()).toContain("foo_late");
    expect(session.getActiveToolNames()).toContain("bar_late");
    expect(lastToolsPassed()).not.toContain("bar_late");
    await expect(
      session.agent.beforeToolCall?.({ toolCall: { name: "bar_late" } }),
    ).resolves.toMatchObject({ block: true });
  });

  it("isolated keeps the static allowlist — no live scoping installed", async () => {
    setupRules("+@all", "+read, +foo_tool");
    withExtensions({ "/ext/foo.ts": ["foo_tool"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi, isolated: true });

    // A hard registry gate is the right boundary here: nothing can register
    // asynchronously, so there is no active-set narrowing to maintain.
    expect(createAgentSession.mock.calls[0][0].tools).toEqual(["read"]);
    expect(session.setActiveToolsByName).not.toHaveBeenCalled();
    expect(session.agent.beforeToolCall).toBeUndefined();
  });
});

// ─── extensions: signed rules as the loader-level extension filter ───────
// Rules select from discovered extensions plus Pi's built-in extensions
// (`builtin:<name>`); the last matching rule wins. Filtering happens at the
// loader via extensionsOverride — excluded extensions never bind handlers or
// register tools.
describe("agent-runner extension rules", () => {
  function builtinFactoryNames(): string[] {
    return (lastLoaderOpts().extensionFactories as Array<{ name: string; builtin?: boolean }>)
      .filter(({ builtin }) => builtin)
      .map(({ name }) => name);
  }

  it("+mcp keeps only the mcp-named extension, drops others", async () => {
    setupRules("+mcp", "+@all");
    withExtensions({
      "/ext/mcp.ts": ["mcp", "mcp_call"],
      "/ext/other.ts": ["other_tool"],
    });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    const tools = lastToolsPassed();
    expect(tools).toContain("mcp");
    expect(tools).toContain("mcp_call");
    expect(tools).not.toContain("other_tool");
  });

  it("matches a package-installed extension by its package short name, not just its src dir (#143)", async () => {
    // A package whose entry is `src/index.ts` canonicalizes to "src"; a child
    // agent must still be able to select it by the package name.
    const dir = mkdtempSync(join(tmpdir(), "subagents-match-"));
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "@scope/pi-subagents", pi: { extensions: ["./src/index.ts"] } }),
      );
      mkdirSync(join(dir, "src"));
      writeFileSync(join(dir, "src", "index.ts"), "export default () => {};");
      const entry = join(dir, "src", "index.ts");

      setupRules("+pi-subagents", "+@all");
      withExtensions({ [entry]: ["pkg_tool"] });
      const { session } = createSession("OK");
      createAgentSession.mockResolvedValue({ session });

      await runAgent(ctx, "Explore", "go", { pi });

      expect(lastToolsPassed()).toContain("pkg_tool");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a later -id rule drops that extension's tools and keeps the others without warnings", async () => {
    setupRules("+@all, -@builtin, -notify", "+@all");
    withExtensions({
      "/ext/notify.ts": ["notify_send"],
      "/ext/mcp.ts": ["mcp_tool"],
    });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });
    const onToolActivity = vi.fn();

    await runAgent(ctx, "Explore", "go", { pi, onToolActivity });

    const tools = lastToolsPassed();
    expect(tools).not.toContain("notify_send");
    expect(tools).toContain("mcp_tool");
    expect(diagnosticsOf(onToolActivity, "extension-")).toEqual([]);
  });

  it("matches extension ids case-insensitively", async () => {
    setupRules("+Mcp", "+@all");
    withExtensions({ "/ext/mcp.ts": ["mcp_tool"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });
    const onToolActivity = vi.fn();

    await runAgent(ctx, "Explore", "go", { pi, onToolActivity });

    expect(diagnosticsOf(onToolActivity, "extension-")).toEqual([]);
    expect(lastToolsPassed()).toContain("mcp_tool");
  });

  it("warns but proceeds when an id matches no extension", async () => {
    setupRules("+mcp, +typo", "+@all");
    withExtensions({ "/ext/mcp.ts": ["mcp_tool"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });
    const onToolActivity = vi.fn();

    const result = await runAgent(ctx, "Explore", "go", { pi, onToolActivity });

    expect(result.responseText).toBe("OK");
    expect(diagnosticsOf(onToolActivity, "extension-")).toEqual([
      'extension-warning:"typo" matches no extension (agent "Explore")',
    ]);
  });

  it("an ambiguous id fails the spawn before any session exists", async () => {
    setupRules("+twin", "+@all");
    withExtensions({ "/a/twin.ts": [], "/b/twin/index.ts": [] });
    createAgentSession.mockResolvedValue(createSession("OK"));

    await expect(runAgent(ctx, "Explore", "go", { pi })).rejects.toThrow(/Agent "Explore" extensions: "twin" is ambiguous/);
    expect(createAgentSession).not.toHaveBeenCalled();
  });

  it("+@all supplies codemode, tool-search, and mcp as replaceable Pi built-ins", async () => {
    setupRules("+@all", "+read");
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    expect((lastLoaderOpts().extensionFactories as Array<Record<string, unknown>>).filter(({ builtin }) => builtin)).toEqual([
      expect.objectContaining({ name: "codemode", builtin: true, replaceable: true }),
      expect.objectContaining({ name: "tool-search", builtin: true, replaceable: true }),
      expect.objectContaining({ name: "mcp", builtin: true, replaceable: true }),
    ]);
  });

  it("+builtin:codemode supplies only codemode, with the model catalog disabled", async () => {
    setupRules("+builtin:codemode", "+read");
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });
    createCodemodeExtension.mockClear();

    await runAgent(ctx, "Explore", "go", { pi });

    expect({ names: builtinFactoryNames(), options: createCodemodeExtension.mock.calls }).toEqual({
      names: ["codemode"],
      options: [[{ models: false }]],
    });
  });

  it("-@builtin supplies no Pi built-in factory", async () => {
    setupRules("+@all, -@builtin", "+read");
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    expect(builtinFactoryNames()).toEqual([]);
  });

  it("rules without a + entry load nothing and supply no Pi built-in factory", async () => {
    setupRules("-mcp", "+read");
    withExtensions({ "/ext/mcp.ts": ["mcp_tool"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    expect({ noExtensions: lastLoaderOpts().noExtensions, builtins: builtinFactoryNames() })
      .toEqual({ noExtensions: true, builtins: [] });
  });
});

// ─── tools: signed rules ────────────────────────────────────────────────
// `tools:` decides which tools surface to the LLM: tool names, `*` globs,
// `@builtin`, `@all`, and `@<extension id>` groups, last match wins. Loading
// an extension grants none of its tools.
describe("agent-runner tool rules", () => {
  it("an exact name rule surfaces only the named tool, mutes the rest", async () => {
    setupRules("+@all, -@builtin", "+foo_tool");
    withExtensions({ "/ext/foo.ts": ["foo_tool", "foo_other"], "/ext/other.ts": ["other_tool"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    const tools = lastToolsPassed();
    expect(tools).toContain("foo_tool");
    expect(tools).not.toContain("foo_other");  // sibling not granted
    expect(tools).not.toContain("other_tool"); // other extension not granted
    expect(tools).not.toContain("read");       // no built-ins granted
  });

  it("an @<extension> group minus one tool grants exactly the rest of that extension", async () => {
    setupRules("+@all, -@builtin", "+@foo, -foo_b");
    withExtensions({ "/ext/foo.ts": ["foo_a", "foo_b", "foo_c"], "/ext/other.ts": ["other_tool"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    expect([...lastToolsPassed()].sort()).toEqual(["foo_a", "foo_c"]);
  });

  it("the hidden nested-tool-scope hook blocks nested calls outside the rules", async () => {
    setupRules("+foo", "+read, +foo_*");
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    const factory = (lastLoaderOpts().extensionFactories as Array<{ name: string; hidden?: boolean; factory(pi: unknown): void }>)
      .find(({ name }) => name === "subagent-nested-tool-scope");
    expect(factory).toMatchObject({ hidden: true });
    const handlers: Array<(event: unknown) => unknown> = [];
    const registry = ["read", "bash", "foo_code", "other_tool"].map((name) => ({ name, sourceInfo: { path: `/ext/${name}.ts` } }));
    factory?.factory({
      on: (_event: string, handler: (event: unknown) => unknown) => handlers.push(handler),
      registerTool: vi.fn(),
      getAllTools: () => registry,
    });
    const call = (toolName: string, parentToolCallId?: string) => handlers[0]?.({ type: "tool_call", toolName, parentToolCallId, input: {} });

    expect(call("other_tool", "parent")).toMatchObject({ block: true });
    expect(call("bash", "parent")).toMatchObject({ block: true });
    expect(call("foo_code", "parent")).toBeUndefined();
    expect(call("read", "parent")).toBeUndefined();
    expect(call("other_tool")).toBeUndefined();
  });

  it("the hidden nested-tool-scope hook registers a ceiling that hides ungranted declarations", async () => {
    setupRules("+foo", "+read, +foo_*");
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    const factory = (lastLoaderOpts().extensionFactories as Array<{ name: string; factory(pi: unknown): void }>)
      .find(({ name }) => name === "subagent-nested-tool-scope");
    const registered: Array<{ name: string; exposure?: string; prepareLoadout?(loadout: unknown): { hiddenDeclarations?: string[] } | undefined }> = [];
    const registry = ["read", "foo_code", "late_tool"].map((name) => ({ name, sourceInfo: { path: `/ext/${name}.ts` } }));
    factory?.factory({ on: vi.fn(), registerTool: (tool: (typeof registered)[number]) => registered.push(tool), getAllTools: () => registry });
    const ceiling = registered[0];
    registry.push({ name: ceiling.name, sourceInfo: { path: "<inline:subagent-nested-tool-scope>" } });

    const declared = ["read", "foo_code", "late_tool", ceiling.name].map((name) => ({ name }));
    expect({ exposure: ceiling.exposure, hidden: ceiling.prepareLoadout?.({ declared })?.hiddenDeclarations }).toEqual({
      exposure: "model-only",
      hidden: ["late_tool", "subagent_tool_ceiling"],
    });
  });

  it("adds no nested-tool-scope hook when extensions do not load", async () => {
    setupRules("", "+read, +foo_*");
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    expect((lastLoaderOpts().extensionFactories as Array<{ name: string }>).map(({ name }) => name))
      .not.toContain("subagent-nested-tool-scope");
  });

  it("built-in-only rules surface no extension tools", async () => {
    setupRules("+@all, -@builtin", "+read");
    withExtensions({ "/ext/foo.ts": ["foo_tool"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    const tools = lastToolsPassed();
    expect(tools).toContain("read");
    expect(tools).not.toContain("foo_tool");
  });

  it("a * glob matches any run of characters", async () => {
    setupRules("+@all, -@builtin", "+read, +foo_*");
    withExtensions({ "/ext/foo.ts": ["foo_a", "foo_b"], "/ext/other.ts": ["bar_tool"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    const tools = lastToolsPassed();
    expect(tools).toContain("foo_a");
    expect(tools).toContain("foo_b");
    expect(tools).not.toContain("bar_tool");
    expect(tools).toContain("read");
  });

  it("tool-name matching is case-sensitive", async () => {
    setupRules("+@all, -@builtin", "+read, +Bar");
    withExtensions({ "/ext/foo.ts": ["Bar", "bar"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    const tools = lastToolsPassed();
    expect(tools).toContain("Bar");
    expect(tools).not.toContain("bar"); // case-sensitive: not the granted tool
  });

  it("isolated: true loads no extensions — only granted built-ins", async () => {
    setupRules("+@all", "+read, +foo_tool");
    withExtensions({ "/ext/foo.ts": ["foo_tool"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi, isolated: true });

    const tools = lastToolsPassed();
    expect(tools).toContain("read");
    expect(tools).not.toContain("foo_tool");
    expect(lastLoaderOpts().noExtensions).toBe(true);
  });

  it("a tool name that matches nothing stays quiet", async () => {
    setupRules("", "+read, +reed");
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });
    const onToolActivity = vi.fn();

    await runAgent(ctx, "Explore", "go", { pi, onToolActivity });

    expect(diagnosticsOf(onToolActivity, "tools-")).toEqual([]);
  });

  it("reports tool resolution diagnostics once, not on every turn", async () => {
    setupRules("+@all, -@builtin", "+read, +@nope");
    withExtensions({ "/ext/foo.ts": ["foo_tool"] });
    const { session, listeners } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });
    const onToolActivity = vi.fn();

    await runAgent(ctx, "Explore", "go", { pi, onToolActivity });
    for (const l of listeners) l({ type: "turn_end", message: { role: "assistant", stopReason: "stop", content: [] }, toolResults: [] });

    expect(diagnosticsOf(onToolActivity, "tools-")).toEqual(['tools-warning:"@nope" matches no tool (agent "Explore")']);
  });
});

// ─── MCP tools a child's rules deny (builtin:mcp) ────────────────────────
// They join excludeTools so codemode and tool_search never list them, and the
// nested-tool-scope hook drops fully denied servers from `mcp_servers`.
describe("agent-runner MCP excludes", () => {
  const RESOURCE_TOOLS = ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"];
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agent-runner-mcp-"));
  });
  afterEach(() => {
    getAgentDir.mockReturnValue("/mock/agent-dir");
    rmSync(dir, { recursive: true, force: true });
  });

  function writeMcpConfig(path: string, servers: string[]) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ mcpServers: Object.fromEntries(servers.map((name) => [name, { command: "unused" }])) }));
  }

  /** Run a child in `dir` whose parent catalog holds `parentTools` (from builtin:mcp); returns its excludeTools. */
  async function excludesFor(extensions: string, tools: string, parentTools: string[] = []): Promise<string[]> {
    setupRules(extensions, tools);
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });
    const getAllTools = () => parentTools.map((name) => ({ name, sourceInfo: { path: "builtin:mcp" } }));

    await runAgent(ctx, "Explore", "go", { pi: { ...pi, getAllTools }, cwd: dir });

    return createAgentSession.mock.calls[0][0].excludeTools;
  }

  /** The nested-tool-scope hook's `before_agent_start` handler, applied to `sections`. */
  async function filterMcpSection(servers: string[], tools: string, sections: Record<string, string>) {
    writeMcpConfig(join(dir, ".pi", "mcp.json"), servers);
    await excludesFor("+builtin:mcp", tools);
    const factory = (lastLoaderOpts().extensionFactories as Array<{ name: string; factory(pi: unknown): void }>)
      .find(({ name }) => name === "subagent-nested-tool-scope");
    const handlers = new Map<string, (event: unknown) => unknown>();
    factory?.factory({
      on: (event: string, handler: (event: unknown) => unknown) => handlers.set(event, handler),
      registerTool: vi.fn(),
      getAllTools: () => [],
    });
    handlers.get("before_agent_start")?.({ type: "before_agent_start", systemPromptOptions: { sections } });
    return sections;
  }

  it("a fully denied server excludes its whole namespace", async () => {
    getAgentDir.mockReturnValue(dir);
    writeMcpConfig(join(dir, "mcp.json"), ["web-search"]);

    expect(await excludesFor("+builtin:mcp", "+read, -mcp__*")).toContain("mcp__web_search__*");
  });

  it("a partly granted server excludes its denied catalog tools by name only", async () => {
    writeMcpConfig(join(dir, ".pi", "mcp.json"), ["docs"]);

    const excludes = await excludesFor("+builtin:mcp", "+read, +mcp__docs__search", ["mcp__docs__search", "mcp__docs__delete"]);

    expect(excludes.filter((name) => name.startsWith("mcp__docs__"))).toEqual(["mcp__docs__delete"]);
  });

  it("a server granted by a glob gets no excludes", async () => {
    writeMcpConfig(join(dir, ".pi", "mcp.json"), ["docs"]);

    const excludes = await excludesFor("+builtin:mcp", "+read, +mcp__docs__*", ["mcp__docs__search"]);

    expect(excludes.filter((name) => name.startsWith("mcp__docs__"))).toEqual([]);
  });

  it("denied resource tools are excluded by name, even when the parent lacks them", async () => {
    expect(await excludesFor("+builtin:mcp", "+read")).toEqual(expect.arrayContaining(RESOURCE_TOOLS));
  });

  it("resource tools the rules grant are not excluded", async () => {
    const excludes = await excludesFor("+builtin:mcp", "+read, +@builtin:mcp");

    expect(excludes.filter((name) => RESOURCE_TOOLS.includes(name))).toEqual([]);
  });

  it("a child that does not load builtin:mcp gets no MCP excludes", async () => {
    writeMcpConfig(join(dir, ".pi", "mcp.json"), ["docs"]);

    const excludes = await excludesFor("+builtin:codemode", "+read", ["mcp__docs__search", ...RESOURCE_TOOLS]);

    expect(excludes.filter((name) => name.startsWith("mcp__") || RESOURCE_TOOLS.includes(name))).toEqual([]);
  });

  it("the mcp_servers section drops only fully denied servers", async () => {
    const sections = await filterMcpSection(["blocked-one", "allowed"], "+read, +mcp__allowed__*", {
      mcp_servers: "Servers:\n- mcp__allowed (codemode): Docs\n- mcp__blocked_one (tool_search): Blocked",
    });

    expect(sections).toEqual({ mcp_servers: "Servers:\n- mcp__allowed (codemode): Docs" });
  });

  it("the mcp_servers section is deleted when no server line remains", async () => {
    const sections = await filterMcpSection(["blocked-one"], "+read", {
      mcp_servers: "Servers:\n- mcp__blocked_one (codemode)\n- … 2 more servers; find their tools with searchTools()",
      other: "kept",
    });

    expect(sections).toEqual({ other: "kept" });
  });

  it("an absent mcp_servers section stays absent", async () => {
    expect(await filterMcpSection(["blocked-one"], "+read", { other: "kept" })).toEqual({ other: "kept" });
  });
});

// ---------- per-call skills injection ----------
const mockPreloadSkills = vi.mocked(_preloadSkills);

describe("runAgent — per-call skills injection", () => {
  beforeEach(() => {
    mockPreloadSkills.mockClear();
  });

  function setupSkillsTestCtx() {
    vi.mocked(getConfig).mockReturnValue({
      displayName: "Worker",
      description: "Worker",
      extensionRules: [],
      toolRules: rules("tools", "+read"),
      discoverSkills: false,
      preloadSkills: ["a"],
      promptMode: "replace",
    } as any);
    vi.mocked(getAgentConfig).mockReturnValue({
      name: "Worker",
      description: "Worker",
      extensionRules: [],
      toolRules: rules("tools", "+read"),
      discoverSkills: false,
      preloadSkills: ["a"],
      systemPrompt: ".",
      promptMode: "replace" as const,
    });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });
  }

  it("(RED→GREEN) options.skills unions with config.preloadSkills, deduped", async () => {
    setupSkillsTestCtx();
    await runAgent(ctx, "Worker" as any, "go", { pi, skills: ["a", "b"] });
    // config has ["a"], options has ["a","b"]; union deduped = ["a","b"]
    expect(mockPreloadSkills).toHaveBeenCalledWith(["a", "b"], expect.any(String));
  });

  it("(RED→GREEN) isolated:true with options.skills -> preloadSkills called with []", async () => {
    setupSkillsTestCtx();
    await runAgent(ctx, "Worker" as any, "go", { pi, isolated: true, skills: ["a"] });
    // isolated overrides to empty list; preloadSkills should not be called with non-empty list
    expect(mockPreloadSkills).not.toHaveBeenCalledWith(expect.arrayContaining(["a"]), expect.any(String));
  });
});

it("retains the previously selected candidate when availability changes before the runner starts", async () => {
  const { session } = createSession("DONE");
  createAgentSession.mockResolvedValue({ session });
  const model = { provider: "fixture", api: "anthropic-messages", id: "selected-model", name: "Selected", baseUrl: "http://localhost", reasoning: false, input: ["text" as const], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 };
  const modelInput = "fixture/missing,fixture/selected-model";
  vi.mocked(getAgentConfig).mockReturnValueOnce(makeAgentConfig({ model: modelInput }));
  const find = vi.fn();
  const context = { ...ctx, modelRegistry: { find, getAll: () => [], getAvailable: () => [], isUsingOAuth: () => false } };
  await runAgent(context, "Explore", "go", { pi, selectedModel: { model, fast: false, modelInput } });
  expect(find).not.toHaveBeenCalled();
  expect(createAgentSession.mock.calls[0][0].model).toBe(model);
});

it("does not prompt when the parent aborted during session startup", async () => {
  const signal = new AbortController();
  const { session } = createSession("UNREACHABLE");
  createAgentSession.mockImplementation(async () => { signal.abort(); return { session }; });
  const result = await runAgent(ctx, "Explore", "go", { pi, signal: signal.signal });
  expect(session.prompt).not.toHaveBeenCalled();
  expect(result.aborted).toBe(true);
});

describe("graph run structured output", () => {
  const schema = {
    schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] },
    providerSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] },
    check(value: unknown): true | string {
      return typeof value === "object" && value !== null && "answer" in value && typeof value.answer === "string"
        ? true : "answer must be a string";
    },
  };

  it.each(["stop", "length"])("injects before session creation, repairs %s prose once, and resets capture on resume", async (stopReason) => {
    const { session } = createSession("prose");
    createAgentSession.mockResolvedValue({ session });
    let calls = 0;
    session.prompt.mockImplementation(async () => {
      calls++;
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "prose" }], stopReason });
      const tool = createAgentSession.mock.calls[0][0].customTools[0];
      if (calls === 2 || calls === 4) await tool.execute("result", { answer: `answer-${calls}` });
    });
    const result = await runAgent(ctx, "Explore", "answer", { pi, graphRun: true, structuredOutput: schema });
    expect(createAgentSession.mock.calls[0][0].tools).toContain("StructuredOutput");
    expect(result.aborted).toBe(false);
    expect(result.interruptionCause).toBeUndefined();
    expect(result.structuredJson).toBe('{"answer":"answer-2"}');
    expect(result.structuredRetried).toBe(true);
    expect(result.failure).toBeUndefined();
    const resumed = await resumeAgent(result.session, "again");
    expect(resumed.failure).toBeUndefined();
    expect(resumed.interruptionCause).toBeUndefined();
    expect(resumed.structuredJson).toBe('{"answer":"answer-4"}');
    expect(resumed.structuredRetried).toBe(true);
    expect(session.prompt).toHaveBeenCalledTimes(4);
  });

  it.each(["stop", "length"])("fails after a single %s prose repair and does not reuse a prior answer", async (stopReason) => {
    const { session } = createSession("prose");
    session.prompt.mockImplementation(async () => {
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "prose" }], stopReason });
    });
    createAgentSession.mockResolvedValue({ session });
    const result = await runAgent(ctx, "Explore", "answer", { pi, structuredOutput: schema });
    expect(result.failure).toContain("StructuredOutput was not produced");
    expect(result.structuredJson).toBeUndefined();
    expect(result.aborted).toBe(false);
    expect(result.interruptionCause).toBeUndefined();
    expect(result.structuredRetried).toBe(true);
    expect(session.prompt).toHaveBeenCalledTimes(2);
    const resumed = await resumeAgent(result.session, "again");
    expect(resumed.failure).toContain("StructuredOutput was not produced");
    expect(resumed.structuredJson).toBeUndefined();
    expect(resumed.interruptionCause).toBeUndefined();
    expect(resumed.structuredRetried).toBe(true);
    expect(session.prompt).toHaveBeenCalledTimes(4);
  });

  it("validates payloads with a model-visible tool error", async () => {
    const { session } = createSession("prose");
    createAgentSession.mockResolvedValue({ session });
    session.prompt.mockImplementation(async () => {
      const tool = createAgentSession.mock.calls[0][0].customTools[0];
      await expect(tool.execute("bad", { answer: 5 })).rejects.toThrow("answer must be a string");
      await tool.execute("good", { answer: "validated" });
    });
    const result = await runAgent(ctx, "Explore", "answer", { pi, structuredOutput: schema });
    expect(result.structuredJson).toBe('{"answer":"validated"}');
    expect(result.structuredRetried).toBe(false);
    expect(session.prompt).toHaveBeenCalledTimes(1);
  });

  it("keeps StructuredOutput through live narrowing but blocks child orchestration tools", async () => {
    setupRules("+@all, -@builtin", "+@builtin", { allowNesting: true });
    const { session, listeners } = createSession("prose");
    createAgentSession.mockResolvedValue({ session });
    const result = await runAgent(ctx, "Explore", "answer", { pi, graphRun: true, structuredOutput: schema });
    expect(session.getActiveToolNames()).toContain("StructuredOutput");
    expect(createAgentSession.mock.calls[0][0].excludeTools).toContain("agent_graph");
    await expect(session.agent.beforeToolCall?.({ toolCall: { name: "StructuredOutput" } })).resolves.toBeUndefined();
    await expect(session.agent.beforeToolCall?.({ toolCall: { name: "agent_graph" } })).resolves.toMatchObject({ block: true });
    for (const listener of listeners) listener({ type: "turn_end", message: { role: "assistant", content: [], stopReason: "stop" } });
    await resumeAgent(result.session, "again");
    expect(session.getActiveToolNames()).toContain("StructuredOutput");
    expect(session.getActiveToolNames()).not.toContain("agent_graph");
  });

  it.each(["sdk", "signal", "turn-limit"])("suppresses structured repair after %s interruption", async (kind) => {
    const { session, listeners } = createSession("checkpoint");
    const controller = new AbortController();
    createAgentSession.mockResolvedValue({ session });
    session.prompt.mockImplementation(async () => {
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "checkpoint" }], stopReason: kind === "sdk" ? "aborted" : "length" });
      if (kind === "signal") controller.abort();
      if (kind === "turn-limit") {
        for (let turn = 0; turn < 10 && !session.abort.mock.calls.length; turn++) {
          for (const listener of listeners) listener({ type: "turn_end", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", name: "read" }] }, toolResults: [] });
        }
      }
    });
    const result = await runAgent(ctx, "Explore", "answer", { pi, structuredOutput: schema, signal: controller.signal, maxTurns: kind === "turn-limit" ? 1 : undefined });
    expect(result.aborted).toBe(true);
    expect(result.interruptionCause).toBe(kind === "turn-limit" ? "turn-limit" : "unknown");
    expect(result.structuredRetried).toBe(false);
    expect(session.prompt).toHaveBeenCalledTimes(1);
    if (kind !== "turn-limit") {
      const resumed = await resumeAgent(result.session, "again", { signal: controller.signal });
      expect(resumed.interruptionCause).toBe("unknown");
      expect(resumed.structuredRetried).toBe(false);
      expect(session.prompt).toHaveBeenCalledTimes(kind === "sdk" ? 2 : 1);
    }
  });

  it("never prompts a pre-aborted structured session", async () => {
    const { session } = createSession("prose");
    createAgentSession.mockResolvedValue({ session });
    const result = await runAgent(ctx, "Explore", "answer", {
      pi, structuredOutput: schema, signal: AbortSignal.abort(),
    });
    expect(result.aborted).toBe(true);
    expect(session.prompt).not.toHaveBeenCalled();
    await resumeAgent(result.session, "again", { signal: AbortSignal.abort() });
    expect(session.prompt).not.toHaveBeenCalled();
  });
});
