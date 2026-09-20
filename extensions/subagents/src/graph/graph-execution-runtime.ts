import { randomUUID } from "node:crypto";
import { type CancellationReason, type ExecutionCorrelation, type ExecutionEvent, ExecutionIndex, executionAttemptId, matchesExecution } from "./graph-execution.js";
import type { GraphRuntimeState, NestedCheckpoint, NodeInstanceId } from "./graph-instance-id.js";
import { applyRecovery, ProjectionTable, type RecoveryProposal } from "./graph-projection.js";
import type { AgentNode, HumanGateNode } from "./ir.js";
import type { NodeHost, NodeSpawnResult } from "./node-host.js";
import type { NodeRun } from "./scheduler.js";
import { subgraphRecoveryProposal } from "./subgraph-disposition.js";

function assertDrainedNestedHistory(checkpoint: NestedCheckpoint): void {
  const index = new ExecutionIndex(checkpoint.state.runtime?.executionLedger ?? []);
  if ([...index.executions.values()].some(rows => !rows.some(row => row.payload.kind === "drain-ack"))) throw new TypeError("Undrained nested execution history");
  for (const nested of Object.values(checkpoint.state.runtime?.nested ?? {})) {
    for (const descendant of [...nested.previous ?? [], nested]) assertDrainedNestedHistory(descendant);
  }
}

/** Driver-owned transactions, not a dispatcher or a resource-release authority. */
export class GraphExecutions {
  readonly index: ExecutionIndex;
  private readonly identities = new Map<string, NodeInstanceId>();
  private readonly latest = new Map<string, ExecutionCorrelation>();
  constructor(readonly runtime: GraphRuntimeState, private readonly nodes: Pick<ReadonlyMap<string, NodeRun>, "get">) {
    const ledger = runtime.executionLedger;
    if (!ledger) throw new TypeError("Missing execution ledger");
    this.index = new ExecutionIndex(ledger);
    for (const row of runtime.manifest) {
      this.identities.set(row.binding, row.instanceId);
      const latest = this.index.latest.get(row.instanceId); if (latest) this.latest.set(row.binding, latest);
    }
  }
  private identity(id: string): NodeInstanceId {
    let identity = this.identities.get(id) ?? this.runtime.manifest.find(row => row.binding === id)?.instanceId;
    if (!identity) identity = randomUUID() as NodeInstanceId;
    this.identities.set(id, identity); return identity;
  }
  current(id: string): ExecutionCorrelation | undefined { return this.latest.get(id); }
  rows(correlation: ExecutionCorrelation): readonly ExecutionEvent[] { return this.index.executions.get(correlation.executionAttemptId) ?? []; }
  begin(id: string, node: AgentNode | HumanGateNode): ExecutionCorrelation | undefined {
    const run = this.nodes.get(id);
    if (!run || run.activation === undefined || run.graphAttempt === undefined) throw new TypeError(`Missing execution state for ${id}`);
    const scope = { runId: this.runtime.runId, instanceId: this.identity(id), activation: run.activation, graphAttempt: run.graphAttempt };
    const budget = { maxExecutions: node.type === "agent" ? node.retry?.maxAttempts ?? 1 : 1 };
    if (this.index.consumed(scope) >= budget.maxExecutions) return undefined;
    const correlation = Object.freeze({ ...scope, executionAttemptId: executionAttemptId(randomUUID()) });
    this.index.append({ ...correlation, payload: { kind: "admitted", resources: node.type === "agent" ? [...node.resources ?? []] : [], budget } });
    this.index.append({ ...correlation, payload: { kind: "dispatched", target: node.type === "agent" ? "agent" : "human-gate" } });
    this.latest.set(id, correlation); run.currentExecutionAttemptId = correlation.executionAttemptId;
    return correlation;
  }
  accepts(id: string, correlation: ExecutionCorrelation): boolean {
    const current = this.latest.get(id);
    return !!current && matchesExecution(current, correlation) && !this.rows(correlation).some(row => ["cancel-requested", "outcome", "drain-ack"].includes(row.payload.kind));
  }
  emit(id: string, event: ExecutionEvent): boolean {
    const current = this.latest.get(id);
    if (!current || !matchesExecution(current, event)) return false;
    if ((event.payload.kind === "cost" || event.payload.kind === "dispatched" || event.payload.kind === "outcome" && event.payload.status !== "cancelled") && !this.accepts(id, event)) return false;
    if (!this.index.append(event)) return true;
    if (event.payload.kind === "cost") {
      const run = this.nodes.get(id);
      if (!run) throw new TypeError(`Missing execution state for ${id}`);
      run.costAttempts = (run.costAttempts ?? 0) + 1;
      if (event.payload.costUsd !== undefined) run.costUsd = (run.costUsd ?? 0) + event.payload.costUsd;
      if (event.payload.unavailable) run.costUnavailable = true;
    }
    return true;
  }
  cost(id: string, correlation: ExecutionCorrelation, costUsd: number | undefined): void {
    if (this.rows(correlation).some(row => row.payload.kind === "cost")) return;
    this.emit(id, { ...correlation, payload: typeof costUsd === "number" && Number.isFinite(costUsd) && costUsd >= 0 ? { kind: "cost", costUsd } : { kind: "cost", unavailable: true } });
  }
  finish(id: string, correlation: ExecutionCorrelation, result: NodeSpawnResult, cancelled: boolean, executed: boolean): boolean {
    const current = this.latest.get(id);
    if (!current || !matchesExecution(current, correlation) || this.rows(correlation).some(row => row.payload.kind === "drain-ack")) return false;
    cancelled ||= this.rows(correlation).some(row => row.payload.kind === "cancel-requested");
    if (cancelled) this.cancel(id, "cancel");
    else if (executed) this.cost(id, correlation, result.costUsd);
    this.emit(id, { ...correlation, payload: { kind: "outcome", status: cancelled ? "cancelled" : result.ok ? "success" : "failure" } });
    this.emit(id, { ...correlation, payload: { kind: "drain-ack", source: "live" } });
    return !cancelled;
  }
  cancel(id: string, reason: CancellationReason): boolean {
    const correlation = this.latest.get(id);
    if (!correlation) return true; // A structural graph node has no execution ledger.
    const prior = this.rows(correlation).find(row => row.payload.kind === "cancel-requested")?.payload;
    if (prior?.kind === "cancel-requested") return prior.reason === reason;
    if (!this.accepts(id, correlation)) return false;
    return this.emit(id, { ...correlation, payload: { kind: "cancel-requested", reason } });
  }
  cancelAll(reason: CancellationReason): void { for (const id of this.latest.keys()) this.cancel(id, reason); }
  /** Apply only the latest correlated, drained disposition; counters advance at admission. */
  recoveryProposal(): RecoveryProposal {
    const subgraphs = subgraphRecoveryProposal(this.runtime, this.nodes);
    const nodes: Record<string, NodeRun> = Object.assign(Object.create(null), subgraphs.nodes); const restarts = [...subgraphs.restarts];
    let cancelled = subgraphs.cancelled;
    for (const [id, correlation] of this.latest) {
      const prior = nodes[id] ?? this.nodes.get(id);
      if (!prior || prior.currentExecutionAttemptId !== correlation.executionAttemptId || prior.activation !== correlation.activation || prior.graphAttempt !== correlation.graphAttempt) continue;
      const rows = this.rows(correlation);
      if (!rows.some(row => row.payload.kind === "drain-ack")) continue;
      const request = rows.find(row => row.payload.kind === "cancel-requested")?.payload;
      if (request?.kind !== "cancel-requested") continue;
      if (request.reason === "cancel") { cancelled = true; continue; }
      if (cancelled || !["running", "pending"].includes(prior.status)) continue;
      const run = { ...prior }; delete run.output; delete run.error;
      if (request.reason === "skip") run.status = "skipped";
      else {
        run.status = "pending"; run.attemptReason = request.reason === "retry" ? "user-retry" : "restore";
        restarts.push(id);
      }
      nodes[id] = run;
    }
    return { nodes, restarts, cancelled, nestedCancelled: subgraphs.nestedCancelled };
  }

  flush(): void {
    const ledger = this.runtime.executionLedger;
    if (!ledger) throw new TypeError("Missing execution ledger");
    Object.assign(this.runtime, { executionLedger: this.index.flush(ledger) });
  }
  async prepareRecovery(host: NodeHost, reclaimedDeadWriter: boolean): Promise<() => void> {
    const nestedCommits: (() => void)[] = [];
    for (const nested of Object.values(this.runtime.nested ?? {})) {
      for (const prior of nested.previous ?? []) assertDrainedNestedHistory(prior);
      if (nested.state.runtime?.executionProtocolVersion === 1) {
        const child = new GraphExecutions(nested.state.runtime, new ProjectionTable(() => nested.state.nodes));
        const recover = await child.prepareRecovery(host, reclaimedDeadWriter);
        nestedCommits.push(() => { recover(); applyRecovery(nested.state, child.recoveryProposal()); });
      }
    }
    const reconciled: ExecutionCorrelation[] = [];
    for (const [id, correlation] of this.latest) {
      const rows = this.rows(correlation);
      if (rows.some(row => row.payload.kind === "drain-ack")) continue;
      const dispatch = rows.filter(row => row.payload.kind === "dispatched").at(-1)?.payload;
      if (!reclaimedDeadWriter || dispatch?.kind !== "dispatched" || dispatch.target === "validation-gate" || !host.reconcileDrain || await host.reconcileDrain(correlation, dispatch.target) !== true) throw new TypeError(`Unreconciled execution drain for ${id}`);
      reconciled.push(correlation);
    }
    // All host reconciliation finishes before the caller opens a synchronous transaction.
    return () => {
      for (const commit of nestedCommits) commit();
      for (const correlation of reconciled) this.index.append({ ...correlation, payload: { kind: "drain-ack", source: "recovery" } }, { reclaimedDeadWriter, reconciled: true });
      this.flush();
    };
  }
}
