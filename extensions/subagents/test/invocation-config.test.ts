import { describe, expect, it } from "vitest";
import { registerAgents } from "../src/agent-types.js";
import { prepareAgentInvocation, resolveAgentInvocationConfig, resolveJoinMode } from "../src/invocation-config.js";
import type { AgentConfig } from "../src/types.js";

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "Explore",
    description: "Explore",
    builtinToolNames: ["read"],
    extensions: false,
    discoverSkills: false,
    preloadSkills: [],
    systemPrompt: "Test agent",
    promptMode: "replace",
    inheritContext: false,
    runInBackground: false,
    isolated: false,
    ...overrides,
  };
}

describe("resolveAgentInvocationConfig", () => {
  it("prefers agent config over tool-call params for locked fields", () => {
    const resolved = resolveAgentInvocationConfig(
      makeConfig({
        model: "provider/config-model",
        thinking: "high",
        maxTurns: 42,
        inheritContext: false,
        runInBackground: false,
        isolated: false,
      }),
      {
        max_turns: 1,
        inherit_context: true,
        run_in_background: true,
        isolated: true,
      },
    );

    expect(resolved.modelInput).toBe("provider/config-model");
    expect(resolved.thinking).toBe("high");
    expect(resolved.maxTurns).toBe(42);
    expect(resolved.inheritContext).toBe(false);
    expect(resolved.runInBackground).toBe(false);
    expect(resolved.isolated).toBe(false);
  });

  it("normalizes thinking 'none' to 'off' (backward compat)", () => {
    expect(resolveAgentInvocationConfig(undefined, {}, "none").thinking).toBe("off");
  });

  it("passes non-legacy thinking levels through unchanged (incl. pi 0.80 'max')", () => {
    expect(resolveAgentInvocationConfig(undefined, {}, "high").thinking).toBe("high");
    expect(resolveAgentInvocationConfig(undefined, {}, "max").thinking).toBe("max");
  });

  it("uses tool-call params when no agent config is available", () => {
    const resolved = resolveAgentInvocationConfig(undefined, {
      max_turns: 3,
      inherit_context: true,
      run_in_background: true,
      isolated: true,
    });

    expect(resolved.maxTurns).toBe(3);
    expect(resolved.inheritContext).toBe(true);
    expect(resolved.runInBackground).toBe(true);
    expect(resolved.isolated).toBe(true);
  });

  it("lets parent fill in booleans when config leaves them undefined", () => {
    const resolved = resolveAgentInvocationConfig(
      makeConfig({
        inheritContext: undefined,
        runInBackground: undefined,
        isolated: undefined,
      }),
      {
        inherit_context: true,
        run_in_background: true,
        isolated: true,
      },
    );

    expect(resolved.inheritContext).toBe(true);
    expect(resolved.runInBackground).toBe(true);
    expect(resolved.isolated).toBe(true);
  });

  it("defaults booleans to false when neither config nor params set them", () => {
    const resolved = resolveAgentInvocationConfig(
      makeConfig({
        inheritContext: undefined,
        runInBackground: undefined,
        isolated: undefined,
      }),
      {},
    );

    expect(resolved.inheritContext).toBe(false);
    expect(resolved.runInBackground).toBe(false);
    expect(resolved.isolated).toBe(false);
  });

  it("resolved config has no isolation key (worktree isolation removed)", () => {
    const resolved = resolveAgentInvocationConfig(makeConfig(), {});
    expect(resolved).not.toHaveProperty("isolation");
  });
});

describe("resolveJoinMode", () => {
  it("returns the global default for background agents", () => {
    expect(resolveJoinMode("smart", true)).toBe("smart");
    expect(resolveJoinMode("async", true)).toBe("async");
  });

  it("ignores join mode for foreground agents", () => {
    expect(resolveJoinMode("smart", false)).toBeUndefined();
    expect(resolveJoinMode("group", false)).toBeUndefined();
  });
});

describe("prepareAgentInvocation caller overrides", () => {
  const plain = { provider: "test", id: "plain", name: "Plain" };
  const parent = { provider: "test", id: "parent", name: "Parent" };
  const registry = { find: (provider: string, id: string) => [plain, parent].find((m) => m.provider === provider && m.id === id), getAll: () => [plain, parent], getAvailable: () => [plain, parent] };
  const prepare = (agentType: string) => prepareAgentInvocation({
    agentType,
    // Stray caller values an LLM may still send; they are no longer part of any contract.
    params: { model: "test/parent", thinking: "high" } as never,
    modelRegistry: registry as never,
    parentModel: parent as never,
    cwd: process.cwd(),
    scopeModels: false,
  });

  it("ignores caller model and thinking for a suffixless frontmatter chain", () => {
    registerAgents(new Map([["suffixless", makeConfig({ name: "suffixless", model: "test/plain" })]]));
    const prepared = prepare("suffixless");
    expect(prepared.invocation.modelInput).toBe("test/plain");
    expect(prepared.invocation.thinking).toBeUndefined();
    expect(prepared.selectedModel.model).toMatchObject({ id: "plain" });
    expect(prepared.selectedModel).not.toHaveProperty("invocationThinkingLevel");
  });

  it("inherits the parent model instead of a caller model when frontmatter omits model", () => {
    registerAgents(new Map([["inherit", makeConfig({ name: "inherit" })]]));
    const prepared = prepare("inherit");
    expect(prepared.invocation.modelInput).toBeUndefined();
    expect(prepared.selectedModel.model).toBe(parent);
    expect(prepared.invocation.thinking).toBeUndefined();
  });
});
