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

import { createHash } from "node:crypto";
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
  SUBAGENT_DECIMAL_RADIX,
  SUBAGENT_FOREGROUND_RENDER_CADENCE_MS,
  SUBAGENT_GROUP_NOTIFICATION_MAX_CHARS,
  SUBAGENT_INDIVIDUAL_NOTIFICATION_MAX_CHARS,
  SUBAGENT_MAX_GENERATION_TURNS,
  SUBAGENT_PING_TIMEOUT_MS,
  SUBAGENT_POLLED_RECENTLY_MS,
  SUBAGENT_POLL_INTERVAL_MS,
  SUBAGENT_RESULT_PREVIEW_LINES,
} from "../constants.js";
import { getAgentConversation, getDefaultMaxTurns, getGraceTurns, normalizeMaxTurns, setDefaultMaxTurns, setGraceTurns, steerAgent } from "../agent-runner.js";
import { BUILTIN_TOOL_NAMES, getAgentConfig, getAllTypes, getAvailableTypes, isValidType, registerAgents, resolveType } from "../agent-types.js";
import { registerRpcHandlers } from "../cross-extension-rpc.js";
import { emitCompactedContract, emitTerminalContract } from "../external-contract-adapter.js";
import { loadCustomAgentsWithDiagnostics } from "../custom-agents.js";
import { applyAndEmitLoaded, type SubagentsSettings, saveAndEmitChanged } from "../settings.js";
import { setToolDescriptionMode, getToolDescriptionMode, setScopeModels } from "../runtime-flags.js";
import { type ModelRegistry, parseModelChain, resolveModel } from "../model-resolver.js";
import { SUBAGENTS_READY, SUBAGENTS_STARTED } from "../../../lib/subagent-channels.js";
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
import { type AgentConfig, type AgentDefinitionDiagnostic, type AgentRecord, type NotificationDetails, type ResumeTargetV1, type SubagentType } from "../types.js";
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
import { formatLifetimeTokens } from "../usage.js";

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
  /** Total subagent cost (USD) accrued this session. Optional for cross-version interop. */
  getLifetimeCost?: () => number;
};

export type SupervisedAgentActivity = AgentActivity & {
  streamingDeltasSeen?: boolean;
  nonStreamingSince?: number;
};

type SubagentGlobal = typeof globalThis & Record<symbol, SubagentManagerBridge | undefined>;

function asSupervisedActivity(activity: AgentActivity | undefined): SupervisedAgentActivity | undefined {
  return activity;
}

function resolveSupervisionActivity(record: AgentRecord, fallback: AgentActivity | undefined): SupervisedAgentActivity | undefined {
  return record.run?.activity ?? asSupervisedActivity(fallback);
}

function readSessionSnapshot(sessionFile: string): Pick<ResumeTargetV1, "entryCount" | "activeLeafId" | "sessionSha256"> | undefined {
  try {
    const bytes = readFileSync(sessionFile);
    const rows = bytes.toString("utf8").trimEnd().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    const entries = rows.slice(1);
    const leaf = entries.at(-1);
    if (rows[0]?.type !== "session" || rows[0]?.version !== 3 || !leaf || typeof leaf.id !== "string") return undefined;
    return {
      entryCount: entries.length,
      activeLeafId: leaf.id,
      sessionSha256: createHash("sha256").update(bytes).digest("hex"),
    };
  } catch {
    return undefined;
  }
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
  const lt = record.lifetimeUsage;
  const totalTokens = lt ? lt.input + lt.output + lt.cacheWrite : 0;
  let contextPercent: number | null = null;
  try {
    if (record.session) {
      contextPercent = record.session.getSessionStats().contextUsage?.percent ?? null;
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
    contextPercent !== null ? `<context_percent>${Math.round(contextPercent)}</context_percent>` : null,
    `</task-notification>`,
  ].filter(Boolean).join('\n');
}


/** Build notification details for the custom message renderer. */
function buildNotificationDetails(record: AgentRecord, resultMaxLen: number, activity?: AgentActivity): NotificationDetails {
  const lt = record.lifetimeUsage;
  const totalTokens = lt ? lt.input + lt.output + lt.cacheWrite : 0;
  let contextPercent: number | null = null;
  try {
    if (record.session) {
      contextPercent = record.session.getSessionStats().contextUsage?.percent ?? null;
    }
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
    contextPercent,
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
  waitForAgentCompletionWithSupervision: (record: AgentRecord, signal?: AbortSignal) => Promise<void>;
  typeListText: string;
  compactTypeListText: string;
  syncSessionContext: (ctx: ExtensionContext | undefined) => void;
  setCurrentCtx: (ctx: ExtensionContext | undefined) => void;
  unsubRpcHandlers: () => void;
  releaseManager: () => void;
  clearBackgroundSupervision: () => void;
  persistResumeTargetSnapshot: (record: AgentRecord) => Promise<void>;
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

  const POLLED_RECENTLY_MS = SUBAGENT_POLLED_RECENTLY_MS;

  // Tracks whether the PARENT prompt loop is active. Children are raw SDK sessions
  // (createAgentSession/session.prompt) and never fire the parent's agent_start/agent_end,
  // so this reflects only the parent. Gates the idle completion-notification flush.
  let parentBusy = false;

  function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function persistResumeTargetSnapshot(record: AgentRecord): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const current = persistentRegistry.getResumeTarget(record.id);
      if (!current) return;
      const sessionSnapshot = readSessionSnapshot(record.sessionFile ?? current.sessionFile);
      const updated = await persistentRegistry.updateResumeTarget(
        record.id,
        { generation: current.generation, revision: current.revision },
        {
          ...(sessionSnapshot ?? {}),
          updatedAt: Date.now(),
          state: {
            status: record.status,
            resultConsumed: !!record.resultConsumed,
            notified: !!record.notified,
            toolUses: record.toolUses,
            lifetimeUsage: { ...(record.lifetimeUsage ?? current.state.lifetimeUsage) },
            lifetimeCost: record.lifetimeCost ?? current.state.lifetimeCost,
            compactionCount: record.compactionCount ?? current.state.compactionCount,
          },
        },
      );
      if (updated) return;
    }
  }


  function sendStaleAgentReminder(record: AgentRecord, idleMs: number, action: "steer" | "abort") {
    if (parentBusy || record.resultConsumed || record.suppressNotification) return;
    const activity = resolveSupervisionActivity(record, agentActivity.get(record.id));
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


  /** Helper: build event data for lifecycle events from an AgentRecord. */
  function buildEventData(record: AgentRecord) {
    const durationMs = record.completedAt ? record.completedAt - record.startedAt : Date.now() - record.startedAt;
    const tokens: string = record.lifetimeUsage
      ? formatLifetimeTokens(record.lifetimeUsage)
      : safeFormatTokens(record.session);
    let contextPercent: number | null = null;
    try {
      if (record.session) {
        contextPercent = record.session.getSessionStats().contextUsage?.percent ?? null;
      }
    } catch {
      /* unavailable */
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
      contextPercent,
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
      void persistResumeTargetSnapshot(record);
    }

    // Widget cleanup — notification is consolidated at agent_end via emitCompletionNotificationsAtIdle.
    agentActivity.delete(record.id);
    widget.markFinished(record.id);
    widget.update();
  }, undefined, (record) => {
    // Emit started event when agent transitions to running (including from queue)
    pi.events.emit(SUBAGENTS_STARTED, {
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
    // Refresh queued → running transitions immediately.
    widget.update();
  }, (record, data) => {
    emitCompactedContract(pi, record, {
      reason: data.reason,
      tokensBefore: data.tokensBefore,
      compactionCount: record.compactionCount ?? 0,
    });
    void persistResumeTargetSnapshot(record);
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
      const activity = resolveSupervisionActivity(record, agentActivity.get(record.id));
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
    // Idle flush: surface completion notifications for agents that finished while the
    // parent sat idle between prompts (no agent_end fires then). notified-gated → one-shot.
    if (!parentBusy) emitCompletionNotificationsAtIdle();
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
    getLifetimeCost: () => manager.getLifetimeCost(),
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

  const { unsubPing: unsubPingRpc, unsubSpawn: unsubSpawnRpc, unsubStop: unsubStopRpc, unsubConsume: unsubConsumeRpc } = registerRpcHandlers({
    events: pi.events,
    pi,
    getCtx: () => currentCtx,
    manager: {
      spawn: (piRef, ctxRef, type, prompt, options) => {
        const resolvedType = requireSpawnableType(type);
        const id = manager.spawn(piRef as ExtensionAPI, ctxRef as ExtensionContext, resolvedType, prompt, options);
        // RPC callers (including TaskExecute) do not execute the Agent tool's UI hooks.
        widget.ensureTimer();
        widget.update();
        return id;
      },
      abort: (id) => manager.abort(id),
      getRecord: (id) => manager.getRecord(id),
    },
  });

  // Broadcast readiness so extensions loaded after us can discover us
  pi.events.emit(SUBAGENTS_READY, {});



  // Live widget: show running agents above editor
  const widget = new AgentWidget(manager, agentActivity);

  function syncSessionContext(ctx: ExtensionContext | undefined) {
    currentCtx = ctx;
    if (!ctx?.hasUI) return;
    widget.setUICtx(ctx.ui as UICtx);
    widget.update();
  }




  // ---- Batch tracking for smart join mode ----

  // Apply persisted settings on startup and emit `subagents:settings_loaded`.
  applyAndEmitLoaded(
    {
      setMaxConcurrent: (n) => manager.setMaxConcurrent(n),
      setDefaultMaxTurns,
      setGraceTurns,
      setToolDescriptionMode: (mode) => setToolDescriptionMode(mode),
      setScopeModels: (on) => setScopeModels(on),
    },
    (event, payload) => pi.events.emit(event, payload),
  );
  // ---- agent_end: consolidated completion notifications ----
  function emitCompletionNotificationsAtIdle() {
    const pending = manager.listAgents().filter(r =>
      r.isBackground &&
      r.completedAt != null &&
      !r.resultConsumed &&
      !r.suppressNotification &&
      !r.notified &&
      !(r.lastPolledAt != null && (Date.now() - r.lastPolledAt) < POLLED_RECENTLY_MS),
    );
    if (pending.length === 0) return;

    let content: string;
    let details: NotificationDetails;

    if (pending.length === 1) {
      const first = pending[0];
      const notification = formatTaskNotification(first, SUBAGENT_INDIVIDUAL_NOTIFICATION_MAX_CHARS);
      const footer =
        (first.outputFile ? `\nFull transcript available at: ${first.outputFile}` : '') +
        (first.sessionFile ? `\nSession log: ${first.sessionFile}` : '');
      content = notification + footer;
      details = buildNotificationDetails(first, SUBAGENT_INDIVIDUAL_NOTIFICATION_MAX_CHARS, agentActivity.get(first.id));
    } else {
      const n = pending.length;
      const notifications = pending.map(r => formatTaskNotification(r, SUBAGENT_GROUP_NOTIFICATION_MAX_CHARS)).join('\n\n');
      const label = `${n} agent(s) finished`;
      content = `Background agent group completed: ${label}\n\n${notifications}\n\nUse get_subagent_result for full output.`;
      const [first, ...rest] = pending;
      details = buildNotificationDetails(first, SUBAGENT_GROUP_NOTIFICATION_MAX_CHARS, agentActivity.get(first.id));
      if (rest.length > 0) {
        details.others = rest.map(r => buildNotificationDetails(r, SUBAGENT_GROUP_NOTIFICATION_MAX_CHARS, agentActivity.get(r.id)));
      }
    }

    pi.sendMessage<NotificationDetails>({
      customType: "subagent-notification",
      content,
      display: true,
      details,
    }, { deliverAs: "followUp", triggerTurn: true });
    for (const r of pending) r.run?.publish({ kind: "notified" });
    for (const r of pending) void persistResumeTargetSnapshot(r);
  }


  /** Build the full type list text dynamically from the custom-agent registry. */
  const buildTypeListText = () => {
    const names = getAvailableTypes();
    const lines = names.map((name) => {
      const cfg = getAgentConfig(name);
      const modelSuffix = cfg?.model ? ` (${getModelLabelFromConfig(parseModelChain(cfg.model)[0]?.model ?? cfg.model)})` : "";
      return `- ${name}: ${cfg?.description ?? name}${modelSuffix}`;
    });
    return [
      ...lines,
      "",
      `Agents can be defined in .pi/agents/<name>.md (project) or ${getAgentDir()}/agents/<name>.md (global) — they are picked up automatically. Project-level agents override global ones.`,
    ].join("\n");
  };

  const firstSentence = (s: string): string => {
    const m = s.match(/^.*?[.!?](\s|$)/);
    return (m ? m[0] : s).trim();
  };

  /** Compact agent list: first-sentence-only descriptions, no model suffix, no footer. */
  const buildCompactTypeListText = () => {
    return getAvailableTypes()
      .map((name) => {
        const cfg = getAgentConfig(name);
        return `- ${name}: ${firstSentence(cfg?.description ?? name)}`;
      })
      .join("\n");
  };

  const typeListText = buildTypeListText();
  const compactTypeListText = buildCompactTypeListText();

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
      const activity = resolveSupervisionActivity(record, agentActivity.get(record.id));
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
    unsubConsumeRpc();
  };
  const releaseManager = () => { delete subagentGlobal[managerKey]; };
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
    waitForAgentCompletionWithSupervision,
    typeListText,
    compactTypeListText,
    syncSessionContext,
    setCurrentCtx,
    unsubRpcHandlers,
    releaseManager,
    clearBackgroundSupervision,
    persistResumeTargetSnapshot,
  };

  // ---- Wire tool surface, renderers, message/lifecycle handlers, and cleanup ----
  registerSubagentRenderers(runtimeContext);
  registerAgentTool(runtimeContext);
  registerGetSubagentResultTool(runtimeContext);
  registerSteerSubagentTool(runtimeContext);
  registerSubagentMessageHandlers(runtimeContext);
  registerCleanup(runtimeContext);
  registerAgentsCommand(runtimeContext);
  pi.on("agent_start", () => { parentBusy = true; });
  pi.on("agent_end", () => { parentBusy = false; emitCompletionNotificationsAtIdle(); });
}
