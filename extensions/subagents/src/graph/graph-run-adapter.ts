/**
 * graph-run-adapter.ts — bridge a graph run into the workflow monitor.
 *
 * The `/agents → Graph runs` dialog, the fleet widget, the inline card and the
 * Herdr pane all render a {@link WorkflowTask}'s append-only progress log. A
 * graph run is node-shaped rather than script-shaped, so this maps each node's
 * {@link NodeRun} state onto a `workflow_agent` progress entry (keyed by a stable
 * per-node index, last-write-wins) — which is exactly what those surfaces already
 * know how to collapse and draw. Each node row carries its incoming dependencies
 * so the roster reads as a graph, not a flat list.
 *
 * Keeping this in one adapter means the monitor stays unaware it is showing a
 * graph, and the graph runtime stays unaware of the monitor.
 */

import type { AgentGraph } from "./ir.js";
import type { NodeResolvedInfo } from "./node-host.js";
import type { WorkflowAgentEntry } from "./progress.js";
import type { RunGraphResult } from "./run-graph.js";
import type { NodeRun } from "./scheduler.js";
import { updateWorkflowProgressBatch, type WorkflowTask } from "./task.js";

const PREVIEW = 200;
function preview(value: unknown): string {
  if (value === undefined) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length <= PREVIEW ? text : `${text.slice(0, PREVIEW - 1)}…`;
}

/**
 * Feeds a graph run's node updates into a workflow task's progress log.
 *
 * Node indices and dependency labels are computed once from the graph topology;
 * `update` then re-emits one entry per node state change.
 */
export class GraphRunReporter {
  private readonly index = new Map<string, number>();
  private readonly deps = new Map<string, string[]>();
  private readonly dependents = new Map<string, string[]>();
  private readonly agentType = new Map<string, string>();
  private readonly stage = new Map<string, number>();
  private readonly resolved = new Map<string, { model?: string; modelId?: string; recordId?: string }>();
  private readonly lastRun = new Map<string, Readonly<NodeRun>>();
  /** Last-emitted activity counts per node, so `refresh` only re-emits on a real change. */
  private readonly lastCounts = new Map<string, string>();
  private readonly queuedAt: number;

  constructor(
    private readonly task: WorkflowTask,
    graph: AgentGraph,
    now: number = Date.now(),
    private readonly getActivity?: (recordId: string) => { toolCalls?: number; tokens?: number } | undefined,
  ) {
    this.queuedAt = now;
    const ids = Object.keys(graph.nodes);
    ids.forEach((id, i) => {
      this.index.set(id, i);
    });
    for (const id of ids) {
      // Forward (non-loop) predecessors are the node's real dependencies.
      this.deps.set(
        id,
        graph.edges.filter(edge => edge.to === id && edge.loop === undefined).map(edge => edge.from),
      );
      const node = graph.nodes[id];
      this.agentType.set(id, node.type === "agent" ? node.agent : node.type);
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
    // Topological layer of each node (longest forward-dependency chain), so the
    // monitor groups nodes by DAG stage instead of a flat roster — a graph-shaped
    // view. Back-edges are already excluded from deps, so the recursion is finite;
    // the seen-set guards any stray forward cycle.
    const depthOf = (id: string, seen: Set<string>): number => {
      const cached = this.stage.get(id);
      if (cached !== undefined) return cached;
      if (seen.has(id)) return 0;
      seen.add(id);
      const d = (this.deps.get(id) ?? []).reduce((max, dep) => Math.max(max, depthOf(dep, seen) + 1), 0);
      seen.delete(id);
      this.stage.set(id, d);
      return d;
    };
    for (const id of ids) depthOf(id, new Set());

    // The run's total is known up front — every declared node — so the header
    // reads N/total from the first frame rather than growing as nodes appear.
    this.task.agentCount = Math.max(this.task.agentCount, ids.length);
  }

  update(nodeId: string, run: Readonly<NodeRun>, now: number = Date.now()): void {
    this.lastRun.set(nodeId, run);
    updateWorkflowProgressBatch(this.task, [this.entry(nodeId, run, now)]);
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
    const changed: WorkflowAgentEntry[] = [];
    for (const [nodeId, run] of this.lastRun) {
      if (run.status !== "running") continue;
      const recordId = this.resolved.get(nodeId)?.recordId;
      const act = recordId !== undefined ? this.getActivity(recordId) : undefined;
      const key = `${act?.toolCalls ?? ""}|${act?.tokens ?? ""}`;
      if (this.lastCounts.get(nodeId) === key) continue;
      this.lastCounts.set(nodeId, key);
      changed.push(this.entry(nodeId, run, now));
    }
    if (changed.length > 0) updateWorkflowProgressBatch(this.task, changed);
  }

  setResolved(nodeId: string, info: NodeResolvedInfo, now: number = Date.now()): void {
    // Merge: recordId and model/modelId arrive on separate `onResolved` calls, so a later
    // one must not clobber an earlier one's fields.
    const prev = this.resolved.get(nodeId) ?? {};
    this.resolved.set(nodeId, {
      model: info.modelName ?? prev.model,
      modelId: info.modelId ?? prev.modelId,
      recordId: info.recordId ?? prev.recordId,
    });
    const run = this.lastRun.get(nodeId);
    if (run !== undefined) updateWorkflowProgressBatch(this.task, [this.entry(nodeId, run, now)]);
  }

  private entry(nodeId: string, run: Readonly<NodeRun>, now: number): WorkflowAgentEntry {
    const deps = this.deps.get(nodeId) ?? [];
    const stage = this.stage.get(nodeId) ?? 0;
    const res = this.resolved.get(nodeId);
    // Live tool-call / token counts, read from the record once it has one. Queued nodes (no
    // recordId) add nothing; `toolCalls` keeps a real 0, `tokens` only shows once it is non-zero.
    const act = res?.recordId !== undefined && this.getActivity !== undefined ? this.getActivity(res.recordId) : undefined;
    const base: WorkflowAgentEntry = {
      type: "workflow_agent",
      index: this.index.get(nodeId) ?? 0,
      label: nodeId,
      state: "start",
      phaseIndex: stage,
      phaseTitle: `Stage ${stage + 1}`,
      agentType: this.agentType.get(nodeId),
      promptPreview: deps.length > 0 ? `depends on: ${deps.join(", ")}` : "entry node",
      deps,
      dependents: this.dependents.get(nodeId) ?? [],
      queuedAt: this.queuedAt,
      ...(run.attempt > 0 ? { attempt: run.attempt } : {}),
      ...(res?.model !== undefined ? { model: res.model } : {}),
      ...(res?.modelId !== undefined ? { modelId: res.modelId } : {}),
      ...(res?.recordId !== undefined ? { recordId: res.recordId } : {}),
      ...(act?.toolCalls !== undefined ? { toolCalls: act.toolCalls } : {}),
      ...(act?.tokens ? { tokens: act.tokens } : {}),
    };
    switch (run.status) {
      case "pending":
        return { ...base, blocked: true };
      case "running":
        return { ...base, startedAt: now, lastProgressAt: now };
      case "completed":
        return { ...base, state: "done", startedAt: now, lastProgressAt: now, resultPreview: preview(run.output) };
      case "failed":
        return { ...base, state: "error", startedAt: now, lastProgressAt: now, error: run.error };
      case "skipped":
        return { ...base, state: "error", skipped: true };
      default:
        return base;
    }
  }
}

/** Settle a workflow task from a graph run's result. */
export function completeGraphTask(task: WorkflowTask, result: RunGraphResult, now: number = Date.now()): void {
  task.control = undefined;
  task.status = result.status === "aborted" ? "killed" : result.status;
  task.value = result.outputs;
  task.endTime = now;
  if (result.status === "failed") {
    const failed = Object.entries(result.nodes)
      .filter(([, node]) => node.status === "failed")
      .map(([id, node]) => `${id}: ${node.error ?? "failed"}`);
    task.error = failed.length > 0 ? failed.join("; ") : "Graph run failed.";
  }
}
