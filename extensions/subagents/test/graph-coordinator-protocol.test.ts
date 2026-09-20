import { expect, it } from "vitest";
import { type CoordinatorAck, type CoordinatorRequest, CoordinatorRequestJournal, coordinatorReceipt } from "../src/graph/coordinator-protocol.js";
import { GraphInstances } from "../src/graph/graph-instance-id.js";

function fixture() {
  const receipt = coordinatorReceipt({ kind: "expand", id: "__proto__", runId: "coord", instanceId: new GraphInstances("coord").add("__proto__", { nodeKey: "__proto__" }).instanceId, activation: 1, graphAttempt: 1, attempt: 1, incarnation: "fresh" });
  const request: CoordinatorRequest = { type: "COORD.REQUEST", receipt, requestSequence: 1, operation: { kind: "insert", fragment: { nodes: { a: { type: "agent", agent: "a", prompt: "a" } }, edges: [] } } };
  const ack: CoordinatorAck = { ...request, type: "COORD.ACK" };
  return { receipt, request, ack, journal: new CoordinatorRequestJournal(receipt) };
}
it("coalesces pending duplicates and replays only committed complete ACKs", () => {
  const { receipt, request, ack, journal } = fixture();
  expect(Object.isFrozen(receipt)).toBe(true);
  expect(journal.receive(request, receipt)).toEqual({ kind: "apply" });
  expect(journal.receive(structuredClone(request), receipt)).toEqual({ kind: "pending" });
  expect(() => journal.commit(ack)).toThrow(/prepared/);
  journal.prepare(ack);
  expect(journal.receive(request, receipt)).toEqual({ kind: "pending" });
  expect(journal.committed(1)).toBeUndefined();
  journal.commit(ack);
  expect(journal.receive(request, { ...receipt, activation: 2 })).toEqual({ kind: "replay", ack });
  expect(Object.isFrozen(journal.committed(1)?.operation)).toBe(true);
});
it("captures nested operation evidence independently of the sender", () => {
  const { receipt, request, journal } = fixture();
  const original = structuredClone(request);
  journal.receive(request, receipt);
  if (request.operation.kind !== "insert") throw new TypeError("Expected insertion");
  request.operation.fragment.nodes.a = { type: "agent", agent: "different", prompt: "a" };
  expect(() => journal.receive(request, receipt)).toThrow(/Conflicting/);
  expect(journal.receive(original, receipt)).toEqual({ kind: "pending" });
});
it("rejects reorder, pending successors and mismatched ACK operations", () => {
  const { receipt, request, ack, journal } = fixture();
  expect(() => journal.receive({ ...request, requestSequence: 2 }, receipt)).toThrow(/Reordered/);
  journal.receive(request, receipt);
  expect(() => journal.receive({ ...request, requestSequence: 2 }, receipt)).toThrow(/pending/);
  expect(() => journal.prepare({ ...ack, operation: { kind: "fail", error: "other" } })).toThrow(/Conflicting/);
  journal.prepare(ack);
  expect(() => journal.commit({ ...ack, operation: { kind: "fail", error: "other" } })).toThrow(/Conflicting/);
  journal.commit(ack);
  expect(() => journal.receive({ ...request, operation: { kind: "fail", error: "other" } }, receipt)).toThrow(/Conflicting/);
});
it.each(["id", "runId", "instanceId", "incarnation", "activation", "graphAttempt", "attempt"] as const)("rejects stale %s", field => {
  const { receipt, request, journal } = fixture();
  const stale = { ...receipt, [field]: typeof receipt[field] === "number" ? 9 : "other" };
  expect(() => journal.receive({ ...request, receipt: stale }, receipt)).toThrow(/Stale/);
  expect(() => journal.receive(request, stale)).toThrow(/Stale/);
  expect(journal.receive(request, receipt)).toEqual({ kind: "apply" });
});
it.each([0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1])("rejects invalid sequence %s", requestSequence => {
  const { receipt, request, journal } = fixture();
  expect(() => journal.receive({ ...request, requestSequence }, receipt)).toThrow(/sequence/);
});
