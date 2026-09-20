import { isDeepStrictEqual } from "node:util";
import type { NodeInstanceId } from "./graph-instance-id.js";
import type { ChildCheckpointRequest, ChildGraphDrained } from "./graph-protocol.js";
import type { GraphFragment } from "./ir.js";

/** Volatile handoff of committed Panda identity; subgraphs retain parent node capacity. */
export interface CoordinatorReceipt {
  readonly kind: "expand" | "fanout" | "bounded_feedback" | "graph";
  readonly id: string;
  readonly runId: string;
  readonly instanceId: NodeInstanceId;
  readonly activation: number;
  readonly graphAttempt: number;
  readonly attempt: number;
  readonly incarnation: string;
}
export function coordinatorReceipt(receipt: CoordinatorReceipt): CoordinatorReceipt { return Object.freeze({ ...receipt }); }
export interface CoordinatorEnvelope {
  readonly receipt: CoordinatorReceipt;
  readonly requestSequence: number;
}
export type CoordinatorOperation =
  | { readonly kind: "nested-checkpoint"; readonly request: ChildCheckpointRequest }
  | { readonly kind: "nested-settlement"; readonly result: ChildGraphDrained }
  | { readonly kind: "insert"; readonly fragment: GraphFragment }
  | { readonly kind: "materialize" | "aggregate" }
  | { readonly kind: "feedback-intent" }
  | { readonly kind: "feedback-materialize" | "feedback-decision"; readonly iteration: number }
  | { readonly kind: "fail"; readonly error: string }
  | { readonly kind: "cancel"; readonly disposition: "cancel" | "lifecycle" };
export interface CoordinatorRequest extends CoordinatorEnvelope { readonly type: "COORD.REQUEST"; readonly operation: CoordinatorOperation }
/** Echoes the whole operation, including topology, not merely its sequence. */
export interface CoordinatorAck extends CoordinatorEnvelope { readonly type: "COORD.ACK"; readonly operation: CoordinatorOperation; readonly ordinals?: Readonly<Record<string, number>> }
export type CoordinatorParentEvent = CoordinatorRequest |
  (CoordinatorEnvelope & { readonly type: "COORD.RELEASE_READY" | "COORD.RELEASED" }) |
  (CoordinatorEnvelope & { readonly type: "COORD.DRAINED"; readonly failure: { readonly error: unknown } });
/** Bounded committed owner facts, never a projection or mutable child-status map. */
export interface CollectionOwnerView {
  readonly revision: number;
  readonly materialized: boolean;
  readonly ready: boolean;
  readonly settled: boolean;
}
export interface FeedbackOwnerView {
  readonly revision: number;
  readonly phase: "absent" | "intent" | "work" | "evaluation" | "decision" | "terminal";
  readonly iteration: number;
}
export type CoordinatorChildEvent = CoordinatorAck |
  { readonly type: "COORD.FEEDBACK_VIEW"; readonly receipt: CoordinatorReceipt; readonly view: FeedbackOwnerView } |
  { readonly type: "COORD.VIEW"; readonly receipt: CoordinatorReceipt; readonly view: CollectionOwnerView } |
  { readonly type: "COORD.ADMITTED" | "COORD.RELEASE"; readonly receipt: CoordinatorReceipt } |
  { readonly type: "COORD.CANCEL"; readonly receipt: CoordinatorReceipt; readonly disposition: "cancel" | "lifecycle" } |
  { readonly type: "FAIL"; readonly error: unknown };

function freeze(value: unknown): void {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const child of Object.values(value)) freeze(child);
}
const capturedRequests = new WeakSet<CoordinatorRequest>();
export function captureCoordinatorRequest(request: CoordinatorRequest): CoordinatorRequest {
  if (capturedRequests.has(request)) return request;
  let copy = request.operation.kind === "insert" ? structuredClone(request) : { ...request, receipt: { ...request.receipt }, operation: { ...request.operation } };
  if (request.operation.kind === "nested-checkpoint") {
    const { frame, ...envelope } = request.operation.request;
    copy = { ...copy, operation: { kind: "nested-checkpoint", request: { ...envelope, frame: { ...structuredClone({ state: frame.state, graph: frame.graph, input: frame.input }), publications: [...frame.publications] } } } };
  } else if (request.operation.kind === "nested-settlement") copy = { ...copy, operation: structuredClone(request.operation) };
  freeze(copy); capturedRequests.add(copy); return copy;
}
interface Entry { readonly request: CoordinatorRequest; prepared?: CoordinatorAck; committed?: CoordinatorAck }
type Delivery = { readonly kind: "apply" | "pending" } | { readonly kind: "replay"; readonly ack: CoordinatorAck };

/** Root-owned replay evidence only. Prepared ACKs authorize nothing until outer commit. */
export class CoordinatorRequestJournal {
  private readonly entries = new Map<number, Entry>();
  readonly receipt: CoordinatorReceipt;
  constructor(receipt: CoordinatorReceipt) { this.receipt = coordinatorReceipt(receipt); }
  matches(envelope: CoordinatorEnvelope): boolean { return isDeepStrictEqual(this.receipt, envelope.receipt); }
  committed(sequence: number): CoordinatorAck | undefined { return this.entries.get(sequence)?.committed; }
  receive(request: CoordinatorRequest, current: CoordinatorReceipt): Delivery {
    if (!this.matches(request)) throw new TypeError("Stale coordinator incarnation or identity");
    if (!Number.isSafeInteger(request.requestSequence) || request.requestSequence < 1) throw new TypeError("Invalid coordinator request sequence");
    const prior = this.entries.get(request.requestSequence);
    if (prior) {
      if (!isDeepStrictEqual(prior.request, request)) throw new TypeError("Conflicting coordinator request sequence");
      return prior.committed ? { kind: "replay", ack: prior.committed } : { kind: "pending" };
    }
    if (request.requestSequence !== this.entries.size + 1) throw new TypeError("Reordered coordinator request sequence");
    if (this.entries.size && !this.entries.get(this.entries.size)?.committed) throw new TypeError("Coordinator request still pending checkpoint");
    if (!isDeepStrictEqual(current, request.receipt)) throw new TypeError("Stale coordinator correlation");
    this.entries.set(request.requestSequence, { request: captureCoordinatorRequest(request) });
    return { kind: "apply" };
  }
  prepare(ack: CoordinatorAck): void {
    const entry = this.entries.get(ack.requestSequence);
    const { ordinals: _ordinals, ...envelope } = ack;
    if (!entry || !isDeepStrictEqual(entry.request, { ...envelope, type: "COORD.REQUEST" })) throw new TypeError("Conflicting coordinator acknowledgment");
    if (entry.prepared) {
      if (!isDeepStrictEqual(entry.prepared, ack)) throw new TypeError("Conflicting prepared coordinator acknowledgment");
      return;
    }
    entry.prepared = Object.freeze({ ...captureCoordinatorRequest(entry.request), type: "COORD.ACK", ...(ack.ordinals ? { ordinals: Object.freeze({ ...ack.ordinals }) } : {}) });
  }
  commit(ack: CoordinatorAck): void {
    const entry = this.entries.get(ack.requestSequence);
    if (!entry?.prepared) throw new TypeError("Coordinator acknowledgment was not prepared");
    if (!isDeepStrictEqual(entry.prepared, ack)) throw new TypeError("Conflicting coordinator acknowledgment commit");
    entry.committed = entry.prepared;
  }
}
