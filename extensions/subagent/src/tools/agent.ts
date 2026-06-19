/**
 * `Agent` tool — spawn (or resume) a sub-agent, foreground or background.
 *
 * Also owns the activity-tracking, detail-building, and subagent-session-dir
 * helpers that only the Agent tool consumes.
 */

import { join } from "node:path";
import { type AgentToolResult, type ExtensionContext, defineTool, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { getDefaultMaxTurns, normalizeMaxTurns } from "../agent-runner.js";
import { getAgentConfig, getAvailableTypes } from "../agent-types.js";
import { SUBAGENT_FOREGROUND_RENDER_CADENCE_MS } from "../constants.js";
import { buildDelegationBlockedMessage, getCurrentDelegatorType, hasDelegationPolicy, resolveDelegationRequest } from "../delegation-policy.js";
import { resolveAgentInvocationConfig } from "../invocation-config.js";
import { resolveModel } from "../model-resolver.js";
import { createOutputFilePath, streamToOutputFile, writeInitialEntry } from "../output-file.js";
import { getRecoveredResultText } from "../result-recovery.js";
import { getResolvedModelLabel, safeFormatTokens, textResult } from "../lifecycle/supervision.js";
import type { SubagentRuntimeContext, SupervisedAgentActivity } from "../lifecycle/supervision.js";
import type { AgentRun } from "../agent-run.js";
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
import { renderAgentSummary } from "../ui-wiring/renderers.js";
import type { AgentRecord, SubagentType } from "../types.js";

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

export function registerAgentTool(ctx: SubagentRuntimeContext): void {
  const {
    pi,
    widget,
    manager,
    agentActivity,
    requireSpawnableType,
    bindTurnAbortSignal,
    getAbortSignal,
    typeListText,
  } = ctx;

  pi.registerTool(defineTool({
    name: "Agent",
    label: "Agent",
    description: `Launch a new agent to handle complex, multi-step tasks autonomously.

The Agent tool launches specialized agents that autonomously handle complex tasks. Each agent type has specific capabilities and tools available to it.

Available agent types:
${typeListText}

Guidelines:
- For parallel work, use run_in_background: true on each agent. Foreground calls run sequentially — only one executes at a time.
- Leave max_turns unset unless you need an explicit cap. Unset is the normal unlimited-by-default behavior.
- Background agents require active supervision: check progress with get_subagent_result, use steer_subagent for mid-run course correction, and use resume to continue the same agent instead of starting duplicate work.
- If a background agent is still useful, keep supervising it rather than launching overlapping duplicate work or leaving it unattended for long periods.
- Choose an available custom agent whose description matches the task.
- Provide clear, detailed prompts so the agent can work autonomously.
- Agent results are returned as text; summarize them for the user.
- Use model to specify a different model (as "provider/modelId", or fuzzy e.g. "haiku", "sonnet").
- Use thinking to control extended thinking level.
- Use inherit_context if the agent needs the parent conversation history.
- Use isolation: "worktree" to run the agent in an isolated git worktree (safe parallel file modifications).`,
    parameters: Type.Object({
      prompt: Type.String({
        description: "The task for the agent to perform.",
      }),
      description: Type.String({
        description: "A short (3-5 word) description of the task (shown in UI).",
      }),
      subagent_type: Type.String({
        description: `The type of specialized agent to use. Available types: ${getAvailableTypes().join(", ")}. Custom agents from .pi/agents/*.md (project) or ${getAgentDir()}/agents/*.md (global) are also available.`,
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
          description: "Set to true to run in background. Returns agent ID immediately; actively supervise longer work with get_subagent_result and steer_subagent.",
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
      isolation: Type.Optional(
        Type.Literal("worktree", {
          description: 'Set to "worktree" to run the agent in a temporary git worktree (isolated copy of the repo). Changes are saved to a branch on completion.',
        }),
      ),
    }),

    // ---- Custom rendering: Claude Code style ----

    renderCall(args, theme) {
      const displayName = args.subagent_type ? getDisplayName(args.subagent_type) : "Agent";
      const desc = args.description ?? "";
      return new Text("▸ " + theme.fg("toolTitle", theme.bold(displayName)) + (desc ? "  " + theme.fg("muted", desc) : ""), 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme) {
      const details = result.details as AgentDetails | undefined;
      if (!details) {
        const text = result.content[0]?.type === "text" ? result.content[0].text : "";
        return new Text(text, 0, 0);
      }

      // ---- While running (streaming) ----
      if (isPartial || details.status === "running") {
        return new Text(renderAgentSummary(details, {
          durationMs: undefined,
          resultPreview: details.activity ?? "thinking…",
        }).join("\n"), 0, 0);
      }

      // ---- Background agent launched ----
      if (details.status === "background") {
        return new Text(theme.fg("dim", `  ⎿  Running in background (ID: ${details.agentId})`), 0, 0);
      }

      // ---- Completed / Steered ----
      if (details.status === "completed" || details.status === "steered") {
        const isSteered = details.status === "steered";
        const doneText = isSteered ? "Wrapped up (turn limit)" : "Done";
        const lines = renderAgentSummary(details, {
          resultPreview: expanded ? undefined : doneText,
        });

        if (expanded) {
          const resultText = result.content[0]?.type === "text" ? result.content[0].text : "";
          if (resultText) {
            const resultLines = resultText.split("\n");
            for (const l of resultLines.slice(0, 50)) {
              lines.push(theme.fg("dim", `  ${l}`));
            }
            if (resultLines.length > 50) {
              lines.push(theme.fg("muted", "  ... (use get_subagent_result with verbose for full output)"));
            }
          }
        }

        return new Text(lines.join("\n"), 0, 0);
      }

      // ---- Stopped (user-initiated abort) ----
      if (details.status === "stopped") {
        return new Text(renderAgentSummary(details, {
          durationMs: undefined,
          resultPreview: "Stopped",
        }).join("\n"), 0, 0);
      }

      // ---- Error / Aborted (hard max_turns) ----
      const resultPreview = details.status === "error"
        ? `Error: ${details.error ?? "unknown"}`
        : "Aborted (max turns exceeded)";
      return new Text(renderAgentSummary(details, {
        durationMs: undefined,
        resultPreview,
      }).join("\n"), 0, 0);
    },

    // ---- Execute ----

    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      // Ensure we have UI context for widget rendering
      widget.setUICtx(ctx.ui as UICtx);
      const parentSignal = getAbortSignal(ctx) ?? signal;
      bindTurnAbortSignal(parentSignal);

      const rawType = params.subagent_type as SubagentType;
      let subagentType: string;
      try {
        subagentType = requireSpawnableType(rawType);
      } catch (err) {
        return textResult(err instanceof Error ? err.message : String(err));
      }
      const displayName = getDisplayName(subagentType);

      const customConfig = getAgentConfig(subagentType);

      const currentDelegatorType = getCurrentDelegatorType(ctx.sessionManager.getEntries() as Array<{ type?: string; customType?: string; data?: { mode?: unknown } }>);
      if (currentDelegatorType) {
        const delegatorConfig = getAgentConfig(currentDelegatorType);
        if (delegatorConfig && hasDelegationPolicy(delegatorConfig)) {
          const delegation = resolveDelegationRequest(delegatorConfig, subagentType, getAvailableTypes());
          if (!delegation.allowed) {
            return textResult(
              buildDelegationBlockedMessage(currentDelegatorType, rawType, delegation.requestedType, delegation.permittedTypes),
            );
          }
        }
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

      const thinking = effectiveThinking;
      const inheritContext = resolvedConfig.inheritContext;
      const runInBackground = resolvedConfig.runInBackground;
      const isolated = resolvedConfig.isolated;
      const isolation = resolvedConfig.isolation;

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
      if (isolation === "worktree") agentTags.push("worktree");
      const effectiveMaxTurns = normalizeMaxTurns(resolvedConfig.maxTurns ?? getDefaultMaxTurns());
      // Shared base fields for all AgentDetails in this call
      const detailBase = {
        displayName,
        description: params.description,
        subagentType,
        modelName: agentModelName,
        tags: agentTags.length > 0 ? agentTags : undefined,
      };

      // Resume existing agent
      if (params.resume) {
        const existing = manager.getRecord(params.resume);
        if (!existing) {
          return textResult(`Agent not found: "${params.resume}". It may have been cleaned up.`);
        }
        if (!existing.session) {
          return textResult(`Agent "${params.resume}" has no active session to resume.`);
        }
        const record = await manager.resume(params.resume, params.prompt, parentSignal);
        if (!record) {
          return textResult(`Failed to resume agent "${params.resume}".`);
        }
        return textResult(
          getRecoveredResultText(record),
          buildDetails(detailBase, record),
        );
      }

      const parentSessionId = getParentSessionId(ctx);
      const subagentSessionDir = createSubagentSessionDir(parentSessionId);

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
        isolation,
        parentSessionId,
        sessionDir: subagentSessionDir,
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
        pi.events.emit("subagents:created", {
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
          `Actively supervise it with get_subagent_result, steer_subagent, and resume as needed.\n` +
          `Do not duplicate this agent's work or leave it unattended for long.`,
          { ...detailBase, toolUses: 0, tokens: "", durationMs: 0, status: "background" as const, agentId: id },
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

      let record!: AgentRecord;
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
      const tokenText = safeFormatTokens(fgState.session);

      const details = buildDetails(detailBase, record, fgState, { tokens: tokenText });


      const sessionLog = record.sessionFile ? `\nSession log: ${record.sessionFile}` : "";

      if (record.status === "error") {
        return textResult(`Agent failed.${sessionLog}\n\n${getRecoveredResultText(record)}`, details);
      }

      const durationMs = (record.completedAt ?? Date.now()) - record.startedAt;
      const statsParts = [`${record.toolUses} tool uses`];
      if (tokenText) statsParts.push(tokenText);
      return textResult(
        `Agent completed in ${formatMs(durationMs)} (${statsParts.join(", ")})${getStatusNote(record.status)}.\n` +
        `Agent ID: ${record.id} (resume with Agent(resume: "${record.id}")).${sessionLog}\n\n` +
        getRecoveredResultText(record),
        details,
      );
    },
  }));
}
