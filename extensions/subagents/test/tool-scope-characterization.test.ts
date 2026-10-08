/**
 * Characterization tests for extension-tool-scoping in agent-tool-scope.ts.
 *
 * `tools:` is PERMISSION ONLY: installExtensionToolScope never adds or removes
 * from the session's active tool set. It resolves the SHARED signed-rule policy
 * (`resolveToolAccess` in extensions/lib/active-tools.ts) against the session's
 * LIVE tool registry at two enforcement points, both live re-reads so a tool
 * that registers later is judged too:
 *   - the ceiling tool is re-ensured active (not reset, if already active) at
 *     install and on every turn_end, in case something else dropped it;
 *   - `beforeToolCall` vetoes top-level calls the rules do not grant.
 *
 * Scenarios locked:
 *  1. Hard gates: nested subagent controls need allowNesting (veto, no narrowing).
 *  2. A `*` glob permits only matching tools, via the veto.
 *  3. An exact name permits a single tool, via the veto.
 *  4. An `@<extension>` group follows each tool's recorded source, via the veto.
 *  5. Trusted `<sdk:` tools are always allowed and never touched.
 *  6. REGRESSION: a tool registered AFTER install becomes allowed once it
 *     registers (live re-read), and a non-matching sibling does not.
 *  7. The ceiling is re-ensured (added if missing) at install and on turn_end,
 *     and left alone (no-op) when already active or absent from the registry.
 *  8. Resolution diagnostics are reported once.
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
    /** Simulate pi emitting turn_end (re-ensures the ceiling). */
    _fireTurnEnd: () => {
      for (const l of listeners) l({ type: "turn_end" });
    },
  };
}

function install(session: ReturnType<typeof makeFakeSession>, tools: string, ctx: Partial<InstallCtx> = {}): void {
  installExtensionToolScope(session as unknown as Parameters<typeof installExtensionToolScope>[0], {
    toolRules: parseAccessRules("tools", tools).rules,
    ceilingToolName: "test_tool_ceiling",
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
  it("excludes canonical retrieval and gate resolution from non-nesting children via the veto, without narrowing the active set", async () => {
    const session = makeFakeSession(["read", "get_agent_result", "resolve_agent_graph_gate"]);
    install(session, "+@all", { gates: { allowNesting: false } });
    expect(session.getActiveToolNames()).toEqual(["read", "get_agent_result", "resolve_agent_graph_gate"]);
    await expect(session.agent.beforeToolCall?.({ toolCall: { name: "resolve_agent_graph_gate" } })).resolves.toMatchObject({ block: true });
    await expect(session.agent.beforeToolCall?.({ toolCall: { name: "get_agent_result" } })).resolves.toMatchObject({ block: true });
    await expect(session.agent.beforeToolCall?.({ toolCall: { name: "read" } })).resolves.toBeUndefined();
  });

  it("allowNesting admits nested subagent tools", () => {
    const nested = ["read", ...NESTED_SUBAGENT_TOOL_NAMES];
    const session = makeFakeSession(nested);
    install(session, "+@all", { gates: { allowNesting: true } });
    expect(session.getActiveToolNames()).toEqual(nested);
  });

  /** HAPPY PATH: installing the scope never narrows or grows the active set — only the veto enforces `tools:`. */
  it("a glob permits only matching tools via the veto, without narrowing the active set", () => {
    const session = makeFakeSession(["read", "foo_alpha", "foo_beta", "bar_tool"]);
    install(session, "+read, +foo_*");

    expect(session.getActiveToolNames()).toEqual(["read", "foo_alpha", "foo_beta", "bar_tool"]);
  });

  /** EDGE CASE: an exact name permits exactly one tool; its siblings are vetoed, not deactivated. */
  it("an exact name permits exactly the named tool via the veto, without narrowing the active set", async () => {
    const session = makeFakeSession(["read", "foo_alpha", "foo_bar", "foo_gamma"]);
    install(session, "+read, +foo_bar");

    expect(session.getActiveToolNames()).toEqual(["read", "foo_alpha", "foo_bar", "foo_gamma"]);
    await expect(session.agent.beforeToolCall?.({ toolCall: { name: "foo_alpha" } })).resolves.toMatchObject({ block: true });
    await expect(session.agent.beforeToolCall?.({ toolCall: { name: "foo_bar" } })).resolves.toBeUndefined();
  });

  it("an @<extension> group permits the tools whose source is that extension via the veto, without narrowing the active set", async () => {
    const session = makeFakeSession(["read", ["a_one", "/ext/alpha.ts"], ["a_two", "/ext/alpha.ts"], ["b_one", "/ext/beta.ts"]]);
    install(session, "+read, +@alpha");

    expect(session.getActiveToolNames()).toEqual(["read", "a_one", "a_two", "b_one"]);
    await expect(session.agent.beforeToolCall?.({ toolCall: { name: "b_one" } })).resolves.toMatchObject({ block: true });
    await expect(session.agent.beforeToolCall?.({ toolCall: { name: "a_one" } })).resolves.toBeUndefined();
  });

  it("a trusted <sdk:> tool stays active without any rule", () => {
    const session = makeFakeSession(["read", ["StructuredOutput", "<sdk:StructuredOutput>"]]);
    install(session, "+read");

    expect(session.getActiveToolNames()).toEqual(["read", "StructuredOutput"]);
  });

  /**
   * REGRESSION — late-registration (the LIVE-read invariant).
   *
   * A static snapshot cannot admit tools that register later (MCP on
   * session_start, context-mode on before_agent_start). The veto re-reads the
   * live registry on every call, so a late-registered matching tool is admitted
   * without waiting for any explicit re-narrow — there is none to wait for.
   *
   * Flow:
   *   1. installExtensionToolScope is called; no extension tools yet.
   *   2. foo_late and bar_late register (late) — Pi activates both; this scope
   *      never touches the active set either way.
   *   3. beforeToolCall re-resolves the rules against the live registry on each
   *      call: foo_late is allowed, bar_late stays blocked.
   */
  it("REGRESSION: a late-registered matching tool becomes allowed once it registers, without entering the active set via this scope", async () => {
    // Registry starts with just the builtin — extension tools haven't registered yet.
    const session = makeFakeSession(["read"]);
    install(session, "+read, +foo_*");

    // Simulate late registration (e.g. MCP server connects, context-mode initializes).
    session._addToRegistry("foo_late");
    session._addToRegistry("bar_late");

    // This scope never adds late-registered tools to the active set — that is
    // Pi's job. turn_end only re-ensures the ceiling.
    session._fireTurnEnd();
    expect(session.getActiveToolNames()).toEqual(["read"]);

    // But the veto re-reads the live registry, so foo_late is admitted and
    // bar_late (not matching +foo_*) stays blocked.
    await expect(session.agent.beforeToolCall?.({ toolCall: { name: "foo_late" } })).resolves.toBeUndefined();
    await expect(session.agent.beforeToolCall?.({ toolCall: { name: "bar_late" } })).resolves.toMatchObject({ block: true });
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

  it("re-ensures the ceiling at install when it is registered but not active", () => {
    const session = makeFakeSession(["read", "test_tool_ceiling"]);
    session.setActiveToolsByName(["read"]); // simulates another extension having dropped it
    install(session, "+read");

    expect(session.getActiveToolNames()).toEqual(["read", "test_tool_ceiling"]);
  });

  it("does not call setActiveToolsByName when the ceiling is already active (no-op)", () => {
    const session = makeFakeSession(["read", "test_tool_ceiling"]);
    const setActiveToolsByName = vi.spyOn(session, "setActiveToolsByName");
    install(session, "+read");

    expect(setActiveToolsByName).not.toHaveBeenCalled();
  });

  it("re-ensures the ceiling on turn_end if something else dropped it", () => {
    const session = makeFakeSession(["read", "test_tool_ceiling"]);
    install(session, "+read");
    session.setActiveToolsByName(["read"]); // another extension's setActiveTools dropped the ceiling

    session._fireTurnEnd();

    expect(session.getActiveToolNames()).toEqual(["read", "test_tool_ceiling"]);
  });

  it("does not add a ceiling tool that is absent from the registry", () => {
    const session = makeFakeSession(["read"]);
    install(session, "+read");

    expect(session.getActiveToolNames()).toEqual(["read"]);
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
