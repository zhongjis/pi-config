import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { GroupJoinManager } from "./group-join.js";
import { getStatusNote } from "./status-note.js";
import { type AgentRecord, agentExecutionKey, type JoinMode, type NotificationDetails } from "./types.js";
import type { AgentActivity, AgentWidget } from "./ui/agent-widget.js";
import type { FleetList } from "./ui/fleet-list.js";
import { getLifetimeTotal, getSessionContextPercent } from "./usage.js";

/** Human-readable status label for agent completion. */
function getStatusLabel(status: string, error?: string): string {
  switch (status) {
    case "error": return `Error: ${error ?? "unknown"}`;
    case "aborted": return "Interrupted";
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
      ? record.result.slice(0, resultMaxLen) + "\n...(truncated, use get_agent_result for full output)"
      : record.result
    : "No output.";

  return [
    `<task-notification>`,
    `<task-id>${record.id}</task-id>`,
    record.toolCallId ? `<tool-use-id>${escapeXml(record.toolCallId)}</tool-use-id>` : null,
    record.outputFile ? `<output-file>${escapeXml(record.outputFile)}</output-file>` : null,
    `<status>${escapeXml(status)}</status>`,
    `<summary>Agent "${escapeXml(record.description)}" ${record.status}${getStatusNote(record.status, record.interruptionCause)}</summary>`,
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
    turnCount: record.turnCount ?? 0,
    maxTurns: activity?.maxTurns,
    totalTokens,
    durationMs: record.completedAt ? record.completedAt - record.startedAt : 0,
    outputFile: record.outputFile,
    error: record.error,
    ...(record.interruptionCause !== undefined ? { interruptionCause: record.interruptionCause } : {}),
    resultPreview: record.result
      ? record.result.length > resultMaxLen
        ? `${record.result.slice(0, resultMaxLen)}\n… ${record.result.length - resultMaxLen} character${record.result.length - resultMaxLen === 1 ? "" : "s"} omitted · full output: ${record.outputFile ? "transcript below" : `get_agent_result(run_id: "${record.id}")`}`
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

interface Completion {
  id: string;
  executionId?: string;
  consumed: boolean;
  individual: { content: string; details: NotificationDetails };
  grouped: { content: string; details: NotificationDetails };
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
  let parking = false;
  const parked = new Map<string, () => void>();
  const completions = new Map<string, Completion>();
  let currentBatchAgents: { id: string; executionId?: string; joinMode: JoinMode }[] = [];
  let batchFinalizeTimer: ReturnType<typeof setTimeout> | undefined;
  let batchCounter = 0;

  function deliver(send: () => void) {
    try { send(); } catch { /* ignore stale completion side-effect errors */ }
  }

  function schedule(key: string, send: () => void, delay = NUDGE_HOLD_MS) {
    cancel(key);
    pendingNudges.set(key, setTimeout(() => {
      pendingNudges.delete(key);
      if (parking) parked.set(key, send);
      else deliver(send);
    }, delay));
  }

  function cancel(key: string) {
    const timer = pendingNudges.get(key);
    if (timer != null) {
      clearTimeout(timer);
      pendingNudges.delete(key);
    }
    parked.delete(key);
  }

  function hold() {
    parking = true;
  }

  function release(flush = true) {
    parking = false;
    if (!flush) return;
    const sends = [...parked.values()];
    parked.clear();
    for (const send of sends) deliver(send);
  }

  function capture(record: AgentRecord): Completion {
    const key = agentExecutionKey(record);
    const existing = completions.get(key);
    if (existing) return existing;
    const activity = record.activity ?? presentation.activity.get(record.id);
    const footer = record.outputFile ? `\nFull transcript available at: ${record.outputFile}` : "";
    const completion: Completion = {
      id: record.id, executionId: record.executionId, consumed: record.resultConsumed === true,
      individual: { content: formatTaskNotification(record, 500) + footer, details: buildNotificationDetails(record, 500, activity) },
      grouped: { content: formatTaskNotification(record, 300), details: buildNotificationDetails(record, 300, activity) },
    };
    completions.set(key, completion);
    return completion;
  }

  function isConsumed(completion: Completion): boolean {
    const current = getRecord(completion.id);
    return completion.consumed || !!(current && agentExecutionKey(current) === agentExecutionKey(completion) && current.resultConsumed);
  }

  function consume(id: string, executionId = getRecord(id)?.executionId) {
    const key = agentExecutionKey({ id, executionId });
    const completion = completions.get(key);
    if (completion) completion.consumed = true;
    cancel(key);
    if (!currentBatchAgents.some(agent => agentExecutionKey(agent) === key)) completions.delete(key);
  }

  function markFinished(completion: Pick<AgentRecord, "id" | "executionId">) {
    const current = getRecord(completion.id);
    if (current && agentExecutionKey(current) !== agentExecutionKey(completion)) return;
    presentation.activity.delete(completion.id);
    presentation.widget.markFinished(completion.id);
    presentation.fleet.onAgentFinished(completion.id);
  }

  function sendIndividualNudge(completion: Completion) {
    markFinished(completion);
    const key = agentExecutionKey(completion);
    schedule(key, () => {
      completions.delete(key);
      if (isConsumed(completion)) return;
      pi.sendMessage<NotificationDetails>({
        customType: "subagent-notification", ...completion.individual, display: true,
      }, { deliverAs: "followUp", triggerTurn: true });
    });
    presentation.widget.update();
  }

  const groupJoin = new GroupJoinManager<Completion>(
    (records, partial) => {
      for (const completion of records) markFinished(completion);
      const groupKey = `group:${records.map(agentExecutionKey).join(",")}`;
      schedule(groupKey, () => {
        for (const completion of records) completions.delete(agentExecutionKey(completion));
        const unconsumed = records.filter(completion => !isConsumed(completion));
        if (unconsumed.length === 0) { presentation.widget.update(); return; }
        const notifications = unconsumed.map(completion => completion.grouped.content).join('\n\n');
        const label = partial
          ? `${unconsumed.length} agent(s) finished (partial — others still running)`
          : `${unconsumed.length} agent(s) finished`;
        const [first, ...rest] = unconsumed;
        const details = { ...first.grouped.details };
        if (rest.length > 0) details.others = rest.map(completion => completion.grouped.details);
        pi.sendMessage<NotificationDetails>({
          customType: "subagent-notification",
          content: `Background agent group completed: ${label}\n\n${notifications}\n\nUse get_agent_result for full output.`,
          display: true, details,
        }, { deliverAs: "followUp", triggerTurn: true });
      });
      presentation.widget.update();
    },
    30_000,
  );

  function onComplete(record: AgentRecord) {
    const completion = capture(record);
    if (isConsumed(completion)) {
      markFinished(completion);
      completions.delete(agentExecutionKey(completion));
      presentation.widget.update();
      return;
    }
    // Keep this exact completion through debounce, never re-read a resumed record.
    if (currentBatchAgents.some(agent => agentExecutionKey(agent) === agentExecutionKey(completion))) {
      presentation.widget.update();
      return;
    }
    const result = groupJoin.onAgentComplete(completion);
    if (result === 'pass') sendIndividualNudge(completion);
    presentation.widget.update();
  }

  /** Finalize the current batch: if 2+ smart-mode agents, register as a group. */
  function finalizeBatch() {
    batchFinalizeTimer = undefined;
    const batchAgents = currentBatchAgents;
    currentBatchAgents = [];
    const smartAgents = batchAgents.filter(agent => agent.joinMode === 'smart' || agent.joinMode === 'group');
    const grouped = smartAgents.length >= 2;
    const groupId = `batch-${++batchCounter}`;
    if (grouped) groupJoin.registerGroup(groupId, smartAgents.map(agentExecutionKey));
    for (const agent of batchAgents) {
      const key = agentExecutionKey(agent);
      const current = getRecord(agent.id);
      const matching = current && agentExecutionKey(current) === key ? current : undefined;
      if (grouped && matching) matching.groupId = groupId;
      const completion = completions.get(key);
      if (!completion) continue;
      if (grouped) groupJoin.onAgentComplete(completion);
      else sendIndividualNudge(completion);
    }
  }

  function track(id: string, joinMode: JoinMode | undefined) {
    if (joinMode == null || joinMode === 'async') return;
    currentBatchAgents.push({ id, executionId: getRecord(id)?.executionId, joinMode });
    // Parallel tool calls dispatched across multiple ticks join the same batch.
    if (batchFinalizeTimer) clearTimeout(batchFinalizeTimer);
    batchFinalizeTimer = setTimeout(finalizeBatch, 100);
  }

  function clearPending() {
    for (const timer of pendingNudges.values()) clearTimeout(timer);
    pendingNudges.clear();
    parked.clear();
    completions.clear();
    if (batchFinalizeTimer) clearTimeout(batchFinalizeTimer);
    batchFinalizeTimer = undefined;
    currentBatchAgents = [];
    groupJoin.dispose();
    parking = false;
  }

  return { schedule, cancel, consume, onComplete, track, clearPending, hold, release };
}
