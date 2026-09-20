import { describe, expect, it, vi } from "vitest";
import type { AgentGraph } from "../src/graph/ir.js";
import type { NodeHost, NodeSpawnResult } from "../src/graph/node-host.js";
import { runGraph } from "../src/graph/run-graph.js";
import type { SchedulerState } from "../src/graph/scheduler.js";
import { deferred, releaseAfterPending } from "./graph-drain.fixture.js";
import { ProjectionDriver as Scheduler } from "./graph-projection.fixture.js";

const agent = () => ({ type: "agent" as const, agent: "x", prompt: "p" });

const gateGraph: AgentGraph = {
  nodes: {
    a: agent(),
    gate: {
      type: "human_gate",
      prompt: "approve?",
      outputSchema: { type: "object", properties: { approved: { type: "boolean" } }, required: ["approved"] },
    },
    done: agent(),
  },
  edges: [
    { from: "a", to: "gate" },
    { from: "gate", to: "done", when: { eq: [{ node: "gate", path: "$.approved" }, true] } },
  ],
  outputs: { decision: { node: "gate", path: "$.approved" } },
};

describe("Scheduler snapshot/hydrate", () => {
  it("round-trips completed node state", () => {
    const graph: AgentGraph = { nodes: { a: agent(), b: agent() }, edges: [{ from: "a", to: "b" }] };
    const s = new Scheduler(graph, {});
    s.markRunning("a");
    s.settle("a", { ok: true, output: { x: 1 } });
    const state = s.snapshotState();
    expect(state.nodes.a.status).toBe("completed");
    expect(state.nodes.a.output).toEqual({ x: 1 });

    const restored = new Scheduler(graph, {});
    restored.hydrate(state);
    expect(restored.nodes.get("a")?.status).toBe("completed");
    expect(restored.nodes.get("a")?.output).toEqual({ x: 1 });
  });

  it("hydrates a mid-flight (running) node back to pending", () => {
    const graph: AgentGraph = { nodes: { a: agent() }, edges: [] };
    const s = new Scheduler(graph, {});
    s.markRunning("a");
    const restored = new Scheduler(graph, {});
    restored.hydrate(s.snapshotState());
    expect(restored.nodes.get("a")?.status).toBe("pending");
  });
});

describe("runGraph durable resume", () => {
  it("fires onGateWaiting with the current run state when a gate awaits", async () => {
    const captured: { id: string; state: SchedulerState }[] = [];
    const host: NodeHost = {
      spawnAgent: async () => ({ ok: true, output: "a-out" }),
      awaitHumanGate: async () => ({ ok: true, output: '{"approved":true}' }),
    };
    await runGraph(gateGraph, {}, { host, onGateWaiting: (id, state) => captured.push({ id, state }) });
    expect(captured).toHaveLength(1);
    expect(captured[0].id).toBe("gate");
    expect(captured[0].state.nodes.a.status).toBe("completed");
    expect(captured[0].state.nodes.gate.status).toBe("running");
  });

  it("resumes from a snapshot without re-running completed nodes", async () => {
    const restore: SchedulerState = {
      nodes: {
        a: { status: "completed", output: "a-out", attempt: 1 },
        gate: { status: "pending", attempt: 0 },
        done: { status: "pending", attempt: 0 },
      },
      loopCounts: {},
    };
    const spawned: string[] = [];
    const host: NodeHost = {
      spawnAgent: async request => {
        spawned.push(request.nodeId);
        return { ok: true, output: "x" } satisfies NodeSpawnResult;
      },
      awaitHumanGate: async () => ({ ok: true, output: '{"approved":true}' }),
    };
    const result = await runGraph(gateGraph, {}, { host, restore });
    expect(result.status).toBe("completed");
    expect(spawned).toEqual(["done"]); // "a" was restored, not re-run
    expect(result.outputs).toEqual({ decision: true });
  });
});

it("restores an active collection without replenishing interrupted legacy executions", async () => {
  const graph: AgentGraph = {
    nodes: {
      research: {
        type: "fanout", items: { path: "$.tasks" }, itemSchema: { type: "object" },
        dispatch: { path: "$.source", cases: { project: "x" } }, prompt: `\${item}`,
      },
      trigger: agent(),
      gate: { type: "human_gate", prompt: "fixture", outputSchema: { type: "object" } },
    },
    edges: [{ from: "trigger", to: "gate" }],
    outputs: { evidence: { node: "research", path: "$.results" } },
  };
  const input = { tasks: [{ source: "project" }, { source: "project" }, { source: "project" }] };
  const gates = new Map<string, (value: NodeSpawnResult) => void>();
  const captures: { state: SchedulerState; graph: AgentGraph }[] = [];
  const controller = new AbortController();
  const human = deferred<NodeSpawnResult>();
  const run = runGraph(graph, input, {
    signal: controller.signal, concurrency: 4,
    host: {
      spawnAgent: request => new Promise(resolve => { gates.set(request.nodeId, resolve); }),
      awaitHumanGate: () => human.promise,
    },
    onGateWaiting: (_id, state, effective) => captures.push({ state, graph: effective }),
  });
  await vi.waitFor(() => expect(gates.size).toBe(4));
  gates.get("research:item:0")?.({ ok: true, output: "retained" });
  gates.get("research:item:1")?.({ ok: false, error: "retained failure" });
  // Let child settlements reach the scheduler before opening the independent gate.
  await new Promise(resolve => setTimeout(resolve, 0));
  gates.get("trigger")?.({ ok: true, output: "ready" });
  await vi.waitFor(() => expect(captures).toHaveLength(1));
  const saved = captures[0];
  expect(saved.state.nodes.research).toMatchObject({ status: "running", attempt: 1 });
  expect(saved.state.nodes["research:item:0"].status).toBe("completed");
  expect(saved.state.nodes["research:item:1"].error).toBe("retained failure");
  expect(saved.state.nodes["research:item:2"].status).toBe("running");
  expect(Object.keys(saved.graph.nodes)).toHaveLength(6);
  controller.abort();
  await releaseAfterPending(run, () => {
    gates.get("research:item:2")?.({ ok: true });
    human.resolve({ ok: true });
  });
  expect((await run).status).toBe("aborted");
  const spawned: string[] = [];
  const added: string[] = [];
  const restored = await runGraph(saved.graph, input, {
    restore: saved.state,
    host: {
      spawnAgent: async request => { spawned.push(request.nodeId); return { ok: true, output: "fresh" }; },
      awaitHumanGate: async () => ({ ok: true, output: "{}" }),
    },
    onNodeAdded: (id, _node, metadata) => {
      added.push(id);
      expect(metadata.dependencies).toEqual([]);
    },
  });
  expect(spawned).toEqual([]);
  expect(added).toEqual(["research:item:0", "research:item:1", "research:item:2"]);
  expect(restored.status).toBe("failed");
  expect(restored.nodes.research.attempt).toBe(1);
  expect(restored.nodes["research:item:2"].attempt).toBe(1);
  expect(restored.outputs.evidence).toMatchObject([
    { status: "completed", output: "retained", attempt: 1 },
    { status: "failed", error: "retained failure", attempt: 1 },
    { status: "failed", error: "Execution budget exhausted", attempt: 1 },
  ]);
});
