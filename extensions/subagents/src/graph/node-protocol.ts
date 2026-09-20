import { isDeepStrictEqual } from "node:util";
import { type CancellationReason, type ExecutionCorrelation, matchesExecution } from "./graph-execution.js";
import type { NodeResolvedInfo, NodeSpawnResult } from "./node-host.js";

/** Allocated in an admission wave; handed to the child only after that wave commits. */
export interface NodeAdmissionReceipt {
  readonly id: string;
  readonly incarnation: string;
  readonly correlation: ExecutionCorrelation;
  readonly executionSequence: number;
}
export function admissionReceipt(receipt: NodeAdmissionReceipt): NodeAdmissionReceipt {
  return Object.freeze({ ...receipt, correlation: Object.freeze({ ...receipt.correlation }) });
}

export interface NodeEnvelope {
  readonly id: string;
  readonly incarnation: string;
  readonly correlation: ExecutionCorrelation;
  /** Monotonic within this volatile incarnation, independent of execution count. */
  readonly requestSequence: number;
}
export type NodeOperation =
  | { readonly kind: "gate"; readonly costUsd: number | undefined }
  | { readonly kind: "repair"; readonly result: Readonly<NodeSpawnResult>; readonly executed: boolean }
  | { readonly kind: "cancel"; readonly disposition: CancellationReason }
  | { readonly kind: "settle"; readonly result: Readonly<NodeSpawnResult>; readonly executed: boolean;
      readonly cancelled: boolean; readonly projection: "complete" | "retry" | "retain" };
export interface NodeRequest extends NodeEnvelope {
  readonly type: "NODE.REQUEST";
  readonly operation: NodeOperation;
}
/** Echoes the complete request, so an ACK cannot authorize a different operation. */
export interface NodeAck extends NodeEnvelope {
  readonly type: "NODE.ACK";
  readonly operation: NodeOperation;
  readonly receipt: NodeAdmissionReceipt;
}
export type NodeParentEvent = NodeRequest |
  (NodeEnvelope & { readonly type: "NODE.RESOLVED"; readonly info: Readonly<NodeResolvedInfo> }) |
  (NodeEnvelope & { readonly type: "NODE.RELEASE_READY" }) |
  (NodeEnvelope & { readonly type: "NODE.RELEASED" }) |
  (NodeEnvelope & { readonly type: "NODE.DRAINED"; readonly failure: { readonly error: unknown } });
export type NodeChildEvent = NodeAck |
  { readonly type: "NODE.ADMITTED"; readonly receipt: NodeAdmissionReceipt } |
  { readonly type: "NODE.RELEASE"; readonly receipt: NodeAdmissionReceipt } |
  { readonly type: "CANCEL"; readonly disposition: CancellationReason; readonly reason?: unknown } |
  { readonly type: "FAIL"; readonly error: unknown };

type Delivery = { readonly kind: "apply" } | { readonly kind: "pending" } | { readonly kind: "replay"; readonly ack: NodeAck };
// Mutable only inside the root-owned request journal; never persisted as lifecycle state.
interface Entry { readonly request: NodeRequest; prepared?: NodeAck; committed?: NodeAck }
export function captureRequest(request: NodeRequest): NodeRequest {
  const operation = request.operation;
  switch (operation.kind) {
    case "repair": case "settle": return Object.freeze({ ...request, correlation: Object.freeze({ ...request.correlation }),
      operation: Object.freeze({ ...operation, result: Object.freeze({ ...operation.result }) }) });
    case "gate": case "cancel": return Object.freeze({ ...request, correlation: Object.freeze({ ...request.correlation }), operation: Object.freeze({ ...operation }) });
    default: { const exhaustive: never = operation; throw new TypeError(`Unknown node operation: ${exhaustive}`); }
  }
}
function requestOf(ack: NodeAck): NodeRequest {
  return { type: "NODE.REQUEST", id: ack.id, incarnation: ack.incarnation, correlation: ack.correlation,
    requestSequence: ack.requestSequence, operation: ack.operation };
}

/** One journal per live incarnation. Root transactions prepare; post-checkpoint actions commit. */
export class NodeRequestJournal {
  private readonly entries = new Map<number, Entry>();
  private latest: NodeAdmissionReceipt;
  constructor(receipt: NodeAdmissionReceipt) { this.latest = admissionReceipt(receipt); }

  get receipt(): NodeAdmissionReceipt { return this.latest; }
  matchesIncarnation(envelope: NodeEnvelope): boolean {
    return envelope.id === this.latest.id && envelope.incarnation === this.latest.incarnation;
  }
  committedSettlement(sequence: number): NodeAck | undefined {
    const ack = this.entries.get(sequence)?.committed;
    return ack?.operation.kind === "settle" ? ack : undefined;
  }

  receive(request: NodeRequest, current: ExecutionCorrelation): Delivery {
    if (request.id !== this.latest.id || request.incarnation !== this.latest.incarnation) throw new TypeError("Stale node incarnation");
    if (!Number.isSafeInteger(request.requestSequence) || request.requestSequence < 1) throw new TypeError("Invalid node request sequence");
    // A committed repair's request names the PRE-repair execution. Replay precedes current-identity validation.
    const prior = this.entries.get(request.requestSequence);
    if (prior) {
      if (!isDeepStrictEqual(prior.request, request)) throw new TypeError("Conflicting node request sequence");
      return prior.committed ? { kind: "replay", ack: prior.committed } : { kind: "pending" };
    }
    if (request.requestSequence !== this.entries.size + 1) throw new TypeError("Reordered node request sequence");
    const previous = this.entries.get(this.entries.size);
    if (previous && !previous.committed) throw new TypeError("Node request still pending checkpoint");
    if (!matchesExecution(current, request.correlation)) throw new TypeError("Stale node execution correlation");
    this.entries.set(request.requestSequence, { request: captureRequest(request) });
    return { kind: "apply" };
  }

  prepare(ack: NodeAck): void {
    const entry = this.entries.get(ack.requestSequence);
    if (!entry || !isDeepStrictEqual(entry.request, requestOf(ack))) throw new TypeError("Conflicting node acknowledgment");
    if (entry.prepared) {
      if (!isDeepStrictEqual(entry.prepared, ack)) throw new TypeError("Conflicting prepared node acknowledgment");
      return;
    }
    const receipt = ack.receipt;
    if (receipt.id !== this.latest.id || receipt.incarnation !== this.latest.incarnation) throw new TypeError("Stale node acknowledgment incarnation");
    switch (entry.request.operation.kind) {
      case "repair": {
        const prior = entry.request.correlation;
        if (!matchesExecution({ ...prior, executionAttemptId: receipt.correlation.executionAttemptId }, receipt.correlation) ||
          receipt.correlation.executionAttemptId === prior.executionAttemptId || receipt.executionSequence !== this.latest.executionSequence + 1) {
          throw new TypeError("Invalid repair acknowledgment identity");
        }
        break;
      }
      case "gate": case "cancel": case "settle":
        if (!matchesExecution(entry.request.correlation, receipt.correlation) || receipt.executionSequence !== this.latest.executionSequence) throw new TypeError("Invalid node acknowledgment identity");
        break;
      default: { const exhaustive: never = entry.request.operation; throw new TypeError(`Unknown node operation: ${exhaustive}`); }
    }
    entry.prepared = Object.freeze({ ...captureRequest(entry.request), type: "NODE.ACK", receipt: admissionReceipt(receipt) });
  }

  /** Call only after the containing checkpoint (including a nested cascade) is acknowledged. */
  commit(ack: NodeAck): void {
    const entry = this.entries.get(ack.requestSequence);
    if (!entry?.prepared) throw new TypeError("Node acknowledgment was not prepared");
    if (!isDeepStrictEqual(entry.prepared, ack)) throw new TypeError("Conflicting node acknowledgment commit");
    if (entry.committed) return;
    entry.committed = entry.prepared;
    this.latest = entry.prepared.receipt;
  }
}
