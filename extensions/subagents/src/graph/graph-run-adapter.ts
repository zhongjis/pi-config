/**
 * graph-run-adapter.ts — bridge a graph run into the monitor.
 *
 * The `/agents → Graph runs` dialog, the fleet widget, the inline card and the
 * Herdr pane all render a {@link GraphRunTask}'s append-only progress log. A
 * graph run is node-shaped rather than script-shaped, so this maps each node's
 * {@link NodeRun} state onto a `graph_run_agent` progress entry (keyed by a stable
 * per-node index, last-write-wins) — which is exactly what those surfaces already
 * know how to collapse and draw. Each node row carries its incoming dependencies
 * so the roster reads as a graph, not a flat list.
 *
 * Keeping this in one adapter means the monitor stays unaware it is showing a
 * graph, and the graph runtime stays unaware of the monitor.
 */

import { type ExecutionCorrelation, matchesExecution } from "./graph-execution.js";
import type { NodeInstance } from "./graph-instance-id.js";
import type { AgentGraph, FanoutPhase, GraphNode } from "./ir.js";
import type { NodeResolvedInfo } from "./node-host.js";
import { isGraphRunOutcome, GRAPH_OUTCOME_KEY } from "./outcome.js";
import type { GraphNodePresentation, GraphRunAgentEntry } from "./progress.js";
import type { RunGraphResult } from "./run-graph.js";
import type { NodeRun } from "./scheduler.js";
import { type GraphRunTask, updateGraphRunProgressBatch } from "./task.js";

const PROMPT_PREVIEW = 200;
function promptPreview(value: unknown): string {
  if (value === undefined) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length <= PROMPT_PREVIEW ? text : `${text.slice(0, PROMPT_PREVIEW - 1)}…`;
}
function resultText(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Feeds a graph run's node updates into a graph run task's progress log.
 *
 * Node indices stay stable while dynamic dependency stages are recomputed as nodes materialize;
 * `update` then re-emits one entry per node state change.
 */
export class GraphRunReporter {
  private readonly index = new Map<string, number>();
  private readonly identities = new Map<string, NodeInstance>();
  private readonly presentation = new Map<string, GraphNodePresentation>();
  private readonly labels = new Map<string, string>();
  private readonly deps = new Map<string, string[]>();
  private readonly dependents = new Map<string, string[]>();
  private readonly agentType = new Map<string, string>();
  private readonly prompt = new Map<string, string>();
  private readonly stage = new Map<string, number>();
  private readonly explicitPhase = new Map<string, FanoutPhase>();
  /** Nodes already registered through the dynamic/restored metadata path. */
  private readonly registered = new Set<string>();
  private readonly current = new Map<string, ExecutionCorrelation>();
  /** Transient v2 execution identity lookup; never emitted or persisted. */
  private readonly executionIndex = new Map<string, number>();
  private readonly resolved = new Map<string, { model?: string; modelId?: string; recordId?: string }>();
  private readonly lastRun = new Map<string, Readonly<NodeRun>>();
  private readonly lastUpdateAt = new Map<string, number>();
  /** Last-emitted activity counts per node, so `refresh` only re-emits on a real change. */
  private readonly lastCounts = new Map<string, string>();
  /** Per-node running start, pinned per attempt so re-emits don't restamp elapsed. */
  private readonly runStart = new Map<string, { at: number; attempt: number }>();
  private readonly queuedAt: number;
  private nextIndex = 0;

  constructor(
    private readonly task: GraphRunTask,
    graph: AgentGraph,
    now: number = Date.now(),
    private readonly getActivity?: (recordId: string) => { toolCalls?: number; tokens?: number } | undefined,
  ) {
    this.queuedAt = now;
    const ids = graph.version === 2 ? [] : Object.keys(graph.nodes);
    ids.forEach((id, i) => {
      this.index.set(id, i);
    });
    this.nextIndex = ids.length;
    for (const id of ids) {
      // Forward (non-loop) predecessors are the node's real dependencies.
      this.deps.set(
        id,
        graph.edges.filter(edge => edge.to === id && edge.loop === undefined).map(edge => edge.from),
      );
      const node = graph.nodes[id];
      this.presentation.set(id, { kind: node.type, name: node.name || id,
        connections: graph.edges.flatMap(edge => (edge.from === id || edge.to === id) && (edge.loop || edge.when)
          ? [{ binding: edge.from === id ? edge.to : edge.from, direction: edge.from === id ? "downstream" as const : "upstream" as const, kind: edge.loop ? "loop" as const : "conditional" as const }] : []),
      });
      this.agentType.set(id, node.type === "agent" ? node.agent : node.type);
      // Only agent / human_gate nodes carry a prompt; subgraph and expand nodes have none.
      if (node.type === "agent" || node.type === "human_gate") this.prompt.set(id, node.prompt);
    }
    // Downstream is the inverse of deps: each node lists the nodes it unblocks, so
    // the monitor can join a failure to its blast radius without re-walking edges.
    for (const id of ids) {
      for (const dep of this.deps.get(id) ?? []) {
        const list = this.dependents.get(dep) ?? [];
        list.push(id);
        this.dependents.set(dep, list);
      }
    }
    this.recomputeStages();

    // The run's total is known up front — every declared node — so the header
    // reads N/total from the first frame rather than growing as nodes appear.
    this.task.agentCount = Math.max(this.task.agentCount, ids.length);
  }

  /** Already-assigned progress/history identity; never allocate during artifact lookup. */
  nodeIndex(nodeId: string): number | undefined {
    return this.index.get(nodeId) ?? this.executionIndex.get(nodeId);
  }

  /** Register or enrich a materialized node before its first state update. Repeated registration is harmless. */
  registerNode(
    nodeId: string,
    node: GraphNode,
    metadata: { dependencies: string[]; phase?: FanoutPhase; instance?: NodeInstance; ordinal?: number; presentation?: GraphNodePresentation },
  ): void {
    if (this.registered.has(nodeId)) return;
    this.registered.add(nodeId);

    const preseeded = this.index.has(nodeId);
    const instance = metadata.instance;
    if (preseeded || instance || metadata.presentation) this.presentation.set(nodeId, metadata.presentation ?? {
      ...this.presentation.get(nodeId),
      kind: node.type,
      name: node.name || (node.type === "agent" ? node.agent : node.type.replaceAll("_", " ")),
      ...(instance?.parentInstanceId ? { parentInstanceId: instance.parentInstanceId } : {}),
      ...(instance?.iteration !== undefined ? { iteration: instance.iteration } : {}),
      ...(instance?.itemIndex !== undefined ? { itemIndex: instance.itemIndex, role: "item" } : {}),
    });
    if (metadata.instance) {
      const instance = metadata.instance;
      this.identities.set(nodeId, instance);
      // V2 rows are one persisted materialization roster, not regrouped topology stages.
      this.explicitPhase.set(nodeId, { index: 0, title: "Graph" });
      this.index.set(nodeId, instance.ordinal);
      this.nextIndex = Math.max(this.nextIndex, instance.ordinal + 1);
      this.executionIndex.set(instance.instanceId, instance.ordinal);
      this.labels.set(nodeId, [(node.name || (node.type === "agent" ? node.agent : node.type.replaceAll("_", " "))).replace(/[\r\n]/g, " "),
        ...(instance.iteration !== undefined ? [`iteration ${instance.iteration}`] : []),
        ...(instance.itemIndex !== undefined ? [`item ${instance.itemIndex + 1}`] : []),
      ].join(" · "));
    } else if (metadata.ordinal !== undefined) {
      this.index.set(nodeId, metadata.ordinal);
      this.nextIndex = Math.max(this.nextIndex, metadata.ordinal + 1);
    } else if (!preseeded) this.index.set(nodeId, this.nextIndex++);
    const dependencies = [...new Set([...(preseeded ? this.deps.get(nodeId) ?? [] : []), ...metadata.dependencies])];
    this.deps.set(nodeId, dependencies);
    const previousStage = this.stage.get(nodeId);
    const previousTitle = this.explicitPhase.get(nodeId)?.title ?? (previousStage !== undefined ? `Stage ${previousStage + 1}` : undefined);
    this.agentType.set(nodeId, node.type === "agent" ? node.agent : node.type);
    if (node.type === "agent" || node.type === "human_gate" || node.type === "fanout") {
      this.prompt.set(nodeId, node.prompt);
    }
    if (metadata.phase !== undefined && metadata.instance === undefined) this.explicitPhase.set(nodeId, metadata.phase);

    const changedNodeIds = new Set(this.recomputeStages());
    const stage = this.stage.get(nodeId) ?? 0;
    const title = this.explicitPhase.get(nodeId)?.title ?? `Stage ${stage + 1}`;
    if (previousStage !== undefined && (previousStage !== stage || previousTitle !== title)) changedNodeIds.add(nodeId);
    for (const dependency of dependencies) {
      const downstream = this.dependents.get(dependency) ?? [];
      if (!downstream.includes(nodeId)) downstream.push(nodeId);
      this.dependents.set(dependency, downstream);
      changedNodeIds.add(dependency);
    }
    const changed = [...changedNodeIds].flatMap(id => {
      const run = this.lastRun.get(id);
      return run === undefined ? [] : [this.entry(id, run, this.lastUpdateAt.get(id) ?? this.queuedAt)];
    });
    if (changed.length > 0) updateGraphRunProgressBatch(this.task, changed);
    this.task.agentCount = Math.max(this.task.agentCount, this.index.size);
  }

  update(nodeId: string, run: Readonly<NodeRun>, correlationOrNow?: ExecutionCorrelation | number, now?: number, presentation?: GraphNodePresentation): void {
    const correlation = typeof correlationOrNow === "number" ? undefined : correlationOrNow;
    const updatedAt = typeof correlationOrNow === "number" ? correlationOrNow : now ?? Date.now();
    if (correlation !== undefined) {
      if (run.activation !== correlation.activation || run.graphAttempt !== correlation.graphAttempt || run.currentExecutionAttemptId !== correlation.executionAttemptId) return;
      const current = this.current.get(nodeId);
      if (current === undefined || !matchesExecution(current, correlation)) {
        this.current.set(nodeId, correlation);
        this.resolved.delete(nodeId);
        this.lastCounts.delete(nodeId);
      }
    }
    if (presentation) this.presentation.set(nodeId, presentation);
    this.lastRun.set(nodeId, run);
    this.lastUpdateAt.set(nodeId, updatedAt);
    updateGraphRunProgressBatch(this.task, [this.entry(nodeId, run, updatedAt)]);
  }

  /**
   * Re-emit every running node whose live activity counts changed since the last emit.
   *
   * The counts (tool calls, tokens) climb during a run, but node entries otherwise
   * re-emit only on status transitions, so a periodic tick calls this to keep them live.
   */
  // ponytail: re-emit appends to the progress log per activity change; fine for normal runs, upgrade = in-place last-write.
  refresh(now: number = Date.now()): void {
    if (this.getActivity === undefined) return;
    const changed: GraphRunAgentEntry[] = [];
    for (const [nodeId, run] of this.lastRun) {
      if (run.status !== "running") continue;
      const recordId = this.resolved.get(nodeId)?.recordId;
      const act = recordId !== undefined ? this.getActivity(recordId) : undefined;
      const key = `${act?.toolCalls ?? ""}|${act?.tokens ?? ""}`;
      if (this.lastCounts.get(nodeId) === key) continue;
      this.lastCounts.set(nodeId, key);
      changed.push(this.entry(nodeId, run, now));
      this.lastUpdateAt.set(nodeId, now);
    }
    if (changed.length > 0) updateGraphRunProgressBatch(this.task, changed);
  }

  setResolved(nodeId: string, info: NodeResolvedInfo, correlation: ExecutionCorrelation, now: number = Date.now()): void {
    const current = this.current.get(nodeId);
    if (current === undefined || !matchesExecution(current, correlation)) return;
    // Merge: recordId and model/modelId arrive on separate `onResolved` calls, so a later
    // one must not clobber an earlier field from this execution.
    const prev = this.resolved.get(nodeId) ?? {};
    this.resolved.set(nodeId, {
      model: info.modelName ?? prev.model,
      modelId: info.modelId ?? prev.modelId,
      recordId: info.recordId ?? prev.recordId,
    });
    const run = this.lastRun.get(nodeId);
    if (run !== undefined) {
      this.lastUpdateAt.set(nodeId, now);
      updateGraphRunProgressBatch(this.task, [this.entry(nodeId, run, now)]);
    }
  }

  /** Recompute non-explicit topological stages after every dynamic registration. */
  private recomputeStages(): string[] {
    const previous = new Map([...this.index.keys()].map(id => [id, {
      stage: this.stage.get(id),
      title: this.explicitPhase.get(id)?.title ?? (this.stage.has(id) ? `Stage ${(this.stage.get(id) ?? 0) + 1}` : undefined),
    }]));
    this.stage.clear();
    const depthOf = (id: string, seen: Set<string>): number => {
      const explicit = this.explicitPhase.get(id);
      if (explicit !== undefined) {
        this.stage.set(id, explicit.index);
        return explicit.index;
      }
      const cached = this.stage.get(id);
      if (cached !== undefined) return cached;
      if (seen.has(id)) return 0;
      seen.add(id);
      const stage = (this.deps.get(id) ?? []).reduce(
        (max, dependency) => this.index.has(dependency) ? Math.max(max, depthOf(dependency, seen) + 1) : max,
        0,
      );
      seen.delete(id);
      this.stage.set(id, stage);
      return stage;
    };
    for (const id of this.index.keys()) depthOf(id, new Set());

    return [...this.index.keys()].filter(id => {
      const before = previous.get(id);
      const stage = this.stage.get(id) ?? 0;
      const title = this.explicitPhase.get(id)?.title ?? `Stage ${stage + 1}`;
      return before !== undefined && (before.stage !== stage || before.title !== title);
    });
  }

  private entry(nodeId: string, run: Readonly<NodeRun>, now: number): GraphRunAgentEntry {
    const deps = this.deps.get(nodeId) ?? [];
    const stage = this.stage.get(nodeId) ?? 0;
    const res = this.resolved.get(nodeId);
    // Live tool-call / token counts, read from the record once it has one. Queued nodes (no
    // recordId) add nothing; `toolCalls` keeps a real 0, `tokens` only shows once it is non-zero.
    const act = res?.recordId !== undefined && this.getActivity !== undefined ? this.getActivity(res.recordId) : undefined;
    const prompt = this.prompt.get(nodeId);
    const base: GraphRunAgentEntry = {
      type: "graph_run_agent",
      index: this.index.get(nodeId) ?? 0,
      label: this.labels.get(nodeId) ?? nodeId,
      nodeBinding: nodeId,
      presentation: this.presentation.get(nodeId),
      ...(this.identities.has(nodeId) ? {
        nodeKey: this.identities.get(nodeId)?.nodeKey,
        instanceId: this.identities.get(nodeId)?.instanceId,
        materializationOrdinal: this.identities.get(nodeId)?.ordinal,
      } : {}),
      state: "start",
      phaseIndex: stage,
      phaseTitle: this.explicitPhase.get(nodeId)?.title ?? `Stage ${stage + 1}`,
      agentType: this.agentType.get(nodeId),
      // ponytail: the pre-interpolation template (`${ref}` unresolved — P2 per ir.ts); good enough, upgrade = capture the resolved NodeSpawnRequest.prompt via onResolved.
      ...(prompt ? { promptPreview: promptPreview(prompt) } : {}),
      deps,
      dependents: this.dependents.get(nodeId) ?? [],
      queuedAt: this.queuedAt,
      ...(run.attempt > 0 ? { attempt: run.attempt } : {}),
      ...(run.attemptReason !== undefined ? { lastAttemptReason: run.attemptReason } : {}),
      ...(res?.model !== undefined ? { model: res.model } : {}),
      ...(res?.modelId !== undefined ? { modelId: res.modelId } : {}),
      ...(res?.recordId !== undefined ? { recordId: res.recordId } : {}),
      ...(act?.toolCalls !== undefined ? { toolCalls: act.toolCalls } : {}),
      ...(act?.tokens ? { tokens: act.tokens } : {}),
    };
    switch (run.status) {
      case "pending":
        return { ...base, blocked: true };
      case "running": {
        let start = this.runStart.get(nodeId);
        if (start === undefined || start.attempt !== run.attempt) {
          start = { at: now, attempt: run.attempt };
          this.runStart.set(nodeId, start);
        }
        return { ...base, startedAt: start.at, lastProgressAt: now };
      }
      case "completed":
        return { ...base, state: "done", startedAt: this.runStart.get(nodeId)?.at ?? now, lastProgressAt: now, resultPreview: resultText(run.output) };
      case "failed":
        return { ...base, state: "error", startedAt: this.runStart.get(nodeId)?.at ?? now, lastProgressAt: now, error: run.error };
      case "skipped":
        return { ...base, state: "error", skipped: true };
      default:
        return base;
    }
  }
}

/** Settle a graph run task from its result. */
export function completeGraphTask(task: GraphRunTask, result: RunGraphResult, now: number = Date.now()): void {
  task.control = undefined;
  task.status = result.status === "aborted" ? "killed" : result.status;
  // A typed graph declares its objective outcome by emitting a reserved graph output.
  // Unlike the script path (where a malformed envelope fails execution), the graph run has
  // already completed by the time outputs resolve, so a missing/malformed envelope is only a
  // presentation verdict: leave `task.outcome` undefined (defaulting to "Completed") and never
  // fail the run. Always strip the reserved key so it never leaks into the user-facing value.
  const outputs = { ...result.outputs };
  const declared = outputs[GRAPH_OUTCOME_KEY];
  if (isGraphRunOutcome(declared)) task.outcome = declared;
  delete outputs[GRAPH_OUTCOME_KEY];
  task.value = result.feedback && Object.keys(result.feedback).length > 0
    ? { outputs, feedback: result.feedback }
    : outputs;
  task.endTime = now;
  if (result.status === "failed") {
    const failed = Object.entries(result.nodes)
      .filter(([, node]) => node.status === "failed")
      .map(([id, node]) => `${id}: ${node.error ?? "failed"}`);
    task.error = failed.length > 0 ? failed.join("; ") : "Graph run failed.";
  }
}
