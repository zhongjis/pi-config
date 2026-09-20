import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { createActor, setup } from "xstate";
import { type CoordinatorParentEvent, coordinatorReceipt } from "../src/graph/coordinator-protocol.js";
import { graphLogic } from "../src/graph/graph-actor.js";
import { GraphInstances } from "../src/graph/graph-instance-id.js";
import { subgraphLogic } from "../src/graph/subgraph-actor.js";

function machine() {
  const receipt = coordinatorReceipt({ kind: "graph", id: "sub", runId: "root", instanceId: new GraphInstances("root").add("sub", { nodeKey: "sub" }).instanceId, activation: 1, graphAttempt: 1, attempt: 1, incarnation: "fresh" });
  const events: CoordinatorParentEvent[] = [];
  const record = ({ event }: { event: CoordinatorParentEvent }) => { events.push(event); };
  const spawnAgent = vi.fn(async () => ({ ok: true }));
  const parent = createActor(setup({ actors: { subgraph: subgraphLogic }, types: { events: {} as CoordinatorParentEvent } }).createMachine({
    invoke: { id: "sub", src: "subgraph", input: { receipt, child: {
      graph: { version: 2, nodes: { leaf: { type: "agent", agent: "worker", prompt: "fixture" } }, edges: [] }, input: {}, depth: 1,
      parent: { id: "sub", invocation: "child" }, options: { runId: "child", host: { spawnAgent }, onCheckpoint: () => {} },
    } } },
    on: { "COORD.REQUEST": { actions: record }, "COORD.RELEASE_READY": { actions: record }, "COORD.RELEASED": { actions: record }, "COORD.DRAINED": { actions: record } },
  })).start();
  const wrapper = parent.getSnapshot().children.sub; assert(wrapper);
  const request = () => { const event = events.at(-1); assert(event?.type === "COORD.REQUEST"); return event; };
  const ack = () => wrapper.send({ ...request(), type: "COORD.ACK", ...(request().operation.kind === "nested-checkpoint" ? { ordinals: {} } : {}) });
  return { parent, wrapper, receipt, events, request, ack, spawnAgent };
}
it("owns one native graph only after admission, forwards cancellation during an outstanding ACK and retains ownership until settlement release", async () => {
  const a = machine();
  try {
    expect(a.wrapper.getSnapshot().children).toEqual({});
    a.wrapper.send({ type: "COORD.ADMITTED", receipt: a.receipt });
    await vi.waitFor(() => expect(a.events).toHaveLength(1));
    const child = a.wrapper.getSnapshot().children.graph; assert(child);
    expect(child).toHaveProperty("logic", graphLogic);
    expect(child.getSnapshot().context.source.depth).toBe(1);
    const pending = a.request();
    a.wrapper.send({ type: "COORD.CANCEL", receipt: a.receipt, disposition: "cancel" });
    expect(child.getSnapshot().context.cancellation).toBeDefined();
    expect(a.request()).toBe(pending);
    a.ack();
    // Cancellation still checkpoints through the wrapper; no executor may dispatch.
    for (let step = 0; step < 20 && a.request().operation.kind !== "nested-settlement"; step++) {
      await vi.waitFor(() => expect(a.request().requestSequence).toBeGreaterThan(step + 1));
      if (a.request().operation.kind === "nested-checkpoint") a.ack();
    }
    expect(a.request().operation.kind).toBe("nested-settlement");
    expect(a.spawnAgent).not.toHaveBeenCalled();
    expect(a.wrapper.getSnapshot().children.graph).toBe(child);
    expect(a.events.some(event => event.type === "COORD.RELEASE_READY")).toBe(false);
    a.ack();
    expect(a.events.at(-1)?.type).toBe("COORD.RELEASE_READY");
    expect(a.wrapper.getSnapshot().children.graph).toBe(child);
    a.wrapper.send({ type: "COORD.RELEASE", receipt: a.receipt });
    expect(a.events.at(-1)?.type).toBe("COORD.RELEASED");
    expect(child.getSnapshot().status).toBe("stopped");
  } finally { a.parent.stop(); }
});
it.each(["ordinals", "correlation", "release"])("fails closed on invalid %s while a checkpoint awaits ACK", async kind => {
  const a = machine();
  try {
    a.wrapper.send({ type: "COORD.ADMITTED", receipt: a.receipt });
    await vi.waitFor(() => expect(a.events).toHaveLength(1));
    const request = a.request();
    if (kind === "release") a.wrapper.send({ type: "COORD.RELEASE", receipt: a.receipt });
    else a.wrapper.send({ ...request, type: "COORD.ACK", ...(kind === "correlation" ? { ordinals: {}, receipt: { ...a.receipt, incarnation: "stale" } } : {}) });
    await vi.waitFor(() => expect(a.events.at(-1)?.type).toBe("COORD.DRAINED"));
    await setImmediate();
    expect(a.spawnAgent).not.toHaveBeenCalled();
    expect(a.events.filter(event => event.type === "COORD.REQUEST")).toHaveLength(1);
  } finally { a.parent.stop(); }
});
