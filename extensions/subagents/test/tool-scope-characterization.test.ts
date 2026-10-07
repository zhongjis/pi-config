/**
 * Characterization tests for extension-tool-scoping in agent-tool-scope.ts.
 *
 * installExtensionToolScope resolves the SHARED signed-rule policy
 * (`resolveToolAccess` + `selectActiveToolNames` in extensions/lib/active-tools.ts)
 * against the session's LIVE tool registry. The critical invariant it owns is
 * the live re-read: it re-queries the session's tool list on every turn_end and
 * every call check, so a tool that registers AFTER the first narrow still enters
 * the active set when the rules grant it.
 *
 * Scenarios locked:
 *  1. Hard gates: nested subagent controls need allowNesting.
 *  2. A `*` glob keeps only matching tools in the active set.
 *  3. An exact name narrows to a single tool.
 *  4. An `@<extension>` group follows each tool's recorded source.
 *  5. Trusted `<sdk:` tools are always allowed.
 *  6. REGRESSION: a tool registered AFTER the first narrow re-enters the active
 *     set when turn_end fires (live re-read), and a non-matching sibling does not.
 *  7. Resolution diagnostics are reported once.
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
  getConfig: vi.fn(),
  getAgentConfig: vi.fn(),
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
import { NESTED_SUBAGENT_TOOL_NAMES, parseAccessRules } from "../../lib/active-tools.js";
import { installExtensionToolScope } from "../src/agent-tool-scope.js";

type InstallCtx = Parameters<typeof installExtensionToolScope>[1];

// ---------------------------------------------------------------------------
// Fake AgentSession — stateful enough for installExtensionToolScope:
//   • registry: the LIVE tool list (name + source path); grows via _addToRegistry()
//   • activeTools: updated by setActiveToolsByName
//   • listeners: subscribed via subscribe(), fired by _fireTurnEnd()
// A bare name registers from `/ext/<name>.ts`; pass `[name, path]` for an explicit source.
// ---------------------------------------------------------------------------
type RegistryEntry = string | [name: string, path: string];
const entry = (e: RegistryEntry) => (typeof e === "string" ? { name: e, path: `/ext/${e}.ts` } : { name: e[0], path: e[1] });

function makeFakeSession(initialRegistry: RegistryEntry[] = []) {
  const registry = initialRegistry.map(entry);
  let activeTools: string[] = registry.map(({ name }) => name);
  const listeners: Array<(event: { type: string }) => void> = [];

  return {
    getAllTools: () => registry.map(({ name, path }) => ({ name, sourceInfo: { path } })),
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
    _addToRegistry: (e: RegistryEntry) => {
      registry.push(entry(e));
    },
    /** Simulate pi emitting turn_end (triggers renarrow). */
    _fireTurnEnd: () => {
      for (const l of listeners) l({ type: "turn_end" });
    },
  };
}

function install(session: ReturnType<typeof makeFakeSession>, tools: string, ctx: Partial<InstallCtx> = {}): void {
  installExtensionToolScope(session as unknown as Parameters<typeof installExtensionToolScope>[0], {
    toolRules: parseAccessRules("tools", tools).rules,
    ...ctx,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ===========================================================================
// Characterization tests
// ===========================================================================

describe("installExtensionToolScope — characterization", () => {
  it("excludes canonical retrieval and gate resolution from non-nesting children", async () => {
    const session = makeFakeSession(["read", "get_agent_result", "resolve_agent_graph_gate"]);
    install(session, "+@all", { gates: { allowNesting: false } });
    expect(session.getActiveToolNames()).toEqual(["read"]);
    await expect(session.agent.beforeToolCall?.({ toolCall: { name: "resolve_agent_graph_gate" } })).resolves.toMatchObject({ block: true });
  });

  it("allowNesting admits nested subagent tools", () => {
    const nested = ["read", ...NESTED_SUBAGENT_TOOL_NAMES];
    const session = makeFakeSession(nested);
    install(session, "+@all", { gates: { allowNesting: true } });
    expect(session.getActiveToolNames()).toEqual(nested);
  });

  /** HAPPY PATH: a `*` glob keeps foo's tools and mutes everything else, plus the granted built-in. */
  it("a glob keeps only matching tools, mutes others", () => {
    const session = makeFakeSession(["read", "foo_alpha", "foo_beta", "bar_tool"]);
    install(session, "+read, +foo_*");

    expect(session.getActiveToolNames()).toEqual(["read", "foo_alpha", "foo_beta"]);
  });

  /** EDGE CASE: an exact name narrows to exactly one tool; its siblings are absent. */
  it("an exact name narrows to exactly the named tool", () => {
    const session = makeFakeSession(["read", "foo_alpha", "foo_bar", "foo_gamma"]);
    install(session, "+read, +foo_bar");

    expect(session.getActiveToolNames()).toEqual(["read", "foo_bar"]);
  });

  it("an @<extension> group grants the tools whose source is that extension", () => {
    const session = makeFakeSession(["read", ["a_one", "/ext/alpha.ts"], ["a_two", "/ext/alpha.ts"], ["b_one", "/ext/beta.ts"]]);
    install(session, "+read, +@alpha");

    expect(session.getActiveToolNames()).toEqual(["read", "a_one", "a_two"]);
  });

  it("a trusted <sdk:> tool stays active without any rule", () => {
    const session = makeFakeSession(["read", ["StructuredOutput", "<sdk:StructuredOutput>"]]);
    install(session, "+read");

    expect(session.getActiveToolNames()).toEqual(["read", "StructuredOutput"]);
  });

  /**
   * REGRESSION — late-registration re-narrow (the LIVE-read invariant).
   *
   * A static snapshot cannot admit tools that register later (MCP on
   * session_start, context-mode on before_agent_start). The turn_end re-narrow
   * re-reads the live registry.
   *
   * Flow:
   *   1. installExtensionToolScope is called; no extension tools yet.
   *   2. After install, foo_late and bar_late register (late).
   *   3. turn_end fires → renarrow re-reads the LIVE registry → foo_late enters.
   *   4. bar_late does NOT enter (+foo_* doesn't match it).
   */
  it("REGRESSION: late-registered matching tool enters active set after turn_end re-narrow", () => {
    // Registry starts with just the builtin — extension tools haven't registered yet.
    const session = makeFakeSession(["read"]);
    install(session, "+read, +foo_*");

    // After install, no extension tools in active set yet.
    expect(session.getActiveToolNames()).toEqual(["read"]);

    // Simulate late registration (e.g. MCP server connects, context-mode initializes).
    session._addToRegistry("foo_late");
    session._addToRegistry("bar_late");

    // Fire turn_end → renarrow re-reads the live registry.
    session._fireTurnEnd();

    expect(session.getActiveToolNames()).toEqual(["read", "foo_late"]);
  });

  it("beforeToolCall blocks a tool the rules do not grant", async () => {
    const session = makeFakeSession(["read", "foo_tool", "bar_tool"]);
    install(session, "+read, +foo_*");

    await expect(
      session.agent.beforeToolCall?.({ toolCall: { name: "bar_tool" } }),
    ).resolves.toMatchObject({ block: true });
    await expect(
      session.agent.beforeToolCall?.({ toolCall: { name: "foo_tool" } }),
    ).resolves.toBeUndefined();
  });

  it("reports resolution diagnostics once across re-narrows and call checks", async () => {
    const session = makeFakeSession(["read"]);
    const onDiagnostics = vi.fn();
    install(session, "+read, +@missing", { onDiagnostics });

    session._fireTurnEnd();
    await session.agent.beforeToolCall?.({ toolCall: { name: "read" } });

    expect(onDiagnostics.mock.calls).toEqual([[[{ severity: "warning", message: '"@missing" matches no tool' }]]]);
  });
});
