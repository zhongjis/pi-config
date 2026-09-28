import assert from "node:assert/strict";
import { boot, required } from "./graph-run-registration.fixture.js";

export const gateNode = {
  type: "human_gate", prompt: "Approve release?",
  outputSchema: { type: "object", properties: { approved: { type: "boolean" } }, required: ["approved"], additionalProperties: false },
};
export const gateGraph = { nodes: { gate: gateNode }, edges: [], outputs: { decision: { node: "gate", path: "$" } } };
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
export function resolveGate(host: Host, identity: Awaited<ReturnType<typeof pendingGate>>, response: unknown = { approved: true }) {
  return required(host.tools.get("resolve_agent_graph_gate")).execute("resolve", { ...identity, response }, undefined, undefined, host.ctx);
}
export async function launch(host: Host, graph: unknown = gateGraph, input: unknown = {}) {
  const result = await required(host.tools.get("agent_graph")).execute("launch", { graph, input }, undefined, undefined, host.ctx);
  return required(result.details?.taskId);
}
