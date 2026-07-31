import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  createAgentSession,
  defaultResourceLoaderCtor,
  loaderExtensionsRef,
  getAgentDir,
  sessionManagerInMemory,
  sessionManagerCreate,
  settingsManagerCreate,
  settingsManagerGetSessionDir,
} = vi.hoisted(() => ({
  createAgentSession: vi.fn(),
  defaultResourceLoaderCtor: vi.fn(),
  loaderExtensionsRef: {
    current: { extensions: [], errors: [], runtime: {} } as {
      extensions: Array<{ path: string; tools: Map<string, unknown> }>;
      errors: Array<{ path: string; error: string }>;
      runtime: Record<string, unknown>;
    },
  },
  getAgentDir: vi.fn(() => "/mock/agent-dir"),
  sessionManagerInMemory: vi.fn(() => ({ kind: "memory-session-manager" })),
  sessionManagerCreate: vi.fn(() => ({ kind: "persistent-session-manager" })),
  settingsManagerGetSessionDir: vi.fn(() => undefined as string | undefined),
  settingsManagerCreate: vi.fn(() => ({ kind: "settings-manager", getSessionDir: settingsManagerGetSessionDir })),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  createAgentSession,
  // Mock loader simulates pi-mono: reload() applies additionalExtensionPaths
  // (an unknown path becomes an error row, mirroring a failed load) and then
  // runs extensionsOverride over the result.
  DefaultResourceLoader: class {
    opts: any;
    constructor(options: any) {
      this.opts = options;
      defaultResourceLoaderCtor(options);
    }

    async reload() {
      // Mirror the real loader: `noExtensions: true` zeros out the discovered set
      // entirely. Otherwise tests pre-register the extensions a path should
      // resolve to; an unregistered path simply yields no extension (a failed load).
      if (this.opts.noExtensions) {
        loaderExtensionsRef.current = { extensions: [], errors: [], runtime: {} };
        return;
      }
      if (this.opts.extensionsOverride) {
        loaderExtensionsRef.current = this.opts.extensionsOverride(loaderExtensionsRef.current);
      }
    }

    getExtensions() {
      return loaderExtensionsRef.current;
    }
  },
  getAgentDir,
  SessionManager: { inMemory: sessionManagerInMemory, create: sessionManagerCreate },
  SettingsManager: { create: settingsManagerCreate },
}));

vi.mock("../src/agent-types.js", () => ({
  BUILTIN_TOOL_NAMES: ["read", "bash", "edit", "write", "grep", "find", "ls"],
  getConfig: vi.fn(() => ({
    displayName: "Explore",
    description: "Explore",
    builtinToolNames: ["read"],
    extensions: false,
    discoverSkills: true,
    preloadSkills: [],
    promptMode: "replace",
  })),
  getAgentConfig: vi.fn(() => ({
    name: "Explore",
    description: "Explore",
    builtinToolNames: ["read"],
    extensions: false,
    discoverSkills: true,
    preloadSkills: [],
    systemPrompt: "You are Explore.",
    promptMode: "replace",
    inheritContext: false,
    runInBackground: false,
    isolated: false,
  })),
  getToolNamesForType: vi.fn(() => ["read"]),
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
  extensionCanonicalName,
  extensionCanonicalNames,
  getAgentConversation,
  parseExtensionsSpec,
  resumeAgent,
  runAgent,
  SUBAGENT_TOOL_NAMES,
} from "../src/agent-runner.js";
import { preloadSkills as _preloadSkills } from "../src/skill-loader.js";

/** The most recent session built by `createSession` — read by `lastToolsPassed()`. */
let lastSession: ReturnType<typeof createSession>["session"] | undefined;

function createSession(finalText: string) {
  const listeners: Array<(event: any) => void> = [];
  // pi activates only these four by default when no allowlist is given
  // (agent-session.js `defaultActiveToolNames`).
  let activeToolNames: string[] = ["read", "bash", "edit", "write"];
  const session = {
    messages: [] as any[],
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
    // Stateful, so the active set reflects what the scope installer actually did
    // and `renarrow`'s no-op guard behaves as it does against real pi.
    getActiveToolNames: vi.fn(() => activeToolNames),
    setActiveToolsByName: vi.fn((names: string[]) => {
      activeToolNames = [...names];
    }),
    // pi's tool REGISTRY (`_toolDefinitions`), read live so tests can simulate an
    // extension registering after bind by mutating `loaderExtensionsRef`.
    getAllTools: vi.fn(() => {
      const opts = createAgentSession.mock.calls[0]?.[0];
      return opts ? mockRegistry(opts).map((name) => ({ name })) : [];
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
  sessionManager: { getBranch: vi.fn(() => []) },
} as any;

const pi = {} as any;

beforeEach(() => {
  createAgentSession.mockReset();
  defaultResourceLoaderCtor.mockClear();
  getAgentDir.mockClear();
  sessionManagerInMemory.mockClear();
  sessionManagerCreate.mockClear();
  settingsManagerGetSessionDir.mockReset();
  settingsManagerGetSessionDir.mockReturnValue(undefined);
  settingsManagerCreate.mockClear();
  loaderExtensionsRef.current = { extensions: [], errors: [], runtime: {} };
  lastSession = undefined;
});

describe("agent-runner final output capture", () => {
  it("returns the final assistant text even when no text_delta events were streamed", async () => {
    const { session } = createSession("LOCKED");
    createAgentSession.mockResolvedValue({ session });

    const result = await runAgent(ctx, "Explore", "Say LOCKED", { pi });

    expect(result.responseText).toBe("LOCKED");
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
    expect(sessionManagerInMemory).toHaveBeenCalledWith("/tmp/worktree");
    expect(createAgentSession).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "/tmp/worktree",
      agentDir: "/mock/agent-dir",
    }));
  });

  it("passes the parent model runtime while retaining the legacy model registry", async () => {
    const { session } = createSession("AUTHENTICATED");
    createAgentSession.mockResolvedValue({ session });
    const modelRuntime = { getAuth: vi.fn(), hasConfiguredAuth: vi.fn() };
    const context = {
      ...ctx,
      modelRegistry: { ...ctx.modelRegistry, runtime: modelRuntime },
    };

    await runAgent(context, "Explore", "Say AUTHENTICATED", { pi });

    expect(createAgentSession).toHaveBeenCalledWith(expect.objectContaining({
      modelRegistry: context.modelRegistry,
      modelRuntime,
    }));
  });

  it("omits modelRuntime when the legacy registry does not expose one", async () => {
    const { session } = createSession("LEGACY");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "Say LEGACY", { pi });

    expect(createAgentSession.mock.calls[0][0]).not.toHaveProperty("modelRuntime");
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
    vi.mocked(getConfig).mockReturnValueOnce(makeConfig({ extensions: false }));
    vi.mocked(getAgentConfig).mockReturnValueOnce(
      makeAgentConfig({ extensions: false, promptMode: "system_instructions" }),
    );
    vi.mocked(getToolNamesForType).mockReturnValueOnce(["read"]);
    const { session } = createSession("CTX");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    expect(defaultResourceLoaderCtor).toHaveBeenCalledWith(
      expect.objectContaining({ noContextFiles: false }),
    );
  });

  it("prompt_mode: system_instructions under isolated keeps noContextFiles true", async () => {
    vi.mocked(getConfig).mockReturnValueOnce(makeConfig({ extensions: false }));
    vi.mocked(getAgentConfig).mockReturnValueOnce(
      makeAgentConfig({ extensions: false, promptMode: "system_instructions" }),
    );
    vi.mocked(getToolNamesForType).mockReturnValueOnce(["read"]);
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

  it("flags a run whose final turn hit the token limit with no text (#144 residual)", async () => {
    // stopReason "length" with empty content is a silent max-token death — it
    // reproduces the #144 "completed with No output." symptom, so it must fail.
    const session = sessionEnding({ role: "assistant", content: [], stopReason: "length" });
    createAgentSession.mockResolvedValue({ session });

    const result = await runAgent(ctx, "Explore", "go", { pi });

    expect(result.failure).toBe("run hit the output token limit before producing any text");
  });

  it("does NOT flag a length stop that produced text (truncated answer completes)", async () => {
    const session = sessionEnding({
      role: "assistant",
      content: [{ type: "text", text: "truncated but useful answer" }],
      stopReason: "length",
    });
    createAgentSession.mockResolvedValue({ session });

    const result = await runAgent(ctx, "Explore", "go", { pi });

    expect(result.failure).toBeUndefined();
    expect(result.responseText).toBe("truncated but useful answer");
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
      emitMessageEnd(listeners, { input: 100, output: 50, cacheWrite: 10 });
      emitMessageEnd(listeners, { input: 200, output: 80, cacheWrite: 20 });
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "OK" }] });
    });

    await runAgent(ctx, "Explore", "go", {
      pi,
      onAssistantUsage: (u) => seen.push(u),
    });

    expect(seen).toEqual([
      { input: 100, output: 50, cacheWrite: 10, cost: 0 },
      { input: 200, output: 80, cacheWrite: 20, cost: 0 },
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

    expect(seen).toEqual([{ input: 50, output: 0, cacheWrite: 0, cost: 0 }]);
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

  it("resumeAgent forwards usage on message_end the same way", async () => {
    const { session, listeners } = createSession("RESUMED");
    const seen: any[] = [];

    session.prompt = vi.fn(async () => {
      emitMessageEnd(listeners, { input: 10, output: 20, cacheWrite: 5 });
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "RESUMED" }] });
    });

    await resumeAgent(session as any, "continue", {
      onAssistantUsage: (u) => seen.push(u),
    });

    expect(seen).toEqual([{ input: 10, output: 20, cacheWrite: 5, cost: 0 }]);
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
//   • Static allowlist (`tools:`) — ONLY for noExtensions/isolated. Nothing can
//     register asynchronously there, so pi-mono's `allowedToolNames` gating both
//     registration and the initial active set is exactly right.
//   • Live scoping — whenever extensions load. `tools:` is left unset so pi's
//     live `isAllowedTool` admits tools whenever they register (pi-mcp registers
//     on session_start, context-mode on before_agent_start); `excludeTools:`
//     carries the name-stable permanent scope; and `installExtensionToolScope`
//     narrows the ACTIVE set for `ext:` selectors, re-deriving on every turn_end
//     so late arrivals are judged too.
// `lastToolsPassed()` returns what the LLM can actually call under either shape.

import {
  getAgentConfig,
  getConfig,
  getToolNamesForType,
} from "../src/agent-types.js";

const BUILTINS_7 = ["read", "bash", "edit", "write", "grep", "find", "ls"];

function makeAgentConfig(overrides: Record<string, unknown> = {}) {
  return {
    name: "test-agent",
    description: "Test",
    builtinToolNames: BUILTINS_7,
    extensions: true as boolean | string[],
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
    builtinToolNames: BUILTINS_7,
    extensions: true as boolean | string[],
    discoverSkills: true,
    preloadSkills: [] as string[],
    promptMode: "replace" as const,
    ...overrides,
  };
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

/**
 * The tool REGISTRY pi would build for a given `createAgentSession` call —
 * mirroring `_refreshToolRegistry`'s `isAllowedTool`:
 *   - `tools:` set   → the allowlist gates the registry (nothing else registers).
 *   - `tools:` unset → every built-in plus every loaded extension tool, minus
 *     `excludeTools`, and it keeps growing as extensions register later.
 * Read live from `loaderExtensionsRef`, so a test can simulate late registration.
 */
function mockRegistry(opts: Record<string, any>): string[] {
  const excluded = new Set<string>(opts.excludeTools ?? []);
  const all: string[] = opts.tools
    ? [...opts.tools]
    : [
        ...BUILTINS_7,
        ...loaderExtensionsRef.current.extensions.flatMap((e) => [...e.tools.keys()]),
      ];
  return [...new Set(all)].filter((t) => !excluded.has(t));
}

/**
 * What the LLM can actually call.
 *
 * Under the static allowlist (`noExtensions`/`isolated`) that is `tools:` verbatim.
 * Otherwise the registry is scoped by `excludeTools` and then narrowed to the ACTIVE
 * set by `installExtensionToolScope` — so the active set is the real answer, and
 * asserting on it means these tests exercise the narrowing rather than a
 * reimplementation of pi's gate.
 */
function lastToolsPassed(): string[] {
  const opts = createAgentSession.mock.calls[0][0];
  if (opts.tools) return opts.tools;
  return lastSession?.getActiveToolNames() ?? [];
}

function lastLoaderOpts(): Record<string, unknown> {
  return defaultResourceLoaderCtor.mock.calls[0][0];
}

describe("agent-runner session persistence", () => {
  it("uses an in-memory session by default", async () => {
    vi.mocked(getAgentConfig).mockReturnValueOnce(makeAgentConfig());
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    expect(sessionManagerInMemory).toHaveBeenCalledWith("/tmp");
    expect(sessionManagerCreate).not.toHaveBeenCalled();
    expect(createAgentSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionManager: { kind: "memory-session-manager" },
    }));
  });

  it("uses pi's normal persistent session location when persistSession is true", async () => {
    vi.mocked(getAgentConfig).mockReturnValueOnce(makeAgentConfig({ persistSession: true }));
    settingsManagerGetSessionDir.mockReturnValue("/normal/pi/sessions");
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    expect(sessionManagerInMemory).not.toHaveBeenCalled();
    expect(sessionManagerCreate).toHaveBeenCalledWith("/tmp", "/normal/pi/sessions");
    expect(createAgentSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionManager: { kind: "persistent-session-manager" },
    }));
  });

  it("uses a frontmatter sessionDir when persistSession is true and sessionDir is configured", async () => {
    vi.mocked(getAgentConfig).mockReturnValueOnce(
      makeAgentConfig({ persistSession: true, sessionDir: ".seams/pi-sessions/seam-plan-reviewer" }),
    );
    settingsManagerGetSessionDir.mockReturnValue("/normal/pi/sessions");
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi, cwd: "/repo" });

    expect(sessionManagerCreate).toHaveBeenCalledWith(
      "/repo",
      "/repo/.seams/pi-sessions/seam-plan-reviewer",
    );
  });

  it("persisted child with parentSessionId uses subagent-sessions/<parentId> dir", async () => {
    vi.mocked(getAgentConfig).mockReturnValueOnce(makeAgentConfig({ persistSession: true }));
    settingsManagerGetSessionDir.mockReturnValue("/normal/pi/sessions");
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi, parentSessionId: "P" });

    expect(sessionManagerCreate).toHaveBeenCalledWith(
      "/tmp",
      expect.stringContaining("subagent-sessions/P"),
    );
    const [, dir] = sessionManagerCreate.mock.calls[0]!;
    expect(dir).toMatch(/subagent-sessions[\\/]P$/);
  });

  it("frontmatter session_dir wins over subagent-sessions dir", async () => {
    vi.mocked(getAgentConfig).mockReturnValueOnce(
      makeAgentConfig({ persistSession: true, sessionDir: "/explicit/session/path" }),
    );
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi, parentSessionId: "P", cwd: "/repo" });

    expect(sessionManagerCreate).toHaveBeenCalledWith("/repo", "/explicit/session/path");
  });

  it("non-persisted session stays inMemory regardless of parentSessionId", async () => {
    vi.mocked(getAgentConfig).mockReturnValueOnce(makeAgentConfig({ persistSession: false }));
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi, parentSessionId: "P" });

    expect(sessionManagerInMemory).toHaveBeenCalledWith("/tmp");
    expect(sessionManagerCreate).not.toHaveBeenCalled();
  });
});

describe("agent-runner master tool allowlist", () => {
  it("extensions: true with extension tools — all 7 built-ins plus extension tools land in the allowlist", async () => {
    vi.mocked(getConfig).mockReturnValueOnce(makeConfig({ extensions: true }));
    vi.mocked(getAgentConfig).mockReturnValueOnce(makeAgentConfig({ extensions: true }));
    vi.mocked(getToolNamesForType).mockReturnValueOnce(BUILTINS_7);
    withExtensions({ "/ext/mcp.ts": ["mcp", "mcp_call"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    // Order is not semantically meaningful (pi-mono dedupes via Set);
    // assert membership and exact size instead.
    const tools = lastToolsPassed();
    expect(tools).toHaveLength(BUILTINS_7.length + 2);
    expect(new Set(tools)).toEqual(new Set([...BUILTINS_7, "mcp", "mcp_call"]));
  });

  it("enumerates tools across multiple loaded extensions", async () => {
    vi.mocked(getConfig).mockReturnValueOnce(makeConfig({ extensions: true }));
    vi.mocked(getAgentConfig).mockReturnValueOnce(makeAgentConfig({ extensions: true }));
    vi.mocked(getToolNamesForType).mockReturnValueOnce(BUILTINS_7);
    withExtensions({ "/ext/a.ts": ["tool_a"], "/ext/b.ts": ["tool_b"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    const tools = lastToolsPassed();
    expect(tools).toContain("tool_a");
    expect(tools).toContain("tool_b");
  });

  it("extension_tools keeps only the named extension tools, mutes the rest", async () => {
    vi.mocked(getConfig).mockReturnValueOnce(makeConfig({ extensions: true }));
    vi.mocked(getAgentConfig).mockReturnValueOnce(
      makeAgentConfig({ extensions: true, extensionToolNames: ["mcp_call"] }),
    );
    vi.mocked(getToolNamesForType).mockReturnValueOnce(BUILTINS_7);
    withExtensions({ "/ext/mcp.ts": ["mcp", "mcp_call"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    const tools = lastToolsPassed();
    expect(tools).not.toContain("mcp");     // not named in extension_tools
    expect(tools).toContain("mcp_call");    // named in extension_tools
    expect(tools).toContain("read");        // builtin still present (no denylist)
    expect(tools).toContain("bash");        // builtin still present (no denylist)
  });

  it("EXCLUDED_TOOL_NAMES never reach the allowlist even if an extension registers them", async () => {
    vi.mocked(getConfig).mockReturnValueOnce(makeConfig({ extensions: true }));
    vi.mocked(getAgentConfig).mockReturnValueOnce(makeAgentConfig({ extensions: true }));
    vi.mocked(getToolNamesForType).mockReturnValueOnce(BUILTINS_7);
    withExtensions({
      "/ext/evil.ts": ["Agent", "get_subagent_result", "steer_subagent", "ok_ext"],
    });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    const tools = lastToolsPassed();
    expect(tools).not.toContain("Agent");
    expect(tools).not.toContain("get_subagent_result");
    expect(tools).not.toContain("steer_subagent");
    expect(tools).toContain("ok_ext");
  });

  it("extensions: false uses builtinToolNames as the static tools allowlist", async () => {
    vi.mocked(getConfig).mockReturnValueOnce(makeConfig({ extensions: false }));
    vi.mocked(getAgentConfig).mockReturnValueOnce(makeAgentConfig({ extensions: false }));
    vi.mocked(getToolNamesForType).mockReturnValueOnce(["read", "grep", "find", "ls"]);
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    const tools = lastToolsPassed();
    expect(tools).toEqual(["read", "grep", "find", "ls"]);
    expect(tools).not.toContain("bash");
  });

  it("dynamic mode: leaves the allowlist unset, denies via excludeTools, activates post-bind", async () => {
    vi.mocked(getConfig).mockReturnValueOnce(makeConfig({ extensions: true }));
    vi.mocked(getAgentConfig).mockReturnValueOnce(makeAgentConfig({ extensions: true }));
    vi.mocked(getToolNamesForType).mockReturnValueOnce(BUILTINS_7);
    withExtensions({ "/ext/mcp.ts": ["mcp"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    // Allowlist unset so async tools (e.g. MCP on session_start) can register;
    // scope is a denylist of our orchestration tools (all built-ins were asked for).
    const opts = createAgentSession.mock.calls[0][0];
    expect(opts.tools).toBeUndefined();
    expect(new Set(opts.excludeTools)).toEqual(
      new Set(Object.values(SUBAGENT_TOOL_NAMES)),
    );

    // The active set is repaired AFTER bindExtensions (tools may register during
    // session_start), activating the extension tool plus the asked-for built-ins.
    expect(session.setActiveToolsByName).toHaveBeenCalledTimes(1);
    const setOrder = session.setActiveToolsByName.mock.invocationCallOrder[0];
    const bindOrder = session.bindExtensions.mock.invocationCallOrder[0];
    expect(setOrder).toBeGreaterThan(bindOrder);
    const activated = new Set(session.setActiveToolsByName.mock.calls[0][0]);
    expect(activated.has("mcp")).toBe(true);
    expect(activated.has("read")).toBe(true);
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

  function setup(o: { builtinToolNames?: string[]; extensionTools?: string[] } = {}) {
    vi.mocked(getConfig).mockReturnValueOnce(makeConfig({ extensions: true }));
    vi.mocked(getAgentConfig).mockReturnValueOnce(
      makeAgentConfig({ extensions: true, extensionToolNames: o.extensionTools }),
    );
    vi.mocked(getToolNamesForType).mockReturnValueOnce(o.builtinToolNames ?? ["read"]);
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
    for (const l of listeners) l({ type: "turn_end" });

    expect(session.getActiveToolNames()).toContain("mcp_search");
  });

  it("extension_tools admits a late matching tool but not a non-matching one", async () => {
    setup({ extensionTools: ["foo_late"] });
    withExtensions({ "/ext/foo.ts": [], "/ext/bar.ts": [] });
    const { session, listeners } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    registerLate("/ext/foo.ts", "foo_late");
    registerLate("/ext/bar.ts", "bar_late");
    for (const l of listeners) l({ type: "turn_end" });

    const active = session.getActiveToolNames();
    expect(active).toContain("foo_late");
    // bar_late did not exist at construction and is not named in extension_tools.
    expect(active).not.toContain("bar_late");
  });

  it("extension_tools narrowing still applies to late-registered siblings", async () => {
    setup({ extensionTools: ["keep_me"] });
    withExtensions({ "/ext/foo.ts": [] });
    const { session, listeners } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    registerLate("/ext/foo.ts", "keep_me");
    registerLate("/ext/foo.ts", "drop_me");
    for (const l of listeners) l({ type: "turn_end" });

    expect(session.getActiveToolNames()).toContain("keep_me");
    expect(session.getActiveToolNames()).not.toContain("drop_me");
  });

  it("beforeToolCall blocks an out-of-scope tool and delegates otherwise", async () => {
    // Turn 1 cannot be narrowed — before_agent_start fires inside prompt() and
    // may widen the set after the turn's tools are snapshotted — so a call-time
    // guard is the only correct enforcement there.
    setup({ extensionTools: ["foo_tool"] });
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
    setup({ extensionTools: ["foo_late"] });
    withExtensions({ "/ext/foo.ts": [], "/ext/bar.ts": [] });
    const { session, listeners } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });
    await resumeAgent(session as any, "keep going");

    registerLate("/ext/foo.ts", "foo_late");
    registerLate("/ext/bar.ts", "bar_late");
    for (const l of listeners) l({ type: "turn_end" });

    expect(session.getActiveToolNames()).toContain("foo_late");
    expect(session.getActiveToolNames()).not.toContain("bar_late");
    await expect(
      session.agent.beforeToolCall?.({ toolCall: { name: "bar_late" } }),
    ).resolves.toMatchObject({ block: true });
  });

  it("isolated keeps the static allowlist — no live scoping installed", async () => {
    vi.mocked(getConfig).mockReturnValueOnce(makeConfig({ extensions: false }));
    vi.mocked(getAgentConfig).mockReturnValueOnce(makeAgentConfig({ extensions: false }));
    vi.mocked(getToolNamesForType).mockReturnValueOnce(["read"]);
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

// ─── extensions: string[] as a loader-level extension filter ────────────
// An array entry is a bare name (filters default-discovered extensions),
// a path (loads that extension fresh), or "*" (keep all defaults).
// Filtering happens at the loader via additionalExtensionPaths +
// extensionsOverride — excluded extensions never bind handlers or register
// tools.

describe("extensionCanonicalName", () => {
  it("strips .ts/.js from a single-file extension basename", () => {
    expect(extensionCanonicalName("/x/foo.ts")).toBe("foo");
    expect(extensionCanonicalName("/x/foo.js")).toBe("foo");
  });
  it("uses the parent directory name for index.{ts,js} extensions", () => {
    expect(extensionCanonicalName("/x/foo/index.ts")).toBe("foo");
    expect(extensionCanonicalName("/x/foo/index.js")).toBe("foo");
  });
  it("lowercases the result for case-insensitive matching", () => {
    expect(extensionCanonicalName("/x/MCP.ts")).toBe("mcp");
    expect(extensionCanonicalName("/x/MyExt.js")).toBe("myext");
    expect(extensionCanonicalName("/x/Foo/index.ts")).toBe("foo");
  });
});

describe("extensionCanonicalNames (#143 — package short name alias)", () => {
  const tmpDirs: string[] = [];
  function pkgDir(name: string, piExtensions: unknown): string {
    const dir = mkdtempSync(join(tmpdir(), "subagents-pkg-"));
    tmpDirs.push(dir);
    const manifest: Record<string, unknown> = { name };
    if (piExtensions !== undefined) manifest.pi = { extensions: piExtensions };
    writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "index.ts"), "export default () => {};");
    return dir;
  }
  afterEach(() => {
    while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  });

  it("aliases a package-declared index.ts entry to the unscoped, lowercased package name", () => {
    // Without this, `pi.extensions: ["./src/index.ts"]` only ever matches as "src".
    const dir = pkgDir("@tintinweb/Pi-Subagents", ["./src/index.ts"]);
    expect(extensionCanonicalNames(join(dir, "src", "index.ts"))).toEqual(["src", "pi-subagents"]);
  });

  it("adds no alias for a loose file with no enclosing package.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "subagents-loose-"));
    tmpDirs.push(dir);
    writeFileSync(join(dir, "foo.ts"), "export default () => {};");
    expect(extensionCanonicalNames(join(dir, "foo.ts"))).toEqual(["foo"]);
  });

  it("adds no alias when the nearest manifest does not declare this entry", () => {
    // The package.json is a real pi package but lists a *different* entry — so a
    // co-located file (e.g. our own test fixtures under this repo) is not falsely
    // stamped with the package name.
    const dir = pkgDir("@scope/other-ext", ["./src/other.ts"]);
    expect(extensionCanonicalNames(join(dir, "src", "index.ts"))).toEqual(["src"]);
  });

  it("adds no alias when the nearest package.json has no pi manifest", () => {
    const dir = pkgDir("just-a-project", undefined);
    expect(extensionCanonicalNames(join(dir, "src", "index.ts"))).toEqual(["src"]);
  });

  it("does not climb past a node_modules boundary into a consumer's manifest", () => {
    // A consumer that *declares* a dependency's entry must not lend its name to
    // that dependency: the walk stops at node_modules before reading it.
    const root = mkdtempSync(join(tmpdir(), "subagents-consumer-"));
    tmpDirs.push(root);
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "consumer", pi: { extensions: ["./node_modules/inner-ext/index.ts"] } }),
    );
    const inner = join(root, "node_modules", "inner-ext");
    mkdirSync(inner, { recursive: true });
    writeFileSync(join(inner, "index.ts"), "export default () => {};");
    // Only the path-derived name — never "consumer".
    expect(extensionCanonicalNames(join(inner, "index.ts"))).toEqual(["inner-ext"]);
  });
});

describe("parseExtensionsSpec", () => {
  it("classifies bare entries as names", () => {
    const spec = parseExtensionsSpec(["mcp", "logger"], "/work");
    expect(spec.names).toEqual(new Set(["mcp", "logger"]));
    expect(spec.paths).toEqual([]);
    expect(spec.wildcard).toBe(false);
  });
  it("treats '*' as the wildcard", () => {
    const spec = parseExtensionsSpec(["*"], "/work");
    expect(spec.wildcard).toBe(true);
    expect(spec.names.size).toBe(0);
    expect(spec.paths).toEqual([]);
  });
  it("resolves a relative path against cwd and adds its canonical name", () => {
    const spec = parseExtensionsSpec(["./rel/foo.ts"], "/work");
    expect(spec.paths).toEqual(["/work/rel/foo.ts"]);
    expect(spec.names).toEqual(new Set(["foo"]));
  });
  it("keeps an absolute path as-is", () => {
    const spec = parseExtensionsSpec(["/abs/bar.ts"], "/work");
    expect(spec.paths).toEqual(["/abs/bar.ts"]);
    expect(spec.names).toEqual(new Set(["bar"]));
  });
  it("expands a leading ~ to the home directory", () => {
    const spec = parseExtensionsSpec(["~/ext/baz.ts"], "/work");
    expect(spec.paths[0]).toBe(`${homedir()}/ext/baz.ts`);
    expect(spec.names).toEqual(new Set(["baz"]));
  });
  it("composes wildcard, names, and paths", () => {
    const spec = parseExtensionsSpec(["*", "mcp", "/abs/foo.ts"], "/work");
    expect(spec.wildcard).toBe(true);
    expect(spec.names).toEqual(new Set(["mcp", "foo"]));
    expect(spec.paths).toEqual(["/abs/foo.ts"]);
  });
  it("lowercases bare-name entries — extension names match case-insensitively", () => {
    const spec = parseExtensionsSpec(["Mcp", "LOGGER"], "/work");
    expect(spec.names).toEqual(new Set(["mcp", "logger"]));
  });
  it("ignores empty entries (defensive — upstream parsers already strip them)", () => {
    const spec = parseExtensionsSpec(["", "mcp", ""], "/work");
    expect(spec.names).toEqual(new Set(["mcp"]));
    expect(spec.wildcard).toBe(false);
  });
});

describe("agent-runner extension allowlist", () => {
  function setupArrayAgent(extensions: string[]) {
    vi.mocked(getConfig).mockReturnValueOnce(makeConfig({ extensions }));
    vi.mocked(getAgentConfig).mockReturnValueOnce(makeAgentConfig({ extensions }));
    vi.mocked(getToolNamesForType).mockReturnValueOnce(BUILTINS_7);
  }

  it("['*'] short-circuits — no extensionsOverride, behaves like extensions: true", async () => {
    setupArrayAgent(["*"]);
    withExtensions({ "/ext/a.ts": ["tool_a"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    const opts = lastLoaderOpts();
    expect(opts.extensionsOverride).toBeUndefined();
    expect(opts.additionalExtensionPaths).toBeUndefined();
    expect(lastToolsPassed()).toContain("tool_a");
  });

  it("['mcp'] keeps only the mcp-named extension, drops others", async () => {
    setupArrayAgent(["mcp"]);
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
    // agent must still be able to allowlist it by the package name.
    const dir = mkdtempSync(join(tmpdir(), "subagents-match-"));
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "@tintinweb/pi-subagents", pi: { extensions: ["./src/index.ts"] } }),
      );
      mkdirSync(join(dir, "src"));
      writeFileSync(join(dir, "src", "index.ts"), "export default () => {};");
      const entry = join(dir, "src", "index.ts");

      setupArrayAgent(["pi-subagents"]);
      withExtensions({ [entry]: ["pkg_tool"] });
      const { session } = createSession("OK");
      createAgentSession.mockResolvedValue({ session });

      await runAgent(ctx, "Explore", "go", { pi });

      // Before the fix keepNames={pi-subagents} but the extension only answered
      // to "src", so it was filtered out and pkg_tool never reached the allowlist.
      expect(lastToolsPassed()).toContain("pkg_tool");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an absolute path is added to additionalExtensionPaths and its extension survives", async () => {
    setupArrayAgent(["/abs/foo.ts"]);
    // Pre-register the path so the mock loader treats it as a successful load.
    withExtensions({ "/abs/foo.ts": ["foo_tool"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    expect(lastLoaderOpts().additionalExtensionPaths).toEqual(["/abs/foo.ts"]);
    expect(lastToolsPassed()).toContain("foo_tool");
  });

  it("['*', path] keeps all defaults plus the extra path", async () => {
    setupArrayAgent(["*", "/abs/foo.ts"]);
    withExtensions({
      "/ext/default.ts": ["default_tool"],
      "/abs/foo.ts": ["foo_tool"],
    });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    const tools = lastToolsPassed();
    expect(tools).toContain("default_tool");
    expect(tools).toContain("foo_tool");
  });

  it("['mcp', path] keeps exactly those two, drops other defaults (no wildcard)", async () => {
    // Changelog: `["mcp", "/abs/foo.ts"]` is *just* those two. Distinct from
    // `['*', path]` (all defaults + path) and `['mcp']` (name only).
    setupArrayAgent(["mcp", "/abs/foo.ts"]);
    withExtensions({
      "/ext/mcp.ts": ["mcp_tool"],
      "/abs/foo.ts": ["foo_tool"],
      "/ext/other.ts": ["other_tool"],
    });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    const opts = lastLoaderOpts();
    expect(opts.additionalExtensionPaths).toEqual(["/abs/foo.ts"]);
    // No "*" → the loader override is in force (narrowing, not load-all).
    expect(opts.extensionsOverride).toBeDefined();
    const tools = lastToolsPassed();
    expect(tools).toContain("mcp_tool");
    expect(tools).toContain("foo_tool");
    expect(tools).not.toContain("other_tool");
  });

  it("extension_tools filters tools from an allowlisted extension", async () => {
    vi.mocked(getConfig).mockReturnValueOnce(makeConfig({ extensions: ["mcp"] }));
    vi.mocked(getAgentConfig).mockReturnValueOnce(
      makeAgentConfig({ extensions: ["mcp"], extensionToolNames: ["mcp_call"] }),
    );
    vi.mocked(getToolNamesForType).mockReturnValueOnce(BUILTINS_7);
    withExtensions({ "/ext/mcp.ts": ["mcp", "mcp_call"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    const tools = lastToolsPassed();
    expect(tools).not.toContain("mcp");
    expect(tools).toContain("mcp_call");
  });

  it("warns but proceeds when a bare name matches no loaded extension", async () => {
    setupArrayAgent(["mcp", "typo"]);
    withExtensions({ "/ext/mcp.ts": ["mcp_tool"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });
    const onToolActivity = vi.fn();

    const result = await runAgent(ctx, "Explore", "go", { pi, onToolActivity });

    expect(result.responseText).toBe("OK");
    expect(onToolActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: expect.stringContaining('extension-error:extension "typo"'),
      }),
    );
  });

  it("warns but proceeds when a path entry fails to load", async () => {
    setupArrayAgent(["/abs/missing.ts"]);
    // Not pre-registered → the mock loader records a load error; the path's
    // canonical name ("missing") is what the unmatched-name check reports.
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });
    const onToolActivity = vi.fn();

    const result = await runAgent(ctx, "Explore", "go", { pi, onToolActivity });

    expect(result.responseText).toBe("OK");
    expect(onToolActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: expect.stringContaining('extension-error:extension "missing"'),
      }),
    );
  });

  it("matches `extensions: [Mcp]` against `mcp.ts` (case-insensitive)", async () => {
    setupArrayAgent(["Mcp"]);
    withExtensions({ "/ext/mcp.ts": ["mcp_tool"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });
    const onToolActivity = vi.fn();

    await runAgent(ctx, "Explore", "go", { pi, onToolActivity });

    // No extension-error warning — the name resolved.
    const errorCalls = onToolActivity.mock.calls.filter((c) =>
      typeof c[0]?.toolName === "string" && c[0].toolName.startsWith("extension-error:"),
    );
    expect(errorCalls).toEqual([]);
    expect(lastToolsPassed()).toContain("mcp_tool");
  });
});

// ─── exclude_extensions: denylist (#94) ──────────────────────────────────
describe("agent-runner exclude_extensions", () => {
  function setupAgent(overrides: Record<string, unknown>) {
    vi.mocked(getConfig).mockReturnValueOnce(makeConfig(overrides));
    vi.mocked(getAgentConfig).mockReturnValueOnce(makeAgentConfig(overrides));
    vi.mocked(getToolNamesForType).mockReturnValueOnce(BUILTINS_7);
  }
  function extensionErrors(onToolActivity: ReturnType<typeof vi.fn>): string[] {
    return onToolActivity.mock.calls
      .map((c) => c[0]?.toolName)
      .filter((n): n is string => typeof n === "string" && n.startsWith("extension-error:"));
  }

  it("extensions: true + exclude — override installed, excluded tools dropped, others kept", async () => {
    setupAgent({ extensions: true, excludeExtensions: ["notify"] });
    withExtensions({
      "/ext/notify.ts": ["notify_send"],
      "/ext/mcp.ts": ["mcp_tool"],
    });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });
    const onToolActivity = vi.fn();

    await runAgent(ctx, "Explore", "go", { pi, onToolActivity });

    expect(lastLoaderOpts().extensionsOverride).toBeDefined();
    const tools = lastToolsPassed();
    expect(tools).not.toContain("notify_send");
    expect(tools).toContain("mcp_tool");
    expect(extensionErrors(onToolActivity)).toEqual([]);
  });

  it("['*'] + exclude — wildcard no longer short-circuits, exclusion applies", async () => {
    setupAgent({ extensions: ["*"], excludeExtensions: ["notify"] });
    withExtensions({
      "/ext/notify.ts": ["notify_send"],
      "/ext/mcp.ts": ["mcp_tool"],
    });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    expect(lastLoaderOpts().extensionsOverride).toBeDefined();
    const tools = lastToolsPassed();
    expect(tools).not.toContain("notify_send");
    expect(tools).toContain("mcp_tool");
  });

  it("allowlist + exclude of a listed name — subtracted, 'in both' warning fires", async () => {
    setupAgent({ extensions: ["mcp", "other"], excludeExtensions: ["other"] });
    withExtensions({
      "/ext/mcp.ts": ["mcp_tool"],
      "/ext/other.ts": ["other_tool"],
    });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });
    const onToolActivity = vi.fn();

    await runAgent(ctx, "Explore", "go", { pi, onToolActivity });

    const tools = lastToolsPassed();
    expect(tools).toContain("mcp_tool");
    expect(tools).not.toContain("other_tool");
    expect(extensionErrors(onToolActivity)).toEqual([
      expect.stringContaining('in both extensions: and exclude_extensions:'),
    ]);
  });

  it("exclude typo — warning fires, all extensions still load", async () => {
    setupAgent({ extensions: true, excludeExtensions: ["nope"] });
    withExtensions({ "/ext/mcp.ts": ["mcp_tool"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });
    const onToolActivity = vi.fn();

    await runAgent(ctx, "Explore", "go", { pi, onToolActivity });

    expect(lastToolsPassed()).toContain("mcp_tool");
    expect(extensionErrors(onToolActivity)).toEqual([
      expect.stringContaining('exclude_extensions: "nope"'),
    ]);
  });

  it("extensions: false + exclude — orphan warning, no override", async () => {
    setupAgent({ extensions: false, excludeExtensions: ["notify"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });
    const onToolActivity = vi.fn();

    await runAgent(ctx, "Explore", "go", { pi, onToolActivity });

    expect(lastLoaderOpts().extensionsOverride).toBeUndefined();
    expect(extensionErrors(onToolActivity)).toEqual([
      expect.stringContaining("exclude_extensions has no effect"),
    ]);
  });

  it("isolated: true + exclude — excludes nulled, no warnings", async () => {
    setupAgent({ extensions: true, excludeExtensions: ["notify"] });
    withExtensions({ "/ext/notify.ts": ["notify_send"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });
    const onToolActivity = vi.fn();

    await runAgent(ctx, "Explore", "go", { pi, onToolActivity, isolated: true });

    expect(lastToolsPassed()).not.toContain("notify_send");
    expect(extensionErrors(onToolActivity)).toEqual([]);
  });

  it("exclude matches case-insensitively", async () => {
    setupAgent({ extensions: true, excludeExtensions: ["MCP"] });
    withExtensions({ "/ext/mcp.ts": ["mcp_tool"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });
    const onToolActivity = vi.fn();

    await runAgent(ctx, "Explore", "go", { pi, onToolActivity });

    expect(lastToolsPassed()).not.toContain("mcp_tool");
    expect(extensionErrors(onToolActivity)).toEqual([]);
  });
});

// ─── unknown built-in tool names in `tools:` (#75) ──────────────────────
describe("agent-runner unknown built-in tools", () => {
  it("emits a tools-error warning for each plain entry not in BUILTIN_TOOL_NAMES", async () => {
    vi.mocked(getConfig).mockReturnValueOnce(makeConfig({ extensions: false }));
    vi.mocked(getAgentConfig).mockReturnValueOnce(
      makeAgentConfig({ extensions: false, builtinToolNames: ["read", "reed", "grep", "edt"] }),
    );
    vi.mocked(getToolNamesForType).mockReturnValueOnce(["read", "reed", "grep", "edt"]);
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });
    const onToolActivity = vi.fn();

    const result = await runAgent(ctx, "Explore", "go", { pi, onToolActivity });

    expect(result.responseText).toBe("OK");
    const errorMessages = onToolActivity.mock.calls
      .map((c) => c[0]?.toolName)
      .filter((n): n is string => typeof n === "string" && n.startsWith("tools-error:"));
    expect(errorMessages).toHaveLength(2);
    expect(errorMessages.some((m) => m.includes('"reed"'))).toBe(true);
    expect(errorMessages.some((m) => m.includes('"edt"'))).toBe(true);
  });

  it("stays quiet when all plain tool names are valid built-ins", async () => {
    vi.mocked(getConfig).mockReturnValueOnce(makeConfig({ extensions: false }));
    vi.mocked(getAgentConfig).mockReturnValueOnce(
      makeAgentConfig({ extensions: false, builtinToolNames: ["read", "grep"] }),
    );
    vi.mocked(getToolNamesForType).mockReturnValueOnce(["read", "grep"]);
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });
    const onToolActivity = vi.fn();

    await runAgent(ctx, "Explore", "go", { pi, onToolActivity });

    const errorMessages = onToolActivity.mock.calls
      .map((c) => c[0]?.toolName)
      .filter((n): n is string => typeof n === "string" && n.startsWith("tools-error:"));
    expect(errorMessages).toEqual([]);
  });
});

// ─── extension_tools tool-name filter ───────────────────────────────────
// `extension_tools:` scopes which EXTENSION tools surface to the LLM by tool
// NAME — exact names or trailing-`*` prefix wildcards. undefined = all extension
// tools; [] = none. It composes with the extensions: loader filter and is the
// direct successor to the old `ext:` extension-name selectors.
describe("agent-runner extension_tools tool filter", () => {
  function setupExtAgent(o: {
    extensions: boolean | string[];
    builtinToolNames: string[];
    extensionToolNames?: string[];
  }) {
    vi.mocked(getConfig).mockReturnValueOnce(makeConfig({ extensions: o.extensions }));
    vi.mocked(getAgentConfig).mockReturnValueOnce(
      makeAgentConfig({
        extensions: o.extensions,
        extensionToolNames: o.extensionToolNames,
      }),
    );
    vi.mocked(getToolNamesForType).mockReturnValueOnce(o.builtinToolNames);
  }

  it("an exact allowlist surfaces only the named tool, mutes the rest", async () => {
    setupExtAgent({ extensions: true, builtinToolNames: [], extensionToolNames: ["foo_tool"] });
    withExtensions({ "/ext/foo.ts": ["foo_tool", "foo_other"], "/ext/other.ts": ["other_tool"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    const tools = lastToolsPassed();
    expect(tools).toContain("foo_tool");
    expect(tools).not.toContain("foo_other");  // sibling not named
    expect(tools).not.toContain("other_tool"); // other extension not named
    expect(tools).not.toContain("read");       // no built-ins requested
    // both extensions still load — no loader override needed under extensions: true
    expect(lastLoaderOpts().extensionsOverride).toBeUndefined();
  });

  it("undefined extension_tools surfaces all loaded extension tools", async () => {
    setupExtAgent({ extensions: true, builtinToolNames: BUILTINS_7, extensionToolNames: undefined });
    withExtensions({ "/ext/foo.ts": ["foo_tool"], "/ext/other.ts": ["other_tool"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    const tools = lastToolsPassed();
    for (const b of BUILTINS_7) expect(tools).toContain(b);
    expect(tools).toContain("foo_tool");
    expect(tools).toContain("other_tool");
  });

  it("an empty extension_tools list surfaces no extension tools", async () => {
    setupExtAgent({ extensions: true, builtinToolNames: ["read"], extensionToolNames: [] });
    withExtensions({ "/ext/foo.ts": ["foo_tool"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    const tools = lastToolsPassed();
    expect(tools).toContain("read");
    expect(tools).not.toContain("foo_tool");
  });

  it("a trailing-* wildcard matches by prefix", async () => {
    setupExtAgent({ extensions: true, builtinToolNames: ["read"], extensionToolNames: ["foo_*"] });
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
    setupExtAgent({ extensions: true, builtinToolNames: ["read"], extensionToolNames: ["Bar"] });
    withExtensions({ "/ext/foo.ts": ["Bar", "bar"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi });

    const tools = lastToolsPassed();
    expect(tools).toContain("Bar");
    expect(tools).not.toContain("bar"); // case-sensitive: not the selected tool
  });

  it("isolated: true ignores extension_tools — no extension tools", async () => {
    setupExtAgent({ extensions: true, builtinToolNames: ["read"], extensionToolNames: ["foo_tool"] });
    withExtensions({ "/ext/foo.ts": ["foo_tool"] });
    const { session } = createSession("OK");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "go", { pi, isolated: true });

    const tools = lastToolsPassed();
    expect(tools).toContain("read");
    expect(tools).not.toContain("foo_tool");
    expect(lastLoaderOpts().noExtensions).toBe(true);
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
      builtinToolNames: ["read"],
      extensions: false,
      discoverSkills: false,
      preloadSkills: ["a"],
      promptMode: "replace",
    } as any);
    vi.mocked(getAgentConfig).mockReturnValue({
      name: "Worker",
      description: "Worker",
      builtinToolNames: ["read"],
      extensions: false,
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
