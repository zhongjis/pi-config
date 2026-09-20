import { setImmediate } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { createActor, enqueueActions, setup, toPromise } from "xstate";
import type { CoordinatorChildEvent, CoordinatorRequest } from "../src/graph/coordinator-protocol.js";
import type { ExpandContext, ExpandInput } from "../src/graph/expand-actor.js";
import { graphLogic } from "../src/graph/graph-actor.js";
import type { AgentGraph } from "../src/graph/ir.js";
import type { SchedulerState } from "../src/graph/scheduler.js";

const graph: AgentGraph = { version: 2, nodes: { e: { type: "expand", source: { path: "$" } } }, edges: [] };
function parked() {
  let request: CoordinatorRequest | undefined;
  const events: CoordinatorChildEvent[] = [];
  const expand = setup({ types: { context: {} as ExpandContext, input: {} as ExpandInput, events: {} as CoordinatorChildEvent } }).createMachine({
    id: "expand", initial: "waitingAck",
    states: { awaitingAdmission: {}, preparing: {}, waitingAck: {}, releaseReady: {}, released: { type: "final" }, failedDrained: {} },
    context: ({ input }) => ({ input, receipt: input.receipt }),
    on: { "*": { actions: enqueueActions(({ context, event, enqueue }) => {
      events.push(event);
      switch (event.type) {
        case "COORD.ADMITTED": request = { type: "COORD.REQUEST", receipt: context.receipt, requestSequence: 1, operation: { kind: "fail", error: "fixture" } }; enqueue.sendParent(request); break;
        case "FAIL": enqueue.sendParent({ type: "COORD.DRAINED", receipt: context.receipt, requestSequence: 1, failure: { error: event.error } }); break;
        case "COORD.RELEASE": enqueue.sendParent({ type: "COORD.RELEASED", receipt: context.receipt, requestSequence: 1 }); break;
        case "COORD.ACK": case "COORD.CANCEL": case "COORD.VIEW": case "COORD.FEEDBACK_VIEW": break;
        default: { const exhaustive: never = event; throw new TypeError(`Unknown coordinator event: ${exhaustive}`); }
      }
    }) } },
  });
  return { logic: graphLogic.provide({ actors: { expand } }), events, request: () => { if (!request) throw new TypeError("Missing request"); return request; } };
}
it("coalesces requests pending commit and replays committed ACK without writes, while retaining child ownership", async () => {
  const child = parked(); const frames: SchedulerState[] = []; let duplicated = false;
  const actor = createActor(child.logic, { input: { graph, input: {}, depth: 0, options: { host: { spawnAgent: async () => ({ ok: true }) }, onCheckpoint: state => {
    frames.push(state);
    if (state.nodes.e.status === "failed" && !duplicated) { duplicated = true; actor.send(structuredClone(child.request())); }
  } } } });
  const result = toPromise(actor); actor.start();
  try {
    await vi.waitFor(() => expect(child.events.filter(event => event.type === "COORD.ACK")).toHaveLength(1));
    expect(actor.getSnapshot().children["node:e"]).toBeDefined(); expect(actor.getSnapshot().status).toBe("active");
    const before = structuredClone(actor.getSnapshot().context.domain?.instances.state); const writes = frames.length;
    actor.send(structuredClone(child.request())); await setImmediate();
    expect(child.events.filter(event => event.type === "COORD.ACK")).toHaveLength(2);
    expect(frames).toHaveLength(writes); expect(actor.getSnapshot().context.domain?.instances.state).toEqual(before);
    actor.send({ type: "COORD.RELEASE_READY", receipt: child.request().receipt, requestSequence: 1 });
    expect((await result).status).toBe("failed");
  } finally { actor.stop(); }
});
it.each(["conflict", "reorder", "stale"] as const)("fails closed on root %s and waits for infrastructure drain", async kind => {
  const child = parked(); const frames: SchedulerState[] = [];
  const actor = createActor(child.logic, { input: { graph, input: {}, depth: 0, options: { host: { spawnAgent: async () => ({ ok: true }) }, onCheckpoint: state => { frames.push(state); } } } });
  const result = toPromise(actor); const rejected = expect(result).rejects.toBeInstanceOf(TypeError); actor.start();
  try {
    await vi.waitFor(() => expect(child.events.some(event => event.type === "COORD.ACK")).toBe(true));
    const writes = frames.length; const request = child.request();
    actor.send(kind === "conflict" ? { ...request, operation: { kind: "fail", error: "other" } } : kind === "reorder" ? { ...request, requestSequence: 3 } : { ...request, receipt: { ...request.receipt, incarnation: "other" } });
    await rejected; expect(frames).toHaveLength(writes); expect(child.events.at(-1)?.type).toBe("FAIL");
  } finally { actor.stop(); }
});
it("acknowledges nested expansion only after its containing outer checkpoint", async () => {
  const frames: SchedulerState[] = []; let acks = 0;
  const outer: AgentGraph = { version: 2, nodes: { nested: { type: "graph", graph: "inner" } }, edges: [] };
  const actor = createActor(graphLogic, { input: { graph: outer, input: {}, depth: 0, options: { loadGraph: () => graph, host: { spawnAgent: async () => ({ ok: true }) }, onCheckpoint: state => { frames.push(state); } } }, inspect: event => {
    if (event.type === "@xstate.event" && event.event.type === "COORD.ACK" && event.event.receipt.kind === "expand") { acks++; expect(frames.at(-1)?.runtime?.nested?.nested.state.nodes.e.status).toBe("failed"); }
  } });
  const result = toPromise(actor); actor.start(); expect((await result).status).toBe("failed"); expect(acks).toBe(1); actor.stop();
});
