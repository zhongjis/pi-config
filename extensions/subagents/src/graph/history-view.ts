import type { GraphHistoryRun } from "./history.js";
import type { WorkflowEntry } from "./progress.js";
import type { WorkflowTask } from "./task.js";

export const HISTORY_DISCLOSURE = "History snapshot · read-only · content not retained";
export const HISTORY_DETAIL = "Details were not retained in history.";

/** UI-only adapter, with no runtime control, abort signal, or conversation handle. */
export interface HistoricalWorkflow {
  type: "history";
  id: string;
  workflowName: string;
  status: GraphHistoryRun["status"];
  startTime: number;
  endTime: number;
  totalPausedMs: number;
  agentCount: number;
  workflowProgress: WorkflowEntry[];
  meta: { name: string; description: string; phases: { title: string }[] };
  history: { omittedNodeCount: number; outcome?: GraphHistoryRun["outcome"] };
}
export type WorkflowRun = WorkflowTask | HistoricalWorkflow;

export function historyDisclosure(history: HistoricalWorkflow["history"]): string {
  return `${HISTORY_DISCLOSURE}${history.omittedNodeCount ? ` · ${history.omittedNodeCount} nodes omitted` : ""}${history.outcome ? ` · Outcome ${history.outcome}` : ""}`;
}

function historyView(run: GraphHistoryRun): HistoricalWorkflow {
  const titles = new Map(run.phases.map(phase => [phase.index, phase.title]));
  return {
    type: "history", id: run.id, workflowName: run.name, status: run.status,
    startTime: run.startTime, endTime: run.endTime, totalPausedMs: run.totalPausedMs, agentCount: run.agentCount,
    history: { omittedNodeCount: run.omittedNodeCount, outcome: run.outcome },
    meta: { name: run.name, description: "", phases: run.phases.map(phase => ({ title: phase.title })) },
    workflowProgress: [
      ...run.phases.map(phase => ({ type: "workflow_phase" as const, ...phase })),
      ...run.nodes.map(node => ({
        ...node, type: "workflow_agent" as const, phaseTitle: node.phaseIndex === undefined ? undefined : titles.get(node.phaseIndex),
        // Static UI copy, never persisted content or a promise of future live detail.
        promptPreview: HISTORY_DETAIL, resultPreview: HISTORY_DETAIL,
        ...(node.state === "error" ? { error: HISTORY_DETAIL } : {}),
        dependents: run.nodes.filter(other => other.deps.includes(node.label)).map(other => other.label),
      })),
    ],
  };
}

/** One merge seam for both inspectors. Live objects always win, regardless of time. */
export function mergeWorkflowRuns(live: Iterable<WorkflowTask>, history: readonly GraphHistoryRun[]): ReadonlyMap<string, WorkflowRun> {
  const merged = new Map<string, WorkflowRun>();
  for (const task of live) merged.set(task.id, task);
  for (const run of history) if (!merged.has(run.id)) merged.set(run.id, historyView(run));
  return merged;
}
