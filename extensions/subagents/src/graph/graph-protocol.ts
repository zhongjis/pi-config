import type { CoordinatorAck, CoordinatorParentEvent } from "./coordinator-protocol.js";
import type { ExpandInput } from "./expand-actor.js";
import type { FanoutInput } from "./fanout-actor.js";
import type { FeedbackInput } from "./feedback-actor.js";
import type { AgentGraph } from "./ir.js";
import type { AgentLifecycleInput, HumanGateLifecycleInput } from "./node-lifecycle-session.js";
import type { NodeAck, NodeParentEvent } from "./node-protocol.js";
import type { RunGraphOptions, RunGraphResult } from "./run-graph.js";
import type { SchedulerState } from "./scheduler.js";
import type { SubgraphInput } from "./subgraph-actor.js";

export interface GraphActorInput {
  readonly graph: AgentGraph;
  readonly input: unknown;
  readonly options: RunGraphOptions;
  readonly depth: number;
  readonly parent?: { readonly id: string; readonly invocation: string };
}
export interface CheckpointFrame {
  readonly state: SchedulerState;
  readonly graph: AgentGraph;
  readonly input: unknown;
  readonly publications: readonly (() => void)[];
}
export interface ChildCheckpointRequest {
  readonly type: "CHECKPOINT.REQUEST";
  readonly id: string;
  readonly invocation: string;
  readonly sequence: number;
  readonly frame: CheckpointFrame;
}
export type GraphAdmission = { readonly kind: "agent"; readonly id: string; readonly input: AgentLifecycleInput } |
  { readonly kind: "human"; readonly id: string; readonly input: HumanGateLifecycleInput } |
  { readonly kind: "expand"; readonly id: string; readonly input: ExpandInput } |
  { readonly kind: "feedback"; readonly id: string; readonly input: FeedbackInput } |
  { readonly kind: "fanout"; readonly id: string; readonly input: FanoutInput } |
  { readonly kind: "graph"; readonly id: string; readonly input: SubgraphInput };
export interface ChildGraphDrained { readonly type: "GRAPH.DRAINED"; readonly id: string; readonly invocation: string; readonly result: RunGraphResult; readonly failure?: { readonly error: unknown } }
export type GraphEvent = NodeParentEvent | CoordinatorParentEvent |
  { readonly type: "CHECKPOINT.ACK"; readonly sequence: number; readonly ordinals: Readonly<Record<string, number>> } |
  { readonly type: "FAIL"; readonly error: unknown } |
  { readonly type: "CANCEL"; readonly reason?: unknown } |
  { readonly type: "START" } | { readonly type: "WAKE" } | { readonly type: "PAUSE" } | { readonly type: "RESUME" } |
  { readonly type: "CONTROL"; readonly token: symbol; readonly index: number; readonly kind: "skip" | "retry" } |
  { readonly type: "FLUSH"; readonly generation: number };
export type GraphReply = { readonly id: string; readonly event: NodeAck | CoordinatorAck };
