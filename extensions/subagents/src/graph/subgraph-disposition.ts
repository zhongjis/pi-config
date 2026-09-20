import { isDeepStrictEqual } from "node:util";
import type { GraphRuntimeState, NodeInstanceId } from "./graph-instance-id.js";
import type { RecoveryProposal } from "./graph-projection.js";
import type { AgentGraph } from "./ir.js";
import type { NodeRun, SchedulerState } from "./scheduler.js";

/** Parent control intent, not a host execution or evidence of physical drain. */
export interface SubgraphDisposition {
  readonly runId: string;
  readonly instanceId: NodeInstanceId;
  readonly activation: number;
  readonly graphAttempt: number;
  readonly attempt: number;
  readonly reason: "skip" | "retry";
}
const matches = (row: SubgraphDisposition, run: NodeRun): boolean => row.attempt === run.attempt && row.activation === run.activation && row.graphAttempt === run.graphAttempt;

export function requestSubgraphDisposition(runtime: GraphRuntimeState, row: SubgraphDisposition): boolean {
  const prior = runtime.subgraphDispositions?.filter(candidate => candidate.instanceId === row.instanceId).at(-1);
  if (prior?.attempt === row.attempt) return isDeepStrictEqual(prior, row);
  runtime.subgraphDispositions = [...runtime.subgraphDispositions ?? [], row];
  return true;
}

/** Called only after recursive recovery has positively drained every child effect. */
export function subgraphRecoveryProposal(runtime: GraphRuntimeState, nodes: Pick<ReadonlyMap<string, NodeRun>, "get">): RecoveryProposal {
  const restarts: string[] = [];
  const changes: Record<string, NodeRun> = Object.create(null);
  const nestedCancelled: GraphRuntimeState[] = [];
  if (!runtime.cancelled) for (const row of runtime.subgraphDispositions ?? []) {
    const instance = runtime.manifest.find(instance => instance.instanceId === row.instanceId);
    if (!instance) throw new TypeError("Missing subgraph disposition owner");
    const prior = changes[instance.binding] ?? nodes.get(instance.binding);
    if (!prior || !matches(row, prior) || !["running", "pending"].includes(prior.status)) continue;
    const child = runtime.nested?.[instance.binding]?.state.runtime;
    if (child) nestedCancelled.push(child);
    const run = { ...prior }; delete run.output; delete run.error;
    switch (row.reason) {
      case "skip": run.status = "skipped"; break;
      case "retry": run.status = "pending"; run.attemptReason = "user-retry"; restarts.push(instance.binding); break;
      default: { const exhaustive: never = row.reason; throw new TypeError(`Unknown subgraph disposition: ${exhaustive}`); }
    }
    changes[instance.binding] = run;
  }
  return { nodes: changes, restarts, nestedCancelled, cancelled: runtime.cancelled === true };
}

export function validateSubgraphDispositions(state: SchedulerState, graph: AgentGraph): void {
  const runtime = state.runtime;
  if (!runtime || runtime.subgraphDispositions === undefined) return;
  if (!Array.isArray(runtime.subgraphDispositions)) throw new TypeError("Invalid subgraph dispositions");
  const latest = new Map<string, SubgraphDisposition>();
  for (const row of runtime.subgraphDispositions) {
    if (!row || typeof row !== "object" || Object.keys(row).sort().join() !== "activation,attempt,graphAttempt,instanceId,reason,runId" || row.runId !== runtime.runId || !["skip", "retry"].includes(row.reason) || ![row.activation, row.graphAttempt, row.attempt].every(n => Number.isSafeInteger(n) && n > 0)) throw new TypeError("Invalid subgraph disposition");
    const instance = runtime.manifest.find(instance => instance.instanceId === row.instanceId);
    const run = instance && state.nodes[instance.binding];
    const prior = latest.get(row.instanceId);
    if (!instance || graph.nodes[instance.binding]?.type !== "graph" || !run || run.activation === undefined || run.graphAttempt === undefined || row.attempt > run.attempt || row.activation > run.activation || row.activation + row.graphAttempt - 1 > row.attempt || (row.activation === run.activation && row.graphAttempt > run.graphAttempt) || (row.attempt === run.attempt && !matches(row, run)) || (prior && (row.attempt <= prior.attempt || row.activation < prior.activation || row.activation === prior.activation && row.graphAttempt <= prior.graphAttempt))) throw new TypeError("Invalid subgraph disposition ownership/order");
    if (matches(row, run) && (run.status === "completed" || run.status === "failed" || row.reason === "retry" && run.status === "skipped" || run.status === "pending" && !runtime.cancelled && (row.reason !== "retry" || run.attemptReason !== "user-retry"))) throw new TypeError("Invalid subgraph disposition settlement");
    latest.set(row.instanceId, row);
  }
}

export function validateSubgraphDispositionTransition(previous: SchedulerState, next: SchedulerState): void {
  const before = previous.runtime?.subgraphDispositions ?? []; const after = next.runtime?.subgraphDispositions ?? [];
  if (after.length < before.length || before.some((row, index) => !isDeepStrictEqual(row, after[index]))) throw new TypeError("Checkpoint rewrites subgraph dispositions");
  for (const instance of next.runtime?.manifest ?? []) {
    if (!after.some(row => row.instanceId === instance.instanceId)) continue;
    const run = previous.nodes[instance.binding]; const successor = next.nodes[instance.binding];
    if (!run || !successor || run.activation === undefined || successor.activation === undefined || run.graphAttempt === undefined || successor.graphAttempt === undefined || successor.activation < run.activation || (successor.activation === run.activation && successor.graphAttempt < run.graphAttempt) || (successor.attempt === run.attempt && (successor.activation !== run.activation || successor.graphAttempt !== run.graphAttempt))) throw new TypeError("Checkpoint rolls back subgraph attempt identity");
  }
  for (const row of after.slice(before.length)) {
    const instance = previous.runtime?.manifest.find(instance => instance.instanceId === row.instanceId);
    const run = instance && previous.nodes[instance.binding]; const successor = instance && next.nodes[instance.binding];
    if (previous.runtime?.cancelled || !run || !successor || run.status !== "running" || !matches(row, run) || !matches(row, successor)) throw new TypeError("Checkpoint appends a stale subgraph disposition");
  }
}
