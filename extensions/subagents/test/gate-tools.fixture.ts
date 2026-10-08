import assert from "node:assert/strict";
import { boot, required } from "./graph-run-registration.fixture.js";

/** `minConfidence: 1` keeps tool-level tests on the escalation path whatever the host's decider answers. */
export const gateNode = {
  type: "decision_gate", state: {}, minConfidence: 1,
  questions: { release: { type: "bool", instructions: "Release now?", criteria: { true: "Ready to release", false: "Not ready" } } },
};
export const gateGraph = { nodes: { gate: gateNode }, edges: [], outputs: { decision: { node: "gate", path: "$" } } };
export const approve = { answers: { release: true }, decidedBy: "orchestrator" };
export const reject = { answers: { release: false }, decidedBy: "human" };
export type Host = ReturnType<typeof boot>;
export function retrieve(host: Host, run_id: string, wait = true, signal?: AbortSignal) {
  return required(host.tools.get("get_agent_result")).execute("read", { run_id, wait }, signal, undefined, host.ctx);
}
export async function pendingGate(host: Host, run_id: string) {
  const result = await retrieve(host, run_id);
  const details: unknown = result.details;
  assert.ok(details && typeof details === "object" && "gate" in details, JSON.stringify(result));
  const gate = details.gate;
  assert.ok(gate && typeof gate === "object" && "gate_id" in gate && "revision" in gate);
  assert.ok(typeof gate.gate_id === "string" && typeof gate.revision === "string");
  return { run_id, gate_id: gate.gate_id, revision: gate.revision };
}
export function resolveGate(host: Host, identity: Awaited<ReturnType<typeof pendingGate>>, response: unknown = approve) {
  return required(host.tools.get("resolve_agent_graph_gate")).execute("resolve", { ...identity, response }, undefined, undefined, host.ctx);
}
export async function launch(host: Host, graph: unknown = gateGraph, input: unknown = {}) {
  const result = await required(host.tools.get("agent_graph")).execute("launch", { graph, input }, undefined, undefined, host.ctx);
  return required(result.details?.taskId);
}
