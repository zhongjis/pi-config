import { isDeepStrictEqual } from "node:util";
import type { GraphRunSnapshot } from "./graph-persist.js";
import type { AgentGraph } from "./ir.js";
import type { SchedulerState } from "./scheduler.js";

function prefix(previous: readonly unknown[], next: readonly unknown[], label: string): void {
  if (next.length < previous.length || previous.some((value, index) => !isDeepStrictEqual(value, next[index]))) throw new TypeError(`Checkpoint rewrites ${label}`);
}
function transition(previous: SchedulerState, next: SchedulerState, graph: AgentGraph): void {
  const before = previous.runtime; const after = next.runtime;
  if (before) {
    if (!after || before.runId !== after.runId || before.startedAt !== after.startedAt || (before.cancelled && !after.cancelled)) throw new TypeError("Checkpoint changes run identity/cancellation");
    prefix(before.manifest, after.manifest, "materialization history");
    if ((after.nextOrdinal ?? 0) < (before.nextOrdinal ?? 0)) throw new TypeError("Checkpoint rolls back materialization counter");
    for (const [key, feedback] of Object.entries(before.feedback ?? {})) {
      const successor = after.feedback?.[key];
      if (!successor) throw new TypeError("Checkpoint removes feedback state");
      if ((successor.budgetCheckedAt ?? 0) < (feedback.budgetCheckedAt ?? 0)) throw new TypeError("Checkpoint rolls back budget clock");
      if (feedback.intent) {
        const admitted = successor.intent ?? successor.active ?? successor.stoppedIntent;
        if (!admitted || admitted.iteration !== feedback.intent.iteration || !isDeepStrictEqual(admitted.tasks, feedback.intent.tasks)) throw new TypeError("Checkpoint rewrites continuation intent");
      }
      prefix(feedback.iterations, successor.iterations, "completed feedback iterations");
      if (feedback.terminal && !isDeepStrictEqual(feedback, successor)) throw new TypeError("Checkpoint rewrites terminal feedback");
      if (feedback.active) {
        const active = successor.active?.iteration === feedback.active.iteration ? successor.active : successor.iterations[feedback.active.iteration - 1];
        if (!active || Object.entries(feedback.active).some(([field, value]) => !isDeepStrictEqual(Reflect.get(active, field), value))) throw new TypeError("Checkpoint rewrites active work");
        if (successor.active?.iteration === feedback.active.iteration && (successor.retryFailures ?? 0) < (feedback.retryFailures ?? 0)) throw new TypeError("Checkpoint resets evaluator repair budget");
      }
    }
    for (const [key, child] of Object.entries(before.nested ?? {})) {
      const successor = after.nested?.[key];
      if (!successor) throw new TypeError("Checkpoint removes nested run");
      if (child.state.runtime?.runId === successor.state.runtime?.runId) {
        if (!isDeepStrictEqual(child.previous ?? [], successor.previous ?? [])) throw new TypeError("Checkpoint rewrites nested history");
        definitionPrefix(child.graph, successor.graph);
        if (!isDeepStrictEqual(child.input, successor.input)) throw new TypeError("Checkpoint changes nested input");
        for (const [binding, ordinal] of Object.entries(child.ordinals)) if (successor.ordinals[binding] !== ordinal) throw new TypeError("Checkpoint rewrites nested ordinal");
        transition(child.state, successor.state, successor.graph);
      } else {
        const { previous: history = [], ...completed } = child;
        if (!isDeepStrictEqual(successor.previous, [...history, completed]) || !successor.state.runtime?.runId.endsWith(`/${next.nodes[key].attempt}`)) throw new TypeError("Checkpoint discards nested invocation history");
      }
    }
  }
  for (const [key, run] of Object.entries(previous.nodes)) {
    const successor = next.nodes[key];
    if (!successor || successor.attempt < run.attempt || successor.attempt > run.attempt + 1) throw new TypeError("Checkpoint rolls back/skips attempts");
    if ((run.costUsd !== undefined && (successor.costUsd === undefined || successor.costUsd < run.costUsd)) || (run.costUnavailable && !successor.costUnavailable) || (successor.costAttempts ?? 0) < (run.costAttempts ?? 0)) throw new TypeError("Checkpoint rolls back cost accounting");
    if (graph.version === 2 && successor.costAttempts === run.costAttempts && (successor.costUsd !== run.costUsd || successor.costUnavailable !== run.costUnavailable)) throw new TypeError("Checkpoint rewrites execution cost");
    if (["completed", "failed", "skipped"].includes(run.status) && !isDeepStrictEqual(run, successor)) {
      const loop = run.status === "completed" && successor.status === "pending" && successor.attemptReason === "loop" && graph.edges.some(edge => edge.to === key && next.nodes[edge.from]?.status === "completed" && (previous.nodes[edge.from]?.status !== "completed" || previous.nodes[edge.from]?.attempt !== next.nodes[edge.from]?.attempt));
      if (!loop) throw new TypeError("Checkpoint rewrites a settled node");
    }
  }
  for (const [key, count] of Object.entries(previous.loopCounts)) if ((next.loopCounts[key] ?? -1) < count) throw new TypeError("Checkpoint rolls back loop counters");
  for (const [key, children] of Object.entries(previous.collections ?? {})) if (!isDeepStrictEqual(children, next.collections?.[key])) throw new TypeError("Checkpoint rewrites collection ownership");
}

/** Called under the write lock, against the actual previous on-disk revision. */
export function validateCheckpointTransition(previous: GraphRunSnapshot, next: GraphRunSnapshot): void {
  if (previous.runId !== next.runId || !isDeepStrictEqual(previous.input, next.input)) throw new TypeError("Checkpoint changes run/input identity");
  definitionPrefix(previous.graph, next.graph);
  transition(previous.state, next.state, next.graph);
}

function definitionPrefix(previous: AgentGraph, next: AgentGraph): void {
  const shape = (value: object, omit: readonly string[]) => Object.fromEntries(Object.entries(value).filter(([key]) => !omit.includes(key)));
  if (!isDeepStrictEqual(shape(previous, ["name", "nodes", "edges"]), shape(next, ["name", "nodes", "edges"]))) throw new TypeError("Checkpoint rewrites graph contracts");
  for (const [key, node] of Object.entries(previous.nodes)) if (!next.nodes[key] || !isDeepStrictEqual(shape(node, ["name", "phase"]), shape(next.nodes[key], ["name", "phase"]))) throw new TypeError("Checkpoint rewrites an executable definition");
  prefix(previous.edges, next.edges, "graph edges");
}
