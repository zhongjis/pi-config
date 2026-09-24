import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import * as agentTypes from "../src/agent-types.js";
import type { AgentGraph } from "../src/graph/ir.js";
import { createNodeHost } from "../src/graph/node-host-adapter.js";
import { runGraph } from "../src/graph/run-graph.js";
import type { AgentConfig } from "../src/types.js";

vi.mock("../src/agent-runner.js", () => ({ runAgent: vi.fn(), resumeAgent: vi.fn() }));

import { runAgent } from "../src/agent-runner.js";
import { graphRunNodeArtifactId } from "../src/graph/history-artifact.js";
import * as outputFiles from "../src/output-file.js";

const ui: Pick<ExtensionContext["ui"], "notify"> = { notify: vi.fn() };
const ctx = {
  cwd: "/tmp",
  modelRegistry: {} as ExtensionContext["modelRegistry"],
  model: undefined,
  sessionManager: { getSessionId: () => "parent" } as ExtensionContext["sessionManager"],
  ui: ui as ExtensionContext["ui"],
} as ExtensionContext;

const model = { provider: "test", id: "chosen" };
function modelContext(cwd = "/tmp", available = [model]): ExtensionContext {
  return {
    ...ctx,
    cwd,
    modelRegistry: {
      find: (provider: string, id: string) => available.find(candidate => candidate.provider === provider && candidate.id === id),
      getAvailable: () => available,
    } as ExtensionContext["modelRegistry"],
  };
}

function agentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "fixture",
    description: "fixture",
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

function configureAgent(config: AgentConfig | undefined): void {
  vi.spyOn(agentTypes, "resolveType").mockReturnValue("fixture");
  vi.spyOn(agentTypes, "getAgentConfig").mockReturnValue(config);
}

const session = () => ({ dispose: vi.fn(), subscribe: vi.fn(() => () => {}) }) as unknown as AgentSession;

let manager: AgentManager;
beforeEach(() => {
  vi.restoreAllMocks();
  agentTypes.registerAgents(new Map());
});
afterEach(() => {
  manager?.dispose();
  vi.resetAllMocks();
});

function setup(responseText = "done", options: { context?: ExtensionContext; scopeModels?: () => boolean } = {}) {
  manager = new AgentManager();
  const exec = vi.fn<ExtensionAPI["exec"]>().mockResolvedValue({ code: 0, stdout: "passed", stderr: "", killed: false });
  const pi: Pick<ExtensionAPI, "exec"> = { exec };
  const host = createNodeHost({
    pi: pi as ExtensionAPI,
    ctx: options.context ?? ctx,
    manager,
    graphRunId: "wf",
    outputTranscript: () => false,
    scopeModels: options.scopeModels,
  });
  vi.mocked(runAgent).mockImplementation(async () => ({ session: session(), responseText, aborted: false, steered: false }));
  return { host, exec };
}

describe("createNodeHost", () => {
  it("maps a completed agent record to a NodeSpawnResult", async () => {
    const { host } = setup("hello");
    const result = await host.spawnAgent(
      { nodeId: "a", attempt: 1, agentType: "general-purpose", prompt: "task" },
      new AbortController().signal,
    );
    expect(result.ok).toBe(true);
    expect(result.output).toBe("hello");
    await host.dispose();
  });

  it("returns a failed result (not a throw) when the manager denies the spawn", async () => {
    const { host } = setup();
    manager.setPolicyChecker(() => 'delegation_policy_denied: Agent "kuafu" cannot delegate to "yanluo".');
    const result = await host.spawnAgent(
      { nodeId: "review", attempt: 1, agentType: "general-purpose", prompt: "task" },
      new AbortController().signal,
    );
    expect(result.ok).toBe(false);
    expect(result.skipped).toBeFalsy();
    expect(result.error).toContain("delegation_policy_denied");
    await host.dispose();
  });

  it("runs a gate command via pi.exec", async () => {
    const { host, exec } = setup();
    const gate = await host.runGate?.("true", { signal: new AbortController().signal });
    expect(gate?.ok).toBe(true);
    expect(exec).toHaveBeenCalled();
    await host.dispose();
  });

  it("executes a whole graph through the real adapter", async () => {
    const { host } = setup("out");
    const graph: AgentGraph = {
      nodes: {
        a: { type: "agent", agent: "general-purpose", prompt: "a" },
        b: { type: "agent", agent: "general-purpose", prompt: "b" },
      },
      edges: [{ from: "a", to: "b" }],
      outputs: { r: { node: "b", path: "$" } },
    };
    const result = await runGraph(graph, {}, { host });
    expect(result.status).toBe("completed");
    expect(result.outputs).toEqual({ r: "out" });
    await host.dispose();
  });

  it("prepares configured graph model, thinking, and raw max turns with graph run ownership", async () => {
    configureAgent(agentConfig({ model: "test/chosen:high", maxTurns: 0 }));
    const { host } = setup("out", { context: modelContext() });
    vi.mocked(runAgent).mockClear();
    await host.spawnAgent(
      { nodeId: "a", attempt: 1, agentType: "fixture", prompt: "task" },
      new AbortController().signal,
    );
    expect(vi.mocked(runAgent).mock.calls.at(-1)?.[3]).toMatchObject({
      graphRun: true,
      selectedModel: { model, modelInput: "test/chosen:high" },
      thinkingLevel: "high",
      maxTurns: 0,
    });
    expect(manager.listAgents()[0]?.graphRunId).toBe("wf");
    await host.dispose();
  });

  it("returns a failed graph result without spawning for an explicit out-of-scope model", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "subagents-node-host-"));
    try {
      mkdirSync(join(cwd, ".pi"));
      writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ enabledModels: ["test/allowed"] }));
      configureAgent(agentConfig());
      const allowed = { ...model, id: "allowed" };
      const { host } = setup("out", { context: modelContext(cwd, [model, allowed]), scopeModels: () => true });
      vi.mocked(runAgent).mockClear();
      const result = await host.spawnAgent(
        { nodeId: "a", attempt: 1, agentType: "fixture", prompt: "task", model: "test/chosen" },
        new AbortController().signal,
      );
      expect(result).toEqual({ ok: false, error: "Model not in scope: test/chosen" });
      expect(runAgent).not.toHaveBeenCalled();
      await host.dispose();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("warns once while running configured out-of-scope graph models", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "subagents-node-host-"));
    try {
      mkdirSync(join(cwd, ".pi"));
      writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ enabledModels: ["test/allowed"] }));
      configureAgent(agentConfig({ model: "test/chosen" }));
      const allowed = { ...model, id: "allowed" };
      const { host } = setup("out", { context: modelContext(cwd, [model, allowed]), scopeModels: () => true });
      vi.mocked(runAgent).mockClear();
      await host.spawnAgent({ nodeId: "a", attempt: 1, agentType: "fixture", prompt: "task" }, new AbortController().signal);
      await host.spawnAgent({ nodeId: "b", attempt: 1, agentType: "fixture", prompt: "task" }, new AbortController().signal);
      expect(ui.notify).toHaveBeenCalledOnce();
      expect(ui.notify).toHaveBeenCalledWith("Model not in scope: test/chosen", "warning");
      expect(runAgent).toHaveBeenCalledTimes(2);
      await host.dispose();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

it("returns authoritative lifetime USD cost, independently of token counts", async () => {
  const { host } = setup();
  vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options) => {
    options.onAssistantUsage?.({ input: 7, output: 3, cacheRead: 0, cacheWrite: 0, cost: 0.125 });
    return { session: session(), responseText: "done", aborted: false, steered: false };
  });
  const result = await host.spawnAgent({ nodeId: "paid", attempt: 1, agentType: "general-purpose", prompt: "task" }, new AbortController().signal);
  expect(manager.listAgents()[0]?.lifetimeCost).toBe(0.125);
  expect(result.costUsd).toBe(0.125);
  await host.dispose();
});

it("uses the registered history index alias for graph transcript paths and entries", async () => {
  setup();
  const path = vi.spyOn(outputFiles, "createOutputFilePath").mockReturnValue("/fixture.output");
  const initial = vi.spyOn(outputFiles, "writeInitialEntry").mockImplementation(() => {});
  const stream = vi.spyOn(outputFiles, "streamToOutputFile").mockReturnValue(() => {});
  const result = vi.spyOn(outputFiles, "writeResultEntry").mockImplementation(() => {});
  const nodeIndex = vi.fn(() => 17);
  const pi: Pick<ExtensionAPI, "exec"> = { exec: vi.fn() };
  const host = createNodeHost({ pi: pi as ExtensionAPI, ctx, manager, graphRunId: "run-id", nodeIndex });
  vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options) => {
    const child = session();
    options.onSessionCreated?.(child);
    return { session: child, responseText: "done", aborted: false, steered: false };
  });
  await host.spawnAgent({ nodeId: "private-binding", attempt: 1, agentType: "general-purpose", prompt: "FIXTURE" }, new AbortController().signal);
  const alias = graphRunNodeArtifactId("run-id", 17);
  expect(nodeIndex).toHaveBeenCalledWith("private-binding");
  expect(path).toHaveBeenCalledWith(ctx.cwd, alias, "parent");
  expect(initial).toHaveBeenCalledWith("/fixture.output", alias, "FIXTURE", ctx.cwd);
  expect(stream).toHaveBeenCalledWith(expect.anything(), "/fixture.output", alias, ctx.cwd);
  expect(result).toHaveBeenCalledWith("/fixture.output", alias, "done", ctx.cwd);
  expect(manager.listAgents()[0]?.outputFile).toBe("/fixture.output");
  expect(manager.listAgents()[0]?.id).not.toBe(alias);
  await host.dispose();
  vi.restoreAllMocks();
});

it.each(["unknown", "removed-config", "disabled"])('fails closed for %s graph agents before dispatch', async kind => {
  const { host } = setup();
  vi.spyOn(agentTypes, "resolveType").mockReturnValue(kind === "unknown" ? undefined : "fixture");
  vi.spyOn(agentTypes, "getAgentConfig").mockReturnValue(kind === "disabled" ? agentConfig({ enabled: false }) : undefined);
  const result = await host.spawnAgent({ nodeId: "a", attempt: 1, agentType: "fixture", prompt: "task" }, new AbortController().signal);
  expect(result.ok).toBe(false);
  expect(result.error).toMatch(/agent.*fixture.*unavailable/i);
  expect(runAgent).not.toHaveBeenCalled();
  expect(manager.listAgents()).toHaveLength(0);
  await host.dispose();
});

it("preserves case-insensitive valid names and explicit model overrides", async () => {
  agentTypes.registerAgents(new Map([["fixture", agentConfig()]]));
  const { host } = setup("done", { context: modelContext() });
  const result = await host.spawnAgent({ nodeId: "a", attempt: 1, agentType: "FiXtUrE", model: "test/chosen", prompt: "task" }, new AbortController().signal);
  expect(result.ok).toBe(true);
  expect(vi.mocked(runAgent).mock.calls.at(-1)?.[1]).toBe("fixture");
  expect(vi.mocked(runAgent).mock.calls.at(-1)?.[3].selectedModel?.model).toEqual(model);
  await host.dispose();
});
