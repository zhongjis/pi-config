import { isDeepStrictEqual } from "node:util";
import type { AgentGraph, FanoutResult } from "./ir.js";
import { compileJsonSchema } from "./json-schema.js";
import type { SchedulerState } from "./scheduler.js";
import { validateGraph } from "./validate.js";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
/** Shared v1/v2 restore boundary, before hydration, upgrade, writes or dispatch. */
export function validateSchedulerState(state: SchedulerState, graph: AgentGraph): void {
  const verdict = validateGraph(graph);
  if (!verdict.ok) throw new TypeError(`Invalid restored graph: ${verdict.errors.join("; ")}`);
  if (!state || !record(state.nodes) || !record(state.loopCounts)) throw new TypeError("Incomplete scheduler checkpoint");
  let attempts = 0;
  for (const [key, run] of Object.entries(state.nodes)) {
    if (!Object.hasOwn(graph.nodes, key) || !record(run) || !["pending", "running", "completed", "failed", "skipped"].includes(run.status) || !Number.isSafeInteger(run.attempt) || run.attempt < 0 || ((run.status === "running" || run.status === "completed") && run.attempt === 0) || (run.error !== undefined && typeof run.error !== "string") || (run.attemptReason !== undefined && !["loop", "user-retry"].includes(run.attemptReason))) throw new TypeError("Invalid restored node state");
    if ((run.costUsd !== undefined && (typeof run.costUsd !== "number" || !Number.isFinite(run.costUsd) || run.costUsd < 0)) || (run.costUnavailable !== undefined && run.costUnavailable !== true) || (run.costAttempts !== undefined && (!Number.isSafeInteger(run.costAttempts) || run.costAttempts < 1 || run.costAttempts > run.attempt)) || (graph.nodes[key].type !== "agent" && (run.costUsd !== undefined || run.costUnavailable !== undefined || run.costAttempts !== undefined))) throw new TypeError("Invalid restored cost accounting");
    attempts += run.attempt;
    const node = graph.nodes[key];
    if (run.status === "completed" && (node.type === "agent" || node.type === "human_gate") && node.outputSchema !== undefined) {
      const schema = compileJsonSchema(node.outputSchema);
      if (!schema.ok || schema.compiled.check(run.output) !== true) throw new TypeError("Invalid restored structured output");
    }
  }
  if (attempts > 1000) throw new TypeError("Restored run count exceeds limit");
  for (const [key, count] of Object.entries(state.loopCounts)) {
    const edge = graph.edges.find(edge => edge.loop && `${edge.from}->${edge.to}` === key);
    if (!edge?.loop || !Number.isSafeInteger(count) || count < 0 || count > edge.loop.maxIterations) throw new TypeError("Invalid restored loop counter");
  }
  if (state.collections !== undefined && !record(state.collections)) throw new TypeError("Invalid collection ownership");
  const owned = new Set<string>();
  for (const [key, children] of Object.entries(state.collections ?? {})) {
    const parent = state.nodes[key];
    if (graph.nodes[key]?.type !== "fanout" || !parent || !["running", "completed"].includes(parent.status) || !Array.isArray(children)) throw new TypeError("Invalid collection parent");
    const results: FanoutResult["results"][number][] = [];
    for (const [index, child] of children.entries()) {
      if (!child || child.nodeId !== `${key}:item:${index}` || owned.has(child.nodeId) || graph.nodes[child.nodeId]?.type !== "agent" || !Object.hasOwn(state.nodes, child.nodeId)) throw new TypeError("Invalid collection child ownership/order");
      owned.add(child.nodeId);
      const run = state.nodes[child.nodeId];
      if (parent.status === "completed" && (run.status === "pending" || run.status === "running")) throw new TypeError("Unsettled completed collection");
      if (run.status !== "pending" && run.status !== "running") results.push({ ...child, index, status: run.status, attempt: run.attempt, ...(run.output !== undefined ? { output: run.output } : {}), ...(run.error !== undefined ? { error: run.error } : {}) });
    }
    if (parent.status === "completed" && !isDeepStrictEqual(parent.output, { results })) throw new TypeError("Forged completed collection output");
  }
  if (Object.keys(state.nodes).length !== Object.keys(graph.nodes).length) throw new TypeError("Incomplete scheduler checkpoint");
  for (const [key, node] of Object.entries(graph.nodes)) {
    if (node.type === "fanout" && ["running", "completed"].includes(state.nodes[key].status) && !Object.hasOwn(state.collections ?? {}, key)) {
      // A running fanout can be checkpointed just before its atomic batch preparation.
      if (state.nodes[key].status === "completed" || Object.keys(graph.nodes).some(id => id.startsWith(`${key}:item:`))) throw new TypeError("Missing fanout ownership");
    }
  }
}
