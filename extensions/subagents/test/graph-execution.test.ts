import { expect, it } from "vitest";
import { appendExecution, type ExecutionEvent, type ExecutionLedgerEntry, executionAttemptId, matchesExecution, projectExecution, remainingExecutions, validateExecutionProtocol } from "../src/graph/graph-execution.js";
import type { NodeInstanceId } from "../src/graph/graph-instance-id.js";

const instanceId = "00000000-0000-4000-8000-000000000001" as NodeInstanceId;
const id = executionAttemptId("00000000-0000-4000-8000-000000000002");
const identity = { runId: "agr_execution", instanceId, activation: 1, graphAttempt: 1, executionAttemptId: id };
const event = (payload: ExecutionEvent["payload"]): ExecutionEvent => ({ ...identity, payload });
const admitted = event({ kind: "admitted", resources: ["repo"], budget: { maxExecutions: 2 } });
const dispatch = event({ kind: "dispatched", target: "agent" });
const cost = event({ kind: "cost", costUsd: 0.2 });
const outcome = event({ kind: "outcome", status: "success" });
const drain = event({ kind: "drain-ack", source: "live" });
const append = (...events: ExecutionEvent[]) => events.reduce<readonly ExecutionLedgerEntry[]>((ledger, row) => appendExecution(ledger, row), []);

it.each(["runId", "instanceId", "activation", "graphAttempt", "executionAttemptId"] as const)("matches all five correlation fields: %s", field => {
  const changed = { ...identity, [field]: typeof identity[field] === "number" ? 2 : "different" };
  expect(matchesExecution(identity, identity)).toBe(true);
  expect(matchesExecution(identity, changed)).toBe(false);
  expect(() => appendExecution(append(admitted), { ...dispatch, ...changed } as ExecutionEvent)).toThrow(/Invalid execution ledger/);
});
it("accepts legal dispatch/cost/validation/outcome/drain and exact duplicates only", () => {
  const validation = event({ kind: "dispatched", target: "validation-gate" });
  const ledger = append(admitted, dispatch, cost, validation, outcome, drain);
  for (const row of [admitted, dispatch, cost, validation, outcome, drain]) expect(appendExecution(ledger, structuredClone(row))).toBe(ledger);
  expect(() => appendExecution(ledger, event({ kind: "cost", costUsd: 0.3 }))).toThrow(/Invalid execution ledger/);
  expect(() => appendExecution(ledger, event({ kind: "outcome", status: "failure" }))).toThrow(/Invalid execution ledger/);
  expect(projectExecution(ledger, identity)).toMatchObject({ consumedExecutions: 1, costUsd: 0.2, costAttempts: 1 });
  expect(remainingExecutions(ledger, identity, { maxExecutions: 2 })).toBe(1);
});
it("rejects illegal ordering and supports escalations without cost", () => {
  const escalate = event({ kind: "dispatched", target: "escalation", reason: "undecided" });
  for (const row of [dispatch, cost, outcome, drain]) expect(() => append(row)).toThrow(/Invalid execution ledger/);
  for (const row of [cost, outcome, drain, event({ kind: "dispatched", target: "validation-gate" })]) expect(() => append(admitted, row)).toThrow(/Invalid execution ledger/);
  expect(() => append(admitted, dispatch, outcome, cost)).toThrow(/Invalid execution ledger/);
  expect(() => append(admitted, escalate, cost)).toThrow(/Invalid execution ledger/);
  expect(append(admitted, escalate, outcome, drain)).toHaveLength(4);
  expect(() => append(admitted, event({ kind: "dispatched", target: "escalation" }))).toThrow(/Invalid execution ledger/);
  expect(() => append(admitted, event({ kind: "dispatched", target: "agent", reason: "undecided" }))).toThrow(/Invalid execution ledger/);
});
it("cancellation accepts only cancelled outcome and drain, including before dispatch", () => {
  const cancel = event({ kind: "cancel-requested", reason: "skip" });
  for (const prefix of [[admitted], [admitted, dispatch]]) {
    const ledger = append(...prefix, cancel);
    expect(appendExecution(ledger, cancel)).toBe(ledger);
    for (const reason of ["retry", "lifecycle", "cancel"] as const) expect(() => appendExecution(ledger, event({ kind: "cancel-requested", reason }))).toThrow(/Invalid execution ledger/);
    const malformed = { ...cancel, payload: { kind: "cancel-requested" } };
    expect(() => validateExecutionProtocol({ runId: identity.runId, manifest: [{ instanceId }], executionProtocolVersion: 1, executionLedger: [...prefix, malformed] })).toThrow(/Invalid execution ledger/);
    for (const row of [dispatch, cost, outcome]) {
      if (prefix.includes(row)) continue;
      expect(() => appendExecution(ledger, row)).toThrow(/Invalid execution ledger/);
    }
    const cancelled = appendExecution(ledger, event({ kind: "outcome", status: "cancelled" }));
    expect(appendExecution(cancelled, drain)).toHaveLength(prefix.length + 3);
  }
});
it("validates UUIDs, positive counters, finite costs and immutable admission budgets", () => {
  for (const invalid of ["x", "00000000-0000-1000-8000-000000000002"]) expect(() => executionAttemptId(invalid)).toThrow(/Invalid execution ledger/);
  for (const activation of [0, -1, 1.5, Infinity]) expect(() => append({ ...admitted, activation })).toThrow(/Invalid execution ledger/);
  for (const maxExecutions of [0, -1, 1.5, Infinity]) expect(() => append(event({ kind: "admitted", resources: [], budget: { maxExecutions } }))).toThrow(/Invalid execution ledger/);
  for (const costUsd of [-1, NaN, Infinity]) expect(() => append(admitted, dispatch, event({ kind: "cost", costUsd }))).toThrow(/Invalid execution ledger/);
  const ledger = append(admitted, dispatch, outcome, drain);
  const second = { ...admitted, executionAttemptId: executionAttemptId("00000000-0000-4000-8000-000000000003") };
  expect(() => appendExecution(ledger, { ...second, payload: { kind: "admitted", resources: ["repo"], budget: { maxExecutions: 3 } } })).toThrow(/Invalid execution ledger/);
  const full = appendExecution(ledger, second);
  expect(remainingExecutions(full, identity, { maxExecutions: 2 })).toBe(0);
  expect(() => appendExecution(full, { ...second, executionAttemptId: executionAttemptId("00000000-0000-4000-8000-000000000004") })).toThrow(/Invalid execution ledger/);
});
it("validates the protocol presence matrix and ownership", () => {
  const runtime = { runId: identity.runId, manifest: [{ instanceId }], executionProtocolVersion: 1, executionLedger: [] };
  validateExecutionProtocol(runtime);
  for (const field of ["executionProtocolVersion", "executionLedger"]) {
    const partial = { ...runtime }; Reflect.deleteProperty(partial, field);
    expect(() => validateExecutionProtocol(partial)).toThrow(/Invalid execution ledger/);
  }
  for (const fields of [{ executionProtocolVersion: 2, executionLedger: [] }, { executionProtocolVersion: undefined, executionLedger: undefined }]) {
    expect(() => validateExecutionProtocol(Object.assign({}, runtime, fields))).toThrow(/Invalid execution ledger/);
  }
  for (const bad of [{ ...admitted, runId: "other" }, { ...admitted, instanceId: id }, { ...admitted, activation: 2 }]) expect(() => validateExecutionProtocol({ ...runtime, executionLedger: [bad] } )).toThrow(/Invalid execution ledger/);
});
