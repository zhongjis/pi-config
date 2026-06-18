/**
 * pi-agents — A pi extension providing Claude Code-style autonomous sub-agents.
 *
 * Tools:
 *   Agent             — LLM-callable: spawn a sub-agent
 *   get_subagent_result  — LLM-callable: check background agent status/result
 *   steer_subagent       — LLM-callable: send a steering message to a running agent
 *
 * Commands:
 *   /agents                 — Interactive agent management menu
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { defineTool, type AgentToolResult, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { buildEjectedAgentMarkdown, buildGenerateAgentPrompt, buildManualAgentMarkdown } from "../agent-definition-authoring.js";
import { AgentManager } from "../agent-manager.js";
import {
  BACKGROUND_STALE_ABORT_AFTER_MS,
  BACKGROUND_STALE_STEER_AFTER_MS,
  BACKGROUND_SUPERVISION_INTERVAL_MS,
  SUBAGENT_BATCH_FINALIZE_DELAY_MS,
  SUBAGENT_DECIMAL_RADIX,
  SUBAGENT_FOREGROUND_RENDER_CADENCE_MS,
  SUBAGENT_GROUP_JOIN_MIN_AGENTS,
  SUBAGENT_GROUP_JOIN_TIMEOUT_MS,
  SUBAGENT_GROUP_NOTIFICATION_MAX_CHARS,
  SUBAGENT_INDIVIDUAL_NOTIFICATION_MAX_CHARS,
  SUBAGENT_MAX_GENERATION_TURNS,
  SUBAGENT_NUDGE_HOLD_MS,
  SUBAGENT_PING_TIMEOUT_MS,
  SUBAGENT_POLLED_RECENTLY_MS,
  SUBAGENT_POLL_INTERVAL_MS,
  SUBAGENT_RESULT_PREVIEW_LINES,
} from "../constants.js";
import { getAgentConversation, getDefaultMaxTurns, getGraceTurns, normalizeMaxTurns, setDefaultMaxTurns, setGraceTurns, steerAgent } from "../agent-runner.js";
import { BUILTIN_TOOL_NAMES, getAgentConfig, getAllTypes, getAvailableTypes, getDefaultAgentNames, getUserAgentNames, isValidType, registerAgents, resolveType } from "../agent-types.js";
import { registerRpcHandlers } from "../cross-extension-rpc.js";
import { emitTerminalContract } from "../external-contract-adapter.js";
import { loadCustomAgentsWithDiagnostics } from "../custom-agents.js";
import { GroupJoinManager } from "../group-join.js";
import { resolveAgentInvocationConfig, resolveJoinMode } from "../invocation-config.js";
import { applyAndEmitLoaded, type SubagentsSettings, saveAndEmitChanged } from "../settings.js";
import { type ModelRegistry, parseModelChain, resolveModel } from "../model-resolver.js";
import { createOutputFilePath, streamToOutputFile, writeInitialEntry } from "../output-file.js";
import { getRecoveredResultText } from "../result-recovery.js";
import {
  emitSupervisionAbortWarning,
  emitSupervisionCeilingHitWarning,
  getBackgroundSupervisionAction,
  parseBackgroundSupervisionMode,
  parseSubagentSupervisionCeilingMs,
  type BackgroundSupervisionReasonClass,
} from "../background-supervision.js";
import { type AgentConfig, type AgentDefinitionDiagnostic, type AgentRecord, type JoinMode, type NotificationDetails, type SubagentType } from "../types.js";
import { buildDelegationBlockedMessage, getCurrentDelegatorType, hasDelegationPolicy, resolveDelegationRequest } from "../delegation-policy.js";
import {
  type AgentActivity,
  type AgentDetails,
  AgentWidget,
  describeActivity,
  formatDuration,
  formatMs,
  formatTokens,
  getDisplayName,
  getPromptModeLabel,
  SPINNER,
  type UICtx,
} from "../ui/agent-widget.js";
import { renderSubagentSummary } from "../ui/summary-renderer.js";
import type { SubagentSummaryAgent, SubagentSummaryStatus } from "../ui/summary-renderer.js";
import { RenderScheduler } from "../ui/render-scheduler.js";
import { BG_AGENT_REGISTRY_ENTRY_TYPE, PersistentBgAgentRegistry, TASK_CLAIM_ENTRY_TYPE } from "./registry-persistence.js";
import { pandaWarn } from "../../../lib/warn.js";
import { registerAgentTool } from "../tools/agent.js";
import { registerGetSubagentResultTool } from "../tools/get_subagent_result.js";
import { registerSteerSubagentTool } from "../tools/steer_subagent.js";
import { registerSubagentRenderers } from "../ui-wiring/renderers.js";
import { registerSubagentMessageHandlers } from "../ui-wiring/messages.js";
import { registerAgentsCommand } from "../ui-wiring/commands.js";
import { registerCleanup } from "./cleanup.js";

// ---- Shared helpers ----
const SUBAGENT_SESSION_DIR_NAME = "subagent-sessions";
const supervisionActiveToolWarnings = new Set<string>();
const supervisionNonStreamingWarnings = new Set<string>();
const supervisionAbortWarnings = new Set<string>();

function safePathSegment(value: string | undefined): string {
  return (value ?? "unknown-session").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 128) || "unknown-session";
}

function getParentSessionId(ctx: ExtensionContext): string | undefined {
  const sessionManager = ctx.sessionManager as { getSessionId?: () => string | undefined } | undefined;
  return typeof sessionManager?.getSessionId === "function" ? sessionManager.getSessionId() : undefined;
}

function createSubagentSessionDir(parentSessionId: string | undefined): string {
  return join(getAgentDir(), SUBAGENT_SESSION_DIR_NAME, safePathSegment(parentSessionId));
}


type SubagentManagerBridge = {
  waitForAll: () => ReturnType<AgentManager["waitForAll"]>;
  hasRunning: () => ReturnType<AgentManager["hasRunning"]>;
  spawn: (...args: Parameters<AgentManager["spawn"]>) => ReturnType<AgentManager["spawn"]>;
  getRecord: AgentManager["getRecord"];
};

export type SupervisedAgentActivity = AgentActivity & {
  streamingDeltasSeen?: boolean;
  nonStreamingSince?: number;
};

type SubagentGlobal = typeof globalThis & Record<symbol, SubagentManagerBridge | undefined>;

function asSupervisedActivity(activity: AgentActivity | undefined): SupervisedAgentActivity | undefined {
  return activity;
}

/** Tool execute return value for a text response. */
export function textResult(msg: string, details?: AgentDetails): AgentToolResult<AgentDetails | undefined> {
  return { content: [{ type: "text", text: msg }], details };
}

/** Safe token formatting — wraps session.getSessionStats() in try-catch. */
export function safeFormatTokens(session: { getSessionStats(): { tokens: { total: number } } } | undefined): string {
  if (!session) return "";
  try {
    return formatTokens(session.getSessionStats().tokens.total);
  } catch (err) {
    void err;
    return "";
  }
}


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
  let totalTokens = 0;
  try {
    if (record.session) {
      const stats = record.session.getSessionStats();
      totalTokens = stats.tokens?.total ?? 0;
    }
  } catch (err) {
    void err;
    /* session stats unavailable */
  }

  const recoveredResult = getRecoveredResultText(record);
  const resultPreview = recoveredResult.length > resultMaxLen
    ? recoveredResult.slice(0, resultMaxLen) + "\n...(truncated, use get_subagent_result for full output)"
    : recoveredResult;

  return [
    `<task-notification>`,
    `<task-id>${record.id}</task-id>`,
    record.toolCallId ? `<tool-use-id>${escapeXml(record.toolCallId)}</tool-use-id>` : null,
    record.outputFile ? `<output-file>${escapeXml(record.outputFile)}</output-file>` : null,
    record.sessionFile ? `<session-file>${escapeXml(record.sessionFile)}</session-file>` : null,
    `<status>${escapeXml(status)}</status>`,
    `<summary>Agent "${escapeXml(record.description)}" ${record.status}</summary>`,
    `<result>${escapeXml(resultPreview)}</result>`,
    `<usage><total_tokens>${totalTokens}</total_tokens><tool_uses>${record.toolUses}</tool_uses><duration_ms>${durationMs}</duration_ms></usage>`,
    `</task-notification>`,
  ].filter(Boolean).join('\n');
}


/** Build notification details for the custom message renderer. */
function buildNotificationDetails(record: AgentRecord, resultMaxLen: number, activity?: AgentActivity): NotificationDetails {
  let totalTokens = 0;
  try {
    if (record.session) totalTokens = record.session.getSessionStats().tokens?.total ?? 0;
  } catch (err) {
    void err;
  }

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
    sessionFile: record.sessionFile,
    error: record.error,
    resultPreview: (() => {
      const recoveredResult = getRecoveredResultText(record);
      return recoveredResult.length > resultMaxLen
        ? recoveredResult.slice(0, resultMaxLen) + "…"
        : recoveredResult;
    })(),
  };
}


export function formatAgentDefinitionDiagnostic(diagnostic: AgentDefinitionDiagnostic): string {
  return `${diagnostic.severity.toUpperCase()} ${diagnostic.agentName} (${diagnostic.file}) field "${diagnostic.field}": ${diagnostic.message}`;
}

export function formatAgentDefinitionDiagnostics(diagnostics: AgentDefinitionDiagnostic[]): string {
  return diagnostics.map(formatAgentDefinitionDiagnostic).join("\n");
}

export function formatInvalidAgentDefinitionMessage(agentName: string, diagnostics: AgentDefinitionDiagnostic[]): string {
  const detail = formatAgentDefinitionDiagnostics(diagnostics);
  return `Agent type "${agentName}" is unavailable because its custom definition has invalid frontmatter.\n${detail}\nFix the frontmatter: tools is invalid/obsolete; use builtin_tools for built-in tools and extension_tools for extension/custom tools; denylist fields are invalid/obsolete.`;
}

export function stripModelDateSuffix(modelId: string): string {
  return modelId.replace(/-\d{8}$/, "");
}

/** Derive a short model label from a model string. */
export function getModelLabelFromConfig(model: string): string {
  // Strip provider prefix (e.g. "anthropic/claude-sonnet-4-6" → "claude-sonnet-4-6")
  const name = model.includes("/") ? model.split("/").pop()! : model;
  return stripModelDateSuffix(name);
}

/** Format the resolved runtime model as provider/model for widget display. */
export function getResolvedModelLabel(model?: { provider?: string; id?: string }): string | undefined {
  if (!model?.id) return undefined;
  return model.provider
    ? `${model.provider}/${stripModelDateSuffix(model.id)}`
    : stripModelDateSuffix(model.id);
}

export interface SubagentRuntimeContext {
  pi: ExtensionAPI;
  manager: AgentManager;
  widget: AgentWidget;
  agentActivity: Map<string, AgentActivity>;
  persistentRegistry: PersistentBgAgentRegistry;
  requireSpawnableType: (type: string) => string;
  reloadCustomAgents: () => void;
  getLatestDiagnostics: () => AgentDefinitionDiagnostic[];
  bindTurnAbortSignal: (signal?: AbortSignal) => void;
  getAbortSignal: (ctx: ExtensionContext) => AbortSignal | undefined;
  cancelNudge: (key: string) => void;
  waitForAgentCompletionWithSupervision: (record: AgentRecord, signal?: AbortSignal) => Promise<void>;
  enqueueBackgroundBatch: (id: string, joinMode: JoinMode) => void;
  getDefaultJoinMode: () => JoinMode;
  setDefaultJoinMode: (mode: JoinMode) => void;
  typeListText: string;
  syncSessionContext: (ctx: ExtensionContext | undefined) => void;
  setCurrentCtx: (ctx: ExtensionContext | undefined) => void;
  unsubRpcHandlers: () => void;
  releaseManager: () => void;
  clearPendingNudges: () => void;
  clearBackgroundSupervision: () => void;
}

export function registerSubagentRuntime(pi: ExtensionAPI, managerKey: symbol) {

  let latestAgentDefinitionDiagnostics: AgentDefinitionDiagnostic[] = [];

  function findDiagnosticsForAgent(agentName: string): AgentDefinitionDiagnostic[] {
    const lower = agentName.toLowerCase();
    return latestAgentDefinitionDiagnostics.filter(diagnostic => diagnostic.agentName.toLowerCase() === lower);
  }

  /** Reload custom agents from .pi/agents/*.md (called on init and each Agent invocation). */
  const reloadCustomAgents = () => {
    const result = loadCustomAgentsWithDiagnostics(process.cwd());
    latestAgentDefinitionDiagnostics = result.diagnostics;
    registerAgents(result.agents);
  };

  // Initial load
  reloadCustomAgents();

  // ---- Agent activity tracking + widget ----
  const agentActivity = new Map<string, AgentActivity>();

  // ---- Durable bg-agent registry + task-claim persistence (Phase 4 / Task 27) ----
  // appendEntry-backed, write-through-first. Rebuilt from the session log on session_start.
  const persistentRegistry = new PersistentBgAgentRegistry(pi);

  // ---- Cancellable pending notifications ----
  // Holds notifications briefly so get_subagent_result can cancel them
  // before they reach pi.sendMessage (fire-and-forget).
  const pendingNudges = new Map<string, ReturnType<typeof setTimeout>>();
  const NUDGE_HOLD_MS = SUBAGENT_NUDGE_HOLD_MS;
  const POLLED_RECENTLY_MS = SUBAGENT_POLLED_RECENTLY_MS;

  function scheduleNudge(key: string, send: () => void, delay = NUDGE_HOLD_MS) {
    cancelNudge(key);
    pendingNudges.set(key, setTimeout(() => {
      pendingNudges.delete(key);
      send();
    }, delay));
  }

  function cancelNudge(key: string) {
    const timer = pendingNudges.get(key);
    if (timer != null) {
      clearTimeout(timer);
      pendingNudges.delete(key);
    }
  }

  function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ---- Individual nudge helper (async join mode) ----
  function emitIndividualNudge(record: AgentRecord) {
    const recentlyPolled = record.lastPolledAt != null && (Date.now() - record.lastPolledAt) < POLLED_RECENTLY_MS;
    if (record.resultConsumed || recentlyPolled) return;  // re-check at send time

    const notification = formatTaskNotification(record, SUBAGENT_INDIVIDUAL_NOTIFICATION_MAX_CHARS);
    const footer =
      (record.outputFile ? `\nFull transcript available at: ${record.outputFile}` : '') +
      (record.sessionFile ? `\nSession log: ${record.sessionFile}` : '');

    pi.sendMessage<NotificationDetails>({
      customType: "subagent-notification",
      content: notification + footer,
      display: true,
      details: buildNotificationDetails(record, SUBAGENT_INDIVIDUAL_NOTIFICATION_MAX_CHARS, agentActivity.get(record.id)),
    }, { deliverAs: "followUp", triggerTurn: true });
  }

  function sendIndividualNudge(record: AgentRecord) {
    agentActivity.delete(record.id);
    widget.markFinished(record.id);
    scheduleNudge(record.id, () => emitIndividualNudge(record));
    widget.update();
  }

  function sendStaleAgentReminder(record: AgentRecord, idleMs: number, action: "steer" | "abort") {
    if (record.resultConsumed || record.suppressNotification) return;
    const activity = agentActivity.get(record.id);
    const idleSeconds = Math.round(idleMs / 1000);
    const currentActivity = activity ? describeActivity(activity.activeTools, activity.responseText) : "waiting";
    const transcript =
      (record.outputFile ? `\nTranscript: ${record.outputFile}` : "") +
      (record.sessionFile ? `\nSession: ${record.sessionFile}` : "");
    const actionText = action === "abort"
      ? "The agent was auto-stopped after prolonged inactivity."
      : "The agent was auto-steered to wrap up because it appears idle.";
    pi.sendMessage({
      customType: "subagent-notification",
      content: `Background agent may be stalled.\n\nAgent ID: ${record.id}\nType: ${getDisplayName(record.type)}\nDescription: ${record.description}\nIdle: ${idleSeconds}s\nCurrent activity: ${currentActivity}\n${actionText}${transcript}\n\nUse get_subagent_result to inspect the latest result, or steer_subagent to send explicit instructions.`,
      display: true,
    }, { deliverAs: "followUp", triggerTurn: true });
  }

  function warnSupervisionSkippedActiveTool(record: AgentRecord, idleMs: number, activity: AgentActivity) {
    if (idleMs < BACKGROUND_STALE_STEER_AFTER_MS || activity.activeTools.size === 0) return;
    const skippedAction = idleMs >= BACKGROUND_STALE_ABORT_AFTER_MS ? "abort" : "steer";
    const key = `${record.id}:${skippedAction}`;
    if (supervisionActiveToolWarnings.has(key)) return;
    supervisionActiveToolWarnings.add(key);
    pandaWarn("subagent.supervision.abort-skipped-active-tool", {
      agentId: record.id,
      skippedAction,
      idleMs,
      activeTools: [...activity.activeTools.values()],
    });
  }

  function warnSupervisionAbort(record: AgentRecord, idleMs: number, reasonClass: BackgroundSupervisionReasonClass) {
    const key = `${record.id}:${reasonClass}`;
    if (supervisionAbortWarnings.has(key)) return;
    supervisionAbortWarnings.add(key);
    emitSupervisionAbortWarning({ agentId: record.id, idleMs, reasonClass });
  }

  function warnSupervisionCeilingHit(record: AgentRecord, idleMs: number, ceilingMs: number) {
    emitSupervisionCeilingHitWarning({ agentId: record.id, idleMs, ceilingMs });
  }

  function warnSupervisionNonStreamingDisabled(record: AgentRecord, idleMs: number, activity: AgentActivity) {
    const key = `${record.id}:non-stream-disabled`;
    if (supervisionNonStreamingWarnings.has(key)) return;
    supervisionNonStreamingWarnings.add(key);
    asSupervisedActivity(activity)!.nonStreamingSince = Date.now();
    warnSupervisionAbort(record, idleMs, "non-stream-disabled");
  }

  // ---- Group join manager ----
  const groupJoin = new GroupJoinManager(
    (records, partial) => {
      for (const r of records) { agentActivity.delete(r.id); widget.markFinished(r.id); }

      const groupKey = `group:${records.map(r => r.id).join(",")}`;
      scheduleNudge(groupKey, () => {
        // Re-check at send time
        const unconsumed = records.filter(r => !r.resultConsumed);
        if (unconsumed.length === 0) { widget.update(); return; }

        const notifications = unconsumed.map(r => formatTaskNotification(r, SUBAGENT_GROUP_NOTIFICATION_MAX_CHARS)).join('\n\n');
        const label = partial
          ? `${unconsumed.length} agent(s) finished (partial — others still running)`
          : `${unconsumed.length} agent(s) finished`;

        const [first, ...rest] = unconsumed;
        const details = buildNotificationDetails(first, SUBAGENT_GROUP_NOTIFICATION_MAX_CHARS, agentActivity.get(first.id));
        if (rest.length > 0) {
          details.others = rest.map(r => buildNotificationDetails(r, SUBAGENT_GROUP_NOTIFICATION_MAX_CHARS, agentActivity.get(r.id)));
        }

        pi.sendMessage<NotificationDetails>({
          customType: "subagent-notification",
          content: `Background agent group completed: ${label}\n\n${notifications}\n\nUse get_subagent_result for full output.`,
          display: true,
          details,
        }, { deliverAs: "followUp", triggerTurn: true });
      });
      widget.update();
    },
    SUBAGENT_GROUP_JOIN_TIMEOUT_MS,
  );

  /** Helper: build event data for lifecycle events from an AgentRecord. */
  function buildEventData(record: AgentRecord) {
    const durationMs = record.completedAt ? record.completedAt - record.startedAt : Date.now() - record.startedAt;
    let tokens: { input: number; output: number; total: number } | undefined;
    try {
      if (record.session) {
        const stats = record.session.getSessionStats();
        tokens = {
          input: stats.tokens?.input ?? 0,
          output: stats.tokens?.output ?? 0,
          total: stats.tokens?.total ?? 0,
        };
      }
    } catch (err) {
      void err;
      /* session stats unavailable */
    }
    return {
      id: record.id,
      type: record.type,
      description: record.description,
      result: record.result,
      error: record.error,
      status: record.status,
      toolUses: record.toolUses,
      durationMs,
      tokens,
      outputFile: record.outputFile,
      sessionFile: record.sessionFile,
      sessionDir: record.sessionDir,
      parentSessionId: record.parentSessionId,
      toolCallId: record.toolCallId,
      modelLabel: record.modelLabel,
    };
  }

  // Background completion: route through group join or send individual nudge
  const manager = new AgentManager((record) => {
    // Emit the frozen external contract (subagents:* event + durable subagents:record).
    const eventData = buildEventData(record);
    emitTerminalContract(pi, record, eventData);

    // Durable bg-agent registry: persist the terminal transition (write-through-first).
    // recordAgent already emits a structured warning + leaves its cache unchanged on
    // append failure; swallow here so a persistence hiccup never blocks completion handling.
    if (record.isBackground) {
      try {
        persistentRegistry.recordAgent({
          id: record.id,
          parentSessionId: record.parentSessionId,
          status: record.status,
          claimedTaskIds: [],
          lastSeenTs: record.completedAt ?? Date.now(),
        });
      } catch { /* already warned; do not break completion handling */ }
    }

    // Skip notification if result was already consumed, is being synchronously waited on, intentionally suppressed, or parent polled recently
    const recentlyPolled = record.lastPolledAt != null && (Date.now() - record.lastPolledAt) < POLLED_RECENTLY_MS;
    if (record.resultConsumed || record.suppressNotification || (record.waitingConsumers ?? 0) > 0 || recentlyPolled) {
      agentActivity.delete(record.id);
      widget.markFinished(record.id);
      widget.update();
      return;
    }

    // If this agent is pending batch finalization (debounce window still open),
    // don't send an individual nudge — finalizeBatch will pick it up retroactively.
    if (currentBatchAgents.some(a => a.id === record.id)) {
      widget.update();
      return;
    }

    const result = groupJoin.onAgentComplete(record);
    if (result === 'pass') {
      sendIndividualNudge(record);
    }
    // 'held' → do nothing, group will fire later
    // 'delivered' → group callback already fired
    widget.update();
  }, undefined, (record) => {
    // Emit started event when agent transitions to running (including from queue)
    pi.events.emit("subagents:started", {
      id: record.id,
      type: record.type,
      description: record.description,
    });
    // Durable bg-agent registry: persist the running transition (write-through-first).
    if (record.isBackground) {
      try {
        persistentRegistry.recordAgent({
          id: record.id,
          parentSessionId: record.parentSessionId,
          status: record.status,
          claimedTaskIds: [],
          lastSeenTs: record.startedAt ?? Date.now(),
        });
      } catch { /* already warned; do not break started handling */ }
    }
  });

  const turnAbortSignals = new WeakSet<AbortSignal>();

  function getAbortSignal(ctx: ExtensionContext): AbortSignal | undefined {
    return (ctx as ExtensionContext & { signal?: AbortSignal }).signal;
  }

  function abortAgentsForTurnCancellation() {
    let hasActiveAgents = false;
    for (const record of manager.listAgents()) {
      if (record.status !== "running" && record.status !== "queued") continue;
      hasActiveAgents = true;
      record.suppressNotification = true;
      cancelNudge(record.id);
    }
    if (hasActiveAgents) manager.abortAll();
  }

  function bindTurnAbortSignal(signal?: AbortSignal) {
    if (!signal || turnAbortSignals.has(signal)) return;

    signal.addEventListener("abort", abortAgentsForTurnCancellation, { once: true });
    turnAbortSignals.add(signal);
  }

  async function superviseBackgroundAgents() {
    const now = Date.now();
    const supervisionMode = parseBackgroundSupervisionMode();
    const ceilingMs = parseSubagentSupervisionCeilingMs();
    for (const record of manager.listAgents()) {
      const activity = agentActivity.get(record.id);
      const { action, idleMs, reasonClass, markNonStreaming } = getBackgroundSupervisionAction({
        record,
        activity,
        now,
        mode: supervisionMode,
        ceilingMs,
      });
      if (supervisionMode === "v2" && activity) warnSupervisionSkippedActiveTool(record, idleMs, activity);
      if (markNonStreaming && activity) warnSupervisionNonStreamingDisabled(record, idleMs, activity);
      if (action === "none") continue;

      if (action === "steer") {
        record.lastSupervisionSteerAt = now;
        if (record.session) {
          try {
            await steerAgent(record.session, `You appear idle after ${Math.round(idleMs / 1000)}s. Wrap up with your best current answer now, or explicitly state what is blocking completion.`);
          } catch (err) {
            void err;
            /* ignore steering failures */
          }
        }
        sendStaleAgentReminder(record, idleMs, "steer");
        continue;
      }

      record.lastSupervisionAbortAt = now;
      record.error = record.error ?? `Auto-stopped after ${Math.round(idleMs / 1000)}s of inactivity.`;
      if (reasonClass === "ceiling") warnSupervisionCeilingHit(record, idleMs, ceilingMs);
      warnSupervisionAbort(record, idleMs, reasonClass ?? "token-idle");
      manager.abort(record.id);
      sendStaleAgentReminder(record, idleMs, "abort");
    }
  }

  const backgroundSupervisionTimer = setInterval(() => {
    void superviseBackgroundAgents();
  }, BACKGROUND_SUPERVISION_INTERVAL_MS);

  // Expose manager via Symbol.for() global registry for cross-package access.
  // Standard Node.js pattern for cross-package singletons (used by OpenTelemetry, etc.).
  const subagentGlobal = globalThis as SubagentGlobal;
  subagentGlobal[managerKey] = {
    waitForAll: () => manager.waitForAll(),
    hasRunning: () => manager.hasRunning(),
    spawn: (piRef, ctxRef, type, prompt, options) => {
      const resolvedType = requireSpawnableType(type);
      return manager.spawn(piRef, ctxRef, resolvedType, prompt, options);
    },
    getRecord: (id: string) => manager.getRecord(id),
  };

  function formatUnavailableAgentType(type: string): string {
    const diagnostics = findDiagnosticsForAgent(type);
    if (diagnostics.length > 0) return formatInvalidAgentDefinitionMessage(type, diagnostics);

    const availableTypes = getAvailableTypes();
    const availableText = availableTypes.length > 0 ? availableTypes.join(", ") : "none";
    return `Unknown or disabled agent type "${type}". Available types: ${availableText}.`;
  }

  function requireSpawnableType(type: string): string {
    reloadCustomAgents();
    const resolved = resolveType(type);
    if (!resolved || !isValidType(resolved)) throw new Error(formatUnavailableAgentType(type));
    return resolved;
  }

  // --- Cross-extension RPC via pi.events ---
  let currentCtx: ExtensionContext | undefined;

  const { unsubPing: unsubPingRpc, unsubSpawn: unsubSpawnRpc, unsubStop: unsubStopRpc } = registerRpcHandlers({
    events: pi.events,
    pi,
    getCtx: () => currentCtx,
    manager: {
      spawn: (piRef, ctxRef, type, prompt, options) => {
        const resolvedType = requireSpawnableType(type);
        return manager.spawn(piRef as ExtensionAPI, ctxRef as ExtensionContext, resolvedType, prompt, options);
      },
      abort: (id) => manager.abort(id),
    },
  });

  // Broadcast readiness so extensions loaded after us can discover us
  pi.events.emit("subagents:ready", {});



  // Live widget: show running agents above editor
  const widget = new AgentWidget(manager, agentActivity);

  function syncSessionContext(ctx: ExtensionContext | undefined) {
    currentCtx = ctx;
    if (!ctx?.hasUI) return;
    widget.setUICtx(ctx.ui as UICtx);
    widget.update();
  }




  // ---- Join mode configuration ----
  let defaultJoinMode: JoinMode = 'smart';
  function getDefaultJoinMode(): JoinMode { return defaultJoinMode; }
  function setDefaultJoinMode(mode: JoinMode) { defaultJoinMode = mode; }

  // ---- Batch tracking for smart join mode ----

  // Apply persisted settings on startup and emit `subagents:settings_loaded`.
  applyAndEmitLoaded(
    {
      setMaxConcurrent: (n) => manager.setMaxConcurrent(n),
      setDefaultMaxTurns,
      setGraceTurns,
      setDefaultJoinMode,
    },
    (event, payload) => pi.events.emit(event, payload),
  );
  // Collects background agent IDs spawned in the current turn for smart grouping.
  // Uses a debounced timer: each new agent resets the 100ms window so that all
  // parallel tool calls (which may be dispatched across multiple microtasks by the
  // framework) are captured in the same batch.
  let currentBatchAgents: { id: string; joinMode: JoinMode }[] = [];
  let batchFinalizeTimer: ReturnType<typeof setTimeout> | undefined;
  let batchCounter = 0;

  /** Finalize the current batch: if 2+ smart-mode agents, register as a group. */
  function finalizeBatch() {
    batchFinalizeTimer = undefined;
    const batchAgents = [...currentBatchAgents];
    currentBatchAgents = [];

    const smartAgents = batchAgents.filter(a => a.joinMode === 'smart' || a.joinMode === 'group');
    if (smartAgents.length >= SUBAGENT_GROUP_JOIN_MIN_AGENTS) {
      const groupId = `batch-${++batchCounter}`;
      const ids = smartAgents.map(a => a.id);
      groupJoin.registerGroup(groupId, ids);
      // Retroactively process agents that already completed during the debounce window.
      // Their onComplete fired but was deferred (agent was in currentBatchAgents),
      // so we feed them into the group now.
      for (const id of ids) {
        const record = manager.getRecord(id);
        if (!record) continue;
        record.groupId = groupId;
        if (record.completedAt != null && !record.resultConsumed && !record.suppressNotification) {
          groupJoin.onAgentComplete(record);
        }
      }
    } else {
      // No group formed — send individual nudges for any agents that completed
      // during the debounce window and had their notification deferred.
      for (const { id } of batchAgents) {
        const record = manager.getRecord(id);
        if (record?.completedAt != null && !record.resultConsumed && !record.suppressNotification) {
          sendIndividualNudge(record);
        }
      }
    }
  }

  /** Enqueue a smart/group background agent into the current spawn batch (debounced). */
  function enqueueBackgroundBatch(id: string, joinMode: JoinMode) {
    currentBatchAgents.push({ id, joinMode });
    // Debounce: reset timer on each new agent so parallel tool calls
    // dispatched across multiple event loop ticks are captured together
    if (batchFinalizeTimer) clearTimeout(batchFinalizeTimer);
    batchFinalizeTimer = setTimeout(finalizeBatch, SUBAGENT_BATCH_FINALIZE_DELAY_MS);
  }


  /** Build the full type list text dynamically from the custom-agent registry. */
  const buildTypeListText = () => {
    const defaultNames = getDefaultAgentNames();
    const userNames = getUserAgentNames();

    const defaultDescs = defaultNames.map((name) => {
      const cfg = getAgentConfig(name);
      const modelSuffix = cfg?.model ? ` (${getModelLabelFromConfig(parseModelChain(cfg.model)[0]?.model ?? cfg.model)})` : "";
      return `- ${name}: ${cfg?.description ?? name}${modelSuffix}`;
    });

    const customDescs = userNames.map((name) => {
      const cfg = getAgentConfig(name);
      return `- ${name}: ${cfg?.description ?? name}`;
    });

    return [
      "Default agents:",
      ...defaultDescs,
      ...(customDescs.length > 0 ? ["", "Custom agents:", ...customDescs] : []),
      "",
      `Custom agents can be defined in .pi/agents/<name>.md (project) or ${getAgentDir()}/agents/<name>.md (global) — they are picked up automatically. Project-level agents override global ones. Creating a .md file with the same name as a default agent overrides it.`,
    ].join("\n");
  };


  const typeListText = buildTypeListText();

  async function waitForAgentPoll(record: AgentRecord, signal?: AbortSignal): Promise<"settled" | "tick" | "aborted"> {
    if (signal?.aborted) return "aborted";

    let cleanupAbort = () => {};
    const abortPromise = signal
      ? new Promise<"aborted">((resolve) => {
          const onAbort = () => resolve("aborted");
          signal.addEventListener("abort", onAbort, { once: true });
          cleanupAbort = () => signal.removeEventListener("abort", onAbort);
        })
      : undefined;

    try {
      const waits: Promise<"settled" | "tick" | "aborted">[] = [
        record.promise!.then(() => "settled" as const, () => "settled" as const),
        delay(SUBAGENT_POLL_INTERVAL_MS).then(() => "tick" as const),
      ];
      if (abortPromise) waits.push(abortPromise);
      return await Promise.race(waits);
    } finally {
      cleanupAbort();
    }
  }

  async function waitForAgentCompletionWithSupervision(record: AgentRecord, signal?: AbortSignal) {
    let idleWrapUpSent = false;
    while (record.status === "running" && record.promise) {
      const activity = agentActivity.get(record.id);
      const supervisionMode = parseBackgroundSupervisionMode();
      const ceilingMs = parseSubagentSupervisionCeilingMs();
      const { action, idleMs, reasonClass } = getBackgroundSupervisionAction({
        record,
        activity,
        now: Date.now(),
        mode: supervisionMode,
        ceilingMs,
        ignoreWaiters: true,
      });
      if (supervisionMode === "v2" && activity) warnSupervisionSkippedActiveTool(record, idleMs, activity);
      // Preserve the non-streaming diagnostic; the unified decision's steer precedence
      // would otherwise mask it during a supervised wait.
      if (
        supervisionMode === "v2" &&
        activity &&
        idleMs >= BACKGROUND_STALE_ABORT_AFTER_MS &&
        asSupervisedActivity(activity)?.streamingDeltasSeen === false
      ) {
        warnSupervisionNonStreamingDisabled(record, idleMs, activity);
      }
      if (action === "abort") {
        record.lastSupervisionAbortAt = Date.now();
        record.error = record.error ?? `Auto-stopped after ${Math.round(idleMs / 1000)}s of inactivity.`;
        if (reasonClass === "ceiling") warnSupervisionCeilingHit(record, idleMs, ceilingMs);
        warnSupervisionAbort(record, idleMs, reasonClass ?? "token-idle");
        manager.abort(record.id);
        await waitForAgentPoll(record, signal);
        return;
      }
      if (action === "steer" && !idleWrapUpSent && record.session) {
        try {
          await steerAgent(record.session, `You appear idle after ${Math.round(idleMs / 1000)}s. Wrap up now with your best available answer, or explicitly state what is blocking completion.`);
          idleWrapUpSent = true;
        } catch (err) {
          void err;
          /* ignore steering failures during supervised wait */
        }
      }

      const outcome = await waitForAgentPoll(record, signal);
      if (outcome === "aborted") {
        abortAgentsForTurnCancellation();
        throw new Error("Agent wait aborted; stopped running subagents.");
      }
      if (outcome === "settled") return;
    }
  }

  // ---- Session context + diagnostics accessors (shared with extracted modules) ----
  const setCurrentCtx = (c: ExtensionContext | undefined) => { currentCtx = c; };
  const getLatestDiagnostics = () => latestAgentDefinitionDiagnostics;

  // ---- Teardown primitives consumed by lifecycle/cleanup ----
  const unsubRpcHandlers = () => {
    unsubSpawnRpc();
    unsubStopRpc();
    unsubPingRpc();
  };
  const releaseManager = () => { delete subagentGlobal[managerKey]; };
  const clearPendingNudges = () => {
    for (const timer of pendingNudges.values()) clearTimeout(timer);
    pendingNudges.clear();
  };
  const clearBackgroundSupervision = () => { clearInterval(backgroundSupervisionTimer); };

  // ---- Build the shared runtime context ----
  const runtimeContext: SubagentRuntimeContext = {
    pi,
    manager,
    widget,
    agentActivity,
    persistentRegistry,
    requireSpawnableType,
    reloadCustomAgents,
    getLatestDiagnostics,
    bindTurnAbortSignal,
    getAbortSignal,
    cancelNudge,
    waitForAgentCompletionWithSupervision,
    enqueueBackgroundBatch,
    getDefaultJoinMode,
    setDefaultJoinMode,
    typeListText,
    syncSessionContext,
    setCurrentCtx,
    unsubRpcHandlers,
    releaseManager,
    clearPendingNudges,
    clearBackgroundSupervision,
  };

  // ---- Wire tool surface, renderers, message/lifecycle handlers, and cleanup ----
  registerSubagentRenderers(runtimeContext);
  registerAgentTool(runtimeContext);
  registerGetSubagentResultTool(runtimeContext);
  registerSteerSubagentTool(runtimeContext);
  registerSubagentMessageHandlers(runtimeContext);
  registerCleanup(runtimeContext);
  registerAgentsCommand(runtimeContext);
}
