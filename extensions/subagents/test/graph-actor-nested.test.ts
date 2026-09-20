import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { createActor, toPromise } from "xstate";
import { graphLogic } from "../src/graph/graph-actor.js";
import type { ChildCheckpointRequest } from "../src/graph/graph-protocol.js";
import type { AgentGraph } from "../src/graph/ir.js";
import { subgraphLogic } from "../src/graph/subgraph-actor.js";

const child: AgentGraph = { version: 2, nodes: { leaf: { type: "agent", agent: "worker", prompt: "fixture" } }, edges: [] };
const graph: AgentGraph = { version: 2, nodes: { sub: { type: "graph", graph: "child" } }, edges: [] };
function parked() {
  let release: (() => void) | undefined; let writes = 0; let latest: ChildCheckpointRequest | undefined;
  const actor = createActor(graphLogic, { inspect: event => { if (event.type === "@xstate.event" && event.event.type === "CHECKPOINT.REQUEST") latest = event.event as ChildCheckpointRequest; }, input: { graph, input: {}, depth: 0, options: {
    loadGraph: () => child,
    onCheckpoint: () => { writes++; },
    host: { spawnAgent: async () => { await new Promise<void>(resolve => { release = resolve; }); return { ok: true }; } },
  } } });
  const result = toPromise(actor); actor.start();
  return { actor, result, release: () => { if (!release) throw new Error("Missing host"); release(); }, ready: () => !!release, writes: () => writes,
    request: (): ChildCheckpointRequest => {
      if (!latest) throw new Error("Missing child checkpoint");
      return { ...latest, frame: { ...latest.frame, state: structuredClone(latest.frame.state) } };
    },
  };
}
it("uses a native child graph and idempotently acknowledges its latest checkpoint", async () => {
  const run = parked(); await vi.waitFor(() => expect(run.ready()).toBe(true));
  const wrapper = run.actor.getSnapshot().children["node:sub"]; assert(wrapper);
  expect(wrapper).toHaveProperty("logic", subgraphLogic);
  const snapshot = wrapper.getSnapshot(); assert("children" in snapshot);
  expect(snapshot.children.graph).toHaveProperty("logic", graphLogic);
  const writes = run.writes(); run.actor.getSnapshot().children["node:sub"]?.send(run.request()); await setImmediate();
  expect(run.writes()).toBe(writes);
  run.release(); expect((await run.result).status).toBe("completed");
});
it.each(["conflict", "reorder", "stale"] as const)("fails closed on a nested checkpoint %s only after physical drain", async kind => {
  const run = parked(); await vi.waitFor(() => expect(run.ready()).toBe(true));
  const request = run.request();
  const completed = run.result.then(() => undefined, error => error);
  let settled = false; void completed.then(() => { settled = true; });
  if (kind === "conflict") request.frame.state.nodes.leaf.attempt++;
  run.actor.getSnapshot().children["node:sub"]?.send(kind === "reorder" ? { ...request, sequence: request.sequence + 2 } : kind === "stale" ? { ...request, invocation: "stale" } : request);
  await setImmediate(); expect(settled).toBe(false);
  expect(run.actor.getSnapshot().context.failure?.error).toBeInstanceOf(TypeError);
  const writes = run.writes(); run.release();
  expect(await completed).toBeInstanceOf(TypeError); expect(run.writes()).toBe(writes);
});
it("propagates a top-level writer error through nested acknowledgment and drains", async () => {
  const error = new Error("nested commit failed"); let spawns = 0;
  const actor = createActor(graphLogic, { input: { graph, input: {}, depth: 0, options: {
    loadGraph: () => child, onCheckpoint: state => { if (state.runtime?.nested) throw error; },
    host: { spawnAgent: async () => { spawns++; return { ok: true }; } },
  } } });
  const result = toPromise(actor); actor.start();
  await expect(result).rejects.toBe(error); expect(spawns).toBe(0);
});
