import { isDeepStrictEqual } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { matchesExecution, type ExecutionCorrelation } from "./graph-execution.js";
import type { HumanGateRequest, NodeSpawnResult } from "./node-host.js";
import type { SchedulerState } from "./scheduler.js";

export interface GateRequest {
  readonly gate_id: string;
  readonly revision: string;
  readonly kind: "human_gate" | "hybrid_gate";
  readonly prompt: string;
  readonly response_schema: Record<string, unknown>;
}

function scope(state: SchedulerState | undefined, runId: string): SchedulerState | undefined {
  if (state?.runtime?.runId === runId) return state;
  for (const nested of Object.values(state?.runtime?.nested ?? {})) {
    const found = scope(nested.state, runId);
    if (found) return found;
  }
  return undefined;
}

/** Only committed execution evidence can authorize an actionable human request. */
export function createGateHandoff(changed: () => void, delivery: {
  publish: (gate: GateRequest) => void; observed: (gateId: string) => void; close: () => void;
}) {
  let checkpoint: SchedulerState | undefined;
  const revision = randomUUID();
  const accepted = new Map<string, unknown>();
  const pending = new Map<string, { request: GateRequest; correlation: ExecutionCorrelation; cancel: () => void; answer: (response: unknown) => void }>();
  function current(correlation: ExecutionCorrelation): boolean {
    const state = scope(checkpoint, correlation.runId);
    const rows = state?.runtime?.executionLedger?.filter(row => !("kind" in row) && matchesExecution(row, correlation)) ?? [];
    return rows.some(row => "payload" in row && row.payload.kind === "dispatched" && row.payload.target === "human-gate") &&
      !rows.some(row => "payload" in row && ["cancel-requested", "outcome", "drain-ack"].includes(row.payload.kind));
  }
  return {
    checkpoint(state: SchedulerState) { checkpoint = state; changed(); },
    has(gateId: string) { const entry = pending.get(gateId); return !!entry && current(entry.correlation); },
    observed: delivery.observed,
    pending(): GateRequest | undefined { return [...pending.values()].find(entry => current(entry.correlation))?.request; },
    resolve(gateId: string, token: string, response: unknown) {
      if (token !== revision) throw new Error("Stale human gate revision.");
      const receipt = { gate_id: gateId, revision, accepted: true };
      if (accepted.has(gateId)) {
        if (!isDeepStrictEqual(accepted.get(gateId), response)) throw new Error("Conflicting human gate response.");
        return receipt;
      }
      const entry = pending.get(gateId);
      if (!entry || !current(entry.correlation)) throw new Error("Stale or unavailable human gate.");
      entry.answer(response);
      accepted.set(gateId, structuredClone(response));
      return receipt;
    },
    async awaitHumanGate(request: HumanGateRequest, signal: AbortSignal): Promise<NodeSpawnResult> {
      signal.throwIfAborted();
      const correlation = request.correlation;
      if (!correlation || !request.schema || !current(correlation)) throw new Error("Human gate has no committed current dispatch.");
      const gate_id = createHash("sha256").update(JSON.stringify(correlation)).digest("hex");
      if (pending.has(gate_id)) throw new Error("Duplicate live human gate dispatch.");
      return new Promise<NodeSpawnResult>(resolve => {
        const cancel = () => {
          signal.removeEventListener("abort", cancel);
          pending.delete(gate_id);
          resolve({ ok: false, skipped: true, error: "Human gate cancelled." });
          changed();
        };
        const answer = (response: unknown) => {
          const valid = request.schema?.check(response);
          if (valid !== true) throw new Error(`Invalid gate response: ${valid}`);
          signal.removeEventListener("abort", cancel);
          pending.delete(gate_id);
          resolve({ ok: true, output: JSON.stringify(response) });
          changed();
        };
        pending.set(gate_id, { correlation, cancel, answer, request: { gate_id, revision, kind: request.kind ?? "human_gate",
          prompt: request.prompt, response_schema: request.schema?.schema ?? {} } });
        signal.addEventListener("abort", cancel, { once: true });
        const published = pending.get(gate_id);
        if (published) delivery.publish(published.request);
        changed();
      });
    },
    close() { delivery.close(); for (const entry of [...pending.values()]) entry.cancel(); checkpoint = undefined; },
  };
}
