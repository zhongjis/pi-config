import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { createActor, toPromise } from "xstate";
import { graphLogic } from "../src/graph/graph-actor.js";
import type { AgentGraph } from "../src/graph/ir.js";
import type { GraphControl } from "../src/graph/run-graph.js";
import type { SchedulerState } from "../src/graph/scheduler.js";

const leaf: AgentGraph = { version: 2, nodes: { leaf: { type: "agent", agent: "worker", prompt: "fixture" } }, edges: [] };
const middle: AgentGraph = { version: 2, nodes: { inner: { type: "graph", graph: "leaf" } }, edges: [] };
const graph: AgentGraph = { version: 2, nodes: { outer: { type: "graph", graph: "middle" } }, edges: [] };
const loadGraph = (name: string) => name === "middle" ? middle : name === "leaf" ? leaf : undefined;
const deepest = (state: SchedulerState | undefined) => state?.runtime?.nested?.outer.state.runtime?.nested?.inner.state;

it("commits three-level checkpoints before cascading ACKs, ordinal publication and dispatch", async () => {
  let committed: SchedulerState | undefined;
  const revisions = new Map<string, number>();
  const invocations = new Map<string, string>();
  const acknowledged = new Set<string>();
  const published = new Set<string>();
  const record = (state: SchedulerState): void => {
    assert(state.runtime);
    revisions.set(state.runtime.runId, state.runtime.revision);
    for (const nested of Object.values(state.runtime.nested ?? {})) record(nested.state);
  };
  const spawnAgent = vi.fn(async () => {
    expect(deepest(committed)?.nodes.leaf.status).toBe("running");
    expect(published.has("outer/inner/leaf")).toBe(true);
    return { ok: true, output: "done" };
  });
  const actor = createActor(graphLogic, {
    input: { graph, input: {}, depth: 0, options: {
      loadGraph, host: { spawnAgent },
      onCheckpoint: state => { committed = state; record(state); },
      onNodeAdded: (id, _node, metadata) => {
        if (!id.includes("/")) return;
        assert(metadata.materializationKey);
        const invocation = metadata.materializationKey.slice(0, metadata.materializationKey.lastIndexOf("/"));
        expect(acknowledged.has(invocation)).toBe(true);
        expect(committed?.runtime?.nested?.outer.ordinals[metadata.materializationKey]).toBe(metadata.ordinal);
        published.add(id);
      },
      onNodeUpdate: id => { if (id.includes("/")) expect(published.has(id)).toBe(true); },
    } },
    inspect: event => {
      if (event.type !== "@xstate.event") return;
      if (event.event.type === "CHECKPOINT.REQUEST" && event.sourceRef) invocations.set(event.sourceRef.sessionId, event.event.invocation);
      if (event.event.type !== "CHECKPOINT.ACK") return;
      const invocation = invocations.get(event.actorRef.sessionId);
      assert(invocation);
      expect(revisions.get(invocation)).toBeGreaterThanOrEqual(event.event.sequence);
      acknowledged.add(invocation);
    },
  });
  const result = toPromise(actor); actor.start();
  try {
    expect((await result).status).toBe("completed");
    expect(spawnAgent).toHaveBeenCalledTimes(1);
    expect(acknowledged.size).toBe(2);
    expect(published).toEqual(new Set(["outer/inner", "outer/inner/leaf"]));
  } finally { actor.stop(); }
});

it.each(["skip", "cancel", "failure"] as const)("retains three-level ownership during %s until a noncooperative human gate drains", async kind => {
  const gated: AgentGraph = { version: 2, nodes: { leaf: { type: "human_gate", prompt: "fixture", outputSchema: { type: "object" } } }, edges: [] };
  const parent: AgentGraph = { ...graph, nodes: { ...graph.nodes, sibling: { type: "agent", agent: "worker", prompt: "fixture" } } };
  let release: (() => void) | undefined;
  let signal: AbortSignal | undefined;
  let control: GraphControl | undefined;
  let committed: SchedulerState | undefined;
  let writes = 0;
  let settled = false;
  const failure = new Error("cascade infrastructure failure");
  const spawnAgent = vi.fn(async () => ({ ok: true }));
  const actor = createActor(graphLogic, { input: { graph: parent, input: {}, depth: 0, options: {
    concurrency: 1, loadGraph: name => name === "leaf" ? gated : loadGraph(name),
    onControl: value => { control = value; },
    onCheckpoint: state => { committed = state; writes++; },
    host: { spawnAgent, awaitHumanGate: async (_request, abort) => {
      signal = abort;
      await new Promise<void>(resolve => { release = resolve; });
      return { ok: true, output: "ignored after cancellation" };
    } },
  } } });
  const result = toPromise(actor).then(value => { settled = true; return value; }, error => { settled = true; return error; });
  actor.start();
  try {
    await vi.waitFor(() => expect(release).toBeDefined());
    assert(control);
    if (kind === "skip") expect(control.skip(0)).toBe(true);
    else actor.send(kind === "failure" ? { type: "FAIL", error: failure } : { type: "CANCEL", reason: "user" });
    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
    await setImmediate();
    expect(settled).toBe(false);
    expect(actor.getSnapshot().children["node:outer"]).toBeDefined();
    expect(committed?.nodes.sibling.status).toBe("pending");
    expect(spawnAgent).not.toHaveBeenCalled();
    const beforeDrain = writes;
    assert(release); release();
    const outcome = await result;
    if (kind === "failure") {
      expect(outcome).toBe(failure);
      expect(writes).toBe(beforeDrain);
    } else {
      expect(outcome).toMatchObject({ status: kind === "cancel" ? "aborted" : "completed" });
      if (kind === "skip") expect(committed?.nodes.outer.status).toBe("skipped");
      else {
        expect(committed?.runtime?.cancelled).toBe(true);
        expect(["skipped", "failed"]).toContain(committed?.nodes.outer.status);
      }
      expect(deepest(committed)?.runtime?.executionLedger?.some(row => "payload" in row && row.payload.kind === "drain-ack")).toBe(true);
    }
    expect(spawnAgent).toHaveBeenCalledTimes(kind === "skip" ? 1 : 0);
  } finally { release?.(); await result; actor.stop(); }
});
