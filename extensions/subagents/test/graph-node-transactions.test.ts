import { expect, it } from "vitest";
import { createGraphDomain } from "../src/graph/graph-domain.js";
import { type NodeOperation, type NodeRequest } from "../src/graph/node-protocol.js";

function fixture() {
  const domain = createGraphDomain({ graph: { nodes: { a: { type: "agent", agent: "worker", prompt: "fixture", retry: { maxAttempts: 3 } } }, edges: [] }, input: {}, depth: 0, options: { host: { spawnAgent: async () => ({ ok: true }) } } });
  const [admission] = domain.plan();
  if (admission?.kind !== "agent") throw new TypeError("Missing admission");
  const receipt = admission.input.receipt;
  const request = (operation: NodeOperation): NodeRequest => ({ type: "NODE.REQUEST", ...receipt, requestSequence: 1, operation });
  return { domain, receipt, request };
}
it("persists gate dispatch without requiring host capability", () => {
  const { domain, receipt, request } = fixture();
  domain.nodeRequest(request({ kind: "gate", costUsd: 2 }), receipt);
  expect(domain.executions.rows(receipt.correlation).map(row => row.payload.kind)).toEqual(["admitted", "dispatched", "cost", "dispatched"]);
  expect(domain.frames.at(-1)?.state.nodes.a.costUsd).toBe(2);
});
it("atomically finishes repair before allocating the next immutable receipt", () => {
  const { domain, receipt, request } = fixture(); const before = domain.frames.length;
  const next = domain.nodeRequest(request({ kind: "repair", result: { ok: false, costUsd: 3 }, executed: true }), receipt);
  expect(domain.frames).toHaveLength(before + 1);
  expect(next.executionSequence).toBe(2); expect(next.correlation.executionAttemptId).not.toBe(receipt.correlation.executionAttemptId);
  expect(Object.isFrozen(next.correlation)).toBe(true); expect(Object.isFrozen(next)).toBe(true);
  expect(domain.frames.at(-1)?.state.runtime?.executionLedger?.map(row => "payload" in row ? row.payload.kind : row.kind)).toEqual(["admitted", "dispatched", "cost", "outcome", "drain-ack", "admitted", "dispatched"]);
});
it("validates exact persisted cancellation without appending rows or checkpoints", () => {
  const { domain, receipt, request } = fixture();
  expect(() => domain.nodeRequest(request({ kind: "cancel", disposition: "skip" }), receipt)).toThrow("not persisted");
  domain.control(0, "skip"); const before = structuredClone(domain.instances.state); const frames = domain.frames.length;
  expect(() => domain.nodeRequest(request({ kind: "cancel", disposition: "retry" }), receipt)).toThrow("not persisted");
  domain.nodeRequest(request({ kind: "cancel", disposition: "skip" }), receipt);
  expect(domain.instances.state).toEqual(before); expect(domain.frames).toHaveLength(frames);
});
it.each(["complete", "retry", "retain"] as const)("applies selected %s settlement even with an existing drain", projection => {
  const { domain, receipt, request } = fixture();
  if (projection === "retry") domain.control(0, "retry");
  if (projection === "retain") domain.cancel("reload");
  const cancelled = projection !== "complete";
  domain.executions.finish("a", receipt.correlation, { ok: true, output: "done", costUsd: 1 }, cancelled, true);
  const rows = [...domain.executions.rows(receipt.correlation)];
  domain.nodeRequest(request({ kind: "settle", result: { ok: true, output: "done", costUsd: 1 }, executed: true, cancelled, projection }), receipt);
  expect(domain.executions.rows(receipt.correlation)).toEqual(rows);
  expect(domain.projection.nodes.get("a")?.status).toBe(projection === "complete" ? "completed" : projection === "retry" ? "pending" : "running");
});
it("carries persisted cancellation across a pending repair identity change", () => {
  const { domain, receipt, request } = fixture(); domain.control(0, "skip");
  const next = domain.nodeRequest(request({ kind: "repair", result: { ok: false }, executed: true }), receipt);
  expect(domain.executions.rows(next.correlation).at(-1)?.payload).toEqual({ kind: "cancel-requested", reason: "skip" });
  expect(domain.executions.rows(receipt.correlation).slice(-2).map(row => row.payload.kind)).toEqual(["outcome", "drain-ack"]);
});
it("rejects stale settlement and contradictory selected disposition", () => {
  const { domain, receipt, request } = fixture();
  const settle = request({ kind: "settle", result: { ok: true }, executed: true, cancelled: false, projection: "retain" });
  expect(() => domain.nodeRequest(settle, receipt)).toThrow("disposition");
  expect(() => domain.nodeRequest({ ...settle, correlation: { ...receipt.correlation, graphAttempt: 9 } }, receipt)).toThrow("identity");
});
