/**
 * `Agent` tool — spawn (or resume) a sub-agent, foreground or background.
 *
 * Also owns the activity-tracking, detail-building, and subagent-session-dir
 * helpers that only the Agent tool consumes.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type AgentToolResult, type ExtensionContext, defineTool, getAgentDir, keyHint } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { renderToolCall, renderToolExpanded, renderToolSummary } from "../../../lib/tool-output.js";
import { prepareAgentRestoreRuntime, getDefaultMaxTurns, normalizeMaxTurns } from "../agent-runner.js";
import { getAgentConfig, getAvailableTypes } from "../agent-types.js";
import { SUBAGENT_FOREGROUND_RENDER_CADENCE_MS } from "../constants.js";
import { DELEGATION_POLICY_DENIED, formatDelegationPolicyDenial, resolvePersistedDelegationPolicy, type ResolvedDelegationPolicy } from "../delegation-policy.js";
import { resolveAgentInvocationConfig } from "../invocation-config.js";
import { resolveModel } from "../model-resolver.js";
import { createOutputFilePath, streamToOutputFile, writeInitialEntry } from "../output-file.js";
import { getRecoveredResultText } from "../result-recovery.js";
import { localUriHint } from "../local-uri-hint.js";
import { getResolvedModelLabel, safeFormatTokens, textResult } from "../lifecycle/supervision.js";
import { buildAgentToolDescription } from "../agent-tool-description.js";
import { getToolDescriptionMode, getScopeModels } from "../runtime-flags.js";
import { readEnabledModels, resolveEnabledModels, decideModelScope, type ModelRegistryRef } from "../enabled-models.js";
import { inspectPersistedChildSessionRecovery, SessionRestoreError, stableSha256, validatePersistedChildSession } from "../session-restoration.js";
import { SUBAGENTS_CREATED } from "../../../lib/subagent-channels.js";
import type { SubagentRuntimeContext, SupervisedAgentActivity } from "../lifecycle/supervision.js";
import { resumeTargetForValidation, type AgentLifecycleSnapshotInput } from "../lifecycle/agent-lifecycle-store.js";
import type { AgentRun, AgentRunTerminalEvent } from "../agent-run.js";
import {
  type AgentActivity,
  type AgentDetails,
  SPINNER,
  type UICtx,
  describeActivity,
  formatMs,
  getDisplayName,
  getPromptModeLabel,
} from "../ui/agent-widget.js";
import { RenderScheduler } from "../ui/render-scheduler.js";
import type { AgentInvocationStatus, AgentRecord, RestoreFailureReason, ResumeRuntimeSnapshot, ResumeTargetState, ResumeTargetV1, SubagentType } from "../types.js";
import { formatCost, formatTurns } from "../../../lib/widget-style.js";
import { formatLifetimeTokens } from "../usage.js";

const SUBAGENT_SESSION_DIR_NAME = "subagent-sessions";

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

const EMPTY_USAGE = { input: 0, output: 0, cacheWrite: 0 };

function placeholderRuntime(): ResumeRuntimeSnapshot {
  return {
    piVersion: "pending",
    model: { provider: "pending", id: "pending", api: "pending" },
    thinkingLevel: "off",
    promptMode: "replace",
    isolated: false,
    inheritContext: false,
    systemPromptHash: "0".repeat(64),
    resourcePolicyHash: "0".repeat(64),
    agentConfigHash: "0".repeat(64),
    extensionIdentities: [],
    activeToolNames: [],
  };
}

function captureResumeTarget(
  record: AgentRecord,
  runtime: ResumeRuntimeSnapshot,
  cwd: string,
  status: ResumeTargetState["status"] = record.status,
  candidate?: AgentRunTerminalEvent,
): AgentLifecycleSnapshotInput {
  if (!record.sessionFile || !record.sessionDir || !record.parentSessionId) {
    throw new Error("Agent session metadata is incomplete");
  }
  const bytes = readFileSync(record.sessionFile);
  const rows = bytes.toString("utf8").trimEnd().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  const header = rows[0];
  const entries = rows.slice(1);
  const leaf = entries.at(-1);
  if (header?.type !== "session" || header.version !== 3 || typeof header.id !== "string" ||
      !leaf || typeof leaf.id !== "string") {
    throw new Error("Agent session JSONL is not a valid v3 session");
  }
  const target: AgentLifecycleSnapshotInput = {
    id: record.id,
    parentSessionId: record.parentSessionId,
    sessionFile: record.sessionFile,
    sessionDir: record.sessionDir,
    childSessionId: header.id,
    entryCount: entries.length,
    activeLeafId: leaf.id,
    sessionSha256: stableSha256(bytes),
    type: record.type,
    description: record.description,
    cwd,
    isBackground: !!record.isBackground,
    createdAt: record.startedAt,
    updatedAt: Date.now(),
    runtime,
    state: {
      status,
      completionDisposition: record.completionDisposition ?? "clean",
      resultConsumed: !!record.resultConsumed,
      notified: !!record.notified,
      toolUses: record.toolUses,
      lifetimeUsage: { ...(record.lifetimeUsage ?? EMPTY_USAGE) },
      lifetimeCost: record.lifetimeCost ?? 0,
      compactionCount: record.compactionCount ?? 0,
    },
  };
  const validated = validatePersistedChildSession(resumeTargetForValidation(target), runtime);
  if (candidate?.kind === "completed") {
    authenticateCandidateResult(candidate, validated.authenticatedFinalAssistantText);
  }
  const completionDisposition = record.completionDisposition === "recovered" || validated.completionDisposition === "recovered"
    ? "recovered"
    : "clean";
  if (record.run) record.run.publish({ kind: "completion_disposition", disposition: completionDisposition });
  else record.completionDisposition = completionDisposition;
  return {
    ...target,
    sessionFile: validated.sessionFile,
    sessionDir: validated.sessionDir,
    entryCount: validated.entryCount,
    activeLeafId: validated.activeLeafId,
    sessionSha256: validated.sessionSha256,
    state: { ...target.state, completionDisposition },
  };
}

function terminalStatus(candidate: AgentRunTerminalEvent): ResumeTargetState["status"] {
  if (candidate.kind === "completed") return candidate.status;
  if (candidate.kind === "aborted") return candidate.status;
  return "error";
}

function authenticateCandidateResult(candidate: AgentRunTerminalEvent, authenticatedFinalAssistantText: string | undefined): void {
  const candidateResult = candidate.result?.trim();
  if (!candidateResult || candidateResult !== authenticatedFinalAssistantText) {
    throw new SessionRestoreError(
      "session_corrupt_or_unsupported",
      "Terminal result must exactly match the nonempty authenticated final assistant text",
    );
  }
}

function authenticatePendingTerminalSuffix(
  target: ResumeTargetV1,
  runtime: ResumeRuntimeSnapshot,
  candidate: AgentRunTerminalEvent,
): void {
  const { classification } = inspectPersistedChildSessionRecovery(target, runtime);
  const recoverable = classification.outcome === "clean_final_assistant" || classification.outcome === "completed_tool_chain";
  const reconstructedResult = classification.reconstructedResult?.trim();
  if (!recoverable || !reconstructedResult) {
    throw new SessionRestoreError(
      classification.failureReason ?? "unsafe_interrupted_operation",
      `Pending terminal suffix is unsafe for repair: ${classification.outcome}`,
    );
  }
  authenticateCandidateResult(candidate, reconstructedResult);
}

/**
 * Create an AgentActivity state and spawn callbacks for tracking tool usage.
 * Used by both foreground and background paths to avoid duplication.
 */
function createActivityTracker(maxTurns?: number, onStreamUpdate?: () => void) {
  const state: SupervisedAgentActivity = {
    activeTools: new Map(),
    toolUses: 0,
    turnCount: 1,
    maxTurns,
    tokens: "",
    responseText: "",
    session: undefined,
    lastProgressAt: Date.now(),
    streamingDeltasSeen: false,
  };

  const refreshActivity = () => {
    state.tokens = safeFormatTokens(state.session);
    onStreamUpdate?.();
  };

  const markProgress = () => {
    state.lastProgressAt = Date.now();
    refreshActivity();
  };

  const markStreamingProgress = () => {
    state.streamingDeltasSeen = true;
    state.nonStreamingSince = undefined;
    markProgress();
  };

  const callbacks = {
    onToolActivity: (activity: { type: "start" | "end"; toolName: string }) => {
      if (activity.type === "start") {
        state.activeTools.set(activity.toolName + "_" + Date.now(), activity.toolName);
      } else {
        for (const [key, name] of state.activeTools) {
          if (name === activity.toolName) { state.activeTools.delete(key); break; }
        }
        state.toolUses++;
      }
      if (activity.type === "start") markProgress();
      else refreshActivity();
    },
    onTextDelta: (_delta: string, fullText: string) => {
      state.responseText = fullText;
      markStreamingProgress();
    },
    onMessageStart: () => {
      state.streamingDeltasSeen = false;
      state.nonStreamingSince = undefined;
    },
    onTurnEnd: (turnCount: number) => {
      state.turnCount = turnCount;
      markProgress();
    },
    onProgress: markStreamingProgress,
    onSessionCreated: (session: any) => {
      state.session = session;
      markProgress();
    },
  };

  return { state, callbacks };
}

/**
 * Live AgentActivity view backed by an AgentRun (the single source of truth).
 * Getters read through to run.activity so the widget, supervision, get_subagent_result,
 * and /agents all observe live run state instead of a parallel tracker. The
 * nonStreamingSince setter routes supervision's only write back into the run.
 */
export function runActivityView(run: AgentRun): SupervisedAgentActivity {
  return {
    get activeTools() { return run.activity.activeTools; },
    get toolUses() { return run.activity.toolUses; },
    get turnCount() { return run.activity.turnCount; },
    get maxTurns() { return run.activity.maxTurns; },
    get tokens() { return safeFormatTokens(run.session as AgentActivity["session"]); },
    get responseText() { return run.activity.responseText; },
    get session() { return run.session as AgentActivity["session"]; },
    get lastProgressAt() { return run.activity.lastProgressAt; },
    get streamingDeltasSeen() { return run.activity.streamingDeltasSeen; },
    get nonStreamingSince() { return run.activity.nonStreamingSince; },
    set nonStreamingSince(v: number | undefined) { run.activity.nonStreamingSince = v; },
  };
}

/** Parenthetical status note for completed agent result text. */
function getStatusNote(status: string): string {
  switch (status) {
    case "aborted": return " (aborted — max turns exceeded, output may be incomplete)";
    case "steered": return " (wrapped up — reached turn limit)";
    case "stopped": return " (stopped by user)";
    default: return "";
  }
}

/** Build AgentDetails from a base + record-specific fields. */
function buildDetails(
  base: Pick<AgentDetails, "displayName" | "description" | "subagentType" | "modelName" | "tags">,
  record: { toolUses: number; startedAt: number; completedAt?: number; status: string; error?: string; id?: string; session?: any },
  activity?: AgentActivity,
  overrides?: Partial<AgentDetails>,
): AgentDetails {
  return {
    ...base,
    toolUses: record.toolUses,
    tokens: safeFormatTokens(record.session),
    turnCount: activity?.turnCount,
    maxTurns: activity?.maxTurns,
    durationMs: (record.completedAt ?? Date.now()) - record.startedAt,
    status: record.status as AgentDetails["status"],
    agentId: record.id,
    error: record.error,
    ...overrides,
  };
}

function buildInvocationFailureDetails(
  subagentType: string,
  description: string,
  failureReason: RestoreFailureReason,
  agentId?: string,
): AgentDetails {
  return {
    displayName: getDisplayName(subagentType),
    description,
    subagentType,
    toolUses: 0,
    tokens: "",
    durationMs: 0,
    status: "error",
    agentId,
    invocationStatus: "failed",
    failureReason,
  };
}

function buildDelegationPolicyDenialDetails(
  policy: ResolvedDelegationPolicy,
  requestedType: string,
  description: string,
): AgentDetails {
  return {
    displayName: getDisplayName(policy.decision.requestedType),
    description,
    subagentType: policy.decision.requestedType,
    toolUses: 0,
    tokens: "",
    durationMs: 0,
    status: "error",
    invocationStatus: "failed",
    category: DELEGATION_POLICY_DENIED,
    activeMode: policy.activeMode,
    requestedType,
    permittedTypes: policy.permittedTypes,
  };
}

function getResultText(result: AgentToolResult<AgentDetails>): string {
  return result.content
    .filter(part => part.type === "text")
    .map(part => part.text ?? "")
    .join("\n");
}

type AgentFailureOutputRecord = Pick<AgentRecord, "status" | "error" | "result" | "toolUses"> &
  Partial<Pick<AgentRecord, "outputFile" | "session">>;

export function formatAgentFailureOutput(
  record: AgentFailureOutputRecord,
  sessionLog = "",
  localHint = "",
): string {
  const error = record.error?.trim() || "Unknown error";
  const recoveredFailure = getRecoveredResultText({
    status: record.status,
    result: undefined,
    error: record.error,
    toolUses: record.toolUses,
    outputFile: record.outputFile,
    session: record.session,
  });
  const partialOutput = record.result?.trim();
  const failureDetails = partialOutput && partialOutput !== recoveredFailure
    ? `\n\nPartial output before the failure:\n${partialOutput}`
    : recoveredFailure
      ? `\n\n${recoveredFailure}`
      : "";
  return `Agent failed: ${error}${sessionLog}${failureDetails}${localHint}`;
}

function getStatusSummary(details: AgentDetails): string {
  if (details.status === "background") return "started";
  if (details.status === "steered") return "completed (turn limit)";
  if (details.status === "aborted") return "aborted";
  if (details.status === "error") return "error";
  return details.status;
}

function getFirstContentLine(text: string): string | undefined {
  return text.split("\n").map(line => line.trim()).find(Boolean);
}

function getActivitySummary(details: AgentDetails, isPartial?: boolean): string | undefined {
  if (!isPartial && details.status !== "running") return undefined;
  const activity = details.activity?.trim();
  return activity && activity !== "thinking" ? activity : undefined;
}

function getModelSummary(details: AgentDetails): string | undefined {
  const tags = details.tags?.map(tag => tag.replace(/^thinking:\s*/, "thinking ")) ?? [];
  const turns = details.turnCount != null ? formatTurns(details.turnCount, details.maxTurns) : undefined;
  const parts = [details.modelName, ...tags, turns].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

function getToolsSummary(details: AgentDetails): string | undefined {
  return details.toolUses && details.toolUses > 0 ? `${details.toolUses}` : undefined;
}

function getContextSummary(details: AgentDetails): string | undefined {
  return details.tokens?.trim() || undefined;
}

function sanitizeCollapsedText(text: string): string {
  return text
    .replace(/(?:[A-Za-z]:\\|\/)(?:[^\s/\\]+[/\\])+[^\s/\\]*/g, "[redacted path]")
    .split("\n")[0]
    .trim();
}

function renderExpandHint(): string {
  try {
    return keyHint("app.tools.expand", "to expand full result");
  } catch (error) {
    if (error instanceof Error && error.message === "Theme not initialized. Call initTheme() first.") {
      return "app.tools.expand to expand full result";
    }
    throw error;
  }
}

function renderSummaryLines(lines: string[], theme: Pick<ExtensionContext["ui"]["theme"], "bold" | "fg">): Text {
  return renderToolSummary(lines, theme, { expandable: true });
}

function formatPermittedTypes(types: string[] | undefined): string | undefined {
  if (!types || types.length === 0) return undefined;
  const visible = types.slice(0, 4);
  return visible.join(", ") + (types.length > visible.length ? ` +${types.length - visible.length}` : "");
}

function renderPolicyDenialSummary(details: AgentDetails, theme: Pick<ExtensionContext["ui"]["theme"], "bold" | "fg">) {
  const primary = theme.fg("error", "├─ status: denied");
  const detailLines = [
    "invocation: failed",
    `reason: ${details.category}`,
  ];
  const permitted = formatPermittedTypes(details.permittedTypes);
  if (permitted) detailLines.push(`permitted: ${permitted}`);
  const detail = detailLines.map(line => theme.fg("toolOutput", `├─ ${line}`));
  const hint = theme.fg("muted", `└─ ${renderExpandHint()}`);
  return renderToolExpanded([primary, ...detail, hint].join("\n"));
}

type AgentToolRenderArgs = {
  subagent_type?: string;
  description?: string;
  skills?: string[];
};

type AgentToolRenderContext = {
  args?: AgentToolRenderArgs;
};

function formatSkillsSummary(skills: string[] | undefined): string | undefined {
  if (!skills || skills.length === 0) return undefined;
  return `skills: ${skills.length} · ${skills.join(", ")}`;
}

function appendSkillsSection(rawText: string, skills: string[] | undefined): string {
  if (!skills || skills.length === 0) return rawText;
  return `${rawText}\n\nSkills\n${skills.map(skill => `- ${skill}`).join("\n")}`;
}

export function renderAgentToolCall(
  args: AgentToolRenderArgs,
  theme: Pick<ExtensionContext["ui"]["theme"], "bold" | "fg">,
 ): Text {
  const displayName = args.subagent_type ? getDisplayName(args.subagent_type) : "Agent";
  const target = [args.description, formatSkillsSummary(args.skills)].filter((value): value is string => Boolean(value)).join(" · ");
  return renderToolCall(displayName, target, theme);
}

export function renderAgentToolResult(
  result: AgentToolResult<AgentDetails>,
  options: { expanded?: boolean; isPartial?: boolean },
  theme: Pick<ExtensionContext["ui"]["theme"], "bold" | "fg">,
  context: AgentToolRenderContext = {},
) {
  const rawText = getResultText(result);
  if (options.expanded) return renderToolExpanded(appendSkillsSection(rawText, context.args?.skills));

  const details = result.details as AgentDetails | undefined;
  if (!details) return renderToolExpanded(rawText);
  if (details.category === DELEGATION_POLICY_DENIED) return renderPolicyDenialSummary(details, theme);

  const lines = [`status: ${getStatusSummary(details)}`];
  const activitySummary = getActivitySummary(details, options.isPartial);
  if (activitySummary) lines.push(`activity: ${activitySummary}`);
  if ((details.status === "background" || details.status === "queued") && details.agentId) {
    lines.push(`agent: ${details.agentId}`);
    lines.push("next: get_subagent_result wait:false");
  }
  const modelSummary = getModelSummary(details);
  if (modelSummary) lines.push(`model: ${modelSummary}`);
  const toolsSummary = getToolsSummary(details);
  if (toolsSummary) lines.push(`tools: ${toolsSummary}`);
  const contextSummary = getContextSummary(details);
  if (contextSummary) lines.push(`context: ${contextSummary}`);
  const resultPreview = getFirstContentLine(rawText);
  if (["completed", "steered", "stopped", "aborted"].includes(details.status) && resultPreview) lines.push(`result: ${sanitizeCollapsedText(resultPreview)}`);
  if (details.invocationStatus && details.invocationStatus !== "started_new") lines.push(`continuation: ${details.invocationStatus}`);
  if (details.failureReason) lines.push(`reason: ${details.failureReason}`);
  else if (details.status === "error" && details.error) lines.push(`error: ${sanitizeCollapsedText(details.error)}`);
  if (details.durationMs != null && details.durationMs > 0 && details.status !== "running" && details.status !== "background" && details.status !== "queued") lines.push(`duration: ${formatMs(details.durationMs)}`);
  return renderSummaryLines(lines, theme);
}

export function registerAgentTool(ctx: SubagentRuntimeContext): void {
  const {
    pi,
    widget,
    manager,
    agentActivity,
    persistentRegistry,
    requireSpawnableType,
    bindTurnAbortSignal,
    getAbortSignal,
    typeListText,
    compactTypeListText,
    consumeResult,
  } = ctx;

  pi.registerTool(defineTool({
    name: "Agent",
    label: "Agent",
    description: buildAgentToolDescription(getToolDescriptionMode(), typeListText, compactTypeListText),
    parameters: Type.Object({
      prompt: Type.String({
        description: "The task for the agent to perform.",
      }),
      description: Type.String({
        description: "A short (3-5 word) description of the task (shown in UI).",
      }),
      subagent_type: Type.String({
        description: "Specialized agent type. Runtime resolves current registry plus active-mode delegation policy; denied calls return current permitted targets.",
      }),
      model: Type.Optional(
        Type.String({
          description:
            'Optional model override. Accepts "provider/modelId" or fuzzy name (e.g. "haiku", "sonnet"). Omit to use the agent type\'s default.',
        }),
      ),
      thinking: Type.Optional(
        Type.String({
          description: "Thinking level: off, minimal, low, medium, high, xhigh. Overrides agent default.",
        }),
      ),
      max_turns: Type.Optional(
        Type.Number({
          description: "Optional explicit cap on agentic turns before wrap-up/stop. Leave unset for unlimited-by-default behavior.",
          minimum: 1,
        }),
      ),
      run_in_background: Type.Optional(
        Type.Boolean({
          description: "Requested result-delivery mode. Agent-type configuration takes precedence. Effective false waits for completion and returns the final result; effective true returns an agent ID immediately. If neither configuration nor this argument sets a value, the default is false.",
        }),
      ),
      resume: Type.Optional(
        Type.String({
          description: "Optional agent ID to continue. Prefer resuming an existing agent over starting duplicate follow-up work.",
        }),
      ),
      isolated: Type.Optional(
        Type.Boolean({
          description: "If true, agent gets no extension/MCP tools — only built-in tools.",
        }),
      ),
      inherit_context: Type.Optional(
        Type.Boolean({
          description: "If true, fork parent conversation into the agent. Default: false (fresh context).",
        }),
      ),
      skills: Type.Optional(
        Type.Array(Type.String(), {
          description: "Skill names to inject (preload full skill content) into the subagent for THIS call. Subagents cannot discover skills on their own, so inject any skill essential to the task. Names must exactly match the skill's `name`. Injected in addition to the agent's own preloaded skills. Inject only what the task needs — each skill adds its full body to the prompt.",
        }),
      ),
    }),

    // ---- Custom rendering: Claude Code style ----

    renderCall(args, theme) {
      return renderAgentToolCall(args, theme);
    },

    renderResult(result, options, theme, context) {
      return renderAgentToolResult(result as AgentToolResult<AgentDetails>, options, theme, context);
    },

    // ---- Execute ----

    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      // Ensure we have UI context for widget rendering
      widget.setUICtx(ctx.ui as UICtx);
      widget.setUsingSubscription(ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false);
      const parentSignal = getAbortSignal(ctx) ?? signal;
      bindTurnAbortSignal(parentSignal);
      const localHint = localUriHint(params.prompt);

      const currentParentSessionId = getParentSessionId(ctx) ?? "";
      const delegationEntries = ctx.sessionManager.getEntries();
      const enforceDelegationPolicy = (targetType: string) => {
        const delegation = resolvePersistedDelegationPolicy({
          entries: delegationEntries,
          availableTypes: getAvailableTypes(),
          requestedType: targetType,
        });
        return delegation.decision.allowed ? undefined : delegation;
      };

      // Explicit resume is routed before spawn-only config. It never falls back to spawn.
      if (params.resume) {
        const live = manager.getRecord(params.resume);
        const durable = persistentRegistry.getResumeTarget(params.resume);
        const targetType = live?.type ?? durable?.type;
        if (!targetType) {
          return textResult(
            `Failed to resume agent "${params.resume}": target_unknown.`,
            buildInvocationFailureDetails(params.subagent_type, params.description, "target_unknown", params.resume),
          );
        }
        if (targetType.toLocaleLowerCase() !== params.subagent_type.toLocaleLowerCase()) {
          return textResult(
            `Failed to resume agent "${params.resume}": scope_mismatch.`,
            buildInvocationFailureDetails(targetType, params.description, "scope_mismatch", params.resume),
          );
        }
        const targetParentSessionId = live?.parentSessionId ?? durable?.parentSessionId ?? "";
        if (targetParentSessionId !== currentParentSessionId) {
          return textResult(
            `Failed to resume agent "${params.resume}": scope_mismatch.`,
            buildInvocationFailureDetails(targetType, params.description, "scope_mismatch", params.resume),
          );
        }
        const denial = enforceDelegationPolicy(targetType);
        if (denial) {
          return textResult(
            formatDelegationPolicyDenial(denial, targetType),
            buildDelegationPolicyDenialDetails(denial, targetType, params.description),
          );
        }

        let restoreSession: (target: ResumeTargetV1) => Promise<any> = async () => {
          throw new Error("Durable restoration is unavailable without a persisted target");
        };
        let persistenceRuntime = durable?.runtime;
        let beginResume: ((target: ResumeTargetV1, record: AgentRecord) => Promise<void>) | undefined;
        let authenticatePendingTerminal: ((record: AgentRecord, candidate: AgentRunTerminalEvent) => Promise<void>) | undefined;
        let commitTerminal: ((record: AgentRecord, candidate: AgentRunTerminalEvent) => Promise<void>) | undefined;
        if (durable) {
          try {
            const restoredModel = ctx.modelRegistry.find(durable.runtime.model.provider, durable.runtime.model.id);
            const prepared = await prepareAgentRestoreRuntime(ctx, targetType, {
              pi, target: durable, model: restoredModel,
              isolated: durable.runtime.isolated,
              inheritContext: durable.runtime.inheritContext,
              thinkingLevel: durable.runtime.thinkingLevel,
            });
            if (live?.session) validatePersistedChildSession(durable, prepared.runtime);
            else restoreSession = async () => prepared.restore();
            persistenceRuntime = prepared.runtime;
          } catch (error) {
            const reason: RestoreFailureReason = error instanceof SessionRestoreError ? error.reason : "runtime_initialization_failed";
            return textResult(
              `Failed to resume agent "${params.resume}": ${reason}.`,
              buildInvocationFailureDetails(targetType, params.description, reason, params.resume),
            );
          }
        }
        const runtimeForPersistence = persistenceRuntime;
        if (durable && runtimeForPersistence) {
          const store = persistentRegistry.getOrCreateLifecycleStore(durable.id);
          beginResume = async (_target, record) => {
            const input = captureResumeTarget(record, runtimeForPersistence, ctx.cwd, "running");
            const begun = await store.beginResume({
              ...input,
              state: { ...input.state, status: "running", resultConsumed: false, notified: false },
            });
            record.lifecycleLease = begun.lease;
          };
          authenticatePendingTerminal = async (record, candidate) => {
            const current = persistentRegistry.getResumeTarget(record.id);
            if (!current || current.state.status !== "running") {
              throw new SessionRestoreError("persistence_failed", "Durable running target is unavailable for terminal repair");
            }
            authenticatePendingTerminalSuffix(current, runtimeForPersistence, candidate);
          };
          commitTerminal = async (record, candidate) => {
            if (!record.lifecycleLease) throw new Error("Durable lifecycle lease is unavailable");
            const input = captureResumeTarget(record, runtimeForPersistence, ctx.cwd, terminalStatus(candidate), candidate);
            await store.commitTerminal(record.lifecycleLease, input);
          };
        }
        const outcome = await manager.resume(params.resume, params.prompt, {
          parentSessionId: currentParentSessionId,
          expectedType: targetType,
          target: durable,
          signal: parentSignal,
          restoreSession,
          beginResume,
          authenticatePendingTerminal,
          commitTerminal,
        });
        if (outcome.status === "failed") {
          return textResult(
            `Failed to resume agent "${params.resume}": ${outcome.reason}. ${outcome.error}`.trim(),
            buildInvocationFailureDetails(targetType, params.description, outcome.reason, params.resume),
          );
        }
        const record = manager.getRecord(outcome.id)!;
        try {
          await consumeResult(record);
        } catch {
          return textResult(
            `Failed to persist result consumption for agent "${record.id}". Retry Agent with resume: "${record.id}".`,
            buildInvocationFailureDetails(targetType, params.description, "persistence_failed", record.id),
          );
        }
        const resumedBase = {
          displayName: getDisplayName(targetType),
          description: record.description,
          subagentType: targetType,
        };
        return textResult(
          getRecoveredResultText(record) + localHint,
          buildDetails(resumedBase, record, undefined, { invocationStatus: outcome.status }),
        );
      }

      const rawType = params.subagent_type as SubagentType;
      let subagentType: string;
      try {
        subagentType = requireSpawnableType(rawType);
      } catch (err) {
        return textResult(err instanceof Error ? err.message : String(err));
      }
      const displayName = getDisplayName(subagentType);
      const customConfig = getAgentConfig(subagentType);
      const denial = enforceDelegationPolicy(subagentType);
      if (denial) {
        return textResult(
          formatDelegationPolicyDenial(denial, rawType),
          buildDelegationPolicyDenialDetails(denial, rawType, params.description),
        );
      }
      const resolvedConfig = resolveAgentInvocationConfig(customConfig, params);

      // Resolve model: fallback chain from agent config; tool-call params replace chain.
      let model = ctx.model;
      let effectiveThinking = resolvedConfig.thinkingOverride;

      if (resolvedConfig.modelCandidates.length > 0) {
        let resolved: any;
        for (const candidate of resolvedConfig.modelCandidates) {
          const result = resolveModel(candidate.model, ctx.modelRegistry);
          if (typeof result !== "string") {
            resolved = result;
            if (!effectiveThinking) effectiveThinking = candidate.thinkingLevel;
            break;
          }
        }
        if (!resolved) {
          if (resolvedConfig.modelFromParams) {
            // All candidates failed from tool params — return error for first candidate
            const firstError = resolveModel(resolvedConfig.modelCandidates[0].model, ctx.modelRegistry);
            return textResult(typeof firstError === "string" ? firstError : "Model resolution failed");
          }
          // config-specified: silent fallback to parent model
        } else {
          model = resolved;
        }
      }

      // scopeModels guardrail: validate the effective model against pi's enabledModels.
      if (getScopeModels() && model) {
        const cwd = process.cwd();
        const patterns = readEnabledModels(cwd);
        const allowed = resolveEnabledModels(patterns, ctx.modelRegistry as unknown as ModelRegistryRef, cwd);
        const decision = decideModelScope({
          model: { provider: model.provider, id: model.id },
          modelFromParams: resolvedConfig.modelFromParams,
          allowed,
        });
        if (decision.action === "block") {
          return textResult(decision.message);
        }
        if (decision.action === "warn") {
          ctx.ui.notify(decision.message, "warning");
        }
      }

      const thinking = effectiveThinking;
      const inheritContext = resolvedConfig.inheritContext;
      const runInBackground = resolvedConfig.runInBackground;
      const isolated = resolvedConfig.isolated;

      // Build display tags for non-default config
      const parentModelId = ctx.model?.id;
      const effectiveModelId = model?.id;
      const agentModelName = effectiveModelId && effectiveModelId !== parentModelId
        ? (model?.name ?? effectiveModelId).replace(/^Claude\s+/i, "").toLowerCase()
        : undefined;
      const agentModelLabel = getResolvedModelLabel(model);
      const agentTags: string[] = [];
      const modeLabel = getPromptModeLabel(subagentType);
      if (modeLabel) agentTags.push(modeLabel);
      if (thinking) agentTags.push(`thinking: ${thinking}`);
      if (isolated) agentTags.push("isolated");
      const effectiveMaxTurns = normalizeMaxTurns(resolvedConfig.maxTurns ?? getDefaultMaxTurns());
      // Shared base fields for all AgentDetails in this call
      const detailBase = {
        displayName,
        description: params.description,
        subagentType,
        modelName: agentModelName,
        tags: agentTags.length > 0 ? agentTags : undefined,
        invocationStatus: "started_new" as AgentInvocationStatus,
      };


      const parentSessionId = currentParentSessionId || undefined;
      const subagentSessionDir = createSubagentSessionDir(parentSessionId);

      // Durable callbacks are defined before shared spawn options so both paths use identical barriers.

      let freshRuntime: ResumeRuntimeSnapshot | undefined;
      const persistFreshResumeTarget = async (record: AgentRecord) => {
        if (!record.sessionFile) throw new Error("Fresh agent session file is unavailable before prompt");
        const provisional: AgentLifecycleSnapshotInput = {
          id: record.id, parentSessionId: record.parentSessionId ?? "", sessionFile: record.sessionFile,
          sessionDir: record.sessionDir ?? dirname(record.sessionFile), childSessionId: "pending",
          entryCount: 0, activeLeafId: "pending", sessionSha256: "0".repeat(64),
          type: record.type, description: record.description, cwd: ctx.cwd,
          isBackground: !!record.isBackground, createdAt: record.startedAt, updatedAt: Date.now(),
          runtime: placeholderRuntime(),
          state: { status: record.status, resultConsumed: false, notified: false, toolUses: record.toolUses, lifetimeUsage: EMPTY_USAGE, lifetimeCost: 0, compactionCount: 0 },
        };
        const concreteThinking = record.session?.thinkingLevel;
        if (!concreteThinking) throw new Error("Fresh agent session thinking level is unavailable before prompt");
        const prepared = await prepareAgentRestoreRuntime(ctx, record.type, {
          pi, target: resumeTargetForValidation(provisional), model, isolated, inheritContext, thinkingLevel: concreteThinking,
        });
        const target = captureResumeTarget(record, prepared.runtime, ctx.cwd, "running");
        const initialized = await persistentRegistry.getOrCreateLifecycleStore(record.id).initialize(target);
        record.lifecycleLease = initialized.lease;
        freshRuntime = prepared.runtime;
      };
      const persistFreshTerminal = async (record: AgentRecord, candidate: AgentRunTerminalEvent) => {
        if (!freshRuntime || !record.lifecycleLease) throw new Error("Fresh durable lifecycle is unavailable");
        const target = captureResumeTarget(record, freshRuntime, ctx.cwd, terminalStatus(candidate), candidate);
        await persistentRegistry.getOrCreateLifecycleStore(record.id).commitTerminal(record.lifecycleLease, target);
      };

      // Shared spawn options for both paths. Background adds isBackground + bg callbacks;
      // foreground adds fg callbacks. Single source so the two call sites can't drift.
      const baseSpawnOptions = {
        description: params.description,
        model,
        modelLabel: agentModelLabel,
        maxTurns: effectiveMaxTurns,
        signal: parentSignal,
        isolated,
        inheritContext,
        thinkingLevel: thinking,
        parentSessionId,
        sessionDir: subagentSessionDir,
        skills: params.skills,
        onBeforePrompt: persistFreshResumeTarget,
        onBeforeTerminal: persistFreshTerminal,
      };

      // Background execution
      if (runInBackground) {
        const { state: bgState, callbacks: bgCallbacks } = createActivityTracker(effectiveMaxTurns);

        // Wrap onSessionCreated to wire output file streaming.
        // The callback lazily reads record.outputFile (set right after spawn)
        // rather than closing over a value that doesn't exist yet.
        let id: string;
        const origBgOnSession = bgCallbacks.onSessionCreated;
        bgCallbacks.onSessionCreated = (session: any) => {
          origBgOnSession(session);
          const rec = manager.getRecord(id);
          if (rec?.outputFile) {
            rec.outputCleanup = streamToOutputFile(session, rec.outputFile, id, ctx.cwd);
          }
          // Capture persistent session JSONL path for discoverability.
          if (rec && typeof session.sessionFile === "string") {
            rec.sessionFile = session.sessionFile;
          }
        };

        id = manager.spawn(pi, ctx, subagentType, params.prompt, {
          ...baseSpawnOptions,
          isBackground: true,
          ...bgCallbacks,
        });

        // Set output file synchronously after spawn, before the event loop yields.
        const record = manager.getRecord(id);
        if (record) {
          record.toolCallId = toolCallId;
          record.outputFile = createOutputFilePath(ctx.cwd, id, ctx.sessionManager.getSessionId());
          writeInitialEntry(record.outputFile, id, params.prompt, ctx.cwd);
        }

        agentActivity.set(id, record?.run ? runActivityView(record.run) : bgState);
        widget.ensureTimer();
        widget.update();

        // Emit created event
        pi.events.emit(SUBAGENTS_CREATED, {
          id,
          type: subagentType,
          description: params.description,
          isBackground: true,
        });

        const isQueued = record?.status === "queued";
        return textResult(
          `Agent ${isQueued ? "queued" : "started"} in background.\n` +
          `Agent ID: ${id}\n` +
          `Type: ${displayName}\n` +
          `Description: ${params.description}\n` +
          (record?.outputFile ? `Output file: ${record.outputFile}\n` : "") +
          `Session dir: ${subagentSessionDir}\n` +
          (record?.sessionFile ? `Session file: ${record.sessionFile}\n` : "") +
          (isQueued ? `Position: queued (max ${manager.getMaxConcurrent()} concurrent)\n` : "") +
          `\nYou will be notified when this agent completes.\n` +
          `Actively supervise it with get_subagent_result and steer_subagent.\n` +
          `Do not duplicate this agent's work or leave it unattended for long.` + localHint,
          { ...detailBase, toolUses: 0, tokens: "", durationMs: 0, status: isQueued ? "queued" as const : "background" as const, agentId: id },
        );
      }

      // Foreground (synchronous) execution — stream progress via onUpdate
      let spinnerFrame = 0;
      const startedAt = Date.now();
      let fgId: string | undefined;
      let foregroundActive = true;

      const streamUpdate = () => {
        const details: AgentDetails = {
          ...detailBase,
          toolUses: fgState.toolUses,
          tokens: fgState.tokens,
          turnCount: fgState.turnCount,
          maxTurns: fgState.maxTurns,
          durationMs: Date.now() - startedAt,
          status: "running",
          activity: describeActivity(fgState.activeTools, fgState.responseText),
          spinnerFrame: spinnerFrame % SPINNER.length,
        };
        const update: AgentToolResult<AgentDetails> = {
          content: [{ type: "text", text: `${fgState.toolUses} tool uses...` }],
          details,
        };
        onUpdate?.(update);
        spinnerFrame = (spinnerFrame + 1) % SPINNER.length;
      };

      let renderScheduler: RenderScheduler | undefined;
      const { state: fgState, callbacks: fgCallbacks } = createActivityTracker(effectiveMaxTurns, () => renderScheduler?.requestRender());
      renderScheduler = new RenderScheduler(() => {
        streamUpdate();
        if (foregroundActive) renderScheduler?.requestRender();
      }, SUBAGENT_FOREGROUND_RENDER_CADENCE_MS);

      const flushStreamUpdate = () => renderScheduler?.flushNow();

      // Tool/session state boundaries should not wait for the progress cadence.
      const origOnToolActivity = fgCallbacks.onToolActivity;
      fgCallbacks.onToolActivity = (activity) => {
        origOnToolActivity(activity);
        flushStreamUpdate();
      };

      // Wire session creation to register in widget
      const origOnSession = fgCallbacks.onSessionCreated;
      fgCallbacks.onSessionCreated = (session: any) => {
        origOnSession(session);
        for (const a of manager.listAgents()) {
          if (a.session === session) {
            fgId = a.id;
            agentActivity.set(a.id, a.run ? runActivityView(a.run) : fgState);
            widget.ensureTimer();
            // Capture persistent session JSONL path for discoverability.
            if (typeof session.sessionFile === "string") a.sessionFile = session.sessionFile;
            break;
          }
        }
        flushStreamUpdate();
      };

      let record: AgentRecord;
      try {
        flushStreamUpdate();
        record = await manager.spawnAndWait(pi, ctx, subagentType, params.prompt, {
          ...baseSpawnOptions,
          ...fgCallbacks,
        });
      } finally {
        foregroundActive = false;
        try {
          flushStreamUpdate();
        } finally {
          renderScheduler?.dispose();

          // Clean up foreground agent from widget
          if (fgId) {
            agentActivity.delete(fgId);
            widget.markFinished(fgId);
          }
        }
      }


      // Get final token count
      // Final token/cost: lifetime accumulators (monotonic, compaction-safe, no cacheRead inflation).
      const usingSubscription = ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false;
      const ltUsage = record.lifetimeUsage;
      const tokenTotal = ltUsage ? ltUsage.input + ltUsage.output + ltUsage.cacheWrite : 0;
      const tokenText = tokenTotal > 0 ? formatLifetimeTokens(ltUsage!) : "";
      const costValue = record.lifetimeCost ?? 0;
      const costText = costValue > 0
        ? (usingSubscription ? `${formatCost(costValue)} (sub)` : formatCost(costValue))
        : undefined;

      const details = buildDetails(detailBase, record, fgState, { tokens: tokenText, cost: costText });


      const sessionLog = record.sessionFile ? `\nSession log: ${record.sessionFile}` : "";

      if (record.status === "error" && !record.lifecycleLease) {
        return textResult(
          `Agent failed to persist resume target: ${record.error ?? "unknown persistence error"}`,
          {
            ...buildInvocationFailureDetails(subagentType, params.description, "persistence_failed", record.id),
            error: record.error,
          },
        );
      }

      try {
        await consumeResult(record);
      } catch {
        return textResult(
          `Failed to persist result consumption for agent "${record.id}". Retry get_subagent_result.`,
          buildInvocationFailureDetails(subagentType, params.description, "persistence_failed", record.id),
        );
      }

      if (record.status === "error") {
        return textResult(formatAgentFailureOutput(record, sessionLog, localHint), details);
      }

      const durationMs = (record.completedAt ?? Date.now()) - record.startedAt;
      const statsParts = [`${record.toolUses} tool uses`];
      if (tokenText) statsParts.push(tokenText);
      return textResult(
        `Agent completed in ${formatMs(durationMs)} (${statsParts.join(", ")})${getStatusNote(record.status)}.\n` +
        `Agent ID: ${record.id} (resume with Agent(resume: "${record.id}")).${sessionLog}\n\n` +
        getRecoveredResultText(record) + localHint,
        details,
      );
    },
  }));
}
