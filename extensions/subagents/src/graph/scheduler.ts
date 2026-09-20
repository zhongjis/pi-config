/**
 * scheduler.ts — the dependency/condition/loop scheduler for a run.
 *
 * Deliberately a small, synchronous, side-effect-light engine that XState is not
 * asked to represent (design §1.10): XState owns each node actor's lifecycle, this
 * owns *which* nodes may run and *when*. Keeping it pure — it never spawns, awaits,
 * or touches a host — is what lets the whole cyclic scheduling story be unit-tested
 * deterministically by scripting node outcomes.
 *
 * ## Readiness
 *
 * A pending node with no incoming edges is a root: ready at once. Otherwise it is
 * ready when every incoming edge's source has *settled* (completed / failed /
 * skipped) — the AND-join — and at least one incoming edge is *active*: its source
 * completed and its `when` holds. If every incoming edge has settled but none is
 * active, the node's activation path never fired, so it is skipped rather than run.
 *
 * ## Loops
 *
 * The AND-join above counts forward edges only; a back edge (marked `loop`) never
 * gates a node's first run. When a node completes, an active outgoing edge into an
 * already-completed target re-runs that target: the back edge that closes a cycle
 * must declare `loop`, and its `maxIterations` is the per-edge cap that bounds the
 * cycle. Forward edges re-fire an already-run target uncapped — a downstream node
 * re-runs when its upstream re-completes — which stays bounded because a back edge in
 * the cycle is capped. A global `maxTotalRuns` backstops anything that slips past.
 */

import { evaluateCondition } from "./condition.js";
import type { FanoutChild } from "./fanout.js";
import type { GraphRuntimeState } from "./graph-instance-id.js";
import type { AgentGraph, FanoutResult, GraphEdge, GraphFragment, NodeId, ValueRef } from "./ir.js";
import { MISSING, type ResolutionContext, resolveValueRef } from "./value-ref.js";

export type NodeStatus = "pending" | "running" | "completed" | "failed" | "skipped";

export interface NodeRun {
  /** Accumulated reported cost across executions of this instance. */
  costUsd?: number;
  costUnavailable?: boolean;
  costAttempts?: number;
  status: NodeStatus;
  /** How many times this node has started (incremented on each (re)run). */
  attempt: number;
  attemptReason?: "user-retry" | "loop";
  /** Parsed output of a completed node — the value ValueRefs read. */
  output?: unknown;
  error?: string;
}

/** The disposition of one node run, fed back from the driver. */
export interface SettleInput {
  costUsd?: number;
  ok: boolean;
  output?: unknown;
  error?: string;
  /** The run was skipped/dismissed rather than a genuine failure. */
  skipped?: boolean;
}

function isSettled(status: NodeStatus | undefined): boolean {
  return status === "completed" || status === "failed" || status === "skipped";
}

/** A serializable snapshot of a run's progress, for durable pause/resume. */
export interface SchedulerState {
  runtime?: GraphRuntimeState;
  nodes: Record<NodeId, NodeRun>;
  loopCounts: Record<string, number>;
  /** Additive v1 metadata; absent in snapshots predating fanout. */
  collections?: Record<NodeId, readonly FanoutChild[]>;
}

export class Scheduler {
  readonly nodes = new Map<NodeId, NodeRun>();
  readonly collections = new Map<NodeId, readonly FanoutChild[]>();
  /** Mutable edge list so an expand node can splice a fragment's edges in at runtime. */
  private readonly edges: GraphEdge[];
  private readonly loopCounts = new Map<string, number>();
  private totalRuns = 0;

  constructor(
    private readonly graph: AgentGraph,
    private readonly input: unknown,
    private readonly maxTotalRuns = 1000,
  ) {
    for (const id of Object.keys(graph.nodes)) this.nodes.set(id, { status: "pending", attempt: 0 });
    this.edges = [...graph.edges];
  }

  /** The ids of every node currently in the run — a fragment must not collide with these. */
  nodeIds(): Set<NodeId> {
    return new Set(this.nodes.keys());
  }

  /**
   * Splice a validated {@link GraphFragment} into the live run: each new node
   * starts `pending` and the fragment's edges join the edge list, so the next
   * ready()/settle() sees the additions exactly like the original graph's nodes.
   */
  insertFragment(fragment: GraphFragment): void {
    for (const id of Object.keys(fragment.nodes)) {
      if (!this.nodes.has(id)) this.nodes.set(id, { status: "pending", attempt: 0 });
    }
    this.edges.push(...fragment.edges);
  }

  private context(): ResolutionContext {
    const outputs = new Map<string, unknown>();
    for (const [id, run] of this.nodes) if (run.status === "completed") outputs.set(id, run.output);
    return { input: this.input, outputs };
  }

  private incoming(id: NodeId): GraphEdge[] {
    return this.edges.filter(edge => edge.to === id);
  }

  private outgoing(id: NodeId): GraphEdge[] {
    return this.edges.filter(edge => edge.from === id);
  }

  private edgeActive(edge: GraphEdge, ctx: ResolutionContext): boolean {
    if (this.nodes.get(edge.from)?.status !== "completed") return false;
    return edge.when === undefined || evaluateCondition(edge.when, ctx);
  }

  /**
   * The nodes ready to run right now.
   *
   * Also resolves pending nodes whose incoming edges have all settled but none is
   * active into `skipped` — a query with a documented side effect, which is what
   * lets the driver converge by simply re-calling it after each settle.
   */
  ready(): NodeId[] {
    const ctx = this.context();
    const runnable: NodeId[] = [];
    for (const [id, run] of this.nodes) {
      if (run.status !== "pending") continue;
      const incoming = this.incoming(id);
      if (incoming.length === 0) {
        runnable.push(id);
        continue;
      }
      // Join on forward edges only: a back edge (loop) never gates a first run.
      const forward = incoming.filter(edge => edge.loop === undefined);
      if (!forward.every(edge => isSettled(this.nodes.get(edge.from)?.status))) continue;
      if (incoming.some(edge => this.edgeActive(edge, ctx))) runnable.push(id);
    }
    return runnable;
  }

  /**
   * Skip pending nodes whose activation path can no longer fire.
   *
   * Called only when the run is quiescent (nothing ready, nothing running): a node
   * whose forward deps have all settled but has no active incoming edge will never
   * run, so it is skipped. Deferring this until quiescence is what lets a loop
   * re-run an upstream and change a downstream's fate before it is skipped. Returns
   * the changed ids in scheduler iteration order so callers can report each update.
   */
  resolveSkips(): NodeId[] {
    const ctx = this.context();
    const changed: NodeId[] = [];
    for (const [id, run] of this.nodes) {
      if (run.status !== "pending") continue;
      const incoming = this.incoming(id);
      if (incoming.length === 0) continue;
      const forward = incoming.filter(edge => edge.loop === undefined);
      if (!forward.every(edge => isSettled(this.nodes.get(edge.from)?.status))) continue;
      if (incoming.some(edge => this.edgeActive(edge, ctx))) continue;
      run.status = "skipped";
      changed.push(id);
    }
    return changed;
  }

  /**
   * Skip any node still pending when the run can make no further progress.
   *
   * A cycle with no live entry leaves nodes waiting on each other forever; once
   * nothing is ready, running, or resolvable as a skip, those are dead and are
   * marked skipped so the run can finish. Returns changed ids in scheduler
   * iteration order.
   */
  forceSkipStuck(): NodeId[] {
    const changed: NodeId[] = [];
    for (const [id, run] of this.nodes) {
      if (run.status === "pending") {
        run.status = "skipped";
        changed.push(id);
      }
    }
    return changed;
  }

  /** Move a node into `running` and count the run against the global backstop. */
  canMaterialize(count: number): boolean {
    return this.totalRuns + [...this.nodes.values()].filter(run => run.status === "pending").length + count <= this.maxTotalRuns;
  }

  markRunning(id: NodeId): void {
    if (this.totalRuns >= this.maxTotalRuns) throw new TypeError(`Graph exceeded ${this.maxTotalRuns} total node runs — a loop is not converging.`);
    const run = this.nodes.get(id);
    if (run === undefined) throw new Error(`Unknown node "${id}"`);
    run.status = "running";
    run.attempt++;
    this.totalRuns++;
  }

  /** Reset a running node to pending so the driver re-runs it (user retry). */
  retry(id: NodeId): boolean {
    const run = this.nodes.get(id);
    if (run?.status !== "running") return false;
    run.status = "pending";
    run.output = undefined;
    run.error = undefined;
    run.attemptReason = "user-retry";
    return true;
  }

  /** Record each returned agent execution before schema repair can dispatch another. */
  recordCost(id: NodeId, costUsd: number | undefined, attempt: number): void {
    const run = this.nodes.get(id);
    if (!run) throw new TypeError(`Unknown cost owner ${id}`);
    if ((run.costAttempts ?? 0) !== attempt - 1) run.costUnavailable = true;
    run.costAttempts = attempt;
    if (costUsd === undefined || !Number.isFinite(costUsd) || costUsd < 0 || !Number.isFinite((run.costUsd ?? 0) + costUsd)) run.costUnavailable = true;
    else run.costUsd = (run.costUsd ?? 0) + costUsd;
  }

  /** Record a node's disposition and re-activate any bounded loop targets. */
  settle(id: NodeId, result: SettleInput): void {
    const run = this.nodes.get(id);
    if (run === undefined) throw new Error(`Unknown node "${id}"`);
    if (result.costUsd !== undefined) run.costUsd = result.costUsd;
    if (result.skipped) {
      run.status = "skipped";
      run.error = result.error;
      return;
    }
    if (!result.ok) {
      run.status = "failed";
      run.error = result.error;
      if (result.output !== undefined) run.output = result.output;
      return;
    }
    run.status = "completed";
    run.output = result.output;

    const ctx = this.context();
    for (const edge of this.outgoing(id)) {
      if (!this.edgeActive(edge, ctx)) continue;
      const target = this.nodes.get(edge.to);
      if (target?.status !== "completed") continue; // only a re-run re-activates a target
      if (edge.loop !== undefined) {
        const key = `${edge.from}->${edge.to}`;
        const count = this.loopCounts.get(key) ?? 0;
        if (count >= edge.loop.maxIterations) continue; // cycle cap reached
        this.loopCounts.set(key, count + 1);
      }
      target.status = "pending";
      target.output = undefined;
      target.attemptReason = "loop";
    }
  }

  /** True once no node is pending or running. */
  isDone(): boolean {
    for (const run of this.nodes.values()) {
      if (run.status === "pending" || run.status === "running") return false;
    }
    return true;
  }

  /** Resolve the graph's declared outputs from completed node values. */
  resolveOutputs(): Record<string, unknown> {
    if (this.graph.outputs === undefined) return {};
    const ctx = this.context();
    const result: Record<string, unknown> = {};
    for (const [name, ref] of Object.entries(this.graph.outputs)) {
      const value = resolveRefLoose(ref, ctx);
      if (value !== undefined) result[name] = value;
    }
    return result;
  }

  /** A barrier consumes no executor slot and completes only after its owned children. */
  settleCollections(): NodeId[] {
    const changed: NodeId[] = [];
    for (const [id, children] of this.collections) {
      if (this.nodes.get(id)?.status !== "running") continue;
      const results: FanoutResult["results"][number][] = [];
      for (const [index, child] of children.entries()) {
        const run = this.nodes.get(child.nodeId);
        if (run === undefined || run.status === "pending" || run.status === "running") break;
        results.push({
          ...child, index, status: run.status, attempt: run.attempt,
          ...(run.output !== undefined ? { output: run.output } : {}),
          ...(run.error !== undefined ? { error: run.error } : {}),
        });
      }
      if (results.length !== children.length) continue;
      this.settle(id, { ok: true, output: { results } satisfies FanoutResult });
      changed.push(id);
    }
    return changed;
  }

  /** Overall status: failed if any node failed, else completed. */
  runStatus(handled: ReadonlySet<string> = new Set()): "completed" | "failed" {
    const collected = new Set([...this.collections.values()].flatMap(children => children.map(child => child.nodeId)));
    for (const [id, run] of this.nodes) if (run.status === "failed" && !collected.has(id) && !handled.has(id)) return "failed";
    return "completed";
  }

  /** Serialize the run's progress for durable persistence. */
  snapshotState(): SchedulerState {
    const nodes: SchedulerState["nodes"] = {};
    for (const [id, run] of this.nodes) {
      nodes[id] = { ...run };
    }
    return {
      nodes, loopCounts: Object.fromEntries(this.loopCounts),
      ...(this.collections.size > 0 ? { collections: Object.fromEntries(this.collections) } : {}),
    };
  }

  /**
   * Restore progress from a snapshot. A node that was mid-flight (`running`) when
   * the snapshot was taken cannot resume its actor, so it is reset to `pending`
   * and re-run; completed/skipped/failed nodes keep their disposition and output.
   */
  hydrate(state: SchedulerState): void {
    // Reject broken ownership before mutating any state: an orphaned running
    // barrier otherwise never settles and keeps the synchronous driver spinning.
    if (state.collections !== undefined &&
        (state.collections === null || typeof state.collections !== "object" || Array.isArray(state.collections))) {
      throw new TypeError("Invalid collection metadata: expected an ownership map");
    }
    const owned = new Set<string>();
    for (const [id, children] of Object.entries(state.collections ?? {})) {
      const parent = state.nodes[id];
      if (!Object.hasOwn(this.graph.nodes, id) || this.graph.nodes[id]?.type !== "fanout" ||
          !Object.hasOwn(state.nodes, id) || !parent || !["running", "completed"].includes(parent.status) || !Array.isArray(children)) {
        throw new TypeError(`Invalid collection "${id}": missing fanout parent, active state, or child list`);
      }
      for (const [index, child] of children.entries()) {
        if (!child || typeof child.nodeId !== "string" || owned.has(child.nodeId) || child.nodeId !== `${id}:item:${index}` ||
            !Object.hasOwn(this.graph.nodes, child.nodeId) || this.graph.nodes[child.nodeId]?.type !== "agent" ||
            !Object.hasOwn(state.nodes, child.nodeId) || !state.nodes[child.nodeId] ||
            !["pending", "running", "completed", "failed", "skipped"].includes(state.nodes[child.nodeId].status) ||
            (parent.status === "completed" && !isSettled(state.nodes[child.nodeId].status))) {
          throw new TypeError(`Invalid collection "${id}": missing, duplicate, or out-of-order child at ${index}`);
        }
        owned.add(child.nodeId);
      }
    }
    for (const [id, saved] of Object.entries(state.nodes)) {
      const run = this.nodes.get(id);
      if (run === undefined) continue;
      run.status = saved.status === "running" ? "pending" : saved.status;
      run.output = saved.output;
      run.attempt = saved.attempt;
      run.error = saved.error;
      run.attemptReason = saved.attemptReason;
      run.costUsd = saved.costUsd;
      run.costUnavailable = saved.costUnavailable;
      run.costAttempts = saved.costAttempts;
    }
    this.loopCounts.clear();
    for (const [key, value] of Object.entries(state.loopCounts)) this.loopCounts.set(key, value);
    this.totalRuns = [...this.nodes.values()].reduce((total, run) => total + run.attempt, 0);
    this.collections.clear();
    for (const [id, children] of Object.entries(state.collections ?? {})) {
      this.collections.set(id, children);
      const parent = this.nodes.get(id);
      if (parent?.status === "pending" && state.nodes[id]?.status === "running") parent.status = "running";
    }
  }
}

function resolveRefLoose(ref: ValueRef, ctx: ResolutionContext): unknown {
  const value = resolveValueRef(ref, ctx);
  return value === MISSING ? undefined : value;
}
