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
import type { AgentGraph, GraphEdge, GraphFragment, NodeId, ValueRef } from "./ir.js";
import { MISSING, type ResolutionContext, resolveValueRef } from "./value-ref.js";

export type NodeStatus = "pending" | "running" | "completed" | "failed" | "skipped";

export interface NodeRun {
  status: NodeStatus;
  /** How many times this node has started (incremented on each (re)run). */
  attempt: number;
  /** Parsed output of a completed node — the value ValueRefs read. */
  output?: unknown;
  error?: string;
}

/** The disposition of one node run, fed back from the driver. */
export interface SettleInput {
  ok: boolean;
  output?: unknown;
  error?: string;
  /** The run was skipped/dismissed rather than a genuine failure. */
  skipped?: boolean;
}

function isSettled(status: NodeStatus | undefined): boolean {
  return status === "completed" || status === "failed" || status === "skipped";
}

export class Scheduler {
  readonly nodes = new Map<NodeId, NodeRun>();
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
   * how many nodes changed, so the driver can re-check for cascades.
   */
  resolveSkips(): number {
    const ctx = this.context();
    let changed = 0;
    for (const [id, run] of this.nodes) {
      if (run.status !== "pending") continue;
      const incoming = this.incoming(id);
      if (incoming.length === 0) continue;
      const forward = incoming.filter(edge => edge.loop === undefined);
      if (!forward.every(edge => isSettled(this.nodes.get(edge.from)?.status))) continue;
      if (incoming.some(edge => this.edgeActive(edge, ctx))) continue;
      run.status = "skipped";
      changed++;
    }
    return changed;
  }

  /**
   * Skip any node still pending when the run can make no further progress.
   *
   * A cycle with no live entry leaves nodes waiting on each other forever; once
   * nothing is ready, running, or resolvable as a skip, those are dead and are
   * marked skipped so the run can finish. Returns how many changed.
   */
  forceSkipStuck(): number {
    let changed = 0;
    for (const run of this.nodes.values()) {
      if (run.status === "pending") {
        run.status = "skipped";
        changed++;
      }
    }
    return changed;
  }

  /** Move a node into `running` and count the run against the global backstop. */
  markRunning(id: NodeId): void {
    const run = this.nodes.get(id);
    if (run === undefined) throw new Error(`Unknown node "${id}"`);
    run.status = "running";
    run.attempt++;
    this.totalRuns++;
    if (this.totalRuns > this.maxTotalRuns) {
      throw new Error(`Graph exceeded ${this.maxTotalRuns} total node runs — a loop is not converging.`);
    }
  }

  /** Reset a running node to pending so the driver re-runs it (user retry). */
  retry(id: NodeId): boolean {
    const run = this.nodes.get(id);
    if (run?.status !== "running") return false;
    run.status = "pending";
    run.output = undefined;
    run.error = undefined;
    return true;
  }

  /** Record a node's disposition and re-activate any bounded loop targets. */
  settle(id: NodeId, result: SettleInput): void {
    const run = this.nodes.get(id);
    if (run === undefined) throw new Error(`Unknown node "${id}"`);
    if (result.skipped) {
      run.status = "skipped";
      return;
    }
    if (!result.ok) {
      run.status = "failed";
      run.error = result.error;
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

  /** Overall status: failed if any node failed, else completed. */
  runStatus(): "completed" | "failed" {
    for (const run of this.nodes.values()) if (run.status === "failed") return "failed";
    return "completed";
  }
}

function resolveRefLoose(ref: ValueRef, ctx: ResolutionContext): unknown {
  const value = resolveValueRef(ref, ctx);
  return value === MISSING ? undefined : value;
}
