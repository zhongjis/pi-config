/**
 * Characterization tests for extension-tool-scoping in agent-runner.ts.
 *
 * installExtensionToolScope now delegates the keep-set to the SHARED
 * computeActiveToolNames engine (extensions/lib/active-tools.ts), filtering
 * extension tools by TOOL NAME (exact or trailing-`*` wildcard) rather than by
 * the old `ext:` extension-NAME selectors. The critical invariant it still owns
 * is the LIVE re-read: it re-queries the session's tool list and re-runs
 * computeActiveToolNames on every turn_end, so a tool that registers AFTER the
 * first narrow still enters the active set — the behavior computeActiveToolNames
 * alone (a static snapshot) cannot replicate.
 *
 * Three scenarios locked:
 *  1. extension_tools wildcard keeps only matching tools in the active set.
 *  2. extension_tools exact name narrows to a single tool.
 *  3. REGRESSION: a tool registered AFTER the first narrow re-enters the active
 *     set when turn_end fires (live re-read), and a non-matching sibling does not.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock @earendil-works/pi-coding-agent — only the pieces agent-runner.ts
// imports as runtime values. Types are erased; we just need the module to load.
// ---------------------------------------------------------------------------
vi.mock("@earendil-works/pi-coding-agent", () => ({
  DefaultResourceLoader: class {
    async reload() {}
    getExtensions() {
      return { extensions: [], errors: [], runtime: {} };
    }
  },
  createAgentSession: vi.fn(),
  getAgentDir: vi.fn(() => "/mock/agent-dir"),
  SessionManager: {
    inMemory: vi.fn(() => ({})),
    create: vi.fn(() => ({})),
  },
  SettingsManager: {
    create: vi.fn(() => ({ getSessionDir: () => undefined })),
  },
}));

// Mock local modules imported by agent-runner.ts so the module loads cleanly.
vi.mock("../src/agent-types.js", () => ({
  BUILTIN_TOOL_NAMES: ["read", "bash", "edit", "write", "grep", "find", "ls"],
  getConfig: vi.fn(),
  getAgentConfig: vi.fn(),
  getToolNamesForType: vi.fn(() => ["read"]),
}));
vi.mock("../src/context.js", () => ({
  buildParentContext: vi.fn(() => undefined),
  extractText: vi.fn(() => ""),
}));
vi.mock("../src/default-agents.js", () => ({ DEFAULT_AGENTS: new Map() }));
vi.mock("../src/env.js", () => ({
  detectEnv: vi.fn(async () => ({ isGitRepo: false, branch: "", platform: "linux" })),
}));
vi.mock("../src/prompts.js", () => ({
  buildAgentPrompt: vi.fn(() => "system prompt"),
}));
vi.mock("../src/skill-loader.js", () => ({ preloadSkills: vi.fn(() => []) }));

// ---------------------------------------------------------------------------
// Import the real function under test — AFTER mocks are declared.
// ---------------------------------------------------------------------------
import { installExtensionToolScope } from "../src/agent-runner.js";

type InstallCtx = Parameters<typeof installExtensionToolScope>[1];

// ---------------------------------------------------------------------------
// Fake AgentSession — stateful enough for installExtensionToolScope:
//   • registry: the LIVE tool list; grows via _addToRegistry()
//   • activeTools: updated by setActiveToolsByName
//   • listeners: subscribed via subscribe(), fired by _fireTurnEnd()
// ---------------------------------------------------------------------------
function makeFakeSession(initialRegistry: string[] = []) {
  const registry: string[] = [...initialRegistry];
  let activeTools: string[] = [...initialRegistry];
  const listeners: Array<(event: { type: string }) => void> = [];

  return {
    getAllTools: () => registry.map((name) => ({ name })),
    getActiveToolNames: () => [...activeTools],
    setActiveToolsByName: (names: string[]) => {
      activeTools = [...names];
    },
    subscribe: (fn: (event: { type: string }) => void) => {
      listeners.push(fn);
      return () => {};
    },
    agent: {
      beforeToolCall: undefined as
        | ((ctx: { toolCall: { name: string } }) => Promise<unknown>)
        | undefined,
    },
    /** Simulate an extension registering a tool after bind. */
    _addToRegistry: (name: string) => {
      registry.push(name);
    },
    /** Simulate pi emitting turn_end (triggers renarrow). */
    _fireTurnEnd: () => {
      for (const l of listeners) l({ type: "turn_end" });
    },
  };
}

function install(session: ReturnType<typeof makeFakeSession>, ctx: Partial<InstallCtx>): void {
  installExtensionToolScope(session as unknown as Parameters<typeof installExtensionToolScope>[0], {
    builtinToolNames: ["read"],
    extensions: true,
    extensionTools: undefined,
    allowNesting: undefined,
    isolated: undefined,
    ...ctx,
  } as InstallCtx);
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ===========================================================================
// Characterization tests
// ===========================================================================

describe("installExtensionToolScope — characterization", () => {
  /**
   * HAPPY PATH: extension_tools wildcard.
   *
   * `extension_tools: foo_*` keeps foo's tools in the active set and mutes
   * everything else, plus the built-ins the agent asked for.
   */
  it("extension_tools wildcard keeps only matching tools, mutes others", () => {
    const session = makeFakeSession(["read", "foo_alpha", "foo_beta", "bar_tool"]);
    install(session, { extensionTools: ["foo_*"] });

    const active = session.getActiveToolNames();
    expect(active).toContain("foo_alpha");
    expect(active).toContain("foo_beta");
    expect(active).toContain("read"); // builtin included
    expect(active).not.toContain("bar_tool"); // non-matching tool muted
  });

  /**
   * EDGE CASE: exact single-tool allowlist.
   *
   * `extension_tools: foo_bar` narrows to exactly one tool; its siblings are absent.
   */
  it("extension_tools exact name narrows to exactly the named tool", () => {
    const session = makeFakeSession(["read", "foo_alpha", "foo_bar", "foo_gamma"]);
    install(session, { extensionTools: ["foo_bar"] });

    const active = session.getActiveToolNames();
    expect(active).toContain("foo_bar"); // only the named tool
    expect(active).not.toContain("foo_alpha"); // sibling excluded
    expect(active).not.toContain("foo_gamma"); // sibling excluded
    expect(active).toContain("read"); // builtin still present
  });

  /**
   * REGRESSION — late-registration re-narrow (the LIVE-read invariant).
   *
   * computeActiveToolNames snapshots the tool list at call-time, so it cannot
   * on its own admit tools that register later (MCP on session_start, context-mode
   * on before_agent_start). The turn_end re-narrow re-reads the live registry.
   *
   * Flow:
   *   1. installExtensionToolScope is called; no extension tools yet.
   *   2. After install, foo_late and bar_late register (late).
   *   3. turn_end fires → renarrow re-reads the LIVE registry → foo_late enters.
   *   4. bar_late does NOT enter (extension_tools: foo_* doesn't match it).
   */
  it("REGRESSION: late-registered matching tool enters active set after turn_end re-narrow", () => {
    // Registry starts with just the builtin — extension tools haven't registered yet.
    const session = makeFakeSession(["read"]);
    install(session, { extensionTools: ["foo_*"] });

    // After install, no extension tools in active set yet.
    expect(session.getActiveToolNames()).not.toContain("foo_late");
    expect(session.getActiveToolNames()).not.toContain("bar_late");

    // Simulate late registration (e.g. MCP server connects, context-mode initializes).
    session._addToRegistry("foo_late");
    session._addToRegistry("bar_late");

    // Fire turn_end → renarrow re-reads the live registry.
    session._fireTurnEnd();

    const active = session.getActiveToolNames();
    // foo_late must enter — it matches the extension_tools filter.
    expect(active).toContain("foo_late");
    // bar_late must NOT enter — it does not match foo_*.
    expect(active).not.toContain("bar_late");
    // Builtin remains.
    expect(active).toContain("read");
  });

  it("beforeToolCall blocks a tool outside the extension_tools filter", async () => {
    const session = makeFakeSession(["read", "foo_tool", "bar_tool"]);
    install(session, { extensionTools: ["foo_*"] });

    await expect(
      session.agent.beforeToolCall?.({ toolCall: { name: "bar_tool" } }),
    ).resolves.toMatchObject({ block: true });
    await expect(
      session.agent.beforeToolCall?.({ toolCall: { name: "foo_tool" } }),
    ).resolves.toBeUndefined();
  });
});
