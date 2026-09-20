import { expect, it } from "vitest";
import { createActor, setup } from "xstate";
import { type CoordinatorChildEvent, type CoordinatorParentEvent, coordinatorReceipt, type FeedbackOwnerView } from "../src/graph/coordinator-protocol.js";
import { feedbackLogic } from "../src/graph/feedback-actor.js";
import { GraphInstances } from "../src/graph/graph-instance-id.js";

function machine(phase: FeedbackOwnerView["phase"] = "absent") {
  const receipt = coordinatorReceipt({ kind: "bounded_feedback", id: "f", runId: "r", instanceId: new GraphInstances("r").add("f", { nodeKey: "f" }).instanceId, activation: 1, graphAttempt: 1, attempt: 1, incarnation: "fresh" });
  const events: CoordinatorParentEvent[] = [];
  const record = ({ event }: { event: CoordinatorParentEvent }) => { events.push(event); };
  const parent = createActor(setup({ actors: { feedback: feedbackLogic }, types: { events: {} as CoordinatorParentEvent } }).createMachine({
    invoke: { id: "feedback", src: "feedback", input: { receipt, view: { revision: 1, phase, iteration: phase === "absent" ? 0 : 1 } } },
    on: { "COORD.REQUEST": { actions: record }, "COORD.RELEASE_READY": { actions: record }, "COORD.RELEASED": { actions: record }, "COORD.DRAINED": { actions: record } },
  })).start();
  const child = parent.getSnapshot().children.feedback;
  if (!child) throw new TypeError("Missing feedback actor");
  const send = (event: CoordinatorChildEvent) => child.send(event);
  const view = (phase: FeedbackOwnerView["phase"], revision: number, iteration = 1) => send({ type: "COORD.FEEDBACK_VIEW", receipt, view: { phase, revision, iteration } });
  const request = () => { const event = events.at(-1); if (event?.type !== "COORD.REQUEST") throw new TypeError("Missing request"); return event; };
  return { parent, child, events, receipt, send, view, request };
}
it("requires ACK plus progressed owner facts for intent, materialization, decision and release", () => {
  const a = machine();
  expect(a.events).toEqual([]);
  a.send({ type: "COORD.ADMITTED", receipt: a.receipt });
  const intent = a.request(); expect(intent.operation.kind).toBe("feedback-intent");
  a.view("absent", 2, 0); // Admission checkpoint is newer but not an intent commit.
  a.send({ ...intent, type: "COORD.ACK" }); expect(a.events).toHaveLength(1);
  a.view("intent", 3);
  const materialize = a.request(); expect(materialize.operation).toEqual({ kind: "feedback-materialize", iteration: 1 });
  a.view("work", 4); expect(a.events).toHaveLength(2); // View before ACK is not permission.
  a.send({ ...intent, type: "COORD.ACK" }); expect(a.events).toHaveLength(2);
  a.send({ ...materialize, type: "COORD.ACK" });
  expect(a.child.getSnapshot().value).toBe("observing");
  a.view("evaluation", 5); expect(a.events).toHaveLength(2);
  a.view("decision", 6);
  const decision = a.request(); expect(decision.operation).toEqual({ kind: "feedback-decision", iteration: 1 });
  a.send({ ...decision, type: "COORD.ACK" }); expect(a.events).toHaveLength(3);
  a.view("intent", 7, 2);
  expect(a.request()).toMatchObject({ requestSequence: 4, operation: { kind: "feedback-materialize", iteration: 2 } });
  a.send({ ...a.request(), type: "COORD.ACK" }); a.view("terminal", 8, 2);
  expect(a.events.at(-1)?.type).toBe("COORD.RELEASE_READY");
  a.send({ type: "COORD.RELEASE", receipt: a.receipt });
  expect(a.events.at(-1)?.type).toBe("COORD.RELEASED"); a.parent.stop();
});
it.each(["intent", "work", "evaluation", "decision"] as const)("bootstraps %s without repeating earlier transitions", phase => {
  const a = machine(phase); a.send({ type: "COORD.ADMITTED", receipt: a.receipt });
  expect(a.events.map(event => event.type === "COORD.REQUEST" ? event.operation.kind : event.type)).toEqual(phase === "intent" ? ["feedback-materialize"] : phase === "decision" ? ["feedback-decision"] : []);
  expect(Object.keys(a.child.getSnapshot().children)).toEqual([]); a.parent.stop();
});
it.each(["cancel", "lifecycle"] as const)("waits for outstanding decision ACK before %s, without successor materialization", disposition => {
  const a = machine("decision"); a.send({ type: "COORD.ADMITTED", receipt: a.receipt }); const decision = a.request();
  a.send({ type: "COORD.CANCEL", receipt: a.receipt, disposition }); a.view("intent", 2, 2);
  expect(a.events).toHaveLength(1);
  a.send({ ...decision, type: "COORD.ACK" });
  expect(a.request().operation).toEqual({ kind: "cancel", disposition });
  a.send({ ...a.request(), type: "COORD.ACK" });
  expect(a.events.at(-1)?.type).toBe("COORD.RELEASE_READY"); a.parent.stop();
});
it.each(["ack", "receipt", "release", "writer"])("drains %s failure without new requests", kind => {
  const a = machine(); a.send({ type: "COORD.ADMITTED", receipt: a.receipt }); const request = a.request();
  if (kind === "ack") a.send({ ...request, type: "COORD.ACK", operation: { kind: "feedback-decision", iteration: 1 } });
  if (kind === "receipt") a.send({ type: "COORD.FEEDBACK_VIEW", receipt: { ...a.receipt, incarnation: "stale" }, view: { revision: 2, phase: "intent", iteration: 1 } });
  if (kind === "release") a.send({ type: "COORD.RELEASE", receipt: a.receipt });
  if (kind === "writer") a.send({ type: "FAIL", error: new Error("writer") });
  expect(a.events.map(event => event.type)).toEqual(["COORD.REQUEST", "COORD.DRAINED"]); a.parent.stop();
});
