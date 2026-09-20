import { prepareFanout } from "./fanout.js";
import type { GraphInstances, NodeInstanceId } from "./graph-instance-id.js";
import type { BoundedFeedbackNode, FanoutResult, GraphEdge, GraphNode, JsonValue } from "./ir.js";
import type { NodeRun, Scheduler } from "./scheduler.js";
import { MAX_NODES } from "./validate.js";
import type { ResolutionContext } from "./value-ref.js";

export interface FeedbackGap { readonly id: string; readonly description: string }
export interface FeedbackDecision {
  readonly decision: "sufficient" | "continue";
  readonly gaps: readonly FeedbackGap[];
  readonly tasks: readonly { readonly gapId: string; readonly item: JsonValue }[];
}
export type FeedbackReason = "sufficient" | "iteration limit" | "item limit" | "deadline/spend limit" | "no progress" | "evaluator failure" | "materialization failure" | "cancellation";
export interface FeedbackIteration {
  readonly iteration: number;
  readonly tasks: readonly JsonValue[];
  readonly work: string;
  readonly evaluator: string;
  readonly workInstanceId: NodeInstanceId;
  readonly evaluatorInstanceId: NodeInstanceId;
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
export const DECISION_SCHEMA = {
  type: "object", additionalProperties: false, required: ["decision", "gaps", "tasks"],
  properties: {
    decision: { enum: ["sufficient", "continue"] },
    gaps: { type: "array", items: { type: "object", required: ["id", "description"], additionalProperties: false, properties: { id: { type: "string", minLength: 1 }, description: { type: "string", minLength: 1 } } } },
    tasks: { type: "array", items: { type: "object", required: ["gapId", "item"], additionalProperties: false, properties: { gapId: { type: "string" }, item: { type: "object" } } } },
  },
} as const;
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (record(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export function decision(value: unknown, node: BoundedFeedbackNode): FeedbackDecision {
  if (!record(value) || !["sufficient", "continue"].includes(String(value.decision)) || !Array.isArray(value.gaps) || !Array.isArray(value.tasks) || Object.keys(value).some(key => !["decision", "gaps", "tasks"].includes(key))) throw new TypeError("Invalid feedback decision");
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
  if (value.decision === "sufficient" ? items.length !== 0 : items.length === 0) throw new TypeError("Invalid feedback task count");
  const prepared = prepareFanout({ ...node.work, items: { path: "$" } }, { input: items, outputs: new Map() });
  if (!prepared.ok) throw new TypeError(prepared.error);
  return { decision: value.decision === "sufficient" ? "sufficient" : "continue", gaps, tasks: prepared.items.map(({ item }, index) => ({ gapId: gapIds[index], item })) };
}

interface FeedbackHost {
  readonly scheduler: Scheduler;
  readonly instances: GraphInstances;
  readonly definitions: Map<string, GraphNode>;
  readonly edges: GraphEdge[];
  readonly context: () => ResolutionContext;
  readonly checkpoint: () => void;
  readonly now: () => number;
  readonly added: (id: string, node: GraphNode, dependencies: string[]) => void;
}
/** Sequencing only: child dispatch and all-settled collection remain scheduler/fanout owned. */
export class BoundedFeedback {
  readonly states: Record<string, FeedbackState>;
  readonly handledNodes = new Set<string>();
  constructor(private readonly host: FeedbackHost) {
    this.states = Object.assign(Object.create(null), host.instances.state.feedback);
    host.instances.state.feedback = this.states;
    for (const state of Object.values(this.states)) {
      for (const iteration of state.iterations) this.handledNodes.add(iteration.evaluator);
      if (state.active) this.handledNodes.add(state.active.evaluator);
    }
  }
  start(id: string, node: BoundedFeedbackNode): void {
    if (this.states[id]) return;
    const prepared = prepareFanout(node.work, this.host.context());
    const state: FeedbackState = { iterations: [], gaps: [] };
    this.states[id] = state;
    if (!prepared.ok) { this.finish(id, "materialization failure", [prepared.error]); return; }
    state.intent = { iteration: 1, tasks: prepared.items.map(item => item.item) };
    this.host.checkpoint();
  }
  evaluator(id: string): { node: BoundedFeedbackNode; input: unknown; remainingAttempts: number; error?: string; failed(error: string): void } | undefined {
    for (const [parent, state] of Object.entries(this.states)) {
      if (state.active?.evaluator !== id) continue;
      const node = this.host.definitions.get(parent);
      if (node?.type !== "bounded_feedback") throw new TypeError("Missing feedback template");
      return { node, input: { iterations: [...state.iterations, { ...state.active, results: this.results(state.active.work) }], gaps: state.gaps },
        remainingAttempts: (node.evaluator.retry?.maxAttempts ?? 1) - (state.retryFailures ?? 0), error: state.retryError,
        failed: error => { state.retryFailures = (state.retryFailures ?? 0) + 1; state.retryError = error; this.host.checkpoint(); },
      };
    }
    return undefined;
  }
  tick(): boolean {
    let changed = false;
    for (const [id, state] of Object.entries(this.states)) {
      if (state.terminal) continue;
      const node = this.host.definitions.get(id);
      if (node?.type !== "bounded_feedback") throw new TypeError("Missing feedback template");
      if (state.intent) { this.materialize(id, node); changed = true; continue; }
      const active = state.active;
      if (!active) continue;
      const evaluator = this.host.scheduler.nodes.get(active.evaluator);
      if (!evaluator || evaluator.status === "pending" || evaluator.status === "running") continue;
      const parsed = evaluator.status === "completed" ? decision(evaluator.output, node) : undefined;
      const iteration: FeedbackIteration = { ...active, results: this.results(active.work), ...(parsed ? { decision: parsed } : { evaluatorError: evaluator.error ?? "Evaluator skipped" }) };
      state.iterations.push(structuredClone(iteration));
      delete state.active;
      if (parsed) state.gaps = parsed.gaps;
      changed = true;
      if (this.budgetExceeded(id, node)) continue;
      if (!parsed) { this.finish(id, "evaluator failure"); continue; }
      const next = feedbackContinuation(state.iterations, node);
      if ("reason" in next) { this.finish(id, next.reason, next.exhaustedBounds); continue; }
      state.intent = { iteration: active.iteration + 1, tasks: next.tasks };
      this.host.checkpoint(); // decision + continuation intent precede any successor UUID allocation
    }
    return changed;
  }
  cancel(): void {
    for (const [id, node] of this.host.definitions) {
      if (node.type !== "bounded_feedback") continue;
      this.states[id] ??= { iterations: [], gaps: [] };
      const state = this.states[id];
      if (state.terminal) continue;
      if (state.active) {
        for (const binding of [state.active.evaluator, ...(this.host.scheduler.collections.get(state.active.work) ?? []).map(child => child.nodeId)]) {
          const run = this.host.scheduler.nodes.get(binding);
          if (run?.status === "pending" || run?.status === "running") this.host.scheduler.settle(binding, { ok: false, skipped: true, error: "Cancellation" });
        }
        this.host.scheduler.settleCollections();
        state.iterations.push({ ...state.active, results: this.results(state.active.work) });
      }
      delete state.active;
      this.finish(id, "cancellation");
    }
  }
  terminalResults(): Record<string, FeedbackResult> {
    const results: Record<string, FeedbackResult> = {};
    for (const [key, state] of Object.entries(this.states)) if (state.terminal) results[key] = state.terminal;
    return results;
  }
  private results(work: string): FanoutResult["results"] {
    return (this.host.scheduler.collections.get(work) ?? []).map((child, index) => {
      const run = this.host.scheduler.nodes.get(child.nodeId);
      const instance = this.host.instances.get(child.nodeId);
      return { ...child, ...instance, index, status: run?.status === "completed" ? "completed" : run?.status === "failed" ? "failed" : "skipped", attempt: run?.attempt ?? 0, ...(run?.output !== undefined ? { output: run.output } : {}), ...(run?.error !== undefined ? { error: run.error } : {}) };
    });
  }
  private finish(id: string, reason: FeedbackReason, exhaustedBounds: readonly string[] = []): void {
    const state = this.states[id];
    if (state.intent) state.stoppedIntent = structuredClone(state.intent);
    delete state.intent;
    const iterations = structuredClone(state.iterations);
    state.terminal = { reason, partial: reason !== "sufficient" || state.gaps.length > 0 || iterations.some(row => row.results.some(result => result.status !== "completed")), iterations, gaps: state.gaps, counters: { iterations: iterations.length, totalItems: iterations.reduce((sum, row) => sum + row.tasks.length, 0) }, exhaustedBounds };
    this.host.scheduler.settle(id, { ok: reason !== "materialization failure", output: state.terminal, ...(reason === "materialization failure" ? { error: exhaustedBounds.join("; ") || reason } : {}) });
    this.host.checkpoint();
  }
  private budgetExceeded(id: string, node: BoundedFeedbackNode): boolean {
    if (node.deadline === undefined && node.spendLimit === undefined) return false;
    const state = this.states[id];
    const now = this.host.now();
    if (!Number.isSafeInteger(now) || now < 0) throw new TypeError("Invalid feedback budget clock");
    state.budgetCheckedAt = Math.max(now, this.host.instances.state.startedAt ?? 0, state.budgetCheckedAt ?? 0);
    const bounds = feedbackBudgetBounds(state, node, this.host.instances.state.startedAt ?? 0, this.host.scheduler.nodes, state.budgetCheckedAt);
    if (bounds.length === 0) return false;
    this.finish(id, "deadline/spend limit", bounds);
    return true;
  }
  private materialize(id: string, node: BoundedFeedbackNode): void {
    const { scheduler, definitions, instances } = this.host;
    const state = this.states[id];
    const intent = state.intent;
    if (!intent) return;
    if (this.budgetExceeded(id, node)) return;
    if (intent.iteration > node.maxIterations) { this.finish(id, "iteration limit", ["maxIterations"]); return; }
    const total = state.iterations.reduce((sum, row) => sum + row.tasks.length, 0) + intent.tasks.length;
    if (intent.tasks.length > node.maxItemsPerIteration || total > node.maxTotalItems) { this.finish(id, "item limit", [intent.tasks.length > node.maxItemsPerIteration ? "maxItemsPerIteration" : "maxTotalItems"]); return; }
    const count = intent.tasks.length + 2;
    if (definitions.size + count > MAX_NODES || !scheduler.canMaterialize(count)) { this.finish(id, "materialization failure", [definitions.size + count > MAX_NODES ? "node limit" : "run limit"]); return; }
    const work = `${id}:iteration:${intent.iteration}:work`;
    const evaluator = `${id}:iteration:${intent.iteration}:evaluator`;
    const context = this.host.context();
    const prepared = prepareFanout({ ...node.work, items: { node: work, path: "$" } }, { ...context, outputs: new Map([...context.outputs, [work, intent.tasks]]) });
    if (!prepared.ok) { this.finish(id, "materialization failure", [prepared.error]); return; }
    const nodes: Record<string, GraphNode> = { [work]: node.work, [evaluator]: { ...node.evaluator, input: { ...node.evaluator.input, feedback: { path: "$" } }, outputSchema: DECISION_SCHEMA } };
    prepared.items.forEach(({ node: child }, index) => { nodes[`${work}:item:${index}`] = { ...child, ...(node.work.name !== undefined ? { name: node.work.name } : {}) }; });
    if (Object.keys(nodes).some(key => definitions.has(key))) { this.finish(id, "materialization failure", ["Generated binding collision"]); return; }
    const parentInstanceId = instances.get(id).instanceId;
    const workInstance = instances.add(work, { nodeKey: id, parentInstanceId, iteration: intent.iteration });
    const evaluatorInstance = instances.add(evaluator, { nodeKey: id, parentInstanceId, iteration: intent.iteration });
    const children = prepared.items.map(({ item }, itemIndex) => {
      const nodeId = `${work}:item:${itemIndex}`;
      const provenance = instances.add(nodeId, { nodeKey: id, parentInstanceId: workInstance.instanceId, iteration: intent.iteration, itemIndex });
      return { nodeId, item, ...provenance };
    });
    const edges = [{ from: work, to: evaluator }];
    scheduler.insertFragment({ nodes, edges });
    for (const [key, definition] of Object.entries(nodes)) definitions.set(key, definition);
    this.host.edges.push(...edges);
    scheduler.markRunning(work);
    scheduler.collections.set(work, children);
    state.retryFailures = 0;
    delete state.retryError;
    state.active = { iteration: intent.iteration, tasks: intent.tasks, work, evaluator, workInstanceId: workInstance.instanceId, evaluatorInstanceId: evaluatorInstance.instanceId };
    delete state.intent;
    this.handledNodes.add(evaluator);
    this.host.checkpoint(); // complete immutable bindings and UUIDs before monitor publication or dispatch
    for (const [key, definition] of Object.entries(nodes)) this.host.added(key, definition, key === evaluator ? [work] : []);
  }
}

/** The same deterministic continuation policy is used by execution and restore validation. */
export function feedbackContinuation(iterations: readonly FeedbackIteration[], node: BoundedFeedbackNode): { reason: FeedbackReason; exhaustedBounds: string[] } | { tasks: readonly JsonValue[] } {
  const last = iterations.at(-1);
  if (!last?.decision) return { reason: "evaluator failure", exhaustedBounds: [] };
  const previous = new Set(iterations.slice(0, -1).flatMap(row => row.results.filter(result => result.status === "completed").map(result => canonical(result.output))));
  if (!last.results.some(result => result.status === "completed" && !previous.has(canonical(result.output)))) return { reason: "no progress", exhaustedBounds: [] };
  if (last.decision.decision === "sufficient") return { reason: "sufficient", exhaustedBounds: [] };
  if (iterations.length >= node.maxIterations) return { reason: "iteration limit", exhaustedBounds: ["maxIterations"] };
  const tasks = last.decision.tasks.map(task => task.item);
  if (tasks.length > node.maxItemsPerIteration || iterations.reduce((sum, row) => sum + row.tasks.length, 0) + tasks.length > node.maxTotalItems) return { reason: "item limit", exhaustedBounds: [tasks.length > node.maxItemsPerIteration ? "maxItemsPerIteration" : "maxTotalItems"] };
  if (iterations.some(row => canonical(row.tasks) === canonical(tasks))) return { reason: "no progress", exhaustedBounds: [] };
  return { tasks };
}

/** Only reported execution costs count; token usage is never a substitute. */
export function feedbackBudgetBounds(state: FeedbackState, node: BoundedFeedbackNode, startedAt: number, nodes: ReadonlyMap<string, NodeRun>, checkedAt: number): string[] {
  const bounds: string[] = [];
  if (node.deadline !== undefined && checkedAt - startedAt >= node.deadline) bounds.push("deadline");
  if (node.spendLimit !== undefined) {
    const runs = [...state.iterations, ...(state.active ? [state.active] : [])].flatMap(row => [row.evaluator, ...row.tasks.map((_, index) => `${row.work}:item:${index}`)]).map(key => nodes.get(key));
    if (runs.some(run => !run || run.costUnavailable || (!["pending", "running"].includes(run.status) && (run.costUsd === undefined || run.costAttempts !== run.attempt)))) bounds.push("spend accounting unavailable");
    if (runs.reduce((sum, run) => sum + (run?.costUsd ?? 0), 0) >= node.spendLimit) bounds.push("spendLimit");
  }
  return bounds;
}
