import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSession, AgentSessionEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const {
  createAgentSession,
  defaultResourceLoaderCtor,
  getAgentConfig,
  getAgentDir,
  getConfig,
  sessionManagerCreate,
  settingsManagerCreate,
} = vi.hoisted(() => ({
  createAgentSession: vi.fn(),
  defaultResourceLoaderCtor: vi.fn(),
  getAgentConfig: vi.fn(),
  getAgentDir: vi.fn(() => "/mock/agent-dir"),
  getConfig: vi.fn(),
  sessionManagerCreate: vi.fn(() => ({ kind: "created-session-manager" })),
  settingsManagerCreate: vi.fn(() => ({
    kind: "settings-manager",
    getDefaultThinkingLevel: () => undefined,
  })),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  VERSION: "test-version",
  createAgentSession,
  DefaultResourceLoader: class {
    constructor(options: any) {
      defaultResourceLoaderCtor(options);
    }

    async reload() {}

    getExtensions() {
      return { extensions: [], errors: [], runtime: {} };
    }
  },
  getAgentDir,
  SessionManager: { create: sessionManagerCreate },
  SettingsManager: { create: settingsManagerCreate },
}));

vi.mock("../src/agent-types.js", () => ({
  BUILTIN_TOOL_NAMES: ["read", "bash", "edit", "write", "grep", "find", "ls"],
  getAgentConfig,
  getConfig,
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
  bindAndApplyAgentSessionPolicy,
  createUnboundAgentSessionRuntime,
  prepareAgentRestoreRuntime,
  resumeAgent,
  runAgent,
} from "../src/agent-runner.js";
import type { ResumeTargetV1 } from "../src/types.js";

type MockExtensionContext = Pick<ExtensionContext, "cwd" | "model" | "modelRegistry" | "getSystemPrompt" | "sessionManager">;

function createSession(
  finalText: string,
  activeToolNames = ["read"],
  terminal: { stopReason?: string; errorMessage?: string; content?: unknown[] } = {},
) {
  const listeners: Array<(event: AgentSessionEvent) => void> = [];
  const session = {
    messages: [] as AgentSession["messages"],
    subscribe: vi.fn((listener: (event: AgentSessionEvent) => void) => {
      listeners.push(listener);
      return () => {};
    }),
    prompt: vi.fn(async () => {
      session.messages.push({
        role: "assistant",
        content: terminal.content ?? [{ type: "text", text: finalText }],
        stopReason: terminal.stopReason ?? "stop",
        errorMessage: terminal.errorMessage,
      } as AgentSession["messages"][number]);
    }),
    abort: vi.fn(),
    steer: vi.fn(),
    getActiveToolNames: vi.fn(() => activeToolNames),
    setActiveToolsByName: vi.fn(),
    bindExtensions: vi.fn(async () => {}),
    dispose: vi.fn(),
  };
  return { session, listeners };
}

function defaultConfig(overrides: Record<string, unknown> = {}) {
  return {
    displayName: "Explore",
    description: "Explore",
    builtinToolNames: ["read"],
    extensions: false,
    discoverSkills: false,
    preloadSkills: [],
    promptMode: "replace",
    ...overrides,
  };
}

function defaultAgentConfig(overrides: Record<string, unknown> = {}) {
  return {
    name: "Explore",
    description: "Explore",
    builtinToolNames: ["read"],
    extensions: false,
    discoverSkills: false,
    preloadSkills: [],
    systemPrompt: "You are Explore.",
    promptMode: "replace",
    inheritContext: false,
    runInBackground: false,
    isolated: false,
    ...overrides,
  };
}

const ctx = {
  cwd: "/tmp",
  model: undefined,
  modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
  getSystemPrompt: vi.fn(() => "parent prompt"),
  sessionManager: { getBranch: vi.fn(() => []) },
} as unknown as MockExtensionContext as ExtensionContext;

const pi = {} as Partial<ExtensionAPI> as ExtensionAPI;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  createAgentSession.mockReset();
  defaultResourceLoaderCtor.mockClear();
  getAgentConfig.mockReset();
  getAgentConfig.mockReturnValue(defaultAgentConfig());
  getConfig.mockReset();
  getConfig.mockReturnValue(defaultConfig());
  getAgentDir.mockClear();
  sessionManagerCreate.mockClear();
  settingsManagerCreate.mockClear();
});

function restoreTarget(): ResumeTargetV1 {
  return {
    version: 1, id: "agent-1", generation: 1, revision: 1, parentSessionId: "parent",
    sessionFile: "/tmp/child.jsonl", sessionDir: "/tmp", childSessionId: "child-1",
    entryCount: 1, activeLeafId: "leaf", sessionSha256: "0".repeat(64),
    type: "Explore", description: "Explore", cwd: "/tmp", isBackground: true,
    createdAt: 1, updatedAt: 2,
    runtime: {
      piVersion: "old", model: { provider: "old", id: "old", api: "old" }, thinkingLevel: "off",
      promptMode: "replace", isolated: false, inheritContext: false,
      systemPromptHash: "0".repeat(64), resourcePolicyHash: "0".repeat(64),
      agentConfigHash: "0".repeat(64), extensionIdentities: [], activeToolNames: [],
    },
    state: { status: "completed", resultConsumed: false, notified: false, toolUses: 0,
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 }, lifetimeCost: 0, compactionCount: 0 },
  };
}

describe("agent-runner final output capture", () => {
  it("returns the final assistant text even when no text_delta events were streamed", async () => {
    const { session } = createSession("LOCKED");
    createAgentSession.mockResolvedValue({ session });

    const result = await runAgent(ctx, "Explore", "Say LOCKED", { pi });

    expect(result.responseText).toBe("LOCKED");
  });

  it("returns a failure for an empty provider-error assistant message", async () => {
    const { session } = createSession("", ["read"], {
      stopReason: "error",
      errorMessage: "provider unavailable",
    });
    createAgentSession.mockResolvedValue({ session });

    const result = await runAgent(ctx, "Explore", "Fail", { pi });

    expect(result.responseText).toBe("");
    expect(result.failure).toContain("provider unavailable");
  });

  it("returns a failure while preserving provider-error partial text", async () => {
    const { session } = createSession("PARTIAL ANSWER", ["read"], {
      stopReason: "error",
      errorMessage: "stream disconnected",
    });
    createAgentSession.mockResolvedValue({ session });

    const result = await runAgent(ctx, "Explore", "Fail after partial", { pi });

    expect(result.responseText).toBe("PARTIAL ANSWER");
    expect(result.failure).toContain("stream disconnected");
  });

  it("returns a failure for an empty length-limited assistant message", async () => {
    const { session } = createSession("", ["read"], { stopReason: "length" });
    createAgentSession.mockResolvedValue({ session });

    const result = await runAgent(ctx, "Explore", "Hit limit", { pi });

    expect(result.responseText).toBe("");
    expect(result.failure).toContain("length");
  });

  it("does not classify an aborted assistant stop alone as a provider failure", async () => {
    const { session } = createSession("PARTIAL ABORTED TEXT", ["read"], {
      stopReason: "aborted",
      errorMessage: "request aborted",
    });
    createAgentSession.mockResolvedValue({ session });

    const result = await runAgent(ctx, "Explore", "Abort", { pi });

    expect(result.responseText).toBe("PARTIAL ABORTED TEXT");
    expect(result.failure).toBeUndefined();
  });

  it("keeps a length-limited assistant message with text successful", async () => {
    const { session } = createSession("USABLE ANSWER", ["read"], { stopReason: "length" });
    createAgentSession.mockResolvedValue({ session });

    const result = await runAgent(ctx, "Explore", "Hit limit", { pi });

    expect(result.responseText).toBe("USABLE ANSWER");
    expect(result.failure).toBeUndefined();
  });

  it.each([
    ["clean empty", { stopReason: "stop" }],
    ["tool-only", { stopReason: "toolUse", content: [{ type: "toolCall", name: "read" }] }],
  ])("keeps %s assistant completion behavior successful", async (_name, terminal) => {
    const { session } = createSession("", ["read"], terminal);
    createAgentSession.mockResolvedValue({ session });

    const result = await runAgent(ctx, "Explore", "Complete cleanly", { pi });

    expect(result.responseText).toBe("");
    expect(result.failure).toBeUndefined();
  });

  it("bounds fallback text to messages created by the current invocation", async () => {
    const { session } = createSession("", ["read"], { stopReason: "stop" });
    session.messages.push({
      role: "assistant",
      content: [{ type: "text", text: "STALE PRIOR ANSWER" }],
      stopReason: "stop",
    } as AgentSession["messages"][number]);
    createAgentSession.mockResolvedValue({ session });

    const result = await runAgent(ctx, "Explore", "Fresh invocation", { pi });

    expect(result.responseText).toBe("");
    expect(result.failure).toBeUndefined();
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

  it("awaits the pre-prompt gate after binding and before prompting", async () => {
    const gate = deferred<void>();
    const { session } = createSession("GATED");
    createAgentSession.mockResolvedValue({ session });

    const run = runAgent(ctx, "Explore", "Say GATED", {
      pi,
      onBeforePrompt: () => gate.promise,
    });

    await vi.waitFor(() => expect(session.bindExtensions).toHaveBeenCalledOnce());
    expect(session.prompt).not.toHaveBeenCalled();

    gate.resolve();
    const result = await run;

    expect(result.responseText).toBe("GATED");
    const bindOrder = session.bindExtensions.mock.invocationCallOrder[0];
    const promptOrder = session.prompt.mock.invocationCallOrder[0];
    expect(bindOrder).toBeLessThan(promptOrder);
  });

  it("disposes the bound child session when the pre-prompt gate rejects", async () => {
    const { session } = createSession("NEVER");
    let providerCount = 1;
    session.dispose.mockImplementation(() => { providerCount = 0; });
    createAgentSession.mockResolvedValue({ session });
    const gateError = new Error("gate rejected");

    await expect(runAgent(ctx, "Explore", "Say NEVER", {
      pi,
      onBeforePrompt: async () => { throw gateError; },
    })).rejects.toBe(gateError);

    expect(session.bindExtensions).toHaveBeenCalledOnce();
    expect(session.prompt).not.toHaveBeenCalled();
    expect(session.dispose).toHaveBeenCalledOnce();
    expect(providerCount).toBe(0);
  });

  it("uses a custom session directory when provided", async () => {
    const { session } = createSession("CUSTOM_DIR");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "Say CUSTOM_DIR", { pi, sessionDir: "/tmp/subagent-sessions/parent-1" });

    expect(sessionManagerCreate).toHaveBeenCalledWith("/tmp", "/tmp/subagent-sessions/parent-1");
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

  it("preloads skills independently of the discoverable skill catalog (S3 combo)", async () => {
    const { preloadSkills } = await import("../src/skill-loader.js");
    const { buildAgentPrompt } = await import("../src/prompts.js");
    vi.mocked(preloadSkills).mockReturnValueOnce([
      { name: "impeccable", content: "impeccable body" },
    ]);
    getConfig.mockReturnValue(defaultConfig({ discoverSkills: true, preloadSkills: ["impeccable"] }));
    const { session } = createSession("COMBO");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "Say COMBO", { pi });

    // noSkills is driven ONLY by !discoverSkills, so the catalog stays available...
    expect(defaultResourceLoaderCtor).toHaveBeenCalledWith(
      expect.objectContaining({ noSkills: false }),
    );
    // ...and the preloaded skill is still injected into the prompt (independent of the catalog).
    expect(buildAgentPrompt).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        skillBlocks: [{ name: "impeccable", content: "impeccable body" }],
      }),
    );
  });


  describe("per-call skills injection via options.skills", () => {
    it("P1 (fresh spawn injects): options.skills injected when config has empty preload", async () => {
      const { preloadSkills } = await import("../src/skill-loader.js");
      const { buildAgentPrompt } = await import("../src/prompts.js");
      vi.mocked(preloadSkills).mockClear();
      vi.mocked(buildAgentPrompt).mockClear();
      vi.mocked(preloadSkills).mockReturnValueOnce([
        { name: "x", content: "x body" },
      ]);
      getConfig.mockReturnValue(defaultConfig({ discoverSkills: false, preloadSkills: [] }));
      const { session } = createSession("P1");
      createAgentSession.mockResolvedValue({ session });

      await runAgent(ctx, "Explore", "P1", { pi, skills: ["x"] });

      // noSkills stays true — discoverSkills:false is unchanged by skills injection
      expect(defaultResourceLoaderCtor).toHaveBeenCalledWith(
        expect.objectContaining({ noSkills: true }),
      );
      // preloadSkills called with ["x"]
      expect(vi.mocked(preloadSkills)).toHaveBeenCalledWith(["x"], "/tmp");
      // skillBlocks injected into prompt extras
      expect(vi.mocked(buildAgentPrompt)).toHaveBeenCalledWith(
        expect.anything(), expect.anything(), expect.anything(), expect.anything(),
        expect.objectContaining({ skillBlocks: [{ name: "x", content: "x body" }] }),
      );
    });

    it("P2 (union + order + dedupe): frontmatter-first, options.skills appended, duplicates removed", async () => {
      const { preloadSkills } = await import("../src/skill-loader.js");
      vi.mocked(preloadSkills).mockClear();
      getConfig.mockReturnValue(defaultConfig({ discoverSkills: false, preloadSkills: ["y"] }));
      const { session } = createSession("P2");
      createAgentSession.mockResolvedValue({ session });

      await runAgent(ctx, "Explore", "P2", { pi, skills: ["x", "y"] });

      // frontmatter "y" first, then "x" from options.skills; "y" deduped (appears once)
      expect(vi.mocked(preloadSkills)).toHaveBeenCalledWith(["y", "x"], "/tmp");
    });

    it("P3 (isolated ignores): options.skills ignored when isolated: true", async () => {
      const { preloadSkills } = await import("../src/skill-loader.js");
      vi.mocked(preloadSkills).mockClear();
      getConfig.mockReturnValue(defaultConfig({ discoverSkills: false, preloadSkills: [] }));
      const { session } = createSession("P3");
      createAgentSession.mockResolvedValue({ session });

      await runAgent(ctx, "Explore", "P3", { pi, isolated: true, skills: ["x"] });

      expect(vi.mocked(preloadSkills)).not.toHaveBeenCalled();
    });

    it("P4 (no param = unchanged baseline): options.skills undefined uses only config.preloadSkills", async () => {
      const { preloadSkills } = await import("../src/skill-loader.js");
      vi.mocked(preloadSkills).mockClear();
      getConfig.mockReturnValue(defaultConfig({ discoverSkills: false, preloadSkills: ["y"] }));
      const { session } = createSession("P4");
      createAgentSession.mockResolvedValue({ session });

      await runAgent(ctx, "Explore", "P4", { pi });

      expect(vi.mocked(preloadSkills)).toHaveBeenCalledWith(["y"], "/tmp");
    });
  });

  it("keeps selected built-ins and exact extension tools without pre-stripping via session tools", async () => {
    getConfig.mockReturnValue(defaultConfig({ builtinToolNames: ["read"], extensions: true }));
    getAgentConfig.mockReturnValue(defaultAgentConfig({
      builtinToolNames: ["read"],
      extensions: true,
      extensionToolNames: ["readonly_bash"],
    }));
    const { session } = createSession("TOOLS", ["read", "bash", "readonly_bash", "other_ext"]);
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "Say TOOLS", { pi });

    expect(createAgentSession.mock.calls[0][0]).not.toHaveProperty("tools");
    expect(session.setActiveToolsByName).toHaveBeenCalledWith(["read", "readonly_bash"]);
    const bindOrder = session.bindExtensions.mock.invocationCallOrder[0];
    const policyOrder = session.setActiveToolsByName.mock.invocationCallOrder[0];
    expect(bindOrder).toBeLessThan(policyOrder);
  });

  it("removes extension tools when extensions are false", async () => {
    getConfig.mockReturnValue(defaultConfig({ builtinToolNames: ["read"], extensions: false }));
    getAgentConfig.mockReturnValue(defaultAgentConfig({
      builtinToolNames: ["read"],
      extensions: false,
      extensionToolNames: ["readonly_bash"],
    }));
    const { session } = createSession("NOEXT", ["read", "readonly_bash"]);
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "Say NOEXT", { pi });

    expect(session.setActiveToolsByName).toHaveBeenCalledWith(["read"]);
    expect(defaultResourceLoaderCtor).toHaveBeenCalledWith(expect.objectContaining({ noExtensions: true }));
  });

  it("removes extension tools when isolated is true", async () => {
    getConfig.mockReturnValue(defaultConfig({ builtinToolNames: ["read"], extensions: true }));
    getAgentConfig.mockReturnValue(defaultAgentConfig({
      builtinToolNames: ["read"],
      extensions: true,
      extensionToolNames: ["readonly_bash"],
    }));
    const { session } = createSession("ISOLATED", ["read", "readonly_bash"]);
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "Say ISOLATED", { pi, isolated: true });

    expect(session.setActiveToolsByName).toHaveBeenCalledWith(["read"]);
    expect(defaultResourceLoaderCtor).toHaveBeenCalledWith(expect.objectContaining({ noExtensions: true }));
  });

  it("does not substring-match extension tool names", async () => {
    getConfig.mockReturnValue(defaultConfig({ builtinToolNames: ["bash"], extensions: true }));
    getAgentConfig.mockReturnValue(defaultAgentConfig({
      builtinToolNames: ["bash"],
      extensions: true,
      extensionToolNames: ["bash"],
    }));
    const { session } = createSession("EXACT", ["bash", "readonly_bash"]);
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "Say EXACT", { pi });

    expect(session.setActiveToolsByName).toHaveBeenCalledWith(["bash"]);
  });

  it("does not apply obsolete denylist fields at runtime", async () => {
    getConfig.mockReturnValue(defaultConfig({ builtinToolNames: ["read", "bash"], extensions: false }));
    getAgentConfig.mockReturnValue(defaultAgentConfig({
      builtinToolNames: ["read", "bash"],
      disallowedTools: ["bash"],
      extensions: false,
    }));
    const { session } = createSession("DENYLIST", ["read", "bash"]);
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "Say DENYLIST", { pi });

    expect(session.setActiveToolsByName).toHaveBeenCalledWith(["read", "bash"]);
  });
  it("creates an unbound session, then binds extensions and applies exact tool policy", async () => {
    const { session } = createSession("PHASED", ["read", "bash", "readonly_bash"]);
    createAgentSession.mockResolvedValue({ session });
    const options = {
      cwd: "/tmp",
      agentDir: "/mock/agent-dir",
      sessionManager: { kind: "opened-session-manager" },
      settingsManager: { kind: "settings-manager" },
      modelRegistry: ctx.modelRegistry,
      model: undefined,
      resourceLoader: {},
      builtinToolNames: ["read"],
      extensions: true as const,
      extensionToolNames: ["readonly_bash"],
    };

    const unbound = await createUnboundAgentSessionRuntime(options as never);

    expect(unbound).toBe(session);
    expect(session.bindExtensions).not.toHaveBeenCalled();
    expect(session.setActiveToolsByName).not.toHaveBeenCalled();

    await bindAndApplyAgentSessionPolicy(unbound, options as never);

    expect(session.bindExtensions).toHaveBeenCalledOnce();
    expect(session.setActiveToolsByName).toHaveBeenCalledWith(["read", "readonly_bash"]);
  });

  it("prepares exact runtime snapshot and rejects mismatch before session creation", async () => {
    const model = { provider: "provider", id: "model", api: "api" };
    const first = await prepareAgentRestoreRuntime(ctx, "Explore", {
      pi,
      target: restoreTarget(),
      model: model as never,
      thinkingLevel: "medium",
    });

    expect(first.runtime).toMatchObject({
      model,
      thinkingLevel: "medium",
      promptMode: "replace",
      isolated: false,
      inheritContext: false,
      extensionIdentities: [],
      activeToolNames: ["read"],
    });

    const target = { ...restoreTarget(), runtime: first.runtime };
    const mismatched = await prepareAgentRestoreRuntime(ctx, "Explore", {
      pi,
      target,
      model: { ...model, api: "other-api" } as never,
      thinkingLevel: "medium",
    });
    createAgentSession.mockClear();
    await expect(mismatched.restore()).rejects.toEqual(
      expect.objectContaining({ reason: "model_unavailable" }),
    );
    expect(createAgentSession).not.toHaveBeenCalled();
  });

  it("resumeAgent returns fresh appended text as an ok outcome", async () => {
    // createSession starts from an empty history and appends the assistant text on prompt,
    // so "RESUMED" is a legitimate new message from the resumed turn (snapshot-bounded).
    const { session } = createSession("RESUMED");

    const result = await resumeAgent(session as unknown as AgentSession, "Continue");

    expect(result).toEqual({ ok: true, text: "RESUMED" });
  });
});

describe("resumeAgent staleness (issue #10 secondary defect)", () => {
  // Repro of the confirmed stale Agent(resume) defect (archived Hou Tu session
  // 019f6f3e, resume #2 == #3 byte-identical COMPLETED summaries). The agent
  // already completed once (prior summary in history); a resume whose turn
  // yields NO fresh usable output must NOT echo the prior assistant summary as
  // a false-positive success. Today resumeAgent returns it via
  // getLastAssistantText scanning back over history.
  function createResumedSession(priorText: string, mode: "empty-error" | "no-message") {
    const session = {
      messages: [
        { role: "assistant", content: [{ type: "text", text: priorText }], stopReason: "stop" },
      ] as AgentSession["messages"],
      subscribe: vi.fn(() => () => {}),
      prompt: vi.fn(async () => {
        if (mode === "empty-error") {
          // pi-agent-core handleRunFailure swallow: empty-text assistant msg, error stop.
          session.messages.push({
            role: "assistant",
            content: [],
            stopReason: "error",
          } as unknown as AgentSession["messages"][number]);
        }
        // mode "no-message": resumed turn appends nothing at all.
      }),
      abort: vi.fn(),
      steer: vi.fn(),
      getActiveToolNames: vi.fn(() => ["read"]),
      setActiveToolsByName: vi.fn(),
      bindExtensions: vi.fn(async () => {}),
    };
    return session;
  }

  it("Case A: swallowed failed turn (empty-text error msg) must not echo the prior summary", async () => {
    const session = createResumedSession("PRIOR SUMMARY", "empty-error");

    const result = await resumeAgent(session as unknown as AgentSession, "Second verification REJECT, PLAN 3: fix v1 exclusivity");

    expect(result).not.toBe("PRIOR SUMMARY");
  });

  it("Case B: resumed turn that appends no message must not echo the prior summary", async () => {
    const session = createResumedSession("PRIOR SUMMARY", "no-message");

    const result = await resumeAgent(session as unknown as AgentSession, "Second verification REJECT, PLAN 3: fix v1 exclusivity");

    expect(result).not.toBe("PRIOR SUMMARY");
  });
});
