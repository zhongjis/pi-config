import { evaluateCondition } from "./condition.js";
import type { ProjectionPatch } from "./graph-projection.js";
import type { AgentGraph, FanoutResult, GraphEdge, NodeId } from "./ir.js";
import type { NodeRun, SchedulerState, SettleInput } from "./scheduler.js";
import { MISSING, type ResolutionContext, resolveValueRef } from "./value-ref.js";

/** Borrowed inputs. Every query/proposal leaves the projection and topology untouched. */
export interface PlanningView {
  readonly state: SchedulerState;
  readonly graph: AgentGraph;
  readonly input: unknown;
  readonly maxTotalRuns?: number;
  readonly nodeOrder?: Iterable<NodeId>;
  readonly collectionOrder?: Iterable<NodeId>;
}
export function resolutionContext(view: PlanningView): ResolutionContext {
  return { input: view.input, outputs: new Map(Object.entries(view.state.nodes).filter(([, run]) => run.status === "completed").map(([id, run]) => [id, run.output])) };
}
const settled = (run: NodeRun | undefined): boolean => !!run && ["completed", "failed", "skipped"].includes(run.status);
function active(edge: GraphEdge, view: PlanningView, ctx: ResolutionContext): boolean {
  return view.state.nodes[edge.from]?.status === "completed" && (edge.when === undefined || evaluateCondition(edge.when, ctx));
}
function nodeEntries(view: PlanningView): [string, NodeRun][] {
  return [...view.nodeOrder ?? Object.keys(view.state.nodes)].map(id => [id, view.state.nodes[id]]);
}
export function readyNodes(view: PlanningView): NodeId[] {
  const ctx = resolutionContext(view);
  return nodeEntries(view).filter(([id, run]) => {
    if (run.status !== "pending") return false;
    const incoming = view.graph.edges.filter(edge => edge.to === id);
    return incoming.length === 0 || incoming.filter(edge => edge.loop === undefined).every(edge => settled(view.state.nodes[edge.from])) && incoming.some(edge => active(edge, view, ctx));
  }).map(([id]) => id);
}
export function skipProposal(view: PlanningView, stuck = false): ProjectionPatch & { readonly skipped: readonly string[] } {
  const nodes: Record<string, NodeRun> = Object.create(null);
  const skipped: string[] = [];
  const projected = { ...view, state: { ...view.state, nodes: { ...view.state.nodes } } };
  const ctx = resolutionContext(view);
  for (const [id, run] of nodeEntries(view)) {
    if (run.status !== "pending") continue;
    const incoming = view.graph.edges.filter(edge => edge.to === id);
    if (!stuck && (!incoming.length || !incoming.filter(edge => edge.loop === undefined).every(edge => settled(projected.state.nodes[edge.from])) || incoming.some(edge => active(edge, projected, ctx)))) continue;
    nodes[id] = { ...run, status: "skipped" };
    projected.state.nodes[id] = nodes[id];
    skipped.push(id);
  }
  return { kind: "skips", nodes, skipped };
}
export function totalRuns(state: SchedulerState): number { return Object.values(state.nodes).reduce((sum, run) => sum + run.attempt, 0); }
export function canMaterialize(view: PlanningView, count: number): boolean {
  return totalRuns(view.state) + Object.values(view.state.nodes).filter(run => run.status === "pending").length + count <= (view.maxTotalRuns ?? 1000);
}
export function hasCapacity(used: number, capacity: number | undefined): boolean { return capacity === undefined || used < capacity; }
export function isDone(state: SchedulerState): boolean { return Object.values(state.nodes).every(settled); }
export function runStatus(state: SchedulerState, handled: ReadonlySet<string> = new Set()): "completed" | "failed" {
  const collected = new Set(Object.values(state.collections ?? {}).flatMap(children => children.map(child => child.nodeId)));
  return Object.entries(state.nodes).some(([id, run]) => run.status === "failed" && !collected.has(id) && !handled.has(id)) ? "failed" : "completed";
}
export function resolveOutputs(view: PlanningView): Record<string, unknown> {
  const ctx = resolutionContext(view);
  return Object.fromEntries(Object.entries(view.graph.outputs ?? {}).flatMap(([name, ref]) => {
    const value = resolveValueRef(ref, ctx);
    return value === MISSING || value === undefined ? [] : [[name, value]];
  }));
}
export type NodeTransition =
  | { readonly kind: "start"; readonly id: string; readonly restored?: boolean; readonly executionIdentity?: boolean }
  | { readonly kind: "retry"; readonly id: string }
  | { readonly kind: "settle"; readonly id: string; readonly result: SettleInput };

export function transitionProposal(view: PlanningView, transition: NodeTransition): ProjectionPatch {
  const prior = Object.hasOwn(view.state.nodes, transition.id) ? view.state.nodes[transition.id] : undefined;
  if (!prior) throw new TypeError(`Unknown node "${transition.id}"`);
  const run = { ...prior };
  const nodes = { [transition.id]: run };
  switch (transition.kind) {
    case "start": {
      const limit = view.maxTotalRuns ?? 1000;
      if (!transition.restored && totalRuns(view.state) >= limit) throw new TypeError(`Graph exceeded ${limit} total node runs — a loop is not converging.`);
      if (transition.executionIdentity) { run.activation ??= run.attempt ? 1 : 0; run.graphAttempt ??= run.attempt ? 1 : 0; }
      run.status = "running";
      if (!transition.restored) {
        if (run.activation !== undefined) {
          if (run.attemptReason === "user-retry" || run.attemptReason === "restore") run.graphAttempt = (run.graphAttempt ?? 0) + 1;
          else { run.activation++; run.graphAttempt = 1; }
          delete run.currentExecutionAttemptId;
        }
        run.attempt++;
      }
      return { kind: "start", nodes };
    }
    case "retry":
      return { kind: "retry", nodes: run.status === "running" ? { [transition.id]: { ...run, status: "pending", output: undefined, error: undefined, attemptReason: "user-retry" } } : {} };
    case "settle": {
      const result = transition.result;
      if (result.costUsd !== undefined) run.costUsd = result.costUsd;
      if (result.skipped) { run.status = "skipped"; run.error = result.error; }
      else if (!result.ok) { run.status = "failed"; run.error = result.error; if (result.output !== undefined) run.output = result.output; }
      else { run.status = "completed"; run.output = result.output; }
      const loops = result.ok && !result.skipped ? loopProposal({ ...view, state: { ...view.state, nodes: { ...view.state.nodes, ...nodes } } }, transition.id) : undefined;
      return { kind: "settle", nodes: { ...nodes, ...loops?.nodes }, ...(loops ? { loopCounts: loops.loopCounts } : {}) };
    }
    default: return assertNever(transition);
  }
}
function assertNever(value: never): never { throw new TypeError(`Unknown node transition: ${value}`); }

export function loopProposal(view: PlanningView, id: string): { readonly nodes: Readonly<Record<string, NodeRun>>; readonly loopCounts: Readonly<Record<string, number>> } {
  const nodes: Record<string, NodeRun> = Object.create(null);
  const loopCounts: Record<string, number> = {};
  const ctx = resolutionContext(view);
  // Conditions retain completion outputs; statuses reflect preceding reactivations.
  for (const edge of view.graph.edges.filter(edge => edge.from === id)) {
    if ((nodes[edge.from] ?? view.state.nodes[edge.from])?.status !== "completed" || edge.when !== undefined && !evaluateCondition(edge.when, ctx)) continue;
    const target = nodes[edge.to] ?? view.state.nodes[edge.to];
    if (target?.status !== "completed") continue;
    if (edge.loop !== undefined) {
      const key = `${edge.from}->${edge.to}`;
      const count = loopCounts[key] ?? view.state.loopCounts[key] ?? 0;
      if (count >= edge.loop.maxIterations) continue;
      loopCounts[key] = count + 1;
    }
    nodes[edge.to] = { ...target, status: "pending", output: undefined, attemptReason: "loop" };
  }
  return { nodes, loopCounts };
}
export function collectionProposal(view: PlanningView): { readonly intent: ProjectionPatch; readonly completed: readonly string[] } {
  const nodes: Record<string, NodeRun> = Object.create(null);
  const loopCounts: Record<string, number> = {};
  const completed: string[] = [];
  const state = { ...view.state, nodes: { ...view.state.nodes }, loopCounts: { ...view.state.loopCounts } };
  for (const id of view.collectionOrder ?? Object.keys(state.collections ?? {})) {
    const children = state.collections?.[id];
    if (!children) continue;
    if (state.nodes[id]?.status !== "running") continue;
    const results: FanoutResult["results"][number][] = [];
    for (const [index, child] of children.entries()) {
      const run = state.nodes[child.nodeId];
      if (!run || run.status === "pending" || run.status === "running") break;
      results.push({ ...child, index, status: run.status, attempt: run.attempt, ...(run.output !== undefined ? { output: run.output } : {}), ...(run.error !== undefined ? { error: run.error } : {}) });
    }
    if (results.length !== children.length) continue;
    const proposal = transitionProposal({ ...view, state }, { kind: "settle", id, result: { ok: true, output: { results } satisfies FanoutResult } });
    Object.assign(nodes, proposal.nodes); Object.assign(loopCounts, proposal.loopCounts);
    Object.assign(state.nodes, proposal.nodes); Object.assign(state.loopCounts, proposal.loopCounts);
    completed.push(id);
  }
  return { intent: { kind: "collections", nodes, loopCounts }, completed };
}
export function restoreProposal(state: SchedulerState): ProjectionPatch {
  const nodes: Record<string, NodeRun> = Object.create(null);
  for (const [id, run] of Object.entries(state.nodes)) {
    const feedback = Object.hasOwn(state.runtime?.feedback ?? {}, id) ? state.runtime?.feedback?.[id] : undefined;
    if (feedback && !feedback.terminal) nodes[id] = { ...run, status: "running" };
    else if (run.status === "running" && !Object.hasOwn(state.collections ?? {}, id)) nodes[id] = { ...run, status: "pending" };
  }
  return { kind: "restore", nodes };
}
