import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSession, AgentSessionEvent, ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const {
  createAgentSession,
  defaultResourceLoaderCtor,
  getAgentConfig,
  getAgentDir,
  getConfig,
  getMemoryToolNames,
  getReadOnlyMemoryToolNames,
  sessionManagerInMemory,
  settingsManagerCreate,
} = vi.hoisted(() => ({
  createAgentSession: vi.fn(),
  defaultResourceLoaderCtor: vi.fn(),
  getAgentConfig: vi.fn(),
  getAgentDir: vi.fn(() => "/mock/agent-dir"),
  getConfig: vi.fn(),
  getMemoryToolNames: vi.fn(() => []),
  getReadOnlyMemoryToolNames: vi.fn(() => []),
  sessionManagerInMemory: vi.fn(() => ({ kind: "memory-session-manager" })),
  settingsManagerCreate: vi.fn(() => ({ kind: "settings-manager" })),
}));

vi.mock("@mariozechner/pi-coding-agent", () => ({
  createAgentSession,
  DefaultResourceLoader: class {
    constructor(options: any) {
      defaultResourceLoaderCtor(options);
    }

    async reload() {}
  },
  getAgentDir,
  SessionManager: { inMemory: sessionManagerInMemory },
  SettingsManager: { create: settingsManagerCreate },
}));

vi.mock("../src/agent-types.js", () => ({
  BUILTIN_TOOL_NAMES: ["read", "bash", "edit", "write", "grep", "find", "ls"],
  getAgentConfig,
  getConfig,
  getMemoryToolNames,
  getReadOnlyMemoryToolNames,
}));

vi.mock("../src/env.js", () => ({
  detectEnv: vi.fn(async () => ({ isGitRepo: false, branch: "", platform: "linux" })),
}));

vi.mock("../src/prompts.js", () => ({
  buildAgentPrompt: vi.fn(() => "system prompt"),
}));

vi.mock("../src/memory.js", () => ({
  buildMemoryBlock: vi.fn(() => ""),
  buildReadOnlyMemoryBlock: vi.fn(() => ""),
}));

vi.mock("../src/skill-loader.js", () => ({
  preloadSkills: vi.fn(() => []),
}));

import { resumeAgent, runAgent } from "../src/agent-runner.js";

type MockExtensionContext = Pick<ExtensionContext, "cwd" | "model" | "modelRegistry" | "getSystemPrompt" | "sessionManager">;

function createSession(finalText: string, activeToolNames = ["read"]) {
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
        content: [{ type: "text", text: finalText }],
      } as AgentSession["messages"][number]);
    }),
    abort: vi.fn(),
    steer: vi.fn(),
    getActiveToolNames: vi.fn(() => activeToolNames),
    setActiveToolsByName: vi.fn(),
    bindExtensions: vi.fn(async () => {}),
  };
  return { session, listeners };
}

function defaultConfig(overrides: Record<string, unknown> = {}) {
  return {
    displayName: "Explore",
    description: "Explore",
    builtinToolNames: ["read"],
    extensions: false,
    skills: false,
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
    skills: false,
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
} as MockExtensionContext as ExtensionContext;

const pi = {} as Partial<ExtensionAPI> as ExtensionAPI;

beforeEach(() => {
  createAgentSession.mockReset();
  defaultResourceLoaderCtor.mockClear();
  getAgentConfig.mockReset();
  getAgentConfig.mockReturnValue(defaultAgentConfig());
  getConfig.mockReset();
  getConfig.mockReturnValue(defaultConfig());
  getAgentDir.mockClear();
  getMemoryToolNames.mockClear();
  getReadOnlyMemoryToolNames.mockClear();
  sessionManagerInMemory.mockClear();
  settingsManagerCreate.mockClear();
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
  it("resumeAgent also falls back to the final assistant message text", async () => {
    const { session } = createSession("RESUMED");

    const result = await resumeAgent(session as unknown as AgentSession, "Continue");

    expect(result).toBe("RESUMED");
  });
});
