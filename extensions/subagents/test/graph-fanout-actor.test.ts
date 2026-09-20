import { expect, it } from "vitest";
import { createActor, setup } from "xstate";
import { type CollectionOwnerView, type CoordinatorChildEvent, type CoordinatorParentEvent, coordinatorReceipt } from "../src/graph/coordinator-protocol.js";
import { fanoutLogic } from "../src/graph/fanout-actor.js";
import { GraphInstances } from "../src/graph/graph-instance-id.js";

function machine(materialized = false) {
  const receipt = coordinatorReceipt({ kind: "fanout", id: "f", runId: "r", instanceId: new GraphInstances("r").add("f", { nodeKey: "f" }).instanceId, activation: 1, graphAttempt: 1, attempt: 1, incarnation: "fresh" });
  const view: CollectionOwnerView = { revision: 1, materialized, ready: false, settled: false };
  const events: CoordinatorParentEvent[] = [];
  const record = ({ event }: { event: CoordinatorParentEvent }) => { events.push(event); };
  const parent = createActor(setup({ actors: { fanout: fanoutLogic }, types: { events: {} as CoordinatorParentEvent } }).createMachine({
    invoke: { id: "fanout", src: "fanout", input: { receipt, view } },
    on: { "COORD.REQUEST": { actions: record }, "COORD.RELEASE_READY": { actions: record }, "COORD.RELEASED": { actions: record }, "COORD.DRAINED": { actions: record } },
  })).start();
  const child = parent.getSnapshot().children.fanout;
  if (!child) throw new TypeError("Missing fanout actor");
  const send = (event: CoordinatorChildEvent) => child.send(event);
  const request = () => { const event = events.at(-1); if (event?.type !== "COORD.REQUEST") throw new TypeError("Missing request"); return event; };
  return { parent, events, receipt, view, send, request };
}
it("hands off admission, materialization, bounded committed collection views, aggregation and explicit release", () => {
  const a = machine();
  expect(a.events).toEqual([]);
  a.send({ type: "COORD.ADMITTED", receipt: a.receipt });
  const materialize = a.request(); expect(materialize.operation.kind).toBe("materialize");
  a.send({ ...materialize, type: "COORD.ACK" });
  expect(a.events).toHaveLength(1);
  a.send({ type: "COORD.VIEW", receipt: a.receipt, view: { ...a.view, revision: 2, materialized: true } });
  expect(a.events).toHaveLength(1);
  a.send({ type: "COORD.VIEW", receipt: a.receipt, view: { ...a.view, revision: 3, materialized: true, ready: true } });
  const aggregate = a.request(); expect(aggregate).toMatchObject({ requestSequence: 2, operation: { kind: "aggregate" } });
  a.send({ ...materialize, type: "COORD.ACK" }); // Exact older ACK cannot settle the newer request.
  expect(a.events).toHaveLength(2);
  a.send({ ...aggregate, type: "COORD.ACK" });
  expect(a.events.at(-1)?.type).toBe("COORD.RELEASE_READY");
  a.send({ ...aggregate, type: "COORD.ACK" });
  expect(a.events).toHaveLength(3);
  a.send({ type: "COORD.RELEASE", receipt: a.receipt });
  expect(a.events.at(-1)?.type).toBe("COORD.RELEASED"); a.parent.stop();
});
it("attaches existing collections without a materialization request, including empty collections", () => {
  const a = machine(true); a.send({ type: "COORD.ADMITTED", receipt: a.receipt });
  expect(a.events).toEqual([]);
  a.send({ type: "COORD.VIEW", receipt: a.receipt, view: { ...a.view, revision: 2, ready: true } });
  expect(a.request().operation.kind).toBe("aggregate"); a.parent.stop();
});
it("waits out an outstanding ACK before requesting persisted lifecycle cancellation", () => {
  const a = machine(); a.send({ type: "COORD.ADMITTED", receipt: a.receipt });
  const materialize = a.request();
  a.send({ type: "COORD.CANCEL", receipt: a.receipt, disposition: "lifecycle" });
  expect(a.events).toHaveLength(1);
  a.send({ ...materialize, type: "COORD.ACK" });
  expect(a.request()).toMatchObject({ requestSequence: 2, operation: { kind: "cancel", disposition: "lifecycle" } });
  a.send({ ...a.request(), type: "COORD.ACK" });
  expect(a.events.at(-1)?.type).toBe("COORD.RELEASE_READY"); a.parent.stop();
});
it.each(["ack", "receipt", "release", "writer"])("drains %s failure without further transaction requests", kind => {
  const a = machine(); a.send({ type: "COORD.ADMITTED", receipt: a.receipt }); const request = a.request();
  if (kind === "ack") a.send({ ...request, type: "COORD.ACK", operation: { kind: "aggregate" } });
  if (kind === "receipt") a.send({ type: "COORD.VIEW", receipt: { ...a.receipt, incarnation: "stale" }, view: a.view });
  if (kind === "release") a.send({ type: "COORD.RELEASE", receipt: a.receipt });
  if (kind === "writer") a.send({ type: "FAIL", error: new Error("writer") });
  expect(a.events.map(event => event.type)).toEqual(["COORD.REQUEST", "COORD.DRAINED"]); a.parent.stop();
});
