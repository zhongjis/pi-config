import { isDeepStrictEqual } from "node:util";
import type { AgentGraph } from "./ir.js";
import type { SchedulerState } from "./scheduler.js";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function object(value: unknown): Record<string, unknown> {
  if (!record(value)) throw new TypeError("context-gather-v1: expected object");
  return value;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new TypeError("context-gather-v1: expected array");
  return value;
}
function id(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new TypeError("context-gather-v1: expected nonblank ID");
  return value;
}
function coverage(input: unknown): Set<string> {
  const ids = array(object(input).requiredCoverage).map(row => id(object(row).id));
  if (!ids.length || new Set(ids).size !== ids.length) throw new TypeError("context-gather-v1: required coverage IDs must be unique and nonempty");
  return new Set(ids);
}
export function validateContextInput(graph: AgentGraph, input: unknown): void {
  if (graph.semanticPolicy === "context-gather-v1") coverage(input);
}

interface ContextOutput {
  readonly graph: AgentGraph;
  readonly input: unknown;
  readonly stage: "plan" | "synthesize" | "evaluation" | "work";
  readonly research?: unknown;
  readonly plan?: unknown;
  readonly item?: unknown;
}

function priorTaskIds(context: ContextOutput): Set<string> {
  const used = new Set<string>();
  if (record(context.plan)) for (const task of array(object(context.plan).tasks)) used.add(id(object(task).taskId));
  if (record(context.research)) for (const iteration of array(object(context.research).iterations)) for (const task of array(object(iteration).tasks)) used.add(id(object(task).taskId));
  return used;
}

/** Relational checks supplement JSON Schema at the existing repair seam; never rewrite evidence. */
export function checkContextOutput(context: ContextOutput, value: unknown): true | string {
  if (context.graph.semanticPolicy !== "context-gather-v1") return true;
  try {
    const requested = coverage(context.input);
    const output = object(value);
    if (context.stage === "work") {
      const item = object(context.item);
      const taskId = id(item.taskId);
      const allowed = new Set(array(item.criterionIds).map(criterion => id(criterion)));
      for (const claim of array(output.claims)) {
        const row = object(claim);
        const claimId = id(row.claimId);
        if (!claimId.startsWith(`${taskId}-`)) throw new TypeError(`Claim claimId must start with taskId prefix ${taskId}-: ${claimId}`);
        for (const criterion of array(row.criterionIds)) {
          const key = id(criterion);
          if (!allowed.has(key)) throw new TypeError(`Claim criterionId outside task: ${key}`);
        }
      }
      return true;
    }
    if (context.stage !== "synthesize") {
      const covered = new Set<string>();
      const seen = new Set<string>();
      const used = context.stage === "evaluation" ? priorTaskIds(context) : new Set<string>();
      for (const task of array(output.tasks)) {
        const item = object(context.stage === "evaluation" ? object(task).item : task);
        const taskId = id(item.taskId);
        if (seen.has(taskId) || used.has(taskId)) throw new TypeError(`Duplicate taskId: ${taskId}`);
        seen.add(taskId);
        for (const criterion of array(item.criterionIds)) {
          const key = id(criterion);
          if (!requested.has(key)) throw new TypeError(`Task criterionId outside required coverage: ${key}`);
          covered.add(key);
        }
      }
      if (context.stage === "plan" && [...requested].some(key => !covered.has(key))) throw new TypeError("Plan must cover every requested criterion");
      return true;
    }
    const raw = new Map<string, Record<string, unknown>>();
    for (const iteration of array(object(context.research).iterations)) {
      for (const result of array(object(iteration).results)) {
        const row = object(result);
        if (row.status !== "completed") continue;
        for (const claim of array(object(row.output).claims)) {
          const source = object(claim); const key = id(source.claimId);
          if (raw.has(key)) throw new TypeError(`Ambiguous research claimId: ${key}`);
          raw.set(key, source);
        }
      }
    }
    const retained = new Map<string, Record<string, unknown>>();
    for (const evidence of array(output.evidence)) {
      const claim = object(evidence); const key = id(claim.claimId);
      if (retained.has(key) || !isDeepStrictEqual(raw.get(key), claim)) throw new TypeError(`Evidence must copy a unique completed research claim exactly: ${key}`);
      retained.set(key, claim);
    }
    const seen = new Set<string>();
    for (const entry of array(output.verifiedCoverage)) {
      const row = object(entry); const key = id(row.id);
      if (!requested.has(key) || seen.has(key)) throw new TypeError(`Unexpected or duplicate verified coverage ID: ${key}`);
      seen.add(key);
      let direct = false;
      for (const reference of array(row.claimIds)) {
        const claim = retained.get(id(reference));
        if (!claim || !array(claim.criterionIds).includes(key)) throw new TypeError(`Coverage claim must resolve to retained evidence for criterion: ${key}`);
        direct ||= claim.confidence === "direct";
      }
      if (row.status === "supported" && !direct) throw new TypeError(`Supported coverage requires a direct claim: ${key}`);
      if (object(output.outcome).status === "succeeded" && row.status !== "supported") throw new TypeError("Succeeded requires every requested criterion supported");
    }
    if (seen.size !== requested.size) throw new TypeError("Verified coverage must contain every requested criterion exactly once");
    return true;
  } catch (error) {
    if (error instanceof TypeError) return `context-gather-v1: ${error.message}`;
    throw error;
  }
}

/** Reuse the same checks on durable completed outputs, including a settled active evaluator. */
export function validateContextRestore(graph: AgentGraph, input: unknown, state: SchedulerState): void {
  if (graph.semanticPolicy !== "context-gather-v1") return;
  validateContextInput(graph, input);
  const feedback = state.runtime?.feedback?.research;
  const rounds = [...(feedback?.iterations ?? []), ...(feedback?.active ? [feedback.active] : [])];
  const evaluators = new Set(rounds.map(row => row.evaluator));
  const workItems = new Map<string, unknown>();
  for (const row of rounds) {
    for (const child of state.collections?.[row.work] ?? []) workItems.set(child.nodeId, child.item);
    row.tasks.forEach((task, index) => { const nodeId = `${row.work}:item:${index}`; if (!workItems.has(nodeId)) workItems.set(nodeId, task); });
  }
  for (const [key, run] of Object.entries(state.nodes)) {
    if (run.status !== "completed") continue;
    const item = workItems.get(key);
    const stage = key === "plan" || key === "synthesize" ? key : evaluators.has(key) ? "evaluation" : item !== undefined ? "work" : undefined;
    if (!stage) continue;
    const index = feedback?.iterations.findIndex(row => row.evaluator === key) ?? -1;
    const prior = stage !== "evaluation" || !feedback ? [] : feedback.active?.evaluator === key ? rounds : index >= 0 ? feedback.iterations.slice(0, index + 1) : rounds;
    const check = checkContextOutput({ graph, input, stage, item, plan: state.nodes.plan?.output, research: stage === "synthesize" ? state.nodes.research?.output : { iterations: prior } }, run.output);
    if (check !== true) throw new TypeError(`Invalid restored semantic output: ${check}`);
  }
}
