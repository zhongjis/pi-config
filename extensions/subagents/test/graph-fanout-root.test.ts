import { expect, it, vi } from "vitest";
import { createActor, toPromise } from "xstate";
import { type CoordinatorRequest, CoordinatorRequestJournal } from "../src/graph/coordinator-protocol.js";
import { graphLogic } from "../src/graph/graph-actor.js";
import { createGraphDomain } from "../src/graph/graph-domain.js";
import { validateSchedulerState } from "../src/graph/graph-state-validation.js";
import type { AgentGraph, FanoutNode } from "../src/graph/ir.js";
import { type GraphControl, runGraph } from "../src/graph/run-graph.js";
import type { SchedulerState } from "../src/graph/scheduler.js";

const fanout: FanoutNode = { type: "fanout", items: { path: "$" }, itemSchema: { type: "object" }, dispatch: { path: "$.kind", cases: { work: "worker" } }, prompt: "${item}" };
const graph: AgentGraph = { version: 2, nodes: { f: fanout }, edges: [], outputs: { result: { node: "f", path: "$" } } };
const input = [{ kind: "work" }];
it("commits admission before coordinator spawn and materialization before leaf registration; actors are root siblings", async () => {
  const order: string[] = []; const frames: SchedulerState[] = [];
  const actor = createActor(graphLogic, { input: { graph, input, depth: 0, options: {
    concurrency: 1,
    onCheckpoint: state => { frames.push(state); if (state.collections?.f) order.push("materialized"); },
    onNodeAdded: id => { if (id === "f:item:0") order.push("register"); },
    onNodeUpdate: id => { if (id === "f:item:0") order.push("update"); },
    host: { spawnAgent: async () => { order.push("spawn"); return { ok: true, output: "evidence" }; } },
  } }, inspect: event => {
    if (event.type === "@xstate.actor" && Reflect.get(event.actorRef, "id") === "node:f") {
      expect(frames.at(-1)?.nodes.f).toMatchObject({ status: "running", attempt: 1, activation: 1, graphAttempt: 1 }); order.push("coordinator");
    }
    if (event.type === "@xstate.event" && event.event.type === "COORD.ACK") {
      const operation: unknown = Reflect.get(event.event, "operation");
      if (operation && typeof operation === "object" && Reflect.get(operation, "kind") === "materialize") expect(frames.at(-1)?.collections?.f).toHaveLength(1);
      if (operation && typeof operation === "object" && Reflect.get(operation, "kind") === "aggregate") expect(frames.at(-1)?.nodes.f.status).toBe("completed");
    }
  } });
  let sawSiblings = false;
  actor.subscribe(snapshot => { if (snapshot.children["node:f"] && snapshot.children["node:f:item:0"]) sawSiblings = true; });
  const result = toPromise(actor); actor.start(); expect((await result).status).toBe("completed");
  expect(sawSiblings).toBe(true);
  expect(order.indexOf("coordinator")).toBeLessThan(order.indexOf("materialized"));
  expect(order.indexOf("materialized")).toBeLessThan(order.indexOf("register"));
  expect(order.indexOf("register")).toBeLessThan(order.indexOf("update"));
  expect(order.indexOf("register")).toBeLessThan(order.indexOf("spawn")); actor.stop();
});
it.each(["admission", "materialization", "settlement"])("fails and drains a writer at %s without publishing uncommitted facts", async boundary => {
  const error = new Error("writer"); const added: string[] = []; const updates: string[] = []; const spawn = vi.fn(async () => ({ ok: true }));
  await expect(runGraph(graph, input, { host: { spawnAgent: spawn }, onNodeAdded: id => { added.push(id); }, onNodeUpdate: (id, run) => { updates.push(`${id}:${run.status}`); }, onCheckpoint: state => {
    if (boundary === "admission" && state.nodes.f.status === "running" || boundary === "materialization" && state.collections?.f || boundary === "settlement" && state.nodes.f.status === "completed") throw error;
  } })).rejects.toBe(error);
  if (boundary !== "settlement") { expect(added).not.toContain("f:item:0"); expect(spawn).not.toHaveBeenCalled(); }
  expect(updates).not.toContain("f:completed");
});
it.each(["admission", "materialization", "settlement"])("restores %s without replacing owner attempts, definitions or UUIDs", async boundary => {
  const frames: { state: SchedulerState; graph: AgentGraph }[] = [];
  await runGraph(graph, input, { host: { spawnAgent: async () => ({ ok: true, output: "evidence" }) }, onCheckpoint: (state, effective) => { frames.push({ state, graph: effective }); } });
  const saved = frames.find(({ state }) => boundary === "admission" ? state.nodes.f.status === "running" && !state.collections?.f : boundary === "materialization" ? !!state.collections?.f && state.nodes["f:item:0"].status === "pending" : state.nodes.f.status === "completed");
  if (!saved) throw new TypeError("Missing checkpoint");
  const checkpoints: SchedulerState[] = []; const created: string[] = [];
  const actor = createActor(graphLogic, { input: { graph: saved.graph, input, depth: 0, options: { restore: saved.state, host: { spawnAgent: async () => ({ ok: true, output: "evidence" }) }, onCheckpoint: state => { checkpoints.push(state); } } }, inspect: event => { if (event.type === "@xstate.actor") created.push(String(Reflect.get(event.actorRef, "id"))); } });
  const result = toPromise(actor); actor.start(); expect((await result).nodes.f.attempt).toBe(1);
  expect(checkpoints[0].nodes.f).toEqual(saved.state.nodes.f);
  const manifest = checkpoints.at(-1)?.runtime?.manifest;
  for (const row of saved.state.runtime?.manifest ?? []) expect(manifest?.find(item => item.binding === row.binding)).toEqual(row);
  expect(manifest?.filter(row => row.binding === "f:item:0")).toHaveLength(1);
  expect(created.includes("node:f")).toBe(boundary !== "settlement"); actor.stop();
});
it.each(["cancel", "shutdown"])("cancels during materialization ACK (%s) and keeps leaf drain independent", async reason => {
  const controller = new AbortController(); let parked: (() => void) | undefined; let control: GraphControl | undefined;
  const frames: SchedulerState[] = [];
  const running = runGraph(graph, input, { signal: controller.signal, onControl: value => { control = value; },
    onCheckpoint: state => { frames.push(state); }, host: { spawnAgent: async () => { await new Promise<void>(resolve => { parked = resolve; }); return { ok: true }; } },
  });
  await vi.waitFor(() => expect(parked).toBeDefined());
  expect(control?.skip(0)).toBe(false); expect(control?.retry(0)).toBe(false);
  controller.abort(reason);
  let finished = false; void running.then(() => { finished = true; });
  try {
    await vi.waitFor(() => expect(frames.at(-1)?.nodes.f.status).toBe(reason === "cancel" ? "skipped" : "running"));
    expect(finished).toBe(false);
  } finally { parked?.(); }
  expect((await running).status).toBe("aborted");
});
it.each(["cancel", "shutdown"])("persists %s during outstanding materialization ACK without leaf dispatch", async reason => {
  const controller = new AbortController(); const spawn = vi.fn(async () => ({ ok: true }));
  const result = await runGraph(graph, input, { signal: controller.signal, host: { spawnAgent: spawn }, onCheckpoint: state => {
    if (state.collections?.f && !controller.signal.aborted) controller.abort(reason);
  } });
  expect(result.status).toBe("aborted"); expect(spawn).not.toHaveBeenCalled();
  expect(result.nodes.f.status).toBe(reason === "cancel" ? "skipped" : "running");
});
it("validates and restores a cancelled materialized collection without redispatch", async () => {
  const controller = new AbortController(); const frames: { state: SchedulerState; graph: AgentGraph }[] = [];
  const result = await runGraph(graph, input, { signal: controller.signal, host: { spawnAgent: async () => { throw new TypeError("Unexpected dispatch"); } }, onCheckpoint: (state, effective) => {
    validateSchedulerState(state, effective); frames.push({ state: structuredClone(state), graph: structuredClone(effective) });
    if (state.collections?.f && !controller.signal.aborted) controller.abort("cancel");
  } });
  expect(result.status).toBe("aborted");
  const saved = frames.at(-1); if (!saved) throw new TypeError("Missing cancelled checkpoint");
  expect(saved.state.nodes.f.status).toBe("skipped"); expect(saved.state.runtime?.cancelled).toBe(true);
  const spawn = vi.fn(async () => ({ ok: true }));
  const restored = await runGraph(saved.graph, input, { restore: saved.state, host: { spawnAgent: spawn }, onCheckpoint: state => { validateSchedulerState(state, saved.graph); } });
  expect(restored.status).toBe("aborted"); expect(spawn).not.toHaveBeenCalled();
});
it("admits the coordinator while an unrelated executor fills concurrency one", async () => {
  let release: (() => void) | undefined; let materialized = false;
  const running = runGraph({ ...graph, nodes: { busy: { type: "agent", agent: "worker", prompt: "busy" }, ...graph.nodes } }, input, {
    concurrency: 1, onCheckpoint: state => { materialized ||= !!state.collections?.f; }, host: { spawnAgent: async request => { if (request.prompt === "busy") await new Promise<void>(resolve => { release = resolve; }); return { ok: true }; } },
  });
  try { await vi.waitFor(() => expect(materialized).toBe(true)); } finally { release?.(); }
  expect((await running).status).toBe("completed");
});
it("journals both fanout transactions with exact replay and rejects stale, conflicting or early aggregation", () => {
  const domain = createGraphDomain({ graph, input, depth: 0, options: { onCheckpoint: () => {}, host: { spawnAgent: async () => ({ ok: true }) } } });
  const admission = domain.plan()[0]; if (admission.kind !== "fanout") throw new TypeError("Missing fanout");
  const request: CoordinatorRequest = { type: "COORD.REQUEST", receipt: admission.input.receipt, requestSequence: 1, operation: { kind: "materialize" } };
  const journal = new CoordinatorRequestJournal(request.receipt);
  expect(journal.receive(request, request.receipt).kind).toBe("apply"); domain.coordinatorRequest(request);
  const ack = { ...request, type: "COORD.ACK" as const }; journal.prepare(ack);
  expect(journal.receive(request, request.receipt).kind).toBe("pending"); journal.commit(ack);
  expect(journal.receive(request, request.receipt)).toEqual({ kind: "replay", ack });
  expect(() => journal.receive({ ...request, operation: { kind: "aggregate" } }, request.receipt)).toThrow(/Conflicting/);
  expect(() => journal.receive({ ...request, receipt: { ...request.receipt, incarnation: "stale" } }, request.receipt)).toThrow(/Stale/);
  expect(() => domain.coordinatorRequest({ ...request, requestSequence: 2, operation: { kind: "aggregate" } })).toThrow(/not ready/);
  expect(domain.instances.state.manifest).toHaveLength(2);
});
