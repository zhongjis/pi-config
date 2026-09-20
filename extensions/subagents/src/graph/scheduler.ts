import type { FanoutChild } from "./fanout.js";
import type { ExecutionAttemptId } from "./graph-execution.js";
import type { GraphRuntimeState } from "./graph-instance-id.js";
import type { NodeId } from "./ir.js";

export type NodeStatus = "pending" | "running" | "completed" | "failed" | "skipped";

export interface NodeRun {
  activation?: number;
  graphAttempt?: number;
  currentExecutionAttemptId?: ExecutionAttemptId;
  /** Accumulated reported cost across executions of this instance. */
  costUsd?: number;
  costUnavailable?: boolean;
  costAttempts?: number;
  status: NodeStatus;
  /** How many times this node has started (incremented on each (re)run). */
  attempt: number;
  attemptReason?: "user-retry" | "loop" | "restore";
  /** Parsed output of a completed node — the value ValueRefs read. */
  output?: unknown;
  error?: string;
}

/** The disposition of one node run, fed back from the driver. */
export interface SettleInput {
  costUsd?: number;
  ok: boolean;
  output?: unknown;
  error?: string;
  /** The run was skipped/dismissed rather than a genuine failure. */
  skipped?: boolean;
}

/** A serializable snapshot of a run's progress, for durable pause/resume. */
export interface SchedulerState {
  runtime?: GraphRuntimeState;
  nodes: Record<NodeId, NodeRun>;
  loopCounts: Record<string, number>;
  /** Additive v1 metadata; absent in snapshots predating fanout. */
  collections?: Record<NodeId, readonly FanoutChild[]>;
}
