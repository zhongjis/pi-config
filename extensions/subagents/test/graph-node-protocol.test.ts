import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { executionAttemptId } from "../src/graph/graph-execution.js";
import { GraphInstances } from "../src/graph/graph-instance-id.js";
import { admissionReceipt, type NodeAck, type NodeRequest, NodeRequestJournal } from "../src/graph/node-protocol.js";

function fixture() {
  const correlation = { runId: "protocol", instanceId: new GraphInstances("protocol").add("a", { nodeKey: "a" }).instanceId,
    activation: 1, graphAttempt: 1, executionAttemptId: executionAttemptId(randomUUID()) };
  const receipt = admissionReceipt({ id: "a", incarnation: randomUUID(), correlation, executionSequence: 2 });
  const request: NodeRequest = { type: "NODE.REQUEST", id: receipt.id, incarnation: receipt.incarnation, correlation,
    requestSequence: 1, operation: { kind: "repair", result: { ok: false, error: "invalid", costUsd: 0.2 }, executed: true } };
  const next = admissionReceipt({ ...receipt, correlation: { ...correlation, executionAttemptId: executionAttemptId(randomUUID()) }, executionSequence: 3 });
  const ack: NodeAck = { ...request, type: "NODE.ACK", receipt: next };
  return { receipt, request, next, ack, journal: new NodeRequestJournal(receipt) };
}

it("copies and freezes the admission receipt and its full correlation", () => {
  const { receipt } = fixture();
  expect(Object.isFrozen(receipt)).toBe(true);
  expect(Object.isFrozen(receipt.correlation)).toBe(true);
  const source = { ...receipt, correlation: { ...receipt.correlation } };
  const copy = admissionReceipt(source);
  source.correlation.activation = 99;
  expect(copy.correlation.activation).toBe(1);
});

it("keeps request numbering separate from execution numbering", () => {
  const { journal, request, receipt } = fixture();
  expect(receipt.executionSequence).toBe(2);
  expect(journal.receive(request, receipt.correlation)).toEqual({ kind: "apply" });
  expect(journal.receive(structuredClone(request), receipt.correlation)).toEqual({ kind: "pending" });
});

it("replays only committed ACKs, including a repair whose prior correlation is now stale", () => {
  const { journal, request, receipt, next, ack } = fixture();
  journal.receive(request, receipt.correlation);
  journal.prepare(ack);
  expect(journal.receive(request, next.correlation)).toEqual({ kind: "pending" });
  journal.commit(ack);
  const replay = journal.receive(structuredClone(request), next.correlation);
  expect(replay).toEqual({ kind: "replay", ack });
  if (replay.kind !== "replay") throw new TypeError("Missing replay");
  expect(Object.isFrozen(replay.ack)).toBe(true);
  expect(Object.isFrozen(replay.ack.receipt.correlation)).toBe(true);
});

it("rejects a changed duplicate without replacing its original ACK", () => {
  const { journal, request, receipt, next, ack } = fixture();
  journal.receive(request, receipt.correlation); journal.prepare(ack); journal.commit(ack);
  expect(() => journal.receive({ ...request, operation: { kind: "gate", costUsd: 9 } }, next.correlation)).toThrow(/Conflicting/);
  expect(journal.receive(request, next.correlation)).toEqual({ kind: "replay", ack });
});

it.each([0, 2, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])("rejects request sequence %s before accepting a first request", requestSequence => {
  const { journal, request, receipt } = fixture();
  expect(() => journal.receive({ ...request, requestSequence }, receipt.correlation)).toThrow(/sequence/);
  expect(journal.receive(request, receipt.correlation)).toEqual({ kind: "apply" });
});

it("rejects a successor while its predecessor still awaits checkpoint commit", () => {
  const { journal, request, receipt, ack, next } = fixture();
  journal.receive(request, receipt.correlation); journal.prepare(ack);
  const successor: NodeRequest = { ...request, requestSequence: 2, correlation: next.correlation, operation: { kind: "gate", costUsd: 0.3 } };
  expect(() => journal.receive(successor, next.correlation)).toThrow(/pending/);
  journal.commit(ack);
  expect(journal.receive(successor, next.correlation)).toEqual({ kind: "apply" });
});

it.each(["id", "incarnation", "runId", "instanceId", "activation", "graphAttempt", "executionAttemptId"] as const)("rejects stale %s even on an acknowledged request", field => {
  const { journal, request, receipt, ack } = fixture();
  journal.receive(request, receipt.correlation); journal.prepare(ack); journal.commit(ack);
  const other = fixture();
  const stale = structuredClone(request);
  const replacement = field === "id" || field === "incarnation" ? { ...stale, [field]: "stale" }
    : { ...stale, correlation: { ...stale.correlation, [field]: field === "activation" || field === "graphAttempt" ? 99 : field === "runId" ? "stale" : other.receipt.correlation[field] } };
  expect(() => journal.receive(replacement, receipt.correlation)).toThrow();
});

it("rejects a new request with a stale correlation without consuming its sequence", () => {
  const { journal, request, receipt, next } = fixture();
  expect(() => journal.receive(request, next.correlation)).toThrow(/Stale/);
  expect(journal.receive(request, receipt.correlation)).toEqual({ kind: "apply" });
});

it("captures request payloads by value so mutation cannot rewrite duplicate evidence", () => {
  const { journal, request, receipt } = fixture();
  journal.receive(request, receipt.correlation);
  const original = structuredClone(request);
  if (request.operation.kind !== "repair") throw new TypeError("Missing repair");
  Object.assign(request.operation.result, { costUsd: 99 });
  expect(() => journal.receive(request, receipt.correlation)).toThrow(/Conflicting/);
  expect(journal.receive(original, receipt.correlation)).toEqual({ kind: "pending" });
});

it("rejects an ACK with mismatched request identity or sequence", () => {
  const { journal, request, receipt, ack } = fixture();
  journal.receive(request, receipt.correlation);
  for (const invalid of [{ ...ack, requestSequence: 2 }, { ...ack, incarnation: "stale" },
    { ...ack, correlation: { ...ack.correlation, activation: 99 } },
    { ...ack, receipt: { ...ack.receipt, executionSequence: 2 } }]) {
    expect(() => journal.prepare(invalid)).toThrow();
  }
  journal.prepare(ack); journal.commit(ack);
  expect(journal.receive(request, ack.receipt.correlation).kind).toBe("replay");
});

it("rejects repair ACKs that change the durable scope or reuse an execution identity", () => {
  const { journal, request, receipt, ack } = fixture();
  journal.receive(request, receipt.correlation);
  for (const invalid of [{ ...ack, receipt: { ...ack.receipt, correlation: receipt.correlation } },
    { ...ack, receipt: { ...ack.receipt, correlation: { ...ack.receipt.correlation, graphAttempt: 2 } } },
    { ...ack, receipt: { ...ack.receipt, incarnation: "replacement" } }]) {
    expect(() => journal.prepare(invalid)).toThrow();
  }
});

it("requires a prepared matching ACK before publishing a commit", () => {
  const { journal, request, receipt, ack } = fixture();
  journal.receive(request, receipt.correlation);
  expect(() => journal.commit(ack)).toThrow(/prepared/);
  journal.prepare(ack);
  expect(() => journal.commit({ ...ack, receipt: { ...ack.receipt, executionSequence: 4 } })).toThrow(/Conflicting/);
  expect(journal.receive(request, receipt.correlation)).toEqual({ kind: "pending" });
});

it("retains old duplicate receipts after subsequent operations commit", () => {
  const { journal, request, receipt, next, ack } = fixture();
  journal.receive(request, receipt.correlation); journal.prepare(ack); journal.commit(ack);
  const gate: NodeRequest = { ...request, requestSequence: 2, correlation: next.correlation, operation: { kind: "gate", costUsd: 0.4 } };
  journal.receive(gate, next.correlation);
  const gateAck: NodeAck = { ...gate, type: "NODE.ACK", receipt: next };
  journal.prepare(gateAck); journal.commit(gateAck);
  expect(journal.receive(request, next.correlation)).toEqual({ kind: "replay", ack });
  expect(journal.receive(gate, next.correlation)).toEqual({ kind: "replay", ack: gateAck });
});

it.each(["gate", "cancel", "settle"] as const)("requires unchanged committed receipt for %s ACK", kind => {
  const { receipt, journal, request, next } = fixture();
  const operation: NodeRequest["operation"] = kind === "gate" ? { kind, costUsd: 0.2 } : kind === "cancel" ? { kind, disposition: "lifecycle" }
    : { kind, result: { ok: true }, executed: true, cancelled: false, projection: "complete" };
  const boundary: NodeRequest = { ...request, operation };
  journal.receive(boundary, receipt.correlation);
  const ack: NodeAck = { ...boundary, type: "NODE.ACK", receipt };
  expect(() => journal.prepare({ ...ack, receipt: next })).toThrow(/identity/);
  journal.prepare(ack); journal.commit(ack);
  expect(journal.receive(boundary, receipt.correlation)).toEqual({ kind: "replay", ack });
});
