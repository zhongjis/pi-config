import { isDeepStrictEqual } from "node:util";
import { upgradeLegacyExecution, validateExecutionState } from "./graph-execution.js";
import type { GraphRunSnapshot } from "./graph-persist.js";
import type { AgentGraph } from "./ir.js";
import type { SchedulerState } from "./scheduler.js";
import { validateSubgraphDispositions, validateSubgraphDispositionTransition } from "./subgraph-disposition.js";

function prefix(previous: readonly unknown[], next: readonly unknown[], label: string): void {
  if (next.length < previous.length || previous.some((value, index) => !isDeepStrictEqual(value, next[index]))) throw new TypeError(`Checkpoint rewrites ${label}`);
}
function transition(previous: SchedulerState, next: SchedulerState, graph: AgentGraph): void {
  const before = previous.runtime; const after = next.runtime;
  validateExecutionState(next, graph);
  validateSubgraphDispositions(next, graph);
  validateSubgraphDispositionTransition(previous, next);
  if (before?.executionProtocolVersion === 1) {
    if (!after || after.executionProtocolVersion !== 1 || !before.executionLedger || !after.executionLedger) throw new TypeError("Checkpoint removes execution protocol");
    prefix(before.executionLedger, after.executionLedger, "execution ledger");
  } else if (before && after?.executionProtocolVersion === 1) {
    const upgraded = upgradeLegacyExecution(previous).runtime;
    if (!upgraded?.executionLedger || !after.executionLedger) throw new TypeError("Checkpoint has incomplete execution protocol");
    prefix(upgraded.executionLedger, after.executionLedger, "legacy execution baseline");
  }
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
      }
    }
    for (const [key, successor] of Object.entries(after.feedback ?? {})) {
      const feedback = before.feedback?.[key];
      const failures = successor.retryFailures ?? 0;
      if (!Number.isSafeInteger(failures) || failures < 0 || (successor.retryError !== undefined) !== (failures > 0) || (failures > 0 && typeof successor.retryError !== "string")) throw new TypeError("Invalid evaluator failure evidence");
      // Evidence resets only when a new evaluator is materialized, never at decision/intent.
      if (!feedback || successor.active && successor.active.evaluator !== feedback.active?.evaluator) {
        if (failures !== 0) throw new TypeError("Checkpoint initializes evaluator failure evidence");
      } else {
        const delta = failures - (feedback.retryFailures ?? 0);
        const sameActive = feedback.active !== undefined && successor.active?.evaluator === feedback.active.evaluator;
        if (delta < 0 || delta > (sameActive ? 1 : 0) || (delta === 0 && successor.retryError !== feedback.retryError)) throw new TypeError("Checkpoint rewrites evaluator failure evidence");
        if (sameActive && after.executionProtocolVersion === 1) {
          const instance = before.manifest.find(row => row.binding === feedback.active?.evaluator);
          if (!instance || !after.executionLedger) throw new TypeError("Missing evaluator execution evidence");
          const appended = after.executionLedger.slice(before.executionProtocolVersion === 1 ? before.executionLedger?.length : 0);
          const failures = appended.filter(row => row.instanceId === instance.instanceId && !("kind" in row) && row.payload.kind === "outcome" && row.payload.status === "failure").length;
          if (delta !== failures) throw new TypeError("Checkpoint evaluator failures disagree with execution outcomes");
        }
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
