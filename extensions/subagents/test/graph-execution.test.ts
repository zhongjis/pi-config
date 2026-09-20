import { expect, it } from "vitest";
import { appendExecution, type ExecutionEvent, type ExecutionLedgerEntry, executionAttemptId, matchesExecution, projectExecution, remainingExecutions, upgradeLegacyExecution, validateExecutionProtocol } from "../src/graph/graph-execution.js";
import type { NodeInstanceId } from "../src/graph/graph-instance-id.js";
import type { SchedulerState } from "../src/graph/scheduler.js";

const instanceId = "00000000-0000-4000-8000-000000000001" as NodeInstanceId;
const id = executionAttemptId("00000000-0000-4000-8000-000000000002");
const identity = { runId: "wf_execution", instanceId, activation: 1, graphAttempt: 1, executionAttemptId: id };
const event = (payload: ExecutionEvent["payload"]): ExecutionEvent => ({ ...identity, payload });
const admitted = event({ kind: "admitted", resources: ["repo"], budget: { maxExecutions: 2 } });
const dispatch = event({ kind: "dispatched", target: "agent" });
const cost = event({ kind: "cost", costUsd: 0.2 });
const outcome = event({ kind: "outcome", status: "success" });
const drain = event({ kind: "drain-ack", source: "live" });
const append = (...events: ExecutionEvent[]) => events.reduce<readonly ExecutionLedgerEntry[]>((ledger, row) => appendExecution(ledger, row), []);
function requireValue<T>(value: T | undefined, message = "missing test value"): T {
  if (value === undefined) throw new Error(message);
  return value;
}

it.each(["runId", "instanceId", "activation", "graphAttempt", "executionAttemptId"] as const)("matches all five correlation fields: %s", field => {
  const changed = { ...identity, [field]: typeof identity[field] === "number" ? 2 : "different" };
  expect(matchesExecution(identity, identity)).toBe(true);
  expect(matchesExecution(identity, changed)).toBe(false);
  expect(() => appendExecution(append(admitted), { ...dispatch, ...changed } as ExecutionEvent)).toThrow();
});
it("accepts legal dispatch/cost/validation/outcome/drain and exact duplicates only", () => {
  const validation = event({ kind: "dispatched", target: "validation-gate" });
  const ledger = append(admitted, dispatch, cost, validation, outcome, drain);
  for (const row of [admitted, dispatch, cost, validation, outcome, drain]) expect(appendExecution(ledger, structuredClone(row))).toBe(ledger);
  expect(() => appendExecution(ledger, event({ kind: "cost", costUsd: 0.3 }))).toThrow();
  expect(() => appendExecution(ledger, event({ kind: "outcome", status: "failure" }))).toThrow();
  expect(projectExecution(ledger, identity)).toMatchObject({ consumedExecutions: 1, costUsd: 0.2, costAttempts: 1 });
  expect(remainingExecutions(ledger, identity, { maxExecutions: 2 })).toBe(1);
});
it("rejects illegal ordering and supports human gates without cost", () => {
  for (const row of [dispatch, cost, outcome, drain]) expect(() => append(row)).toThrow();
  for (const row of [cost, outcome, drain, event({ kind: "dispatched", target: "validation-gate" })]) expect(() => append(admitted, row)).toThrow();
  expect(() => append(admitted, dispatch, outcome, cost)).toThrow();
  expect(() => append(admitted, event({ kind: "dispatched", target: "human-gate" }), cost)).toThrow();
  expect(append(admitted, event({ kind: "dispatched", target: "human-gate" }), outcome, drain)).toHaveLength(4);
});
it("cancellation accepts only cancelled outcome and drain, including before dispatch", () => {
  const cancel = event({ kind: "cancel-requested", reason: "skip" });
  for (const prefix of [[admitted], [admitted, dispatch]]) {
    const ledger = append(...prefix, cancel);
    expect(appendExecution(ledger, cancel)).toBe(ledger);
    for (const reason of ["retry", "lifecycle", "cancel"] as const) expect(() => appendExecution(ledger, event({ kind: "cancel-requested", reason }))).toThrow();
    const malformed = { ...cancel, payload: { kind: "cancel-requested" } };
    expect(() => validateExecutionProtocol({ runId: identity.runId, manifest: [{ instanceId }], executionProtocolVersion: 1, executionLedger: [...prefix, malformed] })).toThrow();
    for (const row of [dispatch, cost, outcome]) {
      if (prefix.includes(row)) continue;
      expect(() => appendExecution(ledger, row)).toThrow();
    }
    const cancelled = appendExecution(ledger, event({ kind: "outcome", status: "cancelled" }));
    expect(appendExecution(cancelled, drain)).toHaveLength(prefix.length + 3);
  }
});
it("validates UUIDs, positive counters, finite costs and immutable admission budgets", () => {
  for (const invalid of ["x", "00000000-0000-1000-8000-000000000002"]) expect(() => executionAttemptId(invalid)).toThrow();
  for (const activation of [0, -1, 1.5, Infinity]) expect(() => append({ ...admitted, activation })).toThrow();
  for (const maxExecutions of [0, -1, 1.5, Infinity]) expect(() => append(event({ kind: "admitted", resources: [], budget: { maxExecutions } }))).toThrow();
  for (const costUsd of [-1, NaN, Infinity]) expect(() => append(admitted, dispatch, event({ kind: "cost", costUsd }))).toThrow();
  const ledger = append(admitted, dispatch, outcome, drain);
  const second = { ...admitted, executionAttemptId: executionAttemptId("00000000-0000-4000-8000-000000000003") };
  expect(() => appendExecution(ledger, { ...second, payload: { kind: "admitted", resources: ["repo"], budget: { maxExecutions: 3 } } })).toThrow();
  const full = appendExecution(ledger, second);
  expect(remainingExecutions(full, identity, { maxExecutions: 2 })).toBe(0);
  expect(() => appendExecution(full, { ...second, executionAttemptId: executionAttemptId("00000000-0000-4000-8000-000000000004") })).toThrow();
});
export function legacy(attempt = 0): SchedulerState {
  return { nodes: { worker: { status: "pending", attempt, ...(attempt ? { costAttempts: 1, costUsd: 0.5 } : {}) } }, loopCounts: {}, runtime: { version: 2, runId: identity.runId, revision: 1, manifest: [{ instanceId, nodeKey: "worker", binding: "worker", ordinal: 0 }] } };
}
it.each([0, 1, 3])("upgrades legacy attempt %s deterministically without inventing executions", attempt => {
  const before = legacy(attempt); const upgraded = upgradeLegacyExecution(before);
  expect(before.runtime?.executionLedger).toBeUndefined();
  expect(upgradeLegacyExecution(upgraded)).toBe(upgraded);
  expect(upgraded.runtime?.executionLedger).toEqual([{ kind: "legacy-baseline", runId: identity.runId, instanceId, activation: attempt ? 1 : 0, graphAttempt: attempt ? 1 : 0, consumedExecutions: attempt, costAttempts: attempt ? 1 : 0, costUsd: attempt ? 0.5 : 0, costUnavailable: false }]);
  const runtime = requireValue(upgraded.runtime, "missing upgraded runtime");
  const executionLedger = requireValue(runtime.executionLedger, "missing execution ledger");
  expect(projectExecution(executionLedger, { ...identity, activation: attempt ? 1 : 0, graphAttempt: attempt ? 1 : 0 }).consumedExecutions).toBe(attempt);
  validateExecutionProtocol(runtime);
});
it("validates the protocol presence matrix, ownership and legacy evidence", () => {
  const runtime = requireValue(legacy().runtime, "missing legacy runtime");
  validateExecutionProtocol(runtime);
  validateExecutionProtocol({ ...runtime, executionProtocolVersion: 1, executionLedger: [] });
  for (const fields of [{ executionProtocolVersion: 1 }, { executionLedger: [] }, { executionProtocolVersion: 2, executionLedger: [] }, { executionProtocolVersion: undefined, executionLedger: undefined }]) {
    expect(() => validateExecutionProtocol(Object.assign({}, runtime, fields))).toThrow();
  }
  for (const bad of [{ ...admitted, runId: "other" }, { ...admitted, instanceId: id }, { ...admitted, activation: 2 }]) expect(() => validateExecutionProtocol({ ...runtime, executionProtocolVersion: 1, executionLedger: [bad] } )).toThrow();
  const upgraded = upgradeLegacyExecution(legacy(3));
  const upgradedRuntime = requireValue(upgraded.runtime, "missing upgraded runtime");
  const [baseline] = requireValue(upgradedRuntime.executionLedger, "missing execution ledger");
  if (!baseline) throw new Error("missing execution baseline");
  expect(() => validateExecutionProtocol({ ...runtime, executionProtocolVersion: 1, executionLedger: [{ ...baseline, costAttempts: 4 }] })).toThrow();
});
