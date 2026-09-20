import { describe, expect, it, vi } from "vitest";
import type { AgentGraph, FanoutNode } from "../src/graph/ir.js";
import type { NodeHost, NodeSpawnResult } from "../src/graph/node-host.js";
import { type GraphControl, runGraph } from "../src/graph/run-graph.js";
import { releaseAfterPending } from "./graph-drain.fixture.js";

const fanout: FanoutNode = {
  type: "fanout", items: { path: "$.tasks" },
  itemSchema: { type: "object", properties: { source: { type: "string" } }, required: ["source"] },
  dispatch: { path: "$.source", cases: { project: "local", external: "remote" } },
  prompt: `\${item}`, phase: { index: 0, title: "Round 1/2" },
};
const graph: AgentGraph = {
  nodes: { research: fanout }, edges: [], outputs: { evidence: { node: "research", path: "$.results" } },
};
const tasks = [{ source: "project" }, { source: "external" }];

function parkedHost() {
  const finish = new Map<string, (result: NodeSpawnResult) => void>();
  const started: string[] = [];
  const host: NodeHost = {
    spawnAgent: request => new Promise(resolve => {
      started.push(request.nodeId);
      finish.set(request.nodeId, resolve);
    }),
  };
  return { host, finish, started };
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing fixture value");
  return value;
}

describe("awaited fanout", () => {
  it("registers fresh children before updates and collects failures in input order", async () => {
    const parked = parkedHost();
    const events: string[] = [];
    const run = runGraph(graph, { tasks }, {
      host: parked.host,
      onNodeAdded: (id, node, metadata) => {
        events.push(`added:${id}`);
        expect(node.type).toBe("agent");
        expect(metadata).toEqual({ dependencies: [], phase: fanout.phase });
      },
      onNodeUpdate: (id, state) => events.push(`${state.status}:${id}`),
    });
    await vi.waitFor(() => expect(parked.started).toHaveLength(2));
    required(parked.finish.get("research:item:1"))({ ok: false, error: "unavailable" });
    await vi.waitFor(() => expect(events).toContain("failed:research:item:1"));
    expect(events).not.toContain("completed:research");
    required(parked.finish.get("research:item:0"))({ ok: true, output: "evidence" });
    const result = await run;
    expect(result.status).toBe("completed");
    expect(result.outputs.evidence).toEqual([
      { nodeId: "research:item:0", index: 0, item: tasks[0], status: "completed", attempt: 1, output: "evidence" },
      { nodeId: "research:item:1", index: 1, item: tasks[1], status: "failed", attempt: 1, error: "unavailable" },
    ]);
    expect(result.nodes["research:item:1"].status).toBe("failed");
    for (const id of parked.started) expect(events.indexOf(`added:${id}`)).toBeLessThan(events.indexOf(`running:${id}`));
    expect(Object.keys(graph.nodes)).toEqual(["research"]);
  });

  it("completes an empty collection without spawning", async () => {
    const spawnAgent = vi.fn<NodeHost["spawnAgent"]>();
    const result = await runGraph(graph, { tasks: [] }, { host: { spawnAgent } });
    expect(result.outputs.evidence).toEqual([]);
    expect(result.status).toBe("completed");
    expect(spawnAgent).not.toHaveBeenCalled();
  });

  it.each([
    ["non-array", { source: "project" }],
    ["invalid item", [tasks[0], {}]],
    ["dispatch miss", [tasks[0], { source: "unknown" }]],
    ["prototype dispatch miss", [tasks[0], { source: "toString" }]],
    ["overflow", Array.from({ length: 500 }, () => tasks[0])],
  ])("rejects %s atomically", async (_label, invalid) => {
    const spawnAgent = vi.fn<NodeHost["spawnAgent"]>();
    const added = vi.fn();
    const result = await runGraph(graph, { tasks: invalid }, { host: { spawnAgent }, onNodeAdded: added });
    expect(result.status).toBe("failed");
    expect(result.nodes.research.error).toBeTruthy();
    expect(Object.keys(result.nodes)).toEqual(["research"]);
    expect(spawnAgent).not.toHaveBeenCalled();
    expect(added).not.toHaveBeenCalled();
  });

  it("rejects deterministic ID collisions without inserting siblings", async () => {
    const collision: AgentGraph = {
      ...graph,
      nodes: { ...graph.nodes, "research:item:1": { type: "agent", agent: "x", prompt: "fixture" } },
      edges: [{ from: "research", to: "research:item:1" }],
    };
    const spawnAgent = vi.fn<NodeHost["spawnAgent"]>();
    const result = await runGraph(collision, { tasks }, { host: { spawnAgent } });
    expect(result.nodes.research.error).toContain("collid");
    expect(result.nodes["research:item:0"]).toBeUndefined();
    expect(spawnAgent).not.toHaveBeenCalled();
  });

  it("does not charge the barrier a concurrency slot and freezes interpolated inputs", async () => {
    const spawnAgent = vi.fn<NodeHost["spawnAgent"]>(async request => {
      expect(request.agentType).toBe("local");
      expect(JSON.parse(request.prompt)).toEqual({ task: { source: "project", value: `\${context}` }, context: { bound: true } });
      return { ok: true, output: '{"found":true}' };
    });
    const schemaGraph: AgentGraph = {
      ...graph, nodes: { research: {
        ...fanout, prompt: `{"task":\${item},"context":\${context}}`,
        input: { context: { path: "$.context" } }, outputSchema: { type: "object" },
      } },
    };
    const result = await runGraph(schemaGraph, { tasks: [{ source: "project", value: `\${context}` }], context: { bound: true } }, {
      host: { spawnAgent }, concurrency: 1,
    });
    expect(result.nodes["research:item:0"].output).toEqual({ found: true });
    expect(spawnAgent).toHaveBeenCalledTimes(1);
  });

  it("collects invalid structured output and denied spawns without failing the graph", async () => {
    const schemaGraph: AgentGraph = { ...graph, nodes: { research: { ...fanout, outputSchema: { type: "object" } } } };
    const result = await runGraph(schemaGraph, { tasks }, { host: {
      spawnAgent: async request => {
        if (request.agentType === "remote") throw new Error("denied");
        return { ok: true, output: "invalid-json" };
      },
    } });
    expect(result.status).toBe("completed");
    expect(result.nodes["research:item:0"].status).toBe("failed");
    expect(result.nodes["research:item:1"].error).toContain("denied");
  });

  it("keeps dynamic control indices stable across pause, retry, and skip", async () => {
    const parked = parkedHost();
    let control: GraphControl | undefined;
    const run = runGraph(graph, { tasks }, { host: parked.host, concurrency: 1, onControl: c => { control = c; } });
    await vi.waitFor(() => expect(parked.started).toEqual(["research:item:0"]));
    required(control).pause();
    expect(required(control).retry(1)).toBe(true);
    expect(required(control).skip(2)).toBe(true);
    required(control).resume();
    await releaseAfterPending(run, () => {
      expect(parked.started).toEqual(["research:item:0"]);
      required(parked.finish.get("research:item:0"))({ ok: true });
    });
    await vi.waitFor(() => expect(parked.started).toEqual(["research:item:0", "research:item:0"]));
    required(parked.finish.get("research:item:0"))({ ok: true, output: "retry-output" });
    const result = await run;
    expect(result.status).toBe("completed");
    expect(result.nodes["research:item:0"]).toMatchObject({ attempt: 2, attemptReason: "user-retry" });
    expect(result.nodes["research:item:1"]).toMatchObject({ status: "skipped", attempt: 0 });
  });

  it("settles a running-child skip while paused", async () => {
    const parked = parkedHost();
    let control: GraphControl | undefined;
    const updates: string[] = [];
    const run = runGraph(graph, { tasks: [tasks[0]] }, {
      host: parked.host, onControl: c => { control = c; },
      onNodeUpdate: (id, state) => updates.push(`${id}:${state.status}`),
    });
    await vi.waitFor(() => expect(parked.started).toHaveLength(1));
    required(control).pause();
    expect(required(control).skip(1)).toBe(true);
    await releaseAfterPending(run, () => {
      expect(updates).not.toContain("research:completed");
      required(parked.finish.get("research:item:0"))({ ok: true });
    });
    await vi.waitFor(() => expect(updates).toContain("research:completed"));
    required(control).resume();
    expect((await run).status).toBe("completed");
  });

  it("allows a new source in a second explicit round", async () => {
    const twoRounds: AgentGraph = {
      nodes: {
        first: fanout,
        evaluate: { type: "agent", agent: "evaluator", prompt: `\${evidence}`, input: { evidence: { node: "first", path: "$.results" } }, outputSchema: { type: "object" } },
        second: { ...fanout, items: { node: "evaluate", path: "$.tasks" }, phase: { index: 1, title: "Round 2/2" } },
      },
      edges: [{ from: "first", to: "evaluate" }, { from: "evaluate", to: "second" }],
    };
    const selectors: string[] = [];
    const result = await runGraph(twoRounds, { tasks: [tasks[0]] }, { host: {
      spawnAgent: async request => {
        selectors.push(request.agentType);
        return { ok: true, output: request.agentType === "evaluator" ? '{"tasks":[{"source":"external"}]}' : "evidence" };
      },
    } });
    expect(selectors).toEqual(["local", "evaluator", "remote"]);
    expect(result.status).toBe("completed");
    expect(result.nodes["first:item:0"].attempt).toBe(1);
    expect(result.nodes["second:item:0"].attempt).toBe(1);
  });
});

it("allows exactly 500 effective nodes and rejects overflow across fanouts", async () => {
  const host: NodeHost = { spawnAgent: async () => ({ ok: true, output: "fixture" }) };
  const atLimit = await runGraph(graph, { tasks: Array.from({ length: 499 }, () => tasks[0]) }, { host });
  expect(atLimit.status).toBe("completed");
  expect(Object.keys(atLimit.nodes)).toHaveLength(500);
  const overflow = await runGraph({ nodes: { first: fanout, second: fanout }, edges: [] }, {
    tasks: Array.from({ length: 250 }, () => tasks[0]),
  }, { host });
  expect(overflow.status).toBe("failed");
  expect(Object.keys(overflow.nodes)).toHaveLength(252);
  expect(overflow.nodes.second.error).toContain("500");
  expect(overflow.nodes["second:item:0"]).toBeUndefined();
});

it("restores literal fanout item placeholders without duplicate dispatch or identity", async () => {
  const input = { tasks: [{ source: "project", value: `\${context}` }], context: { bound: true } };
  const checkpoints: { state: import("../src/graph/scheduler.js").SchedulerState; graph: AgentGraph }[] = [];
  let initialPrompt: string | undefined;
  await runGraph({
    version: 2,
    nodes: { research: {
      ...fanout,
      prompt: `{"task":\${item},"context":\${context}}`,
      input: { context: { path: "$.context" } },
    } },
    edges: [],
  }, input, {
    onCheckpoint: (state, effective) => checkpoints.push({ state, graph: effective }),
    host: { spawnAgent: async request => { initialPrompt = request.prompt; return { ok: true, output: "evidence" }; } },
  });
  expect(initialPrompt).toBe(`{"task":{"source":"project","value":"\${context}"},"context":{"bound":true}}`);
  const saved = checkpoints.find(checkpoint => Object.hasOwn(checkpoint.graph.nodes, "research:item:0"));
  if (!saved) throw new Error("Fanout materialization checkpoint was not captured");
  const restoredPrompts: string[] = [];
  const restoredFrames: typeof checkpoints = [];
  const result = await runGraph(saved.graph, input, {
    restore: saved.state,
    onCheckpoint: (state, effective) => restoredFrames.push({ state, graph: effective }),
    host: { spawnAgent: async request => { restoredPrompts.push(request.prompt); return { ok: true, output: "evidence" }; } },
  });
  expect(result.status).toBe("completed");
  expect(restoredPrompts).toEqual([initialPrompt]);
  expect(restoredFrames.at(-1)?.state.runtime?.manifest).toEqual(saved.state.runtime?.manifest);
  expect(restoredFrames.at(-1)?.graph.nodes["research:item:0"]).toEqual(saved.graph.nodes["research:item:0"]);
  const settled = restoredFrames.at(-1);
  if (!settled) throw new Error("Missing settled checkpoint");
  const spawn = vi.fn(async () => ({ ok: true }));
  await runGraph(settled.graph, input, { restore: settled.state, onCheckpoint: () => {}, host: { spawnAgent: spawn } });
  expect(spawn).not.toHaveBeenCalled();

  for (const mutation of ["prompt", "item", "dispatch", "ownership", "index", "uuid", "static", "expanded"] as const) {
    const forged = structuredClone(saved);
    const child = forged.graph.nodes["research:item:0"];
    const collection = forged.state.collections?.research;
    const manifest = forged.state.runtime?.manifest;
    if (child.type !== "agent" || !collection || !manifest) throw new Error("Missing collection fixture");
    if (mutation === "prompt") child.prompt += " forged";
    if (mutation === "item") Object.assign(collection[0], { item: { source: "project", value: "forged" } });
    if (mutation === "dispatch") child.agent = "forged";
    if (mutation === "ownership") delete forged.state.collections;
    if (mutation === "index") Object.assign(manifest[1], { itemIndex: 1 });
    if (mutation === "uuid") Object.assign(manifest[1], { instanceId: manifest[0].instanceId });
    if (mutation === "static" || mutation === "expanded") {
      forged.graph.nodes.research = mutation === "static" ? { type: "agent", agent: "worker", prompt: "fixture" } : { type: "expand", source: { path: "$" } };
    }
    const onCheckpoint = vi.fn();
    await expect(runGraph(forged.graph, input, { restore: forged.state, onCheckpoint, host: { spawnAgent: spawn } })).rejects.toThrow();
    expect(onCheckpoint).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  }
});
