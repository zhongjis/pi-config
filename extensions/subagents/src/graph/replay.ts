import { evaluateCondition } from "./condition.js";
import { isDone, readyNodes, resolutionContext, resolveOutputs, skipProposal, transitionProposal } from "./graph-planner.js";
import { applyProjection, parseProjection } from "./graph-projection.js";
import type { AgentGraph } from "./ir.js";
import { GRAPH_OUTCOME_KEY } from "./outcome.js";
import type { NodeStatus, SchedulerState } from "./scheduler.js";
import { schemaHash } from "./trace.js";

/**
 * Pure trace replay: re-fold a recorded graph trace through a candidate graph with the real
 * planner and condition evaluator. No host, model, or filesystem access.
 */
export interface TraceHeader {
  readonly runId: string;
  readonly startedAt: number;
  readonly graph: AgentGraph;
  readonly input: unknown;
  readonly schemaHashes: Readonly<Record<string, string>>;
}
interface ExecutionRecord { readonly status: "completed" | "failed" | "skipped"; readonly output?: unknown; readonly error?: string }
export interface ParsedTrace {
  readonly header: TraceHeader;
  /** Terminal records that followed a recorded start, per node, in commit order. */
  readonly executions: ReadonlyMap<string, readonly ExecutionRecord[]>;
  /** Last recorded status per node. */
  readonly recorded: ReadonlyMap<string, NodeStatus>;
  readonly truncated: boolean;
  readonly end?: { readonly status: string; readonly outcome?: unknown };
}
export type ReplayStatus = NodeStatus | "needs-live-run" | "blocked" | "absent";
export interface ReplayReport {
  readonly runId: string;
  readonly truncated: boolean;
  readonly ended: boolean;
  readonly recordedStatus?: string;
  readonly nodes: readonly { readonly id: string; readonly baseline: ReplayStatus; readonly candidate: ReplayStatus }[];
  readonly edges: readonly { readonly from: string; readonly to: string; readonly baselineActive: boolean; readonly candidateActive: boolean }[];
  readonly loopCounts: { readonly baseline: Record<string, number>; readonly candidate: Record<string, number> };
  readonly outputs: { readonly baseline: Record<string, unknown>; readonly candidate: Record<string, unknown> };
  readonly outcome: { readonly baseline?: unknown; readonly candidate?: unknown };
  readonly needsLiveRun: readonly string[];
  readonly selfConsistency: { readonly ok: boolean; readonly mismatches: readonly { readonly id: string; readonly recorded: NodeStatus; readonly replayed: ReplayStatus }[] };
  readonly errors: readonly string[];
}

const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const STATUSES: readonly string[] = ["pending", "running", "completed", "failed", "skipped"];
const TERMINAL: readonly string[] = ["completed", "failed", "skipped"];

/** Defensive JSONL decode: unknown or malformed lines are ignored; a partial final line or cap marker means truncated. */
export function parseTrace(text: string): ParsedTrace | { error: string } {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  let header: TraceHeader | undefined;
  let truncated = false;
  let end: ParsedTrace["end"];
  const executions = new Map<string, ExecutionRecord[]>();
  const recorded = new Map<string, NodeStatus>();
  for (const [index, line] of lines.entries()) {
    let row: unknown;
    try { row = JSON.parse(line); } catch { if (index === lines.length - 1) truncated = true; continue; }
    if (!object(row)) continue;
    if (!header) {
      const graph = row.graph;
      if (row.type !== "header" || row.version !== 1 || typeof row.runId !== "string" || !object(graph) || !object(graph.nodes) || !Array.isArray(graph.edges) || !object(row.schemaHashes)) break;
      header = { runId: row.runId, startedAt: typeof row.startedAt === "number" ? row.startedAt : 0, graph: graph as unknown as AgentGraph, input: row.input,
        schemaHashes: Object.fromEntries(Object.entries(row.schemaHashes).filter((entry): entry is [string, string] => typeof entry[1] === "string")) };
      continue;
    }
    if (row.type === "truncated") truncated = true;
    else if (row.type === "end" && typeof row.status === "string") end = { status: row.status, ...(row.outcome !== undefined ? { outcome: row.outcome } : {}) };
    else if (row.type === "node" && typeof row.nodeId === "string" && typeof row.status === "string" && STATUSES.includes(row.status)) {
      const status = row.status as NodeStatus;
      if (recorded.get(row.nodeId) === "running" && TERMINAL.includes(status)) {
        const list = executions.get(row.nodeId) ?? [];
        list.push({ status: status as ExecutionRecord["status"], ...(row.output !== undefined ? { output: row.output } : {}), ...(typeof row.error === "string" ? { error: row.error } : {}) });
        executions.set(row.nodeId, list);
      }
      recorded.set(row.nodeId, status);
    }
  }
  if (!header) return { error: "Trace has no version 1 header." };
  return { header, executions, recorded, truncated, ...(end ? { end } : {}) };
}

interface Fold {
  readonly statuses: Map<string, ReplayStatus>;
  readonly fired: Set<string>;
  readonly loopCounts: Record<string, number>;
  readonly outputs: Record<string, unknown>;
  readonly parked: readonly string[];
  readonly error?: string;
}
const edgeKey = (from: string, to: string): string => `${from}->${to}`;

/**
 * Drives the real planner. Ready waves start together, then settle in wave order from the
 * k-th recorded execution of each node when its output-contract hash still matches.
 */
// ponytail: fanout, bounded_feedback, expand and graph nodes replay atomically from their recorded
// top-level output; internal children, iterations and expand-inserted topology are never re-planned.
// Upgrade path: fold recorded child lines through collection/feedback proposals per owner.
function fold(trace: ParsedTrace, graph: AgentGraph): Fold {
  const state: SchedulerState = parseProjection(graph);
  const view = () => ({ state, graph, input: trace.header.input });
  const occurrences = new Map<string, number>();
  const parked = new Set<string>();
  const fired = new Set<string>();
  let error: string | undefined;
  try {
    for (;;) {
      const ready = readyNodes(view());
      if (ready.length) {
        for (const id of ready) applyProjection(state, transitionProposal(view(), { kind: "start", id }));
        for (const id of ready) {
          const occurrence = occurrences.get(id) ?? 0;
          occurrences.set(id, occurrence + 1);
          const record = trace.executions.get(id)?.[occurrence];
          const node = graph.nodes[id];
          if (!record || !node || trace.header.schemaHashes[id] !== schemaHash(node)) { parked.add(id); continue; }
          applyProjection(state, transitionProposal(view(), { kind: "settle", id, result: {
            ok: record.status === "completed", ...(record.status === "skipped" ? { skipped: true } : {}),
            ...(record.output !== undefined ? { output: record.output } : {}), ...(record.error !== undefined ? { error: record.error } : {}),
          } }));
          if (record.status !== "completed") continue;
          const ctx = resolutionContext(view());
          for (const edge of graph.edges) if (edge.from === id && (edge.when === undefined || evaluateCondition(edge.when, ctx))) fired.add(edgeKey(edge.from, edge.to));
        }
        continue;
      }
      const skips = skipProposal(view());
      if (skips.skipped.length) { applyProjection(state, skips); continue; }
      if (parked.size || isDone(state)) break;
      const stuck = skipProposal(view(), true);
      if (!stuck.skipped.length) break;
      applyProjection(state, stuck);
    }
  } catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
  const statuses = new Map<string, ReplayStatus>(Object.entries(state.nodes).map(([id, run]) =>
    [id, parked.has(id) && run.status === "running" ? "needs-live-run" : run.status === "pending" && parked.size ? "blocked" : run.status]));
  return { statuses, fired, loopCounts: { ...state.loopCounts }, outputs: resolveOutputs(view()), parked: [...parked], ...(error !== undefined ? { error } : {}) };
}

export function replayTrace(trace: ParsedTrace, candidate: AgentGraph): ReplayReport {
  const baseline = fold(trace, trace.header.graph);
  const next = fold(trace, candidate);
  const ids = [...new Set([...Object.keys(trace.header.graph.nodes), ...Object.keys(candidate.nodes)])];
  const edges = new Map<string, { from: string; to: string }>();
  for (const edge of [...trace.header.graph.edges, ...candidate.edges]) edges.set(edgeKey(edge.from, edge.to), { from: edge.from, to: edge.to });
  const mismatches = Object.keys(trace.header.graph.nodes).flatMap(id => {
    const recorded = trace.recorded.get(id);
    const replayed = baseline.statuses.get(id) ?? "absent";
    return recorded !== undefined && TERMINAL.includes(recorded) && replayed !== recorded ? [{ id, recorded, replayed }] : [];
  });
  return {
    runId: trace.header.runId,
    truncated: trace.truncated,
    ended: trace.end !== undefined,
    ...(trace.end ? { recordedStatus: trace.end.status } : {}),
    nodes: ids.map(id => ({ id, baseline: baseline.statuses.get(id) ?? "absent", candidate: next.statuses.get(id) ?? "absent" })),
    edges: [...edges.entries()].map(([key, edge]) => ({ ...edge, baselineActive: baseline.fired.has(key), candidateActive: next.fired.has(key) })),
    loopCounts: { baseline: baseline.loopCounts, candidate: next.loopCounts },
    outputs: { baseline: baseline.outputs, candidate: next.outputs },
    outcome: { baseline: baseline.outputs[GRAPH_OUTCOME_KEY], candidate: next.outputs[GRAPH_OUTCOME_KEY] },
    needsLiveRun: next.parked,
    selfConsistency: { ok: mismatches.length === 0, mismatches },
    errors: [...baseline.error !== undefined ? [`baseline: ${baseline.error}`] : [], ...next.error !== undefined ? [`candidate: ${next.error}`] : []],
  };
}
