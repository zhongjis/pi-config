import { prepareFanout } from "./fanout.js";
import type { GraphRuntimeState, NodeInstanceId } from "./graph-instance-id.js";
import type { BoundedFeedbackNode, FanoutResult, JsonSchema, JsonValue } from "./ir.js";
import type { NodeRun } from "./scheduler.js";

export interface FeedbackGap { readonly id: string; readonly description: string }
export interface FeedbackDecision {
  readonly decision: "sufficient" | "continue";
  readonly gaps: readonly FeedbackGap[];
  readonly tasks: readonly { readonly gapId: string; readonly item: JsonValue }[];
}
export type FeedbackReason = "sufficient" | "iteration limit" | "item limit" | "deadline/spend limit" | "no progress" | "no accessible route" | "evaluator failure" | "materialization failure" | "cancellation" | "skipped before admission";
/** Without a judge the evaluator materializes with the work; with one, judge and evaluator are lazy root-driven steps. */
export interface FeedbackIteration {
  readonly iteration: number;
  readonly tasks: readonly JsonValue[];
  readonly work: string;
  readonly evaluator?: string;
  readonly workInstanceId: NodeInstanceId;
  readonly evaluatorInstanceId?: NodeInstanceId;
  readonly judge?: string;
  readonly judgeInstanceId?: NodeInstanceId;
  readonly results: FanoutResult["results"];
  readonly decision?: FeedbackDecision;
  readonly evaluatorError?: string;
}
export interface FeedbackResult {
  readonly reason: FeedbackReason;
  readonly partial: boolean;
  readonly iterations: readonly FeedbackIteration[];
  readonly gaps: readonly FeedbackGap[];
  readonly counters: { readonly iterations: number; readonly totalItems: number };
  readonly exhaustedBounds: readonly string[];
}
export interface FeedbackState {
  readonly iterations: FeedbackIteration[];
  gaps: readonly FeedbackGap[];
  intent?: { readonly iteration: number; readonly tasks: readonly JsonValue[] };
  active?: Omit<FeedbackIteration, "results" | "decision" | "evaluatorError">;
  stoppedIntent?: { readonly iteration: number; readonly tasks: readonly JsonValue[] };
  terminal?: FeedbackResult;
  retryFailures?: number;
  retryError?: string;
  /** Last admission check, retained for deterministic terminal validation. */
  budgetCheckedAt?: number;
}
/** A judged evaluator only writes gaps and tasks; the judge owns sufficiency. */
export function decisionSchema(itemSchema: BoundedFeedbackNode["work"]["itemSchema"], judged = false): JsonSchema {
  const gaps = { type: "array", items: { type: "object", required: ["id", "description"], additionalProperties: false, properties: { id: { type: "string", minLength: 1 }, description: { type: "string", minLength: 1 } } } };
  const tasks = { type: "array", items: { type: "object", required: ["gapId", "item"], additionalProperties: false, properties: { gapId: { type: "string" }, item: itemSchema } } };
  if (judged) return { type: "object", additionalProperties: false, required: ["gaps", "tasks"], properties: { gaps, tasks } };
  return { type: "object", additionalProperties: false, required: ["decision", "gaps", "tasks"], properties: { decision: { enum: ["sufficient", "continue"] }, gaps, tasks } };
}
/** Runtime-owned materialized templates; restore regenerates and compares them. */
export function evaluatorTemplate(node: BoundedFeedbackNode): BoundedFeedbackNode["evaluator"] {
  return { ...node.evaluator, input: { ...node.evaluator.input, feedback: { path: "$" } }, outputSchema: decisionSchema(node.work.itemSchema, node.judge !== undefined) };
}
export function judgeTemplate(judge: NonNullable<BoundedFeedbackNode["judge"]>): NonNullable<BoundedFeedbackNode["judge"]> {
  return { ...judge, state: { ...judge.state, feedback: { path: "$" } } };
}
/** The judge's single bool answer; undefined for anything else. */
export function judgeVerdict(node: BoundedFeedbackNode, output: unknown): boolean | undefined {
  const question = Object.keys(node.judge?.questions ?? {})[0];
  const answers = record(output) ? output.answers : undefined;
  const answer = question !== undefined && record(answers) ? answers[question] : undefined;
  return record(answer) && typeof answer.value === "boolean" ? answer.value : undefined;
}
export const JUDGED_SUFFICIENT: FeedbackDecision = { decision: "sufficient", gaps: [], tasks: [] };
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (record(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export function decision(value: unknown, node: BoundedFeedbackNode): FeedbackDecision {
  const judged = node.judge !== undefined;
  const fields = judged ? ["gaps", "tasks"] : ["decision", "gaps", "tasks"];
  if (!record(value) || (!judged && !["sufficient", "continue"].includes(String(value.decision))) || !Array.isArray(value.gaps) || !Array.isArray(value.tasks) || Object.keys(value).some(key => !fields.includes(key))) throw new TypeError("Invalid feedback decision");
  const gaps: FeedbackGap[] = value.gaps.map(gap => {
    if (!record(gap) || typeof gap.id !== "string" || !gap.id.trim() || typeof gap.description !== "string" || !gap.description.trim() || Object.keys(gap).some(key => key !== "id" && key !== "description")) throw new TypeError("Invalid feedback gap");
    return { id: gap.id, description: gap.description };
  });
  if (new Set(gaps.map(gap => gap.id)).size !== gaps.length) throw new TypeError("Duplicate feedback gap");
  const gapIds: string[] = [];
  const items = value.tasks.map(task => {
    if (!record(task) || typeof task.gapId !== "string" || !gaps.some(gap => gap.id === task.gapId) || Object.keys(task).some(key => key !== "gapId" && key !== "item")) throw new TypeError("Task must link to a declared gap");
    gapIds.push(task.gapId);
    return task.item;
  });
  // A judged evaluator may return no task: no accessible route remains.
  if (!judged && (value.decision === "sufficient" ? items.length !== 0 : items.length === 0)) throw new TypeError("Invalid feedback task count");
  const prepared = prepareFanout({ ...node.work, items: { path: "$" } }, { input: items, outputs: new Map() });
  if (prepared.ok === false) throw new TypeError(prepared.error);
  return { decision: !judged && value.decision === "sufficient" ? "sufficient" : "continue", gaps, tasks: prepared.items.map(({ item }, index) => ({ gapId: gapIds[index], item })) };
}

/** Pure terminal projection; root owns its atomic application with scheduler facts. */
export function feedbackTerminal(state: FeedbackState, reason: FeedbackReason, exhaustedBounds: readonly string[] = []): FeedbackState {
  const iterations = structuredClone(state.iterations);
  const { intent, active: _active, ...prior } = state;
  return { ...prior, ...(intent ? { stoppedIntent: structuredClone(intent) } : {}), terminal: {
    reason, partial: reason !== "sufficient" || state.gaps.length > 0 || iterations.some(row => row.results.some(result => result.status !== "completed")),
    iterations, gaps: state.gaps, counters: { iterations: iterations.length, totalItems: iterations.reduce((sum, row) => sum + row.tasks.length, 0) }, exhaustedBounds,
  } };
}

/** The same deterministic continuation policy is used by execution and restore validation. */
export function feedbackContinuation(iterations: readonly FeedbackIteration[], node: BoundedFeedbackNode): { reason: FeedbackReason; exhaustedBounds: string[] } | { tasks: readonly JsonValue[] } {
  const last = iterations.at(-1);
  if (!last?.decision) return { reason: "evaluator failure", exhaustedBounds: [] };
  const previous = new Set(iterations.slice(0, -1).flatMap(row => row.results.filter(result => result.status === "completed").map(result => canonical(result.output))));
  if (!last.results.some(result => result.status === "completed" && !previous.has(canonical(result.output)))) return { reason: "no progress", exhaustedBounds: [] };
  if (last.decision.decision === "sufficient") return { reason: "sufficient", exhaustedBounds: [] };
  if (!last.decision.tasks.length) return { reason: "no accessible route", exhaustedBounds: [] };
  if (iterations.length >= node.maxIterations) return { reason: "iteration limit", exhaustedBounds: ["maxIterations"] };
  const tasks = last.decision.tasks.map(task => task.item);
  if (tasks.length > node.maxItemsPerIteration || iterations.reduce((sum, row) => sum + row.tasks.length, 0) + tasks.length > node.maxTotalItems) return { reason: "item limit", exhaustedBounds: [tasks.length > node.maxItemsPerIteration ? "maxItemsPerIteration" : "maxTotalItems"] };
  if (iterations.some(row => canonical(row.tasks) === canonical(tasks))) return { reason: "no progress", exhaustedBounds: [] };
  return { tasks };
}

/** Executions that ran a model; an escalation-only resume adds an admission without a cost row. */
function modelExecutions(runtime: GraphRuntimeState, binding: string): number {
  const id = runtime.manifest.find(row => row.binding === binding)?.instanceId;
  return (runtime.executionLedger ?? []).filter(row => row.instanceId === id).reduce((total, row) => total + ("kind" in row ? row.consumedExecutions : Number(row.payload.kind === "dispatched" && row.payload.target === "agent")), 0);
}
/** Only reported execution costs count; token usage is never a substitute. */
export function feedbackBudgetBounds(state: FeedbackState, node: BoundedFeedbackNode, startedAt: number, nodes: Pick<ReadonlyMap<string, NodeRun>, "get">, checkedAt: number, runtime?: GraphRuntimeState): string[] {
  const bounds: string[] = [];
  if (node.deadline !== undefined && checkedAt - startedAt >= node.deadline) bounds.push("deadline");
  if (node.spendLimit !== undefined) {
    // Only materialized nodes count: a judged iteration may not have a judge or evaluator yet.
    const bindings = [...state.iterations, ...(state.active ? [state.active] : [])].flatMap(row => [...(row.evaluator !== undefined ? [row.evaluator] : []), ...(row.judge !== undefined ? [row.judge] : []), ...row.tasks.map((_, index) => `${row.work}:item:${index}`)]);
    const runs = bindings.map(key => nodes.get(key));
    if (runs.some((run, index) => !run || run.costUnavailable || (!["pending", "running"].includes(run.status) && (run.costUsd === undefined || run.costAttempts !== (runtime?.executionProtocolVersion === 1 ? modelExecutions(runtime, bindings[index]) : run.attempt))))) bounds.push("spend accounting unavailable");
    if (runs.reduce((sum, run) => sum + (run?.costUsd ?? 0), 0) >= node.spendLimit) bounds.push("spendLimit");
  }
  return bounds;
}
