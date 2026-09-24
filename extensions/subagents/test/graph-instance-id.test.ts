import { describe, expect, it, vi } from "vitest";
import type { AgentGraph } from "../src/graph/ir.js";
import { runGraph } from "../src/graph/run-graph.js";
import type { SchedulerState } from "../src/graph/scheduler.js";
import { deferred, releaseAfterPending } from "./graph-drain.fixture.js";

const graph: AgentGraph = { version: 2, nodes: {
  left: { type: "agent", name: "Same", agent: "worker", prompt: "a" },
  right: { type: "agent", name: "Same", agent: "worker", prompt: "b" },
}, edges: [] };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("v2 runtime identity", () => {
  it("keeps duplicate names separate and dispatches only durable canonical UUIDs", async () => {
    let saved: SchedulerState | undefined;
    const spawnAgent = vi.fn(async (request: { nodeId: string }) => {
      expect(request.nodeId).toMatch(uuid);
      expect(saved?.runtime?.manifest.some(row => row.instanceId === request.nodeId)).toBe(true);
      return { ok: true, output: "ok" };
    });
    const result = await runGraph(graph, {}, { host: { spawnAgent }, onCheckpoint: state => { saved = state; } });
    expect(result.status).toBe("completed");
    expect(new Set(spawnAgent.mock.calls.map(([request]) => request.nodeId)).size).toBe(2);
    expect(saved?.runtime?.manifest.map(row => row.nodeKey)).toEqual(["left", "right"]);
  });

  it("rejects allocator collisions and noncanonical IDs before dispatch", async () => {
    for (const value of ["bad", "00000000-0000-4000-8000-000000000001"]) {
      const spawnAgent = vi.fn();
      await expect(runGraph(graph, {}, { host: { spawnAgent }, allocateInstanceId: () => value, onCheckpoint: () => {} })).rejects.toThrow();
      expect(spawnAgent).not.toHaveBeenCalled();
    }
  });

  it("restores IDs without allocating; fresh replay allocates new IDs", async () => {
    let saved: SchedulerState | undefined;
    const ids: string[] = [];
    const host = { spawnAgent: async (request: { nodeId: string }) => { ids.push(request.nodeId); return { ok: true, output: "ok" }; } };
    await runGraph(graph, {}, { host, onCheckpoint: state => { saved = state; } });
    if (!saved?.runtime) throw new Error("missing checkpoint");
    const original = saved.runtime.manifest.map(row => row.instanceId);
    const allocate = vi.fn(() => "bad");
    await runGraph(graph, {}, { host, restore: saved, allocateInstanceId: allocate, onCheckpoint: () => {} });
    expect(allocate).not.toHaveBeenCalled();
    expect(ids).toEqual(original);
    await runGraph(graph, {}, { host, onCheckpoint: () => {} });
    expect(ids.slice(2).every(id => original.every(previous => previous !== id))).toBe(true);
  });
});

it("checkpoints fanout children before dispatch and restores the same IDs after dispatch crashes", async () => {
  const fanout: AgentGraph = { version: 2, nodes: { work: { type: "fanout", items: { path: "$" }, itemSchema: { type: "object" }, dispatch: { path: "$.kind", cases: { x: "worker" } }, prompt: `\${item}` } }, edges: [] };
  let saved: SchedulerState | undefined;
  let effective = fanout;
  let dispatched: { state: SchedulerState; graph: AgentGraph } | undefined;
  const controller = new AbortController();
  const ids: string[] = [];
  const execution = deferred<{ ok: boolean }>();
  const pending = runGraph(fanout, [{ kind: "x" }], {
    signal: controller.signal,
    onCheckpoint: (state, graph) => { saved = state; effective = graph; },
    host: { spawnAgent: async request => {
      ids.push(request.nodeId);
      expect(saved?.runtime?.manifest.some(row => row.instanceId === request.nodeId)).toBe(true);
      if (saved) dispatched = { state: saved, graph: effective }; // crash checkpoint, before graceful cancellation
      controller.abort();
      return execution.promise;
    } },
  });
  await releaseAfterPending(pending, () => execution.resolve({ ok: true }));
  await pending;
  if (!dispatched) throw new Error("missing dispatch checkpoint");
  const allocate = vi.fn(() => "bad");
  await runGraph(dispatched.graph, [{ kind: "x" }], { restore: dispatched.state, reclaimedDeadWriter: true, allocateInstanceId: allocate, onCheckpoint: () => {}, host: { reconcileDrain: async () => true, spawnAgent: async request => { ids.push(request.nodeId); return { ok: true, output: "ok" }; } } });
  expect(allocate).not.toHaveBeenCalled();
  expect(ids).toHaveLength(1); // The interrupted admission consumed its sole execution.
});

it("rejects asynchronous checkpoint writers before dispatch", async () => {
  const spawnAgent = vi.fn();
  await expect(runGraph(graph, {}, { host: { spawnAgent }, onCheckpoint: async () => {} })).rejects.toThrow(/synchronous/);
  expect(spawnAgent).not.toHaveBeenCalled();
});

it("checkpoints nested v2 runs inside their parent before publishing rows or dispatch", async () => {
  const parent: AgentGraph = { nodes: { nested: { type: "graph", graph: "child" } }, edges: [] };
  let saved: SchedulerState | undefined;
  let effective = parent;
  const added: number[] = [];
  const spawnAgent = vi.fn(async (request: { nodeId: string }) => {
    expect(saved?.runtime?.nested?.nested?.state.runtime?.manifest.some(row => row.instanceId === request.nodeId)).toBe(true);
    return { ok: true, output: "ok" };
  });
  const result = await runGraph(parent, {}, { host: { spawnAgent }, loadGraph: () => graph, onCheckpoint: (state, definition) => { saved = state; effective = definition; }, onNodeAdded: (_id, _node, metadata) => { if (metadata.instance) added.push(metadata.instance.ordinal); } });
  expect(result.status).toBe("completed");
  expect(spawnAgent).toHaveBeenCalledTimes(2);
  expect(added).toEqual([1, 2]);
  const allocate = vi.fn(() => "bad");
  if (!saved) throw new Error("missing parent checkpoint");
  const restoredOrdinals: number[] = [];
  await runGraph(effective, {}, { host: { spawnAgent }, restore: saved, allocateInstanceId: allocate, loadGraph: () => graph, onCheckpoint: () => {}, onNodeAdded: (_id, _node, metadata) => { if (metadata.instance) restoredOrdinals.push(metadata.instance.ordinal); } });
  expect(restoredOrdinals).toEqual([1, 2]);
  expect(allocate).not.toHaveBeenCalled();
  expect(spawnAgent).toHaveBeenCalledTimes(2);
});

it.each(["missing mapping", "missing counter", "low counter"])("rejects nested %s before writes or dispatch", async mutation => {
  const parent: AgentGraph = { version: 2, nodes: { nested: { type: "graph", graph: "child" } }, edges: [] };
  let saved: SchedulerState | undefined;
  await runGraph(parent, {}, { loadGraph: () => graph, onCheckpoint: state => { saved = state; }, host: { spawnAgent: async () => ({ ok: true, output: "ok" }) } });
  if (!saved?.runtime?.nested?.nested) throw new Error("missing nested fixture");
  const key = Object.keys(saved.runtime.nested.nested.ordinals)[0];
  if (mutation === "missing mapping") delete saved.runtime.nested.nested.ordinals[key];
  if (mutation === "missing counter") delete saved.runtime.nextOrdinal;
  if (mutation === "low counter") saved.runtime.nextOrdinal = 1;
  const onCheckpoint = vi.fn(); const spawnAgent = vi.fn();
  await expect(runGraph(parent, {}, { restore: saved, onCheckpoint, host: { spawnAgent } })).rejects.toThrow();
  expect(onCheckpoint).not.toHaveBeenCalled(); expect(spawnAgent).not.toHaveBeenCalled();
});

it("reserves and restores every three-level nested ordinal before publishing rows", async () => {
  const { validateGraphRestore } = await import("../src/graph/graph-restore-validation.js");
  const { restoredNestedRows } = await import("../src/graph/graph-nested-checkpoint.js");
  const top: AgentGraph = { version: 2, nodes: { middle: { type: "graph", graph: "middle" } }, edges: [] };
  const middle: AgentGraph = { nodes: { leaf: { type: "graph", graph: "leaf" } }, edges: [] };
  const leaf: AgentGraph = { version: 2, nodes: { worker: { type: "agent", agent: "fixture", prompt: "leaf" } }, edges: [] };
  let saved: SchedulerState | undefined;
  await runGraph(top, {}, { runId: "nested-depth", loadGraph: name => name === "middle" ? middle : leaf, host: { spawnAgent: async () => ({ ok: true, output: "ok" }) }, onCheckpoint: (state, effective) => { validateGraphRestore(state, effective); saved = structuredClone(state); } });
  const nested = saved?.runtime?.nested?.middle;
  if (!saved || !nested) throw new Error("missing nested checkpoint");
  const rows = restoredNestedRows(nested, "middle");
  expect(rows.map(row => row.id)).toEqual(["middle/leaf", "middle/leaf/worker"]);
  expect(rows.map(row => row.ordinal)).toEqual([1, 2]);
  expect(saved.runtime?.nextOrdinal).toBe(3);
  const spawnAgent = vi.fn();
  await runGraph(top, {}, { runId: "nested-depth", restore: saved, loadGraph: name => name === "middle" ? middle : leaf, host: { spawnAgent }, onCheckpoint: (state, effective) => validateGraphRestore(state, effective) });
  expect(spawnAgent).not.toHaveBeenCalled();
});

it("does not mistake inherited object names for restored nested ownership", async () => {
  const { authorizeGraphResume } = await import("../src/graph/graph-resume-preflight.js");
  const parent: AgentGraph = { version: 2, nodes: { constructor: { type: "graph" as const, graph: "child" } }, edges: [] };
  const child: AgentGraph = { nodes: { worker: { type: "agent", agent: "fixture", prompt: "child" } }, edges: [] };
  let saved: SchedulerState | undefined; const controller = new AbortController(); controller.abort("shutdown");
  await runGraph(parent, {}, { runId: "agr_prototype", signal: controller.signal, host: { spawnAgent: vi.fn() }, onCheckpoint: state => { saved = structuredClone(state); } });
  if (!saved?.runtime) throw new Error("missing checkpoint");
  saved.runtime.nested = {};
  authorizeGraphResume({ version: 2, runId: "agr_prototype", graph: parent, state: saved, input: {}, waitingGate: "", savedAt: 0 }, { deny: () => undefined, load: () => child });
  const spawnAgent = vi.fn(async () => ({ ok: true, output: "ok" }));
  const result = await runGraph(parent, {}, { runId: "agr_prototype", restore: saved, loadGraph: () => child, host: { spawnAgent }, onCheckpoint: state => { saved = state; } });
  expect(result.status).toBe("completed"); expect(spawnAgent).toHaveBeenCalledTimes(1);
  expect(Object.hasOwn(saved.runtime?.nested ?? {}, "constructor")).toBe(true);
});

it("retains an older unbudgeted v2 checkpoint without inventing a run start", async () => {
  let saved: SchedulerState | undefined;
  await runGraph(graph, {}, { host: { spawnAgent: async () => ({ ok: true, output: "ok" }) }, onCheckpoint: state => { saved = state; } });
  if (!saved?.runtime) throw new Error("missing checkpoint");
  Reflect.deleteProperty(saved.runtime, "startedAt");
  const now = vi.fn(() => 2000); const spawnAgent = vi.fn();
  await runGraph(graph, {}, { restore: saved, now, host: { spawnAgent }, onCheckpoint: state => expect(state.runtime?.startedAt).toBeUndefined() });
  expect(now).not.toHaveBeenCalled(); expect(spawnAgent).not.toHaveBeenCalled();
});
it.each([-1, 1.5, Infinity, "1000"])("rejects invalid persisted start %s before side effects", async startedAt => {
  let saved: SchedulerState | undefined;
  await runGraph(graph, {}, { now: () => 1000, host: { spawnAgent: async () => ({ ok: true, output: "ok" }) }, onCheckpoint: state => { saved = state; } });
  if (!saved?.runtime) throw new Error("missing checkpoint");
  Reflect.set(saved.runtime, "startedAt", startedAt);
  const onCheckpoint = vi.fn(); const spawnAgent = vi.fn(); const allocateInstanceId = vi.fn();
  await expect(runGraph(graph, {}, { restore: saved, host: { spawnAgent }, onCheckpoint, allocateInstanceId })).rejects.toThrow();
  expect(onCheckpoint).not.toHaveBeenCalled(); expect(spawnAgent).not.toHaveBeenCalled(); expect(allocateInstanceId).not.toHaveBeenCalled();
});
