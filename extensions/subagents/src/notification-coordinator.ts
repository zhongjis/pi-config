import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { GroupJoinManager } from "./group-join.js";
import { getStatusNote } from "./status-note.js";
import { turnCheckInNotice } from "./turn-ceiling.js";
import { type AgentRecord, agentExecutionKey, type JoinMode, type NotificationDetails } from "./types.js";
import type { AgentActivity } from "./ui/agent-format.js";
import type { FleetList } from "./ui/fleet-list.js";
import { getLifetimeTotal, getSessionContextPercent } from "./usage.js";
import { workNotesUri } from "./work-notes.js";

/** Human-readable status label for agent completion. */
function getStatusLabel(status: string, error?: string): string {
  switch (status) {
    case "error": return `Error: ${error ?? "unknown"}`;
    case "aborted": return "Interrupted";
    case "force_steered": return "Completed after turn-ceiling reminder";
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
  const notes = workNotesUri(record);

  return [
    `<task-notification>`,
    `<task-id>${record.id}</task-id>`,
    record.toolCallId ? `<tool-use-id>${escapeXml(record.toolCallId)}</tool-use-id>` : null,
    record.outputFile ? `<output-file>${escapeXml(record.outputFile)}</output-file>` : null,
    notes ? `<work-notes>${escapeXml(notes)}</work-notes>` : null,
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
  /** After an Esc-aborted run: follow-ups still post, but none starts a turn until the next turn starts. */
  let quiet = false;
  /** Session teardown: no new follow-up may be scheduled. */
  let closed = false;
  const parked = new Map<string, (wake: boolean) => void>();
  const completions = new Map<string, Completion>();
  /** Executions launched through `track`; only they receive check-in follow-ups. */
  const tracked = new Set<string>();
  let currentBatchAgents: { id: string; executionId?: string; joinMode: JoinMode }[] = [];
  let batchFinalizeTimer: ReturnType<typeof setTimeout> | undefined;
  let batchCounter = 0;

  /** `send` receives whether its follow-up may start a turn (`triggerTurn`). */
  function deliver(send: (wake: boolean) => void) {
    try { send(!quiet); } catch { /* ignore stale completion side-effect errors */ }
  }

  function schedule(key: string, send: (wake: boolean) => void, delay = NUDGE_HOLD_MS) {
    if (closed) return;
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
    quiet = false;
  }

  function release() {
    parking = false;
    const sends = [...parked.values()];
    parked.clear();
    for (const send of sends) deliver(send);
  }

  /** The run was aborted (Esc): post held follow-ups now and later ones without starting a turn. */
  function interrupt() {
    quiet = true;
    release();
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
    presentation.fleet.onAgentFinished(completion.id);
  }

  function sendIndividualNudge(completion: Completion) {
    markFinished(completion);
    const key = agentExecutionKey(completion);
    schedule(key, wake => {
      completions.delete(key);
      if (isConsumed(completion)) return;
      pi.sendMessage<NotificationDetails>({
        customType: "subagent-notification", ...completion.individual, display: true,
      }, { deliverAs: "followUp", triggerTurn: wake });
    });
  }

  const groupJoin = new GroupJoinManager<Completion>(
    (records, partial) => {
      for (const completion of records) markFinished(completion);
      const groupKey = `group:${records.map(agentExecutionKey).join(",")}`;
      schedule(groupKey, wake => {
        for (const completion of records) completions.delete(agentExecutionKey(completion));
        const unconsumed = records.filter(completion => !isConsumed(completion));
        if (unconsumed.length === 0) return;
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
        }, { deliverAs: "followUp", triggerTurn: wake });
      });
    },
    30_000,
  );

  function onComplete(record: AgentRecord) {
    tracked.delete(agentExecutionKey(record));
    const completion = capture(record);
    if (isConsumed(completion)) {
      markFinished(completion);
      completions.delete(agentExecutionKey(completion));
      return;
    }
    // Keep this exact completion through debounce, never re-read a resumed record.
    if (currentBatchAgents.some(agent => agentExecutionKey(agent) === agentExecutionKey(completion))) {
      return;
    }
    const result = groupJoin.onAgentComplete(completion);
    if (result === 'pass') sendIndividualNudge(completion);
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
    const executionId = getRecord(id)?.executionId;
    tracked.add(agentExecutionKey({ id, executionId }));
    if (joinMode == null || joinMode === 'async') return;
    currentBatchAgents.push({ id, executionId, joinMode });
    // Parallel tool calls dispatched across multiple ticks join the same batch.
    if (batchFinalizeTimer) clearTimeout(batchFinalizeTimer);
    batchFinalizeTimer = setTimeout(finalizeBatch, 100);
  }

  /** One held follow-up for a check-in no waiter observed; dropped once the Execution stops running. */
  function checkIn(record: AgentRecord, threshold: number) {
    const key = agentExecutionKey(record);
    if (!tracked.has(key)) return;
    schedule(`${key}:check-in`, wake => {
      const current = getRecord(record.id);
      if (!current || agentExecutionKey(current) !== key || current.status !== "running") return;
      const notice = turnCheckInNotice(current, threshold);
      pi.sendMessage<NotificationDetails>({
        customType: "subagent-notification", content: notice, display: true,
        details: { ...buildNotificationDetails(current, 0, current.activity), durationMs: Date.now() - current.startedAt, resultPreview: notice },
      }, { deliverAs: "followUp", triggerTurn: wake });
    });
  }

  /** Teardown: drop pending follow-ups and refuse new ones; completions keep settling during the drain. */
  function close() {
    closed = true;
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

  return { schedule, cancel, consume, onComplete, track, checkIn, close, hold, release, interrupt };
}
