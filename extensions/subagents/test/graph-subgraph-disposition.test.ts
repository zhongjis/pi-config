import assert from "node:assert/strict";
import { expect, it, vi } from "vitest";
import { validateCheckpointTransition } from "../src/graph/graph-checkpoint-transition.js";
import { validateGraphRestore } from "../src/graph/graph-restore-validation.js";
import type { AgentGraph } from "../src/graph/ir.js";
import { type GraphControl, runGraph } from "../src/graph/run-graph.js";
import type { SchedulerState } from "../src/graph/scheduler.js";

const child: AgentGraph = { version: 2, nodes: { a: { type: "agent", agent: "worker", prompt: "x" } }, edges: [] };
const graph: AgentGraph = { version: 2, nodes: { sub: { type: "graph", graph: "child" } }, edges: [] };
const snapshot = (state: SchedulerState) => ({ version: 2 as const, runId: state.runtime?.runId ?? "", state, graph, input: {}, waitingGate: "", savedAt: 0 });

it.each(["skip", "retry"] as const)("recovers subgraph %s at both drain crash boundaries without stale replay", async reason => {
  const frames: SchedulerState[] = []; let control: GraphControl | undefined; let release: (() => void) | undefined;
  const running = runGraph(graph, {}, { loadGraph: () => child, onControl: value => { control = value; }, onCheckpoint: state => frames.push(state), host: { spawnAgent: async () => {
    if (!release) await new Promise<void>(resolve => { release = resolve; });
    return { ok: true, output: "ok" };
  } } });
  await vi.waitFor(() => expect(release).toBeDefined()); assert(control); assert(release);
  const boundary = frames.length;
  expect(control[reason](0)).toBe(true);
  await vi.waitFor(() => expect(frames.length).toBeGreaterThan(boundary));
  const beforeStop = frames[boundary]; assert(beforeStop);
  expect(control[reason === "skip" ? "retry" : "skip"](0)).toBe(false);
  release(); await running;
  const afterDrain = frames.find(state => state.nodes.sub.status === "running" && state.runtime?.nested?.sub.state.runtime?.executionLedger?.some(row => "payload" in row && row.payload.kind === "drain-ack"));
  assert(afterDrain);
  for (const initial of [beforeStop, afterDrain]) {
    let recovery: SchedulerState | undefined; let admission: SchedulerState | undefined; let latest = initial;
    const spawnAgent = vi.fn(async () => ({ ok: true, output: "ok" }));
    const result = await runGraph(graph, {}, { restore: initial, loadGraph: () => child, reclaimedDeadWriter: true, host: { reconcileDrain: async () => true, spawnAgent }, onCheckpoint: state => {
      validateGraphRestore(state, graph); validateCheckpointTransition(snapshot(latest), snapshot(state));
      recovery ??= state; latest = state;
      if (state.nodes.sub.status === "running" && state.nodes.sub.attempt === 2) admission ??= state;
    } });
    expect(result.nodes.sub).toMatchObject({ status: reason === "skip" ? "skipped" : "completed", attempt: reason === "skip" ? 1 : 2, activation: 1, graphAttempt: reason === "skip" ? 1 : 2 });
    expect(spawnAgent).toHaveBeenCalledTimes(reason === "skip" ? 0 : 1);
    assert(recovery);
    const repeat = await runGraph(graph, {}, { restore: recovery, loadGraph: () => child, reclaimedDeadWriter: true, host: { reconcileDrain: async () => true, spawnAgent }, onCheckpoint: () => {} });
    expect(repeat.nodes.sub.attempt).toBe(result.nodes.sub.attempt);
    if (admission) {
      const resumed = await runGraph(graph, {}, { restore: admission, loadGraph: () => child, reclaimedDeadWriter: true, host: { reconcileDrain: async () => true, spawnAgent }, onCheckpoint: () => {} });
      expect(resumed.nodes.sub).toMatchObject({ attempt: 2, activation: 1, graphAttempt: 2 });
    }
    spawnAgent.mockClear();
    await runGraph(graph, {}, { restore: latest, host: { spawnAgent }, onCheckpoint: () => {} });
    expect(spawnAgent).not.toHaveBeenCalled();
  }
});

it("rejects malformed, foreign, stale and rewritten parent dispositions", async () => {
  const frames: SchedulerState[] = []; let control: GraphControl | undefined; let release: (() => void) | undefined;
  const running = runGraph(graph, {}, { loadGraph: () => child, onControl: value => { control = value; }, onCheckpoint: state => frames.push(state), host: { spawnAgent: async () => {
    await new Promise<void>(resolve => { release = resolve; }); return { ok: true, output: "ok" };
  } } });
  await vi.waitFor(() => expect(release).toBeDefined()); assert(control); assert(release);
  const before = frames.at(-1); const boundary = frames.length; control.skip(0); release(); await running;
  const saved = frames[boundary]; assert(saved?.runtime); assert(before);
  const row = saved.runtime.subgraphDispositions?.[0]; assert(row);
  const malformed: unknown[] = [null, {}, [null], [{ ...row, reason: "cancel" }], [{ ...row, runId: "foreign" }], [{ ...row, instanceId: "missing" }], [{ ...row, activation: 0 }], [{ ...row, graphAttempt: 2 }], [{ ...row, attempt: 2 }], [{ ...row, extra: true }], [row, row]];
  for (const records of malformed) {
    const bad = structuredClone(saved); assert(bad.runtime); Reflect.set(bad.runtime, "subgraphDispositions", records);
    expect(() => validateGraphRestore(bad, graph)).toThrow(/subgraph disposition/i);
  }
  const wrongType: AgentGraph = { ...graph, nodes: { sub: { type: "agent", agent: "worker", prompt: "x" } } };
  expect(() => validateGraphRestore(saved, wrongType)).toThrow();
  for (const records of [[], [{ ...row, reason: "retry" as const }]]) {
    const bad = structuredClone(saved); assert(bad.runtime); bad.runtime.subgraphDispositions = records;
    expect(() => validateCheckpointTransition(snapshot(saved), snapshot(bad))).toThrow(/rewrites subgraph dispositions/);
  }
  const stale = structuredClone(before); stale.nodes.sub.status = "pending";
  expect(() => validateCheckpointTransition(snapshot(stale), snapshot(saved))).toThrow(/stale subgraph disposition/);
  const forged = structuredClone(saved); forged.nodes.sub.status = "completed";
  expect(() => validateGraphRestore(forged, graph)).toThrow(/subgraph disposition settlement/);
});

it.each(["skip", "retry"] as const)("fails closed on a nested validation drain before applying parent %s", async reason => {
  const gated: AgentGraph = { ...child, nodes: { a: { type: "agent", agent: "worker", prompt: "x", validation: { gate: "true" } } } };
  const frames: SchedulerState[] = []; let control: GraphControl | undefined; let release: (() => void) | undefined;
  const running = runGraph(graph, {}, { loadGraph: () => gated, onControl: value => { control = value; }, onCheckpoint: state => frames.push(state), host: { spawnAgent: async () => ({ ok: true, output: "ok" }), runGate: async () => {
    if (!release) await new Promise<void>(resolve => { release = resolve; }); return { ok: true, output: "" };
  } } });
  await vi.waitFor(() => expect(release).toBeDefined()); assert(control); assert(release);
  const boundary = frames.length; control[reason](0); release();
  await running;
  const saved = frames[boundary]; assert(saved); const original = structuredClone(saved);
  const onCheckpoint = vi.fn(); const spawnAgent = vi.fn();
  await expect(runGraph(graph, {}, { restore: saved, reclaimedDeadWriter: true, onCheckpoint, host: { reconcileDrain: async () => true, spawnAgent } })).rejects.toThrow("Unreconciled execution drain");
  expect(onCheckpoint).not.toHaveBeenCalled(); expect(spawnAgent).not.toHaveBeenCalled(); expect(saved).toEqual(original);
});

it("rejects an undrained nested descendant in cancelled historical subgraph state", async () => {
  const leaf: AgentGraph = { version: 2, nodes: { a: { type: "agent", agent: "worker", prompt: "x", validation: { gate: "true" } } }, edges: [] };
  const middle: AgentGraph = { version: 2, nodes: { nested: { type: "graph", graph: "leaf" } }, edges: [] };
  const parent: AgentGraph = { version: 2, nodes: { sub: { type: "graph", graph: "middle" } }, edges: [] };
  const loadGraph = (name: string) => name === "middle" ? middle : name === "leaf" ? leaf : undefined;
  const frames: SchedulerState[] = []; let control: GraphControl | undefined; let release: (() => void) | undefined;
  const running = runGraph(parent, {}, { loadGraph, onControl: value => { control = value; }, onCheckpoint: state => frames.push(state), host: {
    spawnAgent: async () => ({ ok: true, output: "ok" }),
    runGate: async () => { if (!release) await new Promise<void>(resolve => { release = resolve; }); return { ok: true, output: "" }; },
  } });
  await vi.waitFor(() => expect(release).toBeDefined()); assert(control); assert(release);
  expect(control.retry(0)).toBe(true); release(); await running;
  const captured = frames.find(state => state.runtime?.nested?.sub.previous?.[0].state.runtime?.cancelled === true);
  assert(captured);
  const saved = structuredClone(captured);
  const historical = saved.runtime?.nested?.sub.previous?.[0];
  assert(historical?.state.runtime?.cancelled);
  const descendant = historical.state.runtime.nested?.nested;
  assert(descendant?.state.runtime?.executionLedger);
  const ledger = descendant.state.runtime.executionLedger.filter(row => !("payload" in row && row.payload.kind === "drain-ack"));
  expect(ledger).toHaveLength(descendant.state.runtime.executionLedger.length - 1);
  Object.assign(descendant.state.runtime, { executionLedger: ledger });
  expect(() => validateGraphRestore(saved, parent)).not.toThrow();
  const original = structuredClone(saved); const onCheckpoint = vi.fn(); const spawnAgent = vi.fn(); const runGate = vi.fn();
  await expect(runGraph(parent, {}, { restore: saved, loadGraph, reclaimedDeadWriter: true, onCheckpoint, host: { reconcileDrain: async () => true, spawnAgent, runGate } })).rejects.toThrow("Undrained nested execution history");
  expect(onCheckpoint).not.toHaveBeenCalled(); expect(spawnAgent).not.toHaveBeenCalled(); expect(runGate).not.toHaveBeenCalled(); expect(saved).toEqual(original);
});
