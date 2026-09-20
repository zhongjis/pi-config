import type { GraphRuntimeState, NodeInstanceId } from "./graph-instance-id.js";
import type { AgentGraph } from "./ir.js";
import type { SchedulerState } from "./scheduler.js";

export type ExecutionAttemptId = string & { readonly __executionAttemptId: unique symbol };
export interface GraphLifecycleEvent<T> {
  readonly runId: string;
  readonly instanceId: NodeInstanceId;
  readonly activation: number;
  readonly graphAttempt: number;
  readonly executionAttemptId: ExecutionAttemptId;
  readonly payload: T;
}
export interface ExecutionBudget { readonly maxExecutions: number }
export type CancellationReason = "skip" | "retry" | "lifecycle" | "cancel";
export type ExecutionPayload =
  | { readonly kind: "admitted"; readonly resources: readonly string[]; readonly budget: ExecutionBudget }
  | { readonly kind: "dispatched"; readonly target: "agent" | "human-gate" | "validation-gate" }
  | { readonly kind: "cost"; readonly costUsd?: number; readonly unavailable?: true }
  | { readonly kind: "cancel-requested"; readonly reason: CancellationReason }
  | { readonly kind: "outcome"; readonly status: "success" | "failure" | "cancelled" }
  | { readonly kind: "drain-ack"; readonly source: "live" | "recovery" };
export type ExecutionEvent = GraphLifecycleEvent<ExecutionPayload>;
export interface LegacyExecutionBaseline {
  readonly kind: "legacy-baseline";
  readonly runId: string;
  readonly instanceId: NodeInstanceId;
  readonly activation: number;
  readonly graphAttempt: number;
  readonly consumedExecutions: number;
  readonly costAttempts: number;
  readonly costUsd: number;
  readonly costUnavailable: boolean;
}
export type ExecutionLedgerEntry = ExecutionEvent | LegacyExecutionBaseline;
type Scope = Pick<ExecutionEvent, "runId" | "instanceId" | "activation" | "graphAttempt">;
export type ExecutionCorrelation = Omit<ExecutionEvent, "payload">;
type Correlation = Scope & { readonly executionAttemptId: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const natural = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 0;
const money = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
function requireValid(ok: boolean): asserts ok { if (!ok) throw new TypeError("Invalid execution ledger"); }
function keys(value: object, allowed: readonly string[]): boolean { return Object.keys(value).every(key => allowed.includes(key)); }
function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((value, i) => equal(value, b[i]));
  return record(a) && record(b) && Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => Object.hasOwn(b, key) && equal(a[key], b[key]));
}
export function executionAttemptId(value: string): ExecutionAttemptId {
  requireValid(typeof value === "string" && uuid.test(value));
  return value as ExecutionAttemptId;
}
function sameScope(a: Scope, b: Scope): boolean {
  return a.runId === b.runId && a.instanceId === b.instanceId && a.activation === b.activation && a.graphAttempt === b.graphAttempt;
}
export function matchesExecution(a: Correlation, b: Correlation): boolean {
  return sameScope(a, b) && a.executionAttemptId === b.executionAttemptId;
}
function baseline(row: ExecutionLedgerEntry): row is LegacyExecutionBaseline { return "kind" in row; }

/** Compatibility accounting never invents historical execution identities or outcomes. */
export function projectExecution(ledger: readonly ExecutionLedgerEntry[], scope: Scope) {
  let consumedExecutions = 0; let costAttempts = 0; let costUsd = 0; let costUnavailable = false;
  for (const row of ledger) {
    if (!sameScope(row, scope)) continue;
    if (baseline(row)) {
      consumedExecutions += row.consumedExecutions; costAttempts += row.costAttempts; costUsd += row.costUsd; costUnavailable ||= row.costUnavailable;
    } else if (row.payload.kind === "admitted") consumedExecutions++;
    else if (row.payload.kind === "cost") { costAttempts++; costUsd += row.payload.costUsd ?? 0; costUnavailable ||= row.payload.unavailable === true; }
  }
  return { consumedExecutions, costAttempts, costUsd, costUnavailable };
}
export function remainingExecutions(ledger: readonly ExecutionLedgerEntry[], scope: Scope, budget: ExecutionBudget): number {
  requireValid(natural(budget.maxExecutions) && budget.maxExecutions > 0);
  return Math.max(0, budget.maxExecutions - projectExecution(ledger, scope).consumedExecutions);
}
function validateRow(value: unknown): asserts value is ExecutionLedgerEntry {
  requireValid(record(value));
  requireValid(typeof value.runId === "string" && value.runId.length > 0 && typeof value.instanceId === "string" && uuid.test(value.instanceId));
  requireValid(natural(value.activation) && natural(value.graphAttempt));
  if (value.kind === "legacy-baseline") {
    requireValid(keys(value, ["kind", "runId", "instanceId", "activation", "graphAttempt", "consumedExecutions", "costAttempts", "costUsd", "costUnavailable"]));
    requireValid(natural(value.consumedExecutions) && natural(value.costAttempts) && value.costAttempts <= value.consumedExecutions && money(value.costUsd) && typeof value.costUnavailable === "boolean");
    requireValid(value.activation === (value.consumedExecutions ? 1 : 0) && value.graphAttempt === value.activation);
    return;
  }
  requireValid(keys(value, ["runId", "instanceId", "activation", "graphAttempt", "executionAttemptId", "payload"]));
  requireValid(value.activation > 0 && value.graphAttempt > 0 && typeof value.executionAttemptId === "string" && uuid.test(value.executionAttemptId) && record(value.payload));
  const p = value.payload;
  switch (p.kind) {
    case "admitted":
      requireValid(keys(p, ["kind", "resources", "budget"]) && Array.isArray(p.resources) && p.resources.every(v => typeof v === "string" && v.length > 0) && new Set(p.resources).size === p.resources.length);
      requireValid(record(p.budget) && keys(p.budget, ["maxExecutions"]) && natural(p.budget.maxExecutions) && p.budget.maxExecutions > 0); break;
    case "dispatched": requireValid(keys(p, ["kind", "target"]) && ["agent", "human-gate", "validation-gate"].includes(String(p.target))); break;
    case "cost": requireValid(keys(p, ["kind", "costUsd", "unavailable"]) && (p.costUsd === undefined || money(p.costUsd)) && (p.unavailable === undefined || p.unavailable === true) && (p.costUsd !== undefined || p.unavailable === true)); break;
    case "outcome": requireValid(keys(p, ["kind", "status"]) && ["success", "failure", "cancelled"].includes(String(p.status))); break;
    case "cancel-requested": requireValid(keys(p, ["kind", "reason"]) && typeof p.reason === "string" && ["skip", "retry", "lifecycle", "cancel"].includes(p.reason)); break;
    case "drain-ack": requireValid(keys(p, ["kind", "source"]) && (p.source === "live" || p.source === "recovery")); break;
    default: requireValid(false);
  }
}

/** Throws on conflict; exact redelivery returns the original ledger reference. */
export function appendExecution(ledger: readonly ExecutionLedgerEntry[], row: ExecutionLedgerEntry, proof?: { reclaimedDeadWriter: boolean; reconciled: boolean }): readonly ExecutionLedgerEntry[] {
  return appendRow(ledger, row, proof?.reclaimedDeadWriter === true && proof.reconciled === true);
}
function appendRow(ledger: readonly ExecutionLedgerEntry[], row: ExecutionLedgerEntry, recovery: boolean): readonly ExecutionLedgerEntry[] {
  validateRow(row);
  if (ledger.some(prior => equal(prior, row))) return ledger;
  const owned = ledger.filter(prior => prior.instanceId === row.instanceId);
  requireValid(owned.every(prior => prior.runId === row.runId));
  if (baseline(row)) {
    requireValid(owned.length === 0 && ledger.every(baseline));
    return [...ledger, row];
  }
  const execution = ledger.filter((prior): prior is ExecutionEvent => !baseline(prior) && prior.executionAttemptId === row.executionAttemptId);
  requireValid(execution.every(prior => matchesExecution(prior, row)));
  const p = row.payload;
  const slot = (payload: ExecutionPayload) => payload.kind === "dispatched" ? `${payload.kind}:${payload.target === "validation-gate" ? "validation" : "host"}` : payload.kind;
  requireValid(!execution.some(prior => slot(prior.payload) === slot(p)));
  if (p.kind === "admitted") {
    requireValid(execution.length === 0);
    const admissions = owned.filter((prior): prior is ExecutionEvent => !baseline(prior) && prior.payload.kind === "admitted");
    const last = admissions.at(-1) ?? owned.find(baseline);
    if (last) {
      requireValid(sameScope(last, row) || (row.activation === last.activation && row.graphAttempt === last.graphAttempt + 1) || (row.activation === last.activation + 1 && row.graphAttempt === 1));
      if (!baseline(last)) requireValid(owned.some(prior => !baseline(prior) && matchesExecution(prior, last) && prior.payload.kind === "drain-ack"));
    } else requireValid(row.activation === 1 && row.graphAttempt === 1);
    for (const prior of admissions) if (sameScope(prior, row) && prior.payload.kind === "admitted") requireValid(equal(prior.payload.budget, p.budget) && equal(prior.payload.resources, p.resources));
    requireValid(remainingExecutions(ledger, row, p.budget) > 0);
  } else {
    requireValid(execution.length > 0);
    const has = (kind: ExecutionPayload["kind"]) => execution.some(prior => prior.payload.kind === kind);
    const host = execution.find(prior => prior.payload.kind === "dispatched");
    requireValid(!has("drain-ack"));
    if (p.kind === "drain-ack") {
      if (p.source === "live") requireValid(has("outcome"));
      else requireValid(recovery && !!host && !execution.some(prior => prior.payload.kind === "dispatched" && prior.payload.target === "validation-gate"));
    }
    else {
      requireValid(!has("outcome"));
      if (has("cancel-requested")) requireValid(p.kind === "outcome" && p.status === "cancelled");
      else if (p.kind === "dispatched") requireValid(p.target === "validation-gate" ? host?.payload.kind === "dispatched" && host.payload.target === "agent" : !host);
      else if (p.kind === "cost") requireValid(host?.payload.kind === "dispatched" && host.payload.target === "agent" && !execution.some(prior => prior.payload.kind === "dispatched" && prior.payload.target === "validation-gate"));
      else if (p.kind === "outcome") requireValid(!!host && p.status !== "cancelled");
    }
  }
  return [...ledger, row];
}

/** Also used by the recursive restore boundary; absent fields preserve legacy snapshots. */
export function validateExecutionProtocol(runtime: { runId: string; manifest: readonly { instanceId: string }[]; executionProtocolVersion?: unknown; executionLedger?: unknown }): void {
  const version = Object.hasOwn(runtime, "executionProtocolVersion"); const ledger = Object.hasOwn(runtime, "executionLedger");
  if (!version && !ledger) return;
  requireValid(version && ledger && runtime.executionProtocolVersion === 1 && Array.isArray(runtime.executionLedger) && Array.isArray(runtime.manifest));
  let validated: readonly ExecutionLedgerEntry[] = [];
  for (const row of runtime.executionLedger) {
    validateRow(row);
    requireValid(row.runId === runtime.runId && runtime.manifest.some(instance => instance.instanceId === row.instanceId));
    const next = appendRow(validated, row, true); // Replay durable evidence; this never grants live recovery authority.
    requireValid(next !== validated); // Redelivery is a no-op, not another durable row.
    validated = next;
  }
}

/** Call after legacy restore validation, before the first upgraded dispatch. No IO or ID allocation. */
export function upgradeLegacyExecution(state: SchedulerState): SchedulerState {
  const runtime = state.runtime;
  requireValid(!!runtime);
  validateExecutionProtocol(runtime);
  if (runtime.executionProtocolVersion === 1) return state;
  const executionLedger: LegacyExecutionBaseline[] = runtime.manifest.map(instance => {
    const run = state.nodes[instance.binding];
    requireValid(!!run && natural(run.attempt));
    return { kind: "legacy-baseline", runId: runtime.runId, instanceId: instance.instanceId, activation: run.attempt ? 1 : 0, graphAttempt: run.attempt ? 1 : 0, consumedExecutions: run.attempt, costAttempts: run.costAttempts ?? 0, costUsd: run.costUsd ?? 0, costUnavailable: run.costUnavailable === true };
  });
  const upgraded: GraphRuntimeState = { ...runtime, executionProtocolVersion: 1, executionLedger };
  validateExecutionProtocol(upgraded);
  return { ...state, runtime: upgraded };
}

/** Check ledger claims against the owning graph and separate scheduler cost evidence. */
export function validateExecutionState(state: SchedulerState, graph: AgentGraph): void {
  const runtime = state.runtime;
  if (!runtime) return;
  validateExecutionProtocol(runtime);
  for (const instance of runtime.manifest) {
    const rows = runtime.executionLedger?.filter(row => row.instanceId === instance.instanceId) ?? [];
    const node = graph.nodes[instance.binding]; const run = state.nodes[instance.binding];
    let costUsd = 0; let costAttempts = 0; let unavailable = false; let graphStarts = 0;
    const scopes = new Set<string>();
    for (const row of rows) {
      requireValid(!!node && !!run);
      if (baseline(row)) {
        requireValid(row.consumedExecutions <= run.attempt);
        costUsd += row.costUsd; costAttempts += row.costAttempts; unavailable ||= row.costUnavailable;
        graphStarts = row.consumedExecutions; if (graphStarts) scopes.add(`${row.activation}:${row.graphAttempt}`);
      } else if (row.payload.kind === "admitted") {
        requireValid(node.type === "agent" || node.type === "human_gate");
        requireValid(row.payload.budget.maxExecutions === (node.type === "agent" ? node.retry?.maxAttempts ?? 1 : 1));
        requireValid(equal(row.payload.resources, node.type === "agent" ? node.resources ?? [] : []));
        const scope = `${row.activation}:${row.graphAttempt}`;
        if (!scopes.has(scope)) { scopes.add(scope); graphStarts++; }
      } else if (row.payload.kind === "dispatched") {
        requireValid(row.payload.target === "human-gate" ? node.type === "human_gate" : node.type === "agent");
        if (row.payload.target === "validation-gate") requireValid(node.type === "agent" && !!node.validation?.gate);
      } else if (row.payload.kind === "cost") {
        costUsd += row.payload.costUsd ?? 0; costAttempts++; unavailable ||= row.payload.unavailable === true;
      } else if (row.payload.kind === "outcome" && row.payload.status === "success" && node.type === "agent" && node.validation?.gate) {
        requireValid(rows.some(prior => !baseline(prior) && matchesExecution(prior, row) && prior.payload.kind === "dispatched" && prior.payload.target === "validation-gate"));
      }
    }
    if (runtime.executionProtocolVersion === 1) requireValid(money(costUsd) && costUsd === (run?.costUsd ?? 0) && costAttempts === (run?.costAttempts ?? 0) && unavailable === (run?.costUnavailable === true));
    const latest = rows.filter((row): row is ExecutionEvent => !baseline(row) && row.payload.kind === "admitted").at(-1);
    if (runtime.executionProtocolVersion === 1 && (node?.type === "agent" || node?.type === "human_gate") && !rows.length) requireValid(run.attempt === 0);
    if (!latest) requireValid(run?.currentExecutionAttemptId === undefined);
    if (latest) {
      requireValid(run.attempt === graphStarts && run.activation === latest.activation && run.graphAttempt === latest.graphAttempt && run.currentExecutionAttemptId === latest.executionAttemptId);
      const execution = rows.filter((row): row is ExecutionEvent => !baseline(row) && matchesExecution(row, latest));
      const outcome = execution.find(row => row.payload.kind === "outcome")?.payload;
      const drained = execution.some(row => row.payload.kind === "drain-ack");
      if (!drained) requireValid(run.status === "running" || run.status === "skipped" && execution.some(row => row.payload.kind === "cancel-requested"));
      if (outcome?.kind === "outcome" && outcome.status === "success" && run.status !== "completed") requireValid(run.attemptReason === "loop" && (run.status === "pending" || run.status === "failed"));
      if (run.status === "completed") requireValid(drained && outcome?.kind === "outcome" && outcome.status === "success");
      if (run.status === "failed") requireValid(drained);
      if (run.status === "skipped") requireValid(execution.some(row => row.payload.kind === "cancel-requested") || drained);
    }
    if (run?.activation !== undefined || run?.graphAttempt !== undefined) requireValid(natural(run.activation) && natural(run.graphAttempt) && run.activation <= run.attempt && run.graphAttempt <= run.attempt && (run.activation === 0) === (run.graphAttempt === 0));
  }
}

/** Transient indexes over an already-validated ledger; runtime appends only generated events. */
export class ExecutionIndex {
  readonly instances = new Map<string, ExecutionLedgerEntry[]>();
  readonly executions = new Map<ExecutionAttemptId, ExecutionEvent[]>();
  readonly latest = new Map<string, ExecutionCorrelation>();
  private readonly scopes = new Map<string, number>();
  private readonly pending: ExecutionEvent[] = [];
  constructor(ledger: readonly ExecutionLedgerEntry[]) { for (const row of ledger) this.index(row); }
  private scope(row: Scope): string { return JSON.stringify([row.runId, row.instanceId, row.activation, row.graphAttempt]); }
  private index(row: ExecutionLedgerEntry): void {
    const owned = this.instances.get(row.instanceId) ?? []; owned.push(row); this.instances.set(row.instanceId, owned);
    if (baseline(row)) this.scopes.set(this.scope(row), row.consumedExecutions);
    else {
      const execution = this.executions.get(row.executionAttemptId) ?? []; execution.push(row); this.executions.set(row.executionAttemptId, execution);
      if (row.payload.kind === "admitted") {
        const { payload: _, ...correlation } = row; this.latest.set(row.instanceId, correlation);
        this.scopes.set(this.scope(row), (this.scopes.get(this.scope(row)) ?? 0) + 1);
      }
    }
  }
  consumed(scope: Scope): number { return this.scopes.get(this.scope(scope)) ?? 0; }
  append(row: ExecutionEvent, proof?: { reclaimedDeadWriter: boolean; reconciled: boolean }): boolean {
    const prior = this.executions.get(row.executionAttemptId);
    requireValid(!prior || matchesExecution(prior[0], row));
    const history = row.payload.kind === "admitted" ? this.instances.get(row.instanceId) ?? [] : prior ?? [];
    if (appendExecution(history, row, proof) === history) return false;
    this.index(row); this.pending.push(row); return true;
  }
  flush(ledger: readonly ExecutionLedgerEntry[]): readonly ExecutionLedgerEntry[] {
    if (!this.pending.length) return ledger;
    const next = [...ledger, ...this.pending]; this.pending.length = 0; return next;
  }
}

export function consumedExecutions(runtime: GraphRuntimeState, binding: string): number {
  const id = runtime.manifest.find(row => row.binding === binding)?.instanceId;
  return (runtime.executionLedger ?? []).filter(row => row.instanceId === id).reduce((total, row) => total + (baseline(row) ? row.consumedExecutions : Number(row.payload.kind === "admitted")), 0);
}
