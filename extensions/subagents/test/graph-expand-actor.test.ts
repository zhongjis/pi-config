import { expect, it } from "vitest";
import { createActor, setup } from "xstate";
import { type CoordinatorChildEvent, type CoordinatorParentEvent, coordinatorReceipt } from "../src/graph/coordinator-protocol.js";
import { type ExpandInput, expandLogic } from "../src/graph/expand-actor.js";
import { GraphInstances } from "../src/graph/graph-instance-id.js";

function machine(source: unknown = { nodes: { a: { type: "agent", agent: "a", prompt: "a" } }, edges: [] }) {
  const receipt = coordinatorReceipt({ kind: "expand", id: "e", runId: "r", instanceId: new GraphInstances("r").add("e", { nodeKey: "e" }).instanceId, activation: 1, graphAttempt: 1, attempt: 1, incarnation: "fresh" });
  const input: ExpandInput = { receipt, source, existingIds: ["e"] };
  const events: CoordinatorParentEvent[] = [];
  const record = ({ event }: { event: CoordinatorParentEvent }) => { events.push(event); };
  const parent = createActor(setup({ actors: { expand: expandLogic }, types: { events: {} as CoordinatorParentEvent } }).createMachine({
    invoke: { id: "expand", src: "expand", input },
    on: { "COORD.REQUEST": { actions: record }, "COORD.RELEASE_READY": { actions: record }, "COORD.RELEASED": { actions: record }, "COORD.DRAINED": { actions: record } },
  })).start();
  const child = parent.getSnapshot().children.expand;
  if (!child) throw new TypeError("Missing expand actor");
  return { parent, events, receipt, send: (event: CoordinatorChildEvent) => child.send(event) };
}
it("waits for committed admission then settlement ACK and explicit release", () => {
  const actor = machine();
  expect(actor.events).toEqual([]);
  actor.send({ type: "COORD.ADMITTED", receipt: actor.receipt });
  const request = actor.events[0];
  if (request.type !== "COORD.REQUEST") throw new TypeError("Missing request");
  expect(request.operation).toEqual({ kind: "insert", fragment: { nodes: { a: { type: "agent", agent: "a", prompt: "a" } }, edges: [] } });
  expect(actor.events).toHaveLength(1);
  actor.send({ ...request, type: "COORD.ACK" });
  expect(actor.events[1].type).toBe("COORD.RELEASE_READY");
  actor.send({ type: "COORD.RELEASE", receipt: actor.receipt });
  expect(actor.events[2].type).toBe("COORD.RELEASED");
  actor.parent.stop();
});
it.each([null, undefined, [], 7, "invalid"])("requests ordinary node failure for source %s", source => {
  const actor = machine(source === undefined ? null : source);
  actor.send({ type: "COORD.ADMITTED", receipt: actor.receipt });
  expect(actor.events[0]).toMatchObject({ type: "COORD.REQUEST", operation: { kind: "fail", error: 'expand node "e" source did not resolve to a GraphFragment' } });
  actor.parent.stop();
});
it("drains infrastructure failure without requesting a write", () => {
  const actor = machine(); const error = new TypeError("writer");
  actor.send({ type: "FAIL", error });
  expect(actor.events).toEqual([{ type: "COORD.DRAINED", receipt: actor.receipt, requestSequence: 0, failure: { error } }]);
  actor.parent.stop();
});
it("fails closed on conflicting ACK or premature release", () => {
  for (const release of [false, true]) {
    const actor = machine(); actor.send({ type: "COORD.ADMITTED", receipt: actor.receipt });
    const request = actor.events[0]; if (request.type !== "COORD.REQUEST") throw new TypeError("Missing request");
    actor.send(release ? { type: "COORD.RELEASE", receipt: actor.receipt } : { ...request, type: "COORD.ACK", operation: { kind: "fail", error: "changed" } });
    expect(actor.events.at(-1)?.type).toBe("COORD.DRAINED");
    actor.parent.stop();
  }
});
it("cancels before preparation only after the admission handoff", () => {
  const actor = machine();
  actor.send({ type: "COORD.CANCEL", receipt: actor.receipt, disposition: "cancel" });
  expect(actor.events).toEqual([]);
  actor.send({ type: "COORD.ADMITTED", receipt: actor.receipt });
  expect(actor.events[0]).toMatchObject({ type: "COORD.REQUEST", operation: { kind: "cancel", disposition: "cancel" } });
  actor.parent.stop();
});
