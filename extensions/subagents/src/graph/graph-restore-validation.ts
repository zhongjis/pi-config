import { isDeepStrictEqual } from "node:util";
import { canonical, DECISION_SCHEMA, decision, type FeedbackIteration, type FeedbackState, feedbackBudgetBounds, feedbackContinuation } from "./bounded-feedback.js";
import { prepareFanout } from "./fanout.js";
import { consumedExecutions } from "./graph-execution.js";
import { type NestedCheckpoint, validateManifest } from "./graph-instance-id.js";
import { nestedMaterializations } from "./graph-nested-checkpoint.js";
import { validateSchedulerState } from "./graph-state-validation.js";
import type { AgentGraph, BoundedFeedbackNode, FanoutNode, GraphNode, JsonValue } from "./ir.js";
import type { SchedulerState } from "./scheduler.js";
import { MAX_NODES } from "./validate.js";
import type { ResolutionContext } from "./value-ref.js";

/** Persisted input is untrusted: all checks precede hydration, replacement and dispatch. */
export function validateGraphRestore(state: SchedulerState, graph: AgentGraph, input: unknown = {}): void {
  // Only collection candidates defer authored-template checks. The checks below
  // must regenerate every candidate and verify its manifest before restore returns.
  const materializedPrompts = new Set<string>();
  for (const children of Object.values(state?.collections ?? {})) {
    if (Array.isArray(children)) for (const child of children) if (child && typeof child.nodeId === "string") materializedPrompts.add(child.nodeId);
  }
  validateSchedulerState(state, graph, materializedPrompts);
  const runtime = state.runtime;
  if (!runtime) throw new TypeError("Missing v2 runtime state");
  validateManifest(runtime, graph);
  if (runtime.startedAt === undefined && Object.values(graph.nodes).some(node => node.type === "bounded_feedback" && node.deadline !== undefined)) throw new TypeError("Deadline requires a persisted run start");
  if (runtime.cancelled !== undefined && typeof runtime.cancelled !== "boolean") throw new TypeError("Invalid cancellation state");
  const instances = new Map(runtime.manifest.map(row => [row.binding, row]));
  const context: ResolutionContext = { input, outputs: new Map(Object.entries(state.nodes).filter(([, run]) => run.status === "completed").map(([key, run]) => [key, run.output])) };
  const prepare = (node: FanoutNode, tasks: readonly JsonValue[]) => {
    let key = "$restore-items";
    while (Object.hasOwn(graph.nodes, key)) key += ":";
    return prepareFanout({ ...node, items: { node: key, path: "$" } }, { ...context, outputs: new Map([...context.outputs, [key, tasks]]) });
  };
  for (const [key, children] of Object.entries(state.collections ?? {})) {
    const node = graph.nodes[key]; const parent = instances.get(key);
    if (node.type !== "fanout" || !parent) throw new TypeError("Invalid collection manifest");
    const prepared = parent.iteration === undefined ? prepareFanout(node, context) : prepare(node, children.map(child => child.item));
    if (!prepared.ok) throw new TypeError(`Invalid restored fanout: ${prepared.error}`);
    if (prepared.items.length !== children.length || prepared.items.some((item, index) => !isDeepStrictEqual(item.item, children[index].item))) throw new TypeError("Invalid restored fanout items");
    children.forEach((child, index) => {
      const instance = instances.get(child.nodeId);
      if (!instance || instance.parentInstanceId !== parent.instanceId || instance.nodeKey !== parent.nodeKey || instance.itemIndex !== index || instance.iteration !== parent.iteration || executionTemplate(graph.nodes[child.nodeId]) !== executionTemplate(prepared.items[index].node)) throw new TypeError("Invalid child definition or provenance");
      // V1 graphs retain their legacy child result shape after snapshot upgrade.
      if (graph.version === 2 && Object.entries(instance).some(([field, value]) => !isDeepStrictEqual(Reflect.get(child, field), value))) throw new TypeError("Invalid child collection provenance");
    });
  }
  const ordinals = new Set(runtime.manifest.map(row => row.ordinal));
  if (runtime.nested !== undefined && (!runtime.nested || typeof runtime.nested !== "object" || Array.isArray(runtime.nested))) throw new TypeError("Invalid nested checkpoints");
  for (const [key, nested] of Object.entries(runtime.nested ?? {})) {
    const parent = instances.get(key);
    const prefix = `${runtime.runId}/${parent?.instanceId}/`;
    if (!nested || (nested.previous !== undefined && !Array.isArray(nested.previous))) throw new TypeError("Invalid nested history");
    let previousInvocation = 0;
    const history: readonly NestedCheckpoint[] = nested.previous ?? [];
    for (const checkpoint of [...history, nested]) {
      const childRunId = checkpoint?.state?.runtime?.runId;
      const invocation = typeof childRunId === "string" && childRunId.startsWith(prefix) ? Number(childRunId.slice(prefix.length)) : 0;
      if (!checkpoint || graph.nodes[key]?.type !== "graph" || !parent || !Number.isSafeInteger(invocation) || invocation <= previousInvocation || invocation > (state.nodes[key]?.attempt ?? 0) || !checkpoint.ordinals || typeof checkpoint.ordinals !== "object" || Array.isArray(checkpoint.ordinals)) throw new TypeError("Invalid nested checkpoint ownership");
      previousInvocation = invocation;
      validateGraphRestore(checkpoint.state, checkpoint.graph, checkpoint.input);
      if (checkpoint !== nested && (checkpoint.previous?.length || (!checkpoint.state.runtime?.cancelled && Object.values(checkpoint.state.nodes).some(run => run.status === "pending" || run.status === "running")))) throw new TypeError("Nonterminal nested invocation history");
      const rows = nestedMaterializations(checkpoint.graph, checkpoint.state);
      if (Object.keys(checkpoint.ordinals).length !== rows.length || rows.some(row => !Object.hasOwn(checkpoint.ordinals, row.key))) throw new TypeError("Incomplete nested ordinal mapping");
      for (const ordinal of Object.values(checkpoint.ordinals)) {
        if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinals.has(ordinal)) throw new TypeError("Duplicate materialization ordinal");
        ordinals.add(ordinal);
      }
    }
  }
  if ((Object.keys(runtime.nested ?? {}).length > 0 && runtime.nextOrdinal === undefined) || (runtime.nextOrdinal !== undefined && (!Number.isSafeInteger(runtime.nextOrdinal) || runtime.nextOrdinal <= Math.max(-1, ...ordinals)))) throw new TypeError("Invalid materialization counter");
  if (runtime.feedback !== undefined && (!runtime.feedback || typeof runtime.feedback !== "object" || Array.isArray(runtime.feedback))) throw new TypeError("Invalid feedback checkpoint");
  for (const [key, node] of Object.entries(graph.nodes)) {
    if (node.type === "bounded_feedback" && state.nodes[key].status !== "pending" && !Object.hasOwn(runtime.feedback ?? {}, key)) {
      const run = state.nodes[key]; const owner = instances.get(key);
      if (run.status !== "running" || run.attempt < 1 || runtime.cancelled || runtime.manifest.some(row => row.parentInstanceId === owner?.instanceId)) throw new TypeError("Missing active feedback state");
    }
  }
  for (const [key, feedback] of Object.entries(runtime.feedback ?? {})) {
    const node = graph.nodes[key];
    if (node?.type !== "bounded_feedback" || !feedback || !Array.isArray(feedback.iterations) || !Array.isArray(feedback.gaps) || (feedback.active && feedback.intent)) throw new TypeError("Invalid feedback checkpoint");
    if (feedback.retryFailures !== undefined && (!Number.isSafeInteger(feedback.retryFailures) || feedback.retryFailures < 0 || runtime.executionProtocolVersion !== 1 && feedback.retryFailures > (node.evaluator.retry?.maxAttempts ?? 1))) throw new TypeError("Invalid evaluator retry budget");
    if (!feedback.terminal && (state.nodes[key].status !== "running" || runtime.cancelled)) throw new TypeError("Invalid active feedback ownership");
    if ((feedback.retryError !== undefined) !== ((feedback.retryFailures ?? 0) > 0) || (feedback.retryError !== undefined && typeof feedback.retryError !== "string")) throw new TypeError("Invalid evaluator retry error");
    const evaluation = feedback.active?.evaluator ?? feedback.iterations.at(-1)?.evaluator;
    if ((feedback.retryFailures ?? 0) > (evaluation ? runtime.executionProtocolVersion === 1 ? consumedExecutions(runtime, evaluation) : state.nodes[evaluation]?.attempt ?? 0 : 0)) throw new TypeError("Evaluator repair count exceeds attempts");
    if (evaluation && runtime.executionProtocolVersion === 1) {
      const instance = instances.get(evaluation);
      if (!instance || !runtime.executionLedger) throw new TypeError("Missing evaluator execution evidence");
      let outcomes = 0; let historical = 0;
      for (const row of runtime.executionLedger) {
        if (row.instanceId !== instance.instanceId) continue;
        if ("kind" in row) historical = row.consumedExecutions;
        else if (row.payload.kind === "outcome" && row.payload.status === "failure") outcomes++;
      }
      // A deterministic legacy baseline records admissions, not historical failure detail.
      const failures = feedback.retryFailures ?? 0;
      if (failures < outcomes || failures > outcomes + historical) throw new TypeError("Evaluator retry failures disagree with execution outcomes");
    }
    const binding = (row: Omit<FeedbackIteration, "results">, iteration: number): void => {
      if (!row || row.iteration !== iteration || !Array.isArray(row.tasks) || row.work !== `${key}:iteration:${iteration}:work` || row.evaluator !== `${key}:iteration:${iteration}:evaluator`) throw new TypeError("Invalid feedback topology binding");
      const work = instances.get(row.work); const evaluator = instances.get(row.evaluator); const parent = instances.get(key);
      if (!work || !evaluator || !parent || work.instanceId !== row.workInstanceId || evaluator.instanceId !== row.evaluatorInstanceId || [work, evaluator].some(instance => instance.parentInstanceId !== parent.instanceId || instance.nodeKey !== key || instance.iteration !== iteration || instance.itemIndex !== undefined) || executionTemplate(graph.nodes[row.work]) !== executionTemplate(node.work) || executionTemplate(graph.nodes[row.evaluator]) !== executionTemplate({ ...node.evaluator, input: { ...node.evaluator.input, feedback: { path: "$" } }, outputSchema: DECISION_SCHEMA })) throw new TypeError("Invalid feedback manifest binding");
      const children = state.collections?.[row.work];
      if (!children || children.length !== row.tasks.length || children.some((child, index) => !isDeepStrictEqual(child.item, row.tasks[index])) || row.tasks.length > node.maxItemsPerIteration) throw new TypeError("Invalid feedback child collection");
    };
    feedback.iterations.forEach((row, index) => {
      binding(row, index + 1);
      if (index > 0) {
        const history = feedback.iterations.slice(0, index);
        if (feedbackBudgetBounds({ iterations: history, gaps: [] }, node, runtime.startedAt ?? 0, new Map(Object.entries(state.nodes)), runtime.startedAt ?? 0, runtime).length > 0) throw new TypeError("Iteration exceeds prior spend budget");
        const previous = feedbackContinuation(history, node);
        if (!("tasks" in previous) || !isDeepStrictEqual(previous.tasks, row.tasks)) throw new TypeError("Iteration does not follow its evaluator decision");
      }
      if (state.nodes[row.work].status !== "completed" || !Array.isArray(row.results) || row.results.length !== row.tasks.length) throw new TypeError("Invalid completed iteration");
      const collected = state.nodes[row.work].output;
      if (!isDeepStrictEqual(collected, { results: row.results })) throw new TypeError("Forged accumulated child outcomes");
      const evaluator = state.nodes[row.evaluator];
      if (row.decision) {
        if (evaluator.status !== "completed" || !isDeepStrictEqual(decision(evaluator.output, node), row.decision) || row.evaluatorError !== undefined) throw new TypeError("Forged evaluator decision");
      } else if (feedback.terminal?.reason === "cancellation" && index === feedback.iterations.length - 1) {
        if (evaluator.status === "pending" || evaluator.status === "running") throw new TypeError("Unsettled cancelled evaluator");
      } else if (!["failed", "skipped"].includes(evaluator.status) || row.evaluatorError !== (evaluator.error ?? "Evaluator skipped")) throw new TypeError("Forged evaluator failure");
    });
    if (feedback.active) binding(feedback.active, feedback.iterations.length + 1);
    const count = feedback.iterations.length + (feedback.active || feedback.intent ? 1 : 0);
    if (count > node.maxIterations) throw new TypeError("Feedback iteration limit exceeded");
    const total = feedback.iterations.reduce((sum, row) => sum + row.tasks.length, 0) + (feedback.active?.tasks.length ?? 0);
    if (total > node.maxTotalItems) throw new TypeError("Feedback item limit exceeded");
    if ((node.deadline !== undefined || node.spendLimit !== undefined) && feedback.iterations.length > 0 && feedback.budgetCheckedAt === undefined && feedback.terminal?.reason !== "cancellation") throw new TypeError("Missing feedback terminal/continuation budget check");
    if (feedback.budgetCheckedAt !== undefined && (!Number.isSafeInteger(feedback.budgetCheckedAt) || feedback.budgetCheckedAt < (runtime.startedAt ?? 0) || (node.deadline === undefined && node.spendLimit === undefined))) throw new TypeError("Invalid feedback budget clock");
    if (feedback.active && (node.deadline !== undefined || node.spendLimit !== undefined) && (feedback.budgetCheckedAt === undefined || feedbackBudgetBounds({ iterations: feedback.iterations, gaps: feedback.gaps }, node, runtime.startedAt ?? 0, new Map(Object.entries(state.nodes)), feedback.budgetCheckedAt, runtime).length > 0)) throw new TypeError("Materialization exceeds feedback budget");
    const expectedGaps = [...feedback.iterations].reverse().find(row => row.decision)?.decision?.gaps ?? [];
    if (!isDeepStrictEqual(feedback.gaps, expectedGaps)) throw new TypeError("Forged accumulated gaps");
    const next = feedback.iterations.length ? feedbackContinuation(feedback.iterations, node) : undefined;
    if (feedback.intent || feedback.active) {
      const batch = feedback.intent ?? feedback.active;
      if (!batch || batch.iteration !== feedback.iterations.length + 1 || !Array.isArray(batch.tasks)) throw new TypeError("Invalid continuation intent");
      let tasks: readonly JsonValue[] | undefined;
      if (next) { if ("tasks" in next) tasks = next.tasks; }
      else { const initial = prepareFanout(node.work, context); if (initial.ok) tasks = initial.items.map(item => item.item); }
      if (!tasks || !isDeepStrictEqual(tasks, batch.tasks)) throw new TypeError("Continuation disagrees with authoritative decision/input");
    }
    if (feedback.terminal) validateTerminal({ state, graph, key, feedback, node, next, context });
    else if (!feedback.active && !feedback.intent) throw new TypeError("Feedback checkpoint has no continuation or terminal");
  }
}

function validateTerminal({ state, graph, key, feedback, node, next, context }: { state: SchedulerState; graph: AgentGraph; key: string; feedback: FeedbackState; node: BoundedFeedbackNode; next: ReturnType<typeof feedbackContinuation> | undefined; context: ResolutionContext }): void {
  const terminal = feedback.terminal;
  if (!terminal) return;
  const skipped = terminal.reason === "skipped before admission" || (terminal.reason === "cancellation" && state.nodes[key].attempt === 0);
  if (skipped) {
    const owner = state.runtime?.manifest.find(row => row.binding === key);
    if (state.nodes[key].attempt !== 0 || feedback.iterations.length || feedback.stoppedIntent || feedback.retryFailures !== undefined || feedback.retryError !== undefined || feedback.budgetCheckedAt !== undefined || state.runtime?.manifest.some(row => row.parentInstanceId === owner?.instanceId)) throw new TypeError("Invalid never-admitted feedback skip");
  }
  let expected: { reason: string; exhaustedBounds: readonly string[] } | undefined = next && "reason" in next ? next : undefined;
  const exhausted = state.runtime && feedback.budgetCheckedAt !== undefined ? feedbackBudgetBounds(feedback, node, state.runtime.startedAt ?? 0, new Map(Object.entries(state.nodes)), feedback.budgetCheckedAt, state.runtime) : [];
  if (exhausted.length > 0) expected = { reason: "deadline/spend limit", exhaustedBounds: exhausted };
  if (terminal.reason === "deadline/spend limit") {
    if (feedback.budgetCheckedAt === undefined || !state.runtime) throw new TypeError("Missing terminal budget check");
    const bounds = feedbackBudgetBounds(feedback, node, state.runtime.startedAt ?? 0, new Map(Object.entries(state.nodes)), feedback.budgetCheckedAt, state.runtime);
    if (bounds.length === 0) throw new TypeError("Forged budget termination");
    expected = { reason: terminal.reason, exhaustedBounds: bounds };
    if (feedback.stoppedIntent) {
      const initial = next ? undefined : prepareFanout(node.work, context);
      const tasks = next && "tasks" in next ? next.tasks : initial?.ok ? initial.items.map(item => item.item) : undefined;
      if (!tasks || feedback.stoppedIntent.iteration !== feedback.iterations.length + 1 || !isDeepStrictEqual(feedback.stoppedIntent.tasks, tasks)) throw new TypeError("Invalid stopped budget intent");
    }
  } else if (terminal.reason === "skipped before admission") {
    expected = { reason: "skipped before admission", exhaustedBounds: [] };
  } else if (terminal.reason === "cancellation") {
    if (!state.runtime?.cancelled) throw new TypeError("Forged cancellation");
    expected = { reason: "cancellation", exhaustedBounds: [] };
  } else if (!expected) {
    const initial = next ? undefined : prepareFanout(node.work, context);
    const tasks = next && "tasks" in next ? next.tasks : initial?.ok ? initial.items.map(item => item.item) : undefined;
    if (initial && !initial.ok) expected = { reason: "materialization failure", exhaustedBounds: [initial.error] };
    else if (tasks) {
      const stopped = feedback.stoppedIntent;
      if (!stopped || stopped.iteration !== feedback.iterations.length + 1 || !isDeepStrictEqual(stopped.tasks, tasks)) throw new TypeError("Missing stopped materialization intent");
      const total = feedback.iterations.reduce((sum, row) => sum + row.tasks.length, 0) + tasks.length;
      const count = tasks.length + 2;
      const runs = Object.values(state.nodes).reduce((sum, run) => sum + run.attempt + Number(run.status === "pending"), 0);
      if (tasks.length > node.maxItemsPerIteration || total > node.maxTotalItems) expected = { reason: "item limit", exhaustedBounds: [tasks.length > node.maxItemsPerIteration ? "maxItemsPerIteration" : "maxTotalItems"] };
      else if (Object.keys(graph.nodes).length + count > MAX_NODES || runs + count > 1000) expected = { reason: "materialization failure", exhaustedBounds: [Object.keys(graph.nodes).length + count > MAX_NODES ? "node limit" : "run limit"] };
      else if ([`${key}:iteration:${stopped.iteration}:work`, `${key}:iteration:${stopped.iteration}:evaluator`, ...tasks.map((_, index) => `${key}:iteration:${stopped.iteration}:work:item:${index}`)].some(binding => Object.hasOwn(graph.nodes, binding))) expected = { reason: "materialization failure", exhaustedBounds: ["Generated binding collision"] };
    }
  }
  const partial = terminal.reason !== "sufficient" || feedback.gaps.length > 0 || feedback.iterations.some(row => row.results.some(result => result.status !== "completed"));
  const counters = { iterations: feedback.iterations.length, totalItems: feedback.iterations.reduce((sum, row) => sum + row.tasks.length, 0) };
  if (!expected || feedback.active || feedback.intent || terminal.reason !== expected.reason || terminal.partial !== partial || !isDeepStrictEqual(terminal.exhaustedBounds, expected.exhaustedBounds) || !isDeepStrictEqual(terminal.counters, counters) || !isDeepStrictEqual(terminal.gaps, feedback.gaps) || !isDeepStrictEqual(terminal.iterations, feedback.iterations) || !isDeepStrictEqual(state.nodes[key].output, skipped ? undefined : terminal) || state.nodes[key].status !== (skipped ? "skipped" : terminal.reason === "materialization failure" ? "failed" : "completed")) throw new TypeError("Invalid terminal accumulator");
}
function executionTemplate(node: GraphNode): string {
  return canonical(Object.fromEntries(Object.entries(node).filter(([key]) => key !== "name" && key !== "phase")));
}
