import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { GroupJoinManager } from "./group-join.js";
import { getStatusNote } from "./status-note.js";
import type { AgentRecord, JoinMode, NotificationDetails } from "./types.js";
import type { AgentActivity, AgentWidget } from "./ui/agent-widget.js";
import type { FleetList } from "./ui/fleet-list.js";
import { getLifetimeTotal, getSessionContextPercent } from "./usage.js";

/** Human-readable status label for agent completion. */
function getStatusLabel(status: string, error?: string): string {
  switch (status) {
    case "error": return `Error: ${error ?? "unknown"}`;
    case "aborted": return "Aborted (max turns exceeded)";
    case "steered": return "Wrapped up (turn limit)";
    case "stopped": return "Stopped";
    default: return "Done";
  }
}

/** Escape XML special characters to prevent injection in structured notifications. */
function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Format a structured task notification matching Claude Code's <task-notification> XML. */
function formatTaskNotification(record: AgentRecord, resultMaxLen: number): string {
  const status = getStatusLabel(record.status, record.error);
  const durationMs = record.completedAt ? record.completedAt - record.startedAt : 0;
  const totalTokens = getLifetimeTotal(record.lifetimeUsage);
  const contextPercent = getSessionContextPercent(record.session);
  const ctxXml = contextPercent !== null ? `<context_percent>${Math.round(contextPercent)}</context_percent>` : "";
  const compactXml = record.compactionCount ? `<compactions>${record.compactionCount}</compactions>` : "";

  const resultPreview = record.result
    ? record.result.length > resultMaxLen
      ? record.result.slice(0, resultMaxLen) + "\n...(truncated, use get_subagent_result for full output)"
      : record.result
    : "No output.";

  return [
    `<task-notification>`,
    `<task-id>${record.id}</task-id>`,
    record.toolCallId ? `<tool-use-id>${escapeXml(record.toolCallId)}</tool-use-id>` : null,
    record.outputFile ? `<output-file>${escapeXml(record.outputFile)}</output-file>` : null,
    `<status>${escapeXml(status)}</status>`,
    `<summary>Agent "${escapeXml(record.description)}" ${record.status}${getStatusNote(record.status)}</summary>`,
    `<result>${escapeXml(resultPreview)}</result>`,
    `<usage><total_tokens>${totalTokens}</total_tokens><tool_uses>${record.toolUses}</tool_uses>${ctxXml}${compactXml}<duration_ms>${durationMs}</duration_ms></usage>`,
    `</task-notification>`,
  ].filter(Boolean).join('\n');
}

/** Build notification details for the custom message renderer. */
function buildNotificationDetails(record: AgentRecord, resultMaxLen: number, activity?: AgentActivity): NotificationDetails {
  const totalTokens = getLifetimeTotal(record.lifetimeUsage);
  return {
    id: record.id,
    description: record.description,
    status: record.status,
    toolUses: record.toolUses,
    turnCount: activity?.turnCount ?? 0,
    maxTurns: activity?.maxTurns,
    totalTokens,
    durationMs: record.completedAt ? record.completedAt - record.startedAt : 0,
    outputFile: record.outputFile,
    error: record.error,
    resultPreview: record.result
      ? record.result.length > resultMaxLen
        ? `${record.result.slice(0, resultMaxLen)}\n… ${record.result.length - resultMaxLen} character${record.result.length - resultMaxLen === 1 ? "" : "s"} omitted · full output: ${record.outputFile ? "transcript below" : `get_subagent_result(agent_id: "${record.id}")`}`
        : record.result
      : "No output.",
  };
}

/** The activation's shared live-agent presentation. */
export interface AgentPresentation {
  readonly activity: Map<string, AgentActivity>;
  readonly widget: AgentWidget;
  readonly fleet: FleetList;
}

const NUDGE_HOLD_MS = 200;
// Observe queued completion before its held notification can fire.
export const QUEUE_WAIT_POLL_MS = Math.floor(NUDGE_HOLD_MS / 4);

export function createNotificationCoordinator(
  pi: ExtensionAPI,
  getRecord: (id: string) => AgentRecord | undefined,
  presentation: AgentPresentation,
) {
  const pendingNudges = new Map<string, ReturnType<typeof setTimeout>>();
  let currentBatchAgents: { id: string; joinMode: JoinMode }[] = [];
  let batchFinalizeTimer: ReturnType<typeof setTimeout> | undefined;
  let batchCounter = 0;

  function schedule(key: string, send: () => void, delay = NUDGE_HOLD_MS) {
    cancel(key);
    pendingNudges.set(key, setTimeout(() => {
      pendingNudges.delete(key);
      try { send(); } catch { /* ignore stale completion side-effect errors */ }
    }, delay));
  }

  function cancel(key: string) {
    const timer = pendingNudges.get(key);
    if (timer != null) {
      clearTimeout(timer);
      pendingNudges.delete(key);
    }
  }

  function emitIndividualNudge(record: AgentRecord) {
    if (record.resultConsumed) return;
    const notification = formatTaskNotification(record, 500);
    const footer = record.outputFile ? `\nFull transcript available at: ${record.outputFile}` : '';
    pi.sendMessage<NotificationDetails>({
      customType: "subagent-notification",
      content: notification + footer,
      display: true,
      details: buildNotificationDetails(record, 500, presentation.activity.get(record.id)),
    }, { deliverAs: "followUp", triggerTurn: true });
  }

  function markFinished(record: AgentRecord) {
    presentation.activity.delete(record.id);
    presentation.widget.markFinished(record.id);
    presentation.fleet.onAgentFinished(record.id);
  }

  function sendIndividualNudge(record: AgentRecord) {
    markFinished(record);
    schedule(record.id, () => emitIndividualNudge(record));
    presentation.widget.update();
  }

  const groupJoin = new GroupJoinManager(
    (records, partial) => {
      for (const r of records) markFinished(r);
      const groupKey = `group:${records.map(r => r.id).join(",")}`;
      schedule(groupKey, () => {
        const unconsumed = records.filter(r => !r.resultConsumed);
        if (unconsumed.length === 0) { presentation.widget.update(); return; }
        const notifications = unconsumed.map(r => formatTaskNotification(r, 300)).join('\n\n');
        const label = partial
          ? `${unconsumed.length} agent(s) finished (partial — others still running)`
          : `${unconsumed.length} agent(s) finished`;
        const [first, ...rest] = unconsumed;
        const details = buildNotificationDetails(first, 300, presentation.activity.get(first.id));
        if (rest.length > 0) {
          details.others = rest.map(r => buildNotificationDetails(r, 300, presentation.activity.get(r.id)));
        }
        pi.sendMessage<NotificationDetails>({
          customType: "subagent-notification",
          content: `Background agent group completed: ${label}\n\n${notifications}\n\nUse get_subagent_result for full output.`,
          display: true,
          details,
        }, { deliverAs: "followUp", triggerTurn: true });
      });
      presentation.widget.update();
    },
    30_000,
  );

  function onComplete(record: AgentRecord) {
    if (record.resultConsumed) {
      markFinished(record);
      presentation.widget.update();
      return;
    }
    // The open debounce batch will pick up an already completed agent retroactively.
    if (currentBatchAgents.some(a => a.id === record.id)) {
      presentation.widget.update();
      return;
    }
    const result = groupJoin.onAgentComplete(record);
    if (result === 'pass') sendIndividualNudge(record);
    presentation.widget.update();
  }

  /** Finalize the current batch: if 2+ smart-mode agents, register as a group. */
  function finalizeBatch() {
    batchFinalizeTimer = undefined;
    const batchAgents = [...currentBatchAgents];
    currentBatchAgents = [];
    const smartAgents = batchAgents.filter(a => a.joinMode === 'smart' || a.joinMode === 'group');
    if (smartAgents.length >= 2) {
      const groupId = `batch-${++batchCounter}`;
      const ids = smartAgents.map(a => a.id);
      groupJoin.registerGroup(groupId, ids);
      for (const id of ids) {
        const record = getRecord(id);
        if (!record) continue;
        record.groupId = groupId;
        if (record.completedAt != null && !record.resultConsumed) {
          groupJoin.onAgentComplete(record);
        }
      }
    } else {
      for (const { id } of batchAgents) {
        const record = getRecord(id);
        if (record?.completedAt != null && !record.resultConsumed) sendIndividualNudge(record);
      }
    }
  }

  function track(id: string, joinMode: JoinMode | undefined) {
    if (joinMode == null || joinMode === 'async') {
      // Foreground/no join mode or explicit async — not part of any batch
    } else {
      currentBatchAgents.push({ id, joinMode });
      // Parallel tool calls dispatched across multiple ticks join the same batch.
      if (batchFinalizeTimer) clearTimeout(batchFinalizeTimer);
      batchFinalizeTimer = setTimeout(finalizeBatch, 100);
    }
  }

  function clearPending() {
    for (const timer of pendingNudges.values()) clearTimeout(timer);
    pendingNudges.clear();
  }

  return { schedule, cancel, onComplete, track, clearPending };
}
