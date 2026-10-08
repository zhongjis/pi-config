import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClassifierResult, Usage } from "@earendil-works/pi-ai";
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import * as agentTypes from "../src/agent-types.js";
import { loadGraphClassifierAgent } from "../src/builtin-agents.js";
import { agentAnswerSchema } from "../src/graph/decision-gate.js";
import type { AgentGraph, ClassifierQuestion } from "../src/graph/ir.js";
import type { DecisionRequest } from "../src/graph/node-host.js";
import { createNodeHost, type NodeHostOptions } from "../src/graph/node-host-adapter.js";
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
    extensionRules: [],
    toolRules: [{ sign: "+", selector: "read" }],
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

function setup(responseText = "done", options: { context?: ExtensionContext; scopeModels?: () => boolean; awaitEscalation?: NodeHostOptions["awaitEscalation"] } = {}) {
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
    awaitEscalation: options.awaitEscalation,
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

it("preserves case-insensitive valid names and resolves the agent's frontmatter model", async () => {
  agentTypes.registerAgents(new Map([["fixture", agentConfig({ model: "test/chosen" })]]));
  const { host } = setup("done", { context: modelContext() });
  const result = await host.spawnAgent({ nodeId: "a", attempt: 1, agentType: "FiXtUrE", prompt: "task" }, new AbortController().signal);
  expect(result.ok).toBe(true);
  expect(vi.mocked(runAgent).mock.calls.at(-1)?.[1]).toBe("fixture");
  expect(vi.mocked(runAgent).mock.calls.at(-1)?.[3].selectedModel?.model).toEqual(model);
  await host.dispose();
});

describe("decision chain", () => {
  const questions: Record<string, ClassifierQuestion> = {
    ship: { type: "bool", instructions: "Is the draft ready to ship?", criteria: { true: "ready", false: "not ready" } },
  };
  const request = (over: Partial<DecisionRequest> = {}): DecisionRequest => ({ nodeId: "gate", state: { draft: "fixture draft" }, questions, ...over });
  const usage = (total: number): Usage => ({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total } });
  // 15/16 and 7/8 keep |2p-1| exact in binary floating point.
  const classified = (probability: number, over: Partial<ClassifierResult> = {}): ClassifierResult => ({
    api: "fixture-classify", provider: "fixture", model: "cls", answers: { ship: { type: "bool", probability } }, stopReason: "stop", timestamp: 0, ...over,
  });
  const failed = (over: Partial<ClassifierResult> = {}): ClassifierResult => ({ ...classified(0.5), answers: {}, stopReason: "error", errorMessage: "boom", ...over });
  const evidence = (provider: string, id: string) => ({
    dispose: vi.fn(), thinkingLevel: "low",
    subscribe: vi.fn((listener: (event: unknown) => void) => {
      listener({ type: "message_end", message: { role: "assistant", provider, model: id } });
      return () => {};
    }),
  }) as unknown as AgentSession;
  const answered = (structuredJson: string | undefined, cost = 0.25) => vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options) => {
    const child = evidence("fixture", "chat");
    options.onSessionCreated?.(child);
    options.onAssistantUsage?.({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost });
    return { session: child, responseText: "", aborted: false, steered: false, structuredJson };
  });

  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "subagents-decision-"));
    mkdirSync(join(cwd, ".pi"));
    mkdirSync(join(cwd, "agent"));
    vi.stubEnv("PI_CODING_AGENT_DIR", join(cwd, "agent"));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(cwd, { recursive: true, force: true });
  });

  function chain(value: string | null): void {
    writeFileSync(join(cwd, ".pi", "tool_models.json"), JSON.stringify({ version: 1, tools: { "subagents.decision_gate": value === null ? null : { chain: value } } }));
  }

  type Classify = (signal: AbortSignal | undefined) => ClassifierResult | Promise<ClassifierResult>;
  function decisionContext({ classifiers = {}, chat = [], locked = [], lockedClassifiers = [] }: { classifiers?: Record<string, Classify>; chat?: string[]; locked?: string[]; lockedClassifiers?: string[] } = {}) {
    const models = [...chat, ...locked].map(key => {
      const [provider, id] = key.split("/");
      return { provider, id, name: id, api: "fixture-chat" };
    });
    const authed = (model: { provider: string; id: string }) => chat.includes(`${model.provider}/${model.id}`);
    const classify = vi.fn(async (model: { provider: string; id: string }, _context: unknown, options?: { signal?: AbortSignal }) => classifiers[`${model.provider}/${model.id}`](options?.signal));
    const modelRegistry = {
      findOfType: (type: string, provider: string, id: string) => type === "classifier" && `${provider}/${id}` in classifiers ? { type, provider, id, api: "fixture-classify" } : undefined,
      getAvailableOfType: async (type: string, provider: string) => type !== "classifier" ? [] : Object.keys(classifiers)
        .filter(key => key.startsWith(`${provider}/`) && !lockedClassifiers.includes(key))
        .map(key => ({ type, provider, id: key.slice(provider.length + 1), api: "fixture-classify" })),
      classify,
      find: (provider: string, id: string) => models.find(model => model.provider === provider && model.id === id),
      hasConfiguredAuth: authed,
      isUsingOAuth: () => false,
      getAll: () => models,
      getAvailable: () => models.filter(authed),
    };
    return { context: { ...ctx, cwd, modelRegistry: modelRegistry as unknown as ExtensionContext["modelRegistry"] }, classify, models };
  }

  it("returns a confident classifier answer without spawning an agent", async () => {
    chain("fixture/cls,fixture/chat");
    const { context, classify } = decisionContext({ classifiers: { "fixture/cls": () => classified(0.9375, { usage: usage(0.5) }) }, chat: ["fixture/chat"] });
    const { host } = setup("", { context });
    const spawnInternal = vi.spyOn(manager, "spawnInternalAndWait");
    const onResolved = vi.fn();
    const signal = new AbortController().signal;
    const result = await host.decide?.(request({ onResolved }), signal);
    expect(result).toEqual({ ok: true, answers: { ship: { value: true, confidence: 0.875 } }, decidedBy: "classifier", model: "fixture/cls", costUsd: 0.5 });
    expect(classify).toHaveBeenCalledWith(expect.objectContaining({ provider: "fixture", id: "cls" }), { state: { draft: "fixture draft" }, questions }, { signal });
    expect(onResolved).toHaveBeenCalledWith({ modelId: "cls", modelName: "fixture/cls" });
    expect(spawnInternal).not.toHaveBeenCalled();
    expect(runAgent).not.toHaveBeenCalled();
    await host.dispose();
  });

  it("advances past a classifier error and sums every attempted entry's known cost", async () => {
    chain("fixture/cls-a,fixture/missing,fixture/cls-b");
    const { context } = decisionContext({ classifiers: {
      "fixture/cls-a": () => failed({ usage: usage(0.25) }),
      "fixture/cls-b": () => classified(0.0625, { usage: usage(0.5) }),
    } });
    const { host } = setup("", { context });
    const result = await host.decide?.(request(), new AbortController().signal);
    expect(result).toEqual({ ok: true, answers: { ship: { value: false, confidence: 0.875 } }, decidedBy: "classifier", model: "fixture/cls-b", costUsd: 0.75 });
    await host.dispose();
  });

  it("reports unknown cost when a completed classifier call reports no usage", async () => {
    chain("fixture/cls-a,fixture/cls-b");
    const { context } = decisionContext({ classifiers: { "fixture/cls-a": () => classified(0.9375, { answers: {} }), "fixture/cls-b": () => classified(0.9375, { usage: usage(0.5) }) } });
    const { host } = setup("", { context });
    const result = await host.decide?.(request(), new AbortController().signal);
    expect(result).toMatchObject({ ok: true, decidedBy: "classifier", model: "fixture/cls-b" });
    expect(result?.costUsd).toBeUndefined();
    await host.dispose();
  });

  it("skips a catalog classifier without credentials before classifying", async () => {
    chain("fixture/cls,fixture/chat");
    const { context, classify } = decisionContext({ classifiers: { "fixture/cls": () => classified(0.9375) }, lockedClassifiers: ["fixture/cls"], chat: ["fixture/chat"] });
    const { host } = setup("", { context });
    answered('{"ship":{"probability":0.9375}}');
    const result = await host.decide?.(request(), new AbortController().signal);
    expect(result).toMatchObject({ ok: true, decidedBy: "agent", model: "fixture/chat", costUsd: 0.25 });
    expect(classify).not.toHaveBeenCalled();
    await host.dispose();
  });

  it("charges nothing for a failed classifier call that reports no usage", async () => {
    chain("fixture/cls,fixture/chat");
    const { context } = decisionContext({ classifiers: { "fixture/cls": () => failed() }, chat: ["fixture/chat"] });
    const { host } = setup("", { context });
    answered('{"ship":{"probability":0.9375}}');
    const result = await host.decide?.(request(), new AbortController().signal);
    expect(result).toMatchObject({ ok: true, decidedBy: "agent", costUsd: 0.25 });
    await host.dispose();
  });

  it("falls back to the internal agent on the chat entry's exact model and thinking", async () => {
    chain("fixture/chat:low");
    const { context, models } = decisionContext({ chat: ["fixture/chat"] });
    const { host } = setup("", { context });
    const spawnInternal = vi.spyOn(manager, "spawnInternalAndWait");
    answered('{"ship":{"probability":0.9375}}');
    const onResolved = vi.fn();
    const result = await host.decide?.(request({ onResolved }), new AbortController().signal);
    expect(result).toEqual({ ok: true, answers: { ship: { value: true, confidence: 0.875 } }, decidedBy: "agent", model: "fixture/chat", costUsd: 0.25 });
    expect(spawnInternal).toHaveBeenCalledOnce();
    const [, , config, prompt, options] = spawnInternal.mock.calls[0];
    expect(config).toBe(loadGraphClassifierAgent());
    expect(prompt).toContain("Questions:");
    expect(prompt).toContain("fixture draft");
    expect(options).toMatchObject({ graphRunId: "wf", description: "gate", model: models[0], selectedModel: { model: models[0], thinkingLevel: "low" }, thinkingLevel: "low" });
    expect(options.structuredOutput?.schema).toEqual(agentAnswerSchema(questions));
    expect(vi.mocked(runAgent).mock.calls[0]?.[3]).toMatchObject({ agentConfig: config, graphRun: true, selectedModel: { model: models[0] } });
    expect(onResolved).toHaveBeenCalledWith({ recordId: manager.listAgents()[0]?.id });
    expect(onResolved).toHaveBeenCalledWith({ modelId: "chat", modelName: "fixture/chat", thinking: "low" });
    await host.dispose();
  });

  it("advances past invalid agent output to the next entry", async () => {
    chain("fixture/chat,fixture/cls");
    const { context } = decisionContext({ classifiers: { "fixture/cls": () => classified(0.9375, { usage: usage(0.5) }) }, chat: ["fixture/chat"] });
    const { host } = setup("", { context });
    answered('{"ship":{"probability":2}}');
    const result = await host.decide?.(request(), new AbortController().signal);
    expect(result).toMatchObject({ ok: true, decidedBy: "classifier", model: "fixture/cls", costUsd: 0.75 });
    expect(runAgent).toHaveBeenCalledOnce();
    await host.dispose();
  });

  it("aggregates every entry failure once the chain is exhausted", async () => {
    chain("fixture/cls,fixture/locked,fixture/missing,missing-bare");
    const { context } = decisionContext({ classifiers: { "fixture/cls": () => failed({ usage: usage(0) }) }, locked: ["fixture/locked"] });
    const { host } = setup("", { context });
    const result = await host.decide?.(request(), new AbortController().signal);
    expect(result).toEqual({
      ok: false, costUsd: 0,
      error: "fixture/cls: boom; fixture/locked: unavailable; fixture/missing: unavailable; missing-bare: unavailable",
    });
    expect(runAgent).not.toHaveBeenCalled();
    await host.dispose();
  });

  it("reports an empty chain without trying any model", async () => {
    chain(null);
    const { context, classify } = decisionContext();
    const { host } = setup("", { context });
    expect(await host.decide?.(request(), new AbortController().signal))
      .toEqual({ ok: false, error: "No decision models configured (tool_models key subagents.decision_gate)", costUsd: 0 });
    expect(classify).not.toHaveBeenCalled();
    await host.dispose();
  });

  it("skips without trying further entries once aborted", async () => {
    chain("fixture/cls,fixture/chat");
    const controller = new AbortController();
    const { context, classify } = decisionContext({
      classifiers: { "fixture/cls": () => { controller.abort(); return failed({ stopReason: "aborted" }); } },
      chat: ["fixture/chat"],
    });
    const { host } = setup("", { context });
    const result = await host.decide?.(request(), controller.signal);
    expect(result).toMatchObject({ ok: false, skipped: true, error: "Aborted." });
    expect(classify).toHaveBeenCalledOnce();
    expect(runAgent).not.toHaveBeenCalled();
    expect(await host.decide?.(request(), controller.signal)).toEqual({ ok: false, skipped: true, error: "Aborted.", costUsd: 0 });
    expect(classify).toHaveBeenCalledOnce();
    await host.dispose();
  });

  it("dispose aborts and drains an in-flight agent fallback", async () => {
    chain("fixture/chat");
    const { context } = decisionContext({ chat: ["fixture/chat"] });
    const { host } = setup("", { context });
    let started!: () => void;
    const running = new Promise<void>(resolve => { started = resolve; });
    let childSignal: AbortSignal | undefined;
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options) => {
      childSignal = options.signal;
      started();
      await new Promise(resolve => options.signal?.addEventListener("abort", resolve, { once: true }));
      return { session: session(), responseText: "", aborted: true, steered: false };
    });
    const pending = host.decide?.(request(), new AbortController().signal);
    await running;
    await host.dispose();
    expect(childSignal?.aborted).toBe(true);
    expect(manager.listAgents()[0]?.status).toBe("stopped");
    await expect(pending).resolves.toMatchObject({ ok: false, skipped: true });
  });

  it("runs a decision_gate through the real adapter's agent fallback without opening UI", async () => {
    chain("fixture/chat");
    const { context } = decisionContext({ chat: ["fixture/chat"] });
    const select = vi.fn<ExtensionContext["ui"]["select"]>();
    const { host } = setup("", { context: { ...context, ui: { ...context.ui, select } } });
    answered('{"ship":{"probability":0.9375}}');
    const graph: AgentGraph = { nodes: { gate: { type: "decision_gate", state: { draft: { path: "$.draft" } }, questions } }, edges: [], outputs: { result: { node: "gate", path: "$" } } };
    const result = await runGraph(graph, { draft: "fixture draft" }, { host });
    expect(result.outputs).toEqual({ result: { answers: { ship: { value: true, confidence: 0.875 } }, decidedBy: "agent" } });
    expect(vi.mocked(runAgent).mock.calls.at(-1)?.[3].structuredOutput?.schema).toEqual(agentAnswerSchema(questions));
    expect(select).not.toHaveBeenCalled();
    await host.dispose();
  });

  it.each([
    ["an exhausted chain", "fixture/missing", /No decision model answered/],
    ["a low-confidence answer", "fixture/cls", /Confidence below 0\.8 \(classifier fixture\/cls\)/],
  ] as const)("escalates %s to the orchestrator without opening UI", async (_label, value, reason) => {
    chain(value);
    const { context } = decisionContext({ classifiers: { "fixture/cls": () => classified(0.875, { usage: usage(0) }) } });
    const select = vi.fn<ExtensionContext["ui"]["select"]>();
    const awaitEscalation = vi.fn<NonNullable<NodeHostOptions["awaitEscalation"]>>()
      .mockResolvedValue({ ok: true, output: JSON.stringify({ answers: { ship: false }, decidedBy: "orchestrator" }) });
    const { host } = setup("", { context: { ...context, ui: { ...context.ui, select } }, awaitEscalation });
    const graph: AgentGraph = { nodes: { gate: { type: "decision_gate", state: {}, questions } }, edges: [], outputs: { result: { node: "gate", path: "$" } } };
    const result = await runGraph(graph, {}, { host });
    expect(result.outputs).toEqual({ result: { answers: { ship: { value: false, confidence: 1 } }, decidedBy: "orchestrator" } });
    expect(awaitEscalation).toHaveBeenCalledWith(expect.objectContaining({ reason: expect.stringMatching(reason), questions, correlation: expect.any(Object) }), expect.any(AbortSignal));
    expect(select).not.toHaveBeenCalled();
    expect(runAgent).not.toHaveBeenCalled();
    await host.dispose();
  });
});
