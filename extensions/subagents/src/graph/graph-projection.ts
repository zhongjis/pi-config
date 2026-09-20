import type { FanoutChild } from "./fanout.js";
import type { GraphRuntimeState } from "./graph-instance-id.js";
import type { AgentGraph, NodeId } from "./ir.js";
import type { NodeRun, SchedulerState } from "./scheduler.js";

/** Selected by a root transaction; application contains no scheduling policy. */
export interface ProjectionPatch {
  readonly kind: "start" | "retry" | "settle" | "skips" | "collections" | "restore";
  readonly nodes: Readonly<Record<NodeId, NodeRun>>;
  readonly loopCounts?: Readonly<Record<string, number>>;
}
export type ProjectionIntent = ProjectionPatch
  | { readonly kind: "materialize"; readonly ids: readonly NodeId[] }
  | { readonly kind: "collection"; readonly id: NodeId; readonly children: readonly FanoutChild[] };

export function applyProjection(state: SchedulerState, intent: ProjectionIntent): void {
  switch (intent.kind) {
    case "start": case "retry": case "settle": case "skips": case "collections": case "restore":
      for (const [id, run] of Object.entries(intent.nodes)) Object.defineProperty(state.nodes, id, { value: run, writable: true, enumerable: true, configurable: true });
      Object.assign(state.loopCounts, intent.loopCounts);
      return;
    case "materialize":
      for (const id of intent.ids) if (!Object.hasOwn(state.nodes, id)) Object.defineProperty(state.nodes, id, { value: { status: "pending", attempt: 0 }, writable: true, enumerable: true, configurable: true });
      return;
    case "collection":
      state.collections ??= {};
      Object.defineProperty(state.collections, intent.id, { value: intent.children, writable: true, enumerable: true, configurable: true });
      return;
    default: assertNever(intent);
  }
}
function assertNever(value: never): never { throw new TypeError(`Unknown projection intent: ${value}`); }

/** Read-through view only: no second node/status map and no lifecycle methods. */
export class ProjectionTable<T> {
  constructor(private readonly record: () => Readonly<Record<string, T>>, private readonly order: () => Iterable<string> = () => Object.keys(record())) {}
  get(id: string): T | undefined { return Object.hasOwn(this.record(), id) ? this.record()[id] : undefined; }
  has(id: string): boolean { return Object.hasOwn(this.record(), id); }
  get size(): number { return Object.keys(this.record()).length; }
  *keys(): IterableIterator<string> { yield* this.order(); }
  *values(): IterableIterator<T> { for (const key of this.order()) yield this.record()[key]; }
  *[Symbol.iterator](): IterableIterator<[string, T]> { for (const key of this.order()) yield [key, this.record()[key]]; }
}

/** Parse ownership without changing lifecycle. Root restore selection is separate. */
export function parseProjection(graph: AgentGraph, saved?: SchedulerState): SchedulerState {
  if (!saved) return { nodes: Object.fromEntries(Object.keys(graph.nodes).map(id => [id, { status: "pending", attempt: 0 }])), loopCounts: {} };
  if (saved.collections !== undefined && (saved.collections === null || typeof saved.collections !== "object" || Array.isArray(saved.collections))) throw new TypeError("Invalid collection metadata: expected an ownership map");
  const owned = new Set<string>();
  for (const [id, children] of Object.entries(saved.collections ?? {})) {
    const parent = saved.nodes[id];
    if (!Object.hasOwn(graph.nodes, id) || graph.nodes[id]?.type !== "fanout" || !Object.hasOwn(saved.nodes, id) || !parent || (!["running", "completed"].includes(parent.status) && !(parent.status === "skipped" && saved.runtime?.cancelled === true)) || !Array.isArray(children)) throw new TypeError(`Invalid collection "${id}": missing fanout parent, restorable state, or child list`);
    for (const [index, child] of children.entries()) {
      if (!child || typeof child.nodeId !== "string" || owned.has(child.nodeId) || child.nodeId !== `${id}:item:${index}` || !Object.hasOwn(graph.nodes, child.nodeId) || graph.nodes[child.nodeId]?.type !== "agent" || !Object.hasOwn(saved.nodes, child.nodeId) || !saved.nodes[child.nodeId] || !["pending", "running", "completed", "failed", "skipped"].includes(saved.nodes[child.nodeId].status) || (parent.status === "completed" && ["pending", "running"].includes(saved.nodes[child.nodeId].status))) throw new TypeError(`Invalid collection "${id}": missing, duplicate, or out-of-order child at ${index}`);
      owned.add(child.nodeId);
    }
  }
  return structuredClone(saved);
}

export function snapshotProjection(state: SchedulerState): SchedulerState {
  return { nodes: Object.fromEntries(Object.entries(state.nodes).map(([id, run]) => [id, { ...run }])), loopCounts: { ...state.loopCounts }, ...(state.collections && Object.keys(state.collections).length ? { collections: { ...state.collections } } : {}), ...(state.runtime ? { runtime: state.runtime } : {}) };
}

export interface RecoveryProposal {
  readonly nodes: Readonly<Record<string, NodeRun>>;
  readonly restarts: readonly string[];
  readonly cancelled: boolean;
  readonly nestedCancelled: readonly GraphRuntimeState[];
}
/** Recovery evidence was selected after physical drain reconciliation. */
export function applyRecovery(state: SchedulerState, proposal: RecoveryProposal): void {
  applyProjection(state, { kind: "restore", nodes: proposal.nodes });
  if (state.runtime && proposal.cancelled) state.runtime.cancelled = true;
  for (const nested of proposal.nestedCancelled) nested.cancelled = true;
}
