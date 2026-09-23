import { createActor, toPromise } from "xstate";
import type { FeedbackResult } from "./bounded-feedback.js";
import { graphLogic } from "./graph-actor.js";
import type { ExecutionCorrelation } from "./graph-execution.js";
import type { NodeInstance } from "./graph-instance-id.js";
import type { AgentGraph, FanoutPhase, GraphNode } from "./ir.js";
import type { NodeHost, NodeResolvedInfo } from "./node-host.js";
import type { GraphNodePresentation } from "./progress.js";
import type { NodeRun, SchedulerState } from "./scheduler.js";

export { type GraphActor, graphLogic } from "./graph-actor.js";
export { namespaceFragment } from "./graph-fragment.js";

export const DEFAULT_CONCURRENCY = 8;

/**
 * The run's control surface, handed to the caller once via
 * {@link RunGraphOptions.onControl}. Shape matches the script runtime's control
 * so the same `/agents` dialog keys drive both. Skip/retry address a node by its
 * declaration index (the order the monitor lists nodes in).
 */
export interface GraphControl {
  pause(): void;
  resume(): void;
  isPaused(): boolean;
  skip(index: number): boolean;
  retry(index: number): boolean;
}

export interface RunGraphOptions {
  host: NodeHost;
  reclaimedDeadWriter?: boolean;
  authorizeAgent?(agent: string): string | undefined;
  runId?: string;
  allocateInstanceId?: () => string;
  /** Injectable epoch-millisecond clock for durable feedback deadlines. */
  now?: () => number;
  /** Synchronous durable commit; throwing prevents further dispatch. Required for v2. */
  onCheckpoint?(state: SchedulerState, graph: AgentGraph): void;
  concurrency?: number;
  signal?: AbortSignal;
  /**
   * Resolves a `graph` node's saved-graph reference to an inline {@link AgentGraph}.
   * Injected so this driver never touches the filesystem or the saved-graph store.
   */
  loadGraph?: (name: string) => AgentGraph | undefined;
  /**
   * Named resource capacities. A node's declared `resources` are each admitted
   * only while their in-use count is below the configured capacity; a resource
   * absent here is unlimited.
   */
  resources?: Record<string, { capacity: number }>;
  /**
   * Reports the initial post-hydration snapshot for each static node, then
   * running, settled, retried, and automatic-skip updates.
   */
  onNodeUpdate?(nodeId: string, run: Readonly<NodeRun>, correlation?: ExecutionCorrelation, presentation?: GraphNodePresentation): void;
  /** Register dynamic rows before their first update; dependencies are display-only. */
  onNodeAdded?(nodeId: string, node: GraphNode, metadata: { dependencies: string[]; phase?: FanoutPhase; instance?: NodeInstance; ordinal?: number; materializationKey?: string; presentation?: GraphNodePresentation }): void;
  /** Fired once the child agent's effective model is known. */
  onNodeResolved?(nodeId: string, info: NodeResolvedInfo, correlation: ExecutionCorrelation): void;
  /** Hands the caller the run's control surface, once, before the first node. */
  onControl?(control: GraphControl): void;
  /** Restore progress from a prior run's snapshot (durable resume). */
  restore?: SchedulerState;
  /** Fired when a human_gate begins awaiting, carrying the run state to persist. */
  onGateWaiting?(nodeId: string, state: SchedulerState, effectiveGraph: AgentGraph): void;
}

export interface RunGraphResult {
  readonly feedback?: Readonly<Record<string, FeedbackResult>>;
  status: "completed" | "failed" | "aborted";
  outputs: Record<string, unknown>;
  nodes: Record<string, NodeRun>;
}

export function coerceGraphInput(input: unknown): unknown {
  if (typeof input !== "string") return input;
  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
}

/** The actor owns lifecycle; this adapter owns only the external signal listener. */
export async function runGraph(graph: AgentGraph, input: unknown, options: RunGraphOptions): Promise<RunGraphResult> {
  const actor = createActor(graphLogic, { input: { graph, input, options, depth: 0 } });
  const abort = () => actor.send({ type: "CANCEL", reason: options.signal?.reason });
  const result = toPromise(actor);
  options.signal?.addEventListener("abort", abort, { once: true });
  actor.start();
  if (options.signal?.aborted) abort();
  try { return await result; }
  finally { options.signal?.removeEventListener("abort", abort); actor.stop(); }
}
