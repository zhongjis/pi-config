import { expect, it, vi } from "vitest";
import { createActor, toPromise } from "xstate";
import { graphLogic } from "../src/graph/graph-actor.js";
import { createGraphDomain } from "../src/graph/graph-domain.js";
import type { AgentGraph, GraphFragment } from "../src/graph/ir.js";
import { runGraph } from "../src/graph/run-graph.js";
import type { SchedulerState } from "../src/graph/scheduler.js";

const graph: AgentGraph = { version: 2, nodes: { e: { type: "expand", source: { path: "$" } } }, edges: [] };
const fragment: GraphFragment = { nodes: { child: { type: "agent", agent: "worker", prompt: "fixture" } }, edges: [] };
it("checkpoints running identity before actor creation and atomic insertion before registration and dispatch", async () => {
  const order: string[] = []; const frames: SchedulerState[] = [];
  const actor = createActor(graphLogic, { input: { graph, input: fragment, depth: 0, options: {
    onCheckpoint: state => { frames.push(state); order.push(state.nodes.e.status === "completed" && state.nodes.child?.status === "pending" ? "insert" : "checkpoint"); },
    onNodeAdded: id => { if (id === "child") order.push("register"); },
    onNodeUpdate: id => { if (id === "child") order.push("update"); },
    host: { spawnAgent: async () => { order.push("spawn"); return { ok: true }; } },
  } }, inspect: event => {
    if (event.type === "@xstate.actor" && Reflect.get(event.actorRef, "id") === "node:e") { expect(frames.at(-1)?.nodes.e).toMatchObject({ status: "running", attempt: 1, activation: 1, graphAttempt: 1 }); order.push("coordinator"); }
    if (event.type === "@xstate.event" && event.event.type === "COORD.ACK") { expect(frames.at(-1)?.nodes.e.status).toBe("completed"); order.push("ack"); }
  } });
  const result = toPromise(actor); actor.start(); expect((await result).status).toBe("completed");
  expect(order.indexOf("coordinator")).toBeLessThan(order.indexOf("insert"));
  expect(order.indexOf("insert")).toBeLessThan(order.indexOf("ack"));
  expect(order.indexOf("insert")).toBeLessThan(order.indexOf("register"));
  expect(order.indexOf("register")).toBeLessThan(order.indexOf("update"));
  expect(order.indexOf("register")).toBeLessThan(order.indexOf("spawn"));
  actor.stop();
});
it.each(["running", "completed"] as const)("writer failure at %s blocks topology publication and dispatch", async status => {
  const error = new Error("checkpoint failed"); const added: string[] = []; const spawn = vi.fn(async () => ({ ok: true }));
  await expect(runGraph(graph, fragment, { host: { spawnAgent: spawn }, onNodeAdded: id => { added.push(id); }, onCheckpoint: state => { if (state.nodes.e.status === status) throw error; } })).rejects.toBe(error);
  expect(added).not.toContain("child"); expect(spawn).not.toHaveBeenCalled();
});
it("restores interrupted coordinator identity and recomputes source without incrementing attempts", async () => {
  let saved: SchedulerState | undefined; const crash = new Error("crash");
  await expect(runGraph(graph, fragment, { host: { spawnAgent: async () => ({ ok: true }) }, onCheckpoint: state => {
    if (state.nodes.e.status === "running") { saved = structuredClone(state); throw crash; }
  } })).rejects.toBe(crash);
  if (!saved) throw new TypeError("Missing running checkpoint");
  const initial: SchedulerState[] = [];
  const restored = await runGraph(graph, fragment, { restore: saved, host: { spawnAgent: async () => ({ ok: true }) }, onCheckpoint: state => { initial.push(state); } });
  expect(initial[0].nodes.e).toEqual(saved.nodes.e);
  expect(restored.nodes.e).toMatchObject({ status: "completed", attempt: 1, activation: 1, graphAttempt: 1 });
  expect(initial.at(-1)?.runtime?.manifest.filter(row => row.binding === "child")).toHaveLength(1);
  expect(initial.at(-1)?.runtime?.manifest[0].instanceId).toBe(saved.runtime?.manifest[0].instanceId);
});
it("does not recreate an actor for a committed settled expansion", async () => {
  let saved: SchedulerState | undefined; let effective: AgentGraph | undefined;
  await runGraph(graph, fragment, { host: { spawnAgent: async () => ({ ok: true }) }, onCheckpoint: (state, definition) => { saved = state; effective = definition; } });
  if (!saved || !effective) throw new TypeError("Missing checkpoint");
  const children: string[] = [];
  const actor = createActor(graphLogic, { input: { graph: effective, input: fragment, depth: 0, options: { restore: saved, onCheckpoint: () => {}, host: { spawnAgent: async () => { throw new TypeError("Unexpected dispatch"); } } } }, inspect: event => { if (event.type === "@xstate.actor") children.push(String(Reflect.get(event.actorRef, "id"))); } });
  const result = toPromise(actor); actor.start(); expect((await result).status).toBe("completed");
  expect(children).not.toContain("node:e"); actor.stop();
});
it.each(["cancel", "shutdown"])("persists %s before coordinator cancellation without inserting", async reason => {
  const controller = new AbortController(); const frames: SchedulerState[] = [];
  const result = await runGraph(graph, fragment, { signal: controller.signal, host: { spawnAgent: async () => { throw new TypeError("Unexpected dispatch"); } }, onCheckpoint: state => {
    frames.push(state); if (state.nodes.e.status === "running" && !controller.signal.aborted) controller.abort(reason);
  } });
  expect(result.status).toBe("aborted"); expect(Object.keys(result.nodes)).toEqual(["e"]);
  expect(frames.at(-1)?.runtime?.cancelled).toBe(reason === "cancel" ? true : undefined);
  expect(result.nodes.e.status).toBe(reason === "cancel" ? "skipped" : "running");
});
it("allows expansion while the executor slot is occupied", async () => {
  let release: (() => void) | undefined; let inserted = false;
  const running = runGraph({ ...graph, nodes: { busy: { type: "agent", agent: "worker", prompt: "busy" }, ...graph.nodes } }, fragment, {
    concurrency: 1, onCheckpoint: state => { if (state.nodes.e.status === "completed") inserted = true; },
    host: { spawnAgent: async () => { if (!release) await new Promise<void>(resolve => { release = resolve; }); return { ok: true }; } },
  });
  try { await vi.waitFor(() => expect(inserted).toBe(true)); } finally { release?.(); }
  expect((await running).status).toBe("completed");
});
it("revalidates competing prepared insertions against current topology", () => {
  const domain = createGraphDomain({ graph: { ...graph, nodes: { ...graph.nodes, other: { type: "expand", source: { path: "$" } } } }, input: fragment, depth: 0, options: { onCheckpoint: () => {}, host: { spawnAgent: async () => ({ ok: true }) } } });
  const admissions = domain.plan();
  for (const admission of admissions) {
    if (admission.kind !== "expand") throw new TypeError("Expected coordinator");
    domain.coordinatorRequest({ type: "COORD.REQUEST", receipt: admission.input.receipt, requestSequence: 1, operation: { kind: "insert", fragment } });
  }
  expect(domain.projection.nodes.get("e")?.status).toBe("completed");
  expect(domain.projection.nodes.get("other")?.status).toBe("failed");
  expect(domain.instances.state.manifest.filter(row => row.binding === "child")).toHaveLength(1);
  const admission = admissions[0]; if (admission.kind !== "expand") throw new TypeError("Expected coordinator");
  expect(() => domain.coordinatorRequest({ type: "COORD.REQUEST", receipt: { ...admission.input.receipt, activation: 9 }, requestSequence: 2, operation: { kind: "insert", fragment } })).toThrow(/Stale/);
});
it("accepts exactly 500 effective nodes", async () => {
  const nodes = Object.fromEntries(Array.from({ length: 499 }, (_, i) => [String(i), { type: "agent" as const, agent: "worker", prompt: "fixture" }]));
  const result = await runGraph(graph, { nodes, edges: [] }, { concurrency: 50, onCheckpoint: () => {}, host: { spawnAgent: async () => ({ ok: true }) } });
  expect(result.status).toBe("completed"); expect(Object.keys(result.nodes)).toHaveLength(500);
});

it.each(["new-loop", "new-path"])("rejects %s reaching an existing barrier before any insertion or publication", async kind => {
  const ordinary = { type: "agent" as const, agent: "worker", prompt: "fixture" };
  const base: AgentGraph = { version: 2, nodes: {
    ...graph.nodes, review: ordinary, fix: ordinary,
    barrier: { type: "fanout", items: { path: "$.items" }, itemSchema: { type: "object" }, dispatch: { path: "$.kind", cases: { x: "worker" } }, prompt: "${item}" },
  }, edges: kind === "new-loop" ? [{ from: "review", to: "barrier" }] : [{ from: "fix", to: "review", loop: { maxIterations: 2 } }] };
  const addition: GraphFragment = { nodes: { bridge: ordinary }, edges: kind === "new-loop"
    ? [{ from: "bridge", to: "review", loop: { maxIterations: 2 } }]
    : [{ from: "review", to: "bridge" }, { from: "bridge", to: "barrier" }] };
  const added: string[] = [];
  const frames: { state: SchedulerState; graph: AgentGraph }[] = [];
  const result = await runGraph(base, { ...addition, items: [] }, {
    onCheckpoint: (state, effective) => { frames.push({ state, graph: effective }); },
    onNodeAdded: id => { added.push(id); },
    host: { spawnAgent: async () => ({ ok: true }) },
  });
  expect(result.nodes.e.status).toBe("failed");
  expect(result.nodes.e.error).toContain("can reach barrier");
  expect(result.nodes.bridge).toBeUndefined();
  expect(added).not.toContain("bridge");
  for (const frame of frames) {
    expect(Object.keys(frame.graph.nodes)).toEqual(Object.keys(base.nodes));
    expect(frame.graph.edges).toEqual(base.edges);
    expect(frame.state.runtime?.manifest.some(row => row.binding === "bridge")).toBe(false);
  }
});
