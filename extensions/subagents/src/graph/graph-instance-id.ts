import { randomUUID } from "node:crypto";
import type { FeedbackState } from "./bounded-feedback.js";
import type { ExecutionLedgerEntry } from "./graph-execution.js";
import type { AgentGraph, NodeKey } from "./ir.js";
import type { SchedulerState } from "./scheduler.js";
import type { SubgraphDisposition } from "./subgraph-disposition.js";

export type NodeInstanceId = string & { readonly __nodeInstanceId: unique symbol };
export interface NodeInstance {
  readonly instanceId: NodeInstanceId;
  readonly nodeKey: NodeKey;
  /** Scheduler binding; not the authored key for generated instances. */
  readonly binding: string;
  readonly ordinal: number;
  readonly parentInstanceId?: NodeInstanceId;
  readonly iteration?: number;
  readonly itemIndex?: number;
}
export interface NestedCheckpoint {
  graph: AgentGraph;
  state: SchedulerState;
  ordinals: Record<string, number>;
  input?: unknown;
  previous?: readonly NestedCheckpoint[];
}
export interface GraphRuntimeState {
  readonly version: 2;
  readonly executionProtocolVersion?: 1;
  readonly executionLedger?: readonly ExecutionLedgerEntry[];
  readonly runId: string;
  /** Durable run start; absent only in older snapshots without deadline accounting. */
  readonly startedAt?: number;
  revision: number;
  cancelled?: boolean;
  subgraphDispositions?: readonly SubgraphDisposition[];
  nextOrdinal?: number;
  nested?: Record<string, NestedCheckpoint>;
  feedback?: Record<string, FeedbackState>;
  readonly manifest: NodeInstance[];
}
export function isInstanceId(value: unknown): value is NodeInstanceId {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}
export function validateManifest(state: GraphRuntimeState, graph: AgentGraph): void {
  if ((state.startedAt !== undefined && (!Number.isSafeInteger(state.startedAt) || state.startedAt < 0)) || state.version !== 2 || typeof state.runId !== "string" || !state.runId ||
      !Number.isSafeInteger(state.revision) || state.revision < 0 || !Array.isArray(state.manifest)) {
    throw new TypeError("Invalid graph runtime checkpoint");
  }
  const ids = new Set<string>();
  const bindings = new Set<string>();
  let previousOrdinal = -1;
  for (const row of state.manifest) {
    if (!row || !isInstanceId(row.instanceId) || ids.has(row.instanceId) || !Number.isSafeInteger(row.ordinal) || row.ordinal <= previousOrdinal ||
        typeof row.nodeKey !== "string" || !row.nodeKey || typeof row.binding !== "string" ||
        !Object.hasOwn(graph.nodes, row.binding) || bindings.has(row.binding) ||
        (row.parentInstanceId !== undefined && !ids.has(row.parentInstanceId)) ||
        (row.iteration !== undefined && (!Number.isSafeInteger(row.iteration) || row.iteration < 1)) ||
        (row.itemIndex !== undefined && (!Number.isSafeInteger(row.itemIndex) || row.itemIndex < 0))) {
      throw new TypeError("Invalid or duplicate graph instance identity");
    }
    const parent = state.manifest.find(candidate => candidate.instanceId === row.parentInstanceId);
    const source = parent ? graph.nodes[parent.binding] : undefined;
    let provenance = !parent && row.nodeKey === row.binding && row.iteration === undefined && row.itemIndex === undefined;
    if (parent) {
      switch (source?.type) {
        case "expand": provenance = row.nodeKey === row.binding && row.iteration === undefined && row.itemIndex === undefined; break;
        case "fanout": provenance = row.nodeKey === parent.nodeKey && row.itemIndex !== undefined && row.iteration === parent.iteration; break;
        case "bounded_feedback": provenance = row.nodeKey === parent.nodeKey && row.itemIndex === undefined && row.iteration !== undefined && row.iteration <= source.maxIterations; break;
      }
    }
    if (!provenance) throw new TypeError("Invalid materialization provenance");
    previousOrdinal = row.ordinal;
    ids.add(row.instanceId);
    bindings.add(row.binding);
  }
  if (bindings.size !== Object.keys(graph.nodes).length) throw new TypeError("Incomplete graph instance manifest");
}

/** One run's append-only materialization ledger; callers checkpoint before publishing rows. */
export class GraphInstances {
  readonly state: GraphRuntimeState;
  constructor(runId: string, private readonly allocate: () => string = randomUUID, restored?: GraphRuntimeState, now: () => number = Date.now) {
    this.state = restored === undefined ? { version: 2, runId, startedAt: now(), revision: 0, manifest: [] } : structuredClone(restored);
    if (this.state.startedAt !== undefined && (!Number.isSafeInteger(this.state.startedAt) || this.state.startedAt < 0)) throw new TypeError("Invalid graph run start timestamp");
    if (this.state.runId !== runId) throw new TypeError("Checkpoint belongs to another run");
    if (this.state.nested) Object.setPrototypeOf(this.state.nested, null);
    if (this.state.feedback) Object.setPrototypeOf(this.state.feedback, null);
  }
  add(binding: string, provenance: Omit<NodeInstance, "instanceId" | "binding" | "ordinal">): NodeInstance {
    const instanceId = this.allocate();
    if (!isInstanceId(instanceId) || this.state.manifest.some(row => row.instanceId === instanceId || row.binding === binding)) {
      throw new TypeError("Invalid or duplicate graph instance identity");
    }
    const row: NodeInstance = { ...provenance, binding, instanceId, ordinal: this.reserveOrdinal() };
    this.state.manifest.push(row);
    return row;
  }
  reserveOrdinal(): number {
    const ordinal = this.state.nextOrdinal ?? Math.max(-1, ...this.state.manifest.map(row => row.ordinal), ...Object.values(this.state.nested ?? {}).flatMap(child => [...child.previous ?? [], child].flatMap(checkpoint => Object.values(checkpoint.ordinals)))) + 1;
    if (!Number.isSafeInteger(ordinal) || ordinal >= Number.MAX_SAFE_INTEGER) throw new TypeError("Materialization ordinal exhausted");
    this.state.nextOrdinal = ordinal + 1;
    return ordinal;
  }
  get(binding: string): NodeInstance {
    const row = this.state.manifest.find(entry => entry.binding === binding);
    if (!row) throw new TypeError(`Missing materialization for ${binding}`);
    return row;
  }
}
