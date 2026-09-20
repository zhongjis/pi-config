import { isDeepStrictEqual } from "node:util";
import type { CancellationReason } from "./graph-execution.js";
import type { CompiledSchema } from "./json-schema.js";
import type { NodeHost, NodeSpawnResult } from "./node-host.js";
import { admissionReceipt, type NodeAck, type NodeAdmissionReceipt, type NodeChildEvent, type NodeEnvelope, type NodeOperation, type NodeParentEvent, type NodeRequest, NodeRequestJournal } from "./node-protocol.js";

interface NodeInput {
  readonly receipt: NodeAdmissionReceipt;
  readonly host: NodeHost;
  readonly authorize?: () => string | undefined;
}
interface Prompt {
  readonly nodeId: string;
  readonly prompt: string;
  readonly schema?: CompiledSchema;
}
export interface AgentLifecycleInput extends NodeInput {
  readonly node: Prompt & { readonly kind: "agent"; readonly agentType: string; readonly gate?: string; readonly maxAttempts?: number };
}
export interface HumanGateLifecycleInput extends NodeInput {
  readonly node: Prompt & { readonly kind: "human" };
}
export type NodeLifecycleInput = AgentLifecycleInput | HumanGateLifecycleInput;
export type NodeResolution = Extract<NodeParentEvent, { type: "NODE.RESOLVED" }>;
export type NodeLifecycleEvent = NodeChildEvent | NodeResolution;

/** Volatile actor-local protocol/effect evidence, never a Panda projection. */
export interface NodeSession {
  readonly input: NodeLifecycleInput;
  readonly controller: AbortController;
  readonly journal: NodeRequestJournal;
  receipt: NodeAdmissionReceipt;
  admitted: boolean;
  active: boolean;
  executed: boolean;
  requestSequence: number;
  pending?: NodeRequest;
  continuation?: "spawn" | "gate";
  cancellation?: { readonly disposition: CancellationReason; readonly reason: unknown };
  cancelAcknowledged: boolean;
  settled: boolean;
  failure?: { readonly error: unknown };
  result: NodeSpawnResult;
}
export function nodeSession(input: NodeLifecycleInput): NodeSession {
  const receipt = admissionReceipt(input.receipt);
  return { input, receipt, controller: new AbortController(), journal: new NodeRequestJournal(receipt),
    admitted: false, active: false, executed: false, requestSequence: 0, cancelAcknowledged: false, settled: false,
    result: { ok: false, skipped: true, error: "Aborted." } };
}
export function envelope(context: NodeSession): NodeEnvelope {
  return { id: context.receipt.id, incarnation: context.receipt.incarnation, correlation: context.receipt.correlation, requestSequence: context.requestSequence };
}
export function failNode(context: NodeSession, error: unknown): void {
  context.failure ??= { error };
  context.controller.abort(context.failure.error);
}
export function acceptReceipt(context: NodeSession, receipt: NodeAdmissionReceipt): boolean {
  if (isDeepStrictEqual(context.receipt, receipt)) return true;
  failNode(context, new TypeError("Conflicting node receipt"));
  return false;
}
export function nodeRequest(context: NodeSession, operation: NodeOperation): NodeRequest {
  if (context.failure || context.pending || !context.admitted) throw new TypeError("Node request outside committed protocol boundary");
  const request: NodeRequest = { type: "NODE.REQUEST", ...envelope(context), requestSequence: ++context.requestSequence, operation };
  context.journal.receive(request, context.receipt.correlation);
  context.pending = request;
  return request;
}
export function acceptAck(context: NodeSession, ack: NodeAck): void {
  if (context.failure) return;
  try {
    // The same journal rules validate child ACKs and root replay; it holds no lifecycle projection.
    context.journal.prepare(ack);
    context.journal.commit(ack);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    failNode(context, error);
    return;
  }
  if (context.pending?.requestSequence !== ack.requestSequence) return; // Exact committed duplicate.
  context.receipt = admissionReceipt(ack.receipt);
  context.pending = undefined;
  switch (ack.operation.kind) {
    case "repair": context.continuation = "spawn"; context.executed = false; break;
    case "gate": context.continuation = "gate"; break;
    case "cancel": context.cancelAcknowledged = true; context.controller.abort(context.cancellation?.reason); break;
    case "settle": context.settled = true; break;
    default: { const exhaustive: never = ack.operation; throw new TypeError(`Unknown node operation: ${exhaustive}`); }
  }
}
export function settlement(context: NodeSession): NodeOperation {
  const disposition = context.cancellation?.disposition;
  return { kind: "settle", result: context.cancellation ? { ok: false, skipped: true, error: "Aborted." } : context.result,
    executed: context.executed, cancelled: context.cancelAcknowledged,
    projection: disposition === "retry" ? "retry" : disposition === "lifecycle" ? "retain" : "complete" };
}
