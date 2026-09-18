import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type AgentSession, defineTool, type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { parseModelChain, resolveFirstAvailable } from "../../lib/model-selection.js";
import type { AgentManager } from "./agent-manager.js";
import { createAgentResultBuilder, formatLifetimeTokens, partialOutputSuffix, textResult } from "./agent-result.js";
import { getDefaultMaxTurns, normalizeMaxTurns, SUBAGENT_TOOL_NAMES } from "./agent-runner.js";
import { BUILTIN_TOOL_NAMES, getAgentConfig, getAvailableTypes, resolveType } from "./agent-types.js";
import { DELEGATION_POLICY_DENIED, formatDelegationPolicyDenial, type ResolvedDelegationPolicy } from "./delegation-policy.js";
import { isModelInScope, readEnabledModels, resolveEnabledModels } from "./enabled-models.js";
import { resolveAgentInvocationConfig, resolveJoinMode } from "./invocation-config.js";
import { resolveAgentModel } from "./model-resolution.js";
import type { AgentPresentation, createNotificationCoordinator } from "./notification-coordinator.js";
import { createOutputFilePath, streamToOutputFile, writeInitialEntry } from "./output-file.js";
import type { SubagentsSettings } from "./settings.js";
import { getForegroundOutcomeNote } from "./status-note.js";
import { normalizeThinkingLevel } from "./thinking-level.js";
import { renderAgentToolCall, renderAgentToolResult } from "./tool-rendering.js";
import type { AgentConfig, AgentInvocation, AgentRecord, SubagentType } from "./types.js";
import { type AgentActivity, type AgentDetails, buildInvocationTags, describeActivity, formatMs, getDisplayName, getPromptModeLabel, SPINNER, type UICtx } from "./ui/agent-widget.js";
import { addUsage } from "./usage.js";

/** Shared by the tool description and agent-authoring menus. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** The Agent execution host; settings remain activation-owned and live. */
export interface AgentToolHost {
  readonly pi: ExtensionAPI;
  readonly manager: AgentManager;
  readonly settings: Readonly<Required<Pick<SubagentsSettings, "defaultJoinMode" | "scopeModels" | "outputTranscript" | "toolDescriptionMode" | "showCost">>>;
  readonly reloadCustomAgents: () => void;
  readonly resolveDelegation: (ctx: ExtensionContext, type: string) => ResolvedDelegationPolicy;
}

/** Track the same live activity for foreground and background execution. */
function createActivityTracker(maxTurns?: number, onStreamUpdate?: () => void) {
  const state: AgentActivity = {
    activeTools: new Map(),
    toolUses: 0,
    turnCount: 1,
    maxTurns,
    responseText: "",
    session: undefined,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    lastProgressAt: Date.now(),
  };
  const callbacks = {
    onToolActivity: (activity: { type: "start" | "end" | "diagnostic"; toolName: string }) => {
      if (activity.type === "start") {
        state.activeTools.set(activity.toolName + "_" + Date.now(), activity.toolName);
      } else if (activity.type === "end") {
        for (const [key, name] of state.activeTools) {
          if (name === activity.toolName) { state.activeTools.delete(key); break; }
        }
        state.toolUses++;
      }
      state.lastProgressAt = Date.now();
      onStreamUpdate?.();
    },
    onTextDelta: (_delta: string, fullText: string) => {
      state.responseText = fullText;
      state.lastProgressAt = Date.now();
      onStreamUpdate?.();
    },
    onTurnEnd: (turnCount: number) => {
      state.turnCount = turnCount;
      state.lastProgressAt = Date.now();
      onStreamUpdate?.();
    },
    onSessionCreated: (session: AgentSession) => {
      state.session = session;
    },
    onAssistantUsage: (usage: { input: number; output: number; cacheWrite: number }) => {
      addUsage(state.lifetimeUsage, usage);
      state.lastProgressAt = Date.now();
      onStreamUpdate?.();
    },
  };
  return { state, callbacks };
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
    error: formatDelegationPolicyDenial(policy, requestedType),
    result: "",
    activeMode: policy.activeMode,
    requestedType,
    permittedTypes: policy.permittedTypes,
  };
}

/** Advertise configuration, not resolved runtime access. */
const formatToolsSuffix = (cfg: AgentConfig | undefined): string => {
  const tools = cfg?.builtinToolNames;
  const builtins = !tools || (tools.length === BUILTIN_TOOL_NAMES.length
    && BUILTIN_TOOL_NAMES.every((tool) => tools.includes(tool)))
    ? "all" : tools.join(", ");
  const extensions = cfg?.isolated || cfg?.extensions === false
    ? "unavailable"
    : cfg?.extensionToolNames?.join(", ") ?? "all available within runtime policy";
  return `(Built-in tools: ${builtins || "none"}) (Configured extension tools: ${extensions || "none"})`;
};

const buildTypeListText = () => getAvailableTypes().map((name) => {
  const cfg = getAgentConfig(name);
  return `- ${name}: ${cfg?.description ?? name} (Model chain: ${cfg?.model ?? "inherit parent"}) ${formatToolsSuffix(cfg)}`;
}).join("\n");

const firstSentence = (text: string): string => {
  const match = text.match(/^.*?[.!?](?=\s|$)/s);
  return (match ? match[0] : text).replace(/\s+/g, " ").trim();
};

const buildCompactTypeListText = () => getAvailableTypes().map((name) => {
  const cfg = getAgentConfig(name);
  return `- ${name}: ${firstSentence(cfg?.description ?? name)} ${formatToolsSuffix(cfg)}`;
}).join("\n");

// allow: SIZE_OK — one complete tool definition keeps its schema, description, and execution paths together.
export function createAgentTool(
  host: AgentToolHost,
  presentation: AgentPresentation,
  notifications: Pick<ReturnType<typeof createNotificationCoordinator>, "track">,
) {
  const { pi, manager, settings, reloadCustomAgents, resolveDelegation } = host;
  const { activity: agentActivity, widget, fleet } = presentation;
  const buildDetails = createAgentResultBuilder(() => settings.showCost);

  const compactAgentToolDescription = `Launch an autonomous agent for complex, multi-step tasks. Agent types:
${buildCompactTypeListText()}

Configuration only; runtime access depends on extension loading, authentication, and permissions.

Custom agents: .pi/agents/<name>.md (project) or ${getAgentDir()}/agents/<name>.md (global).

Notes:
- description: 3-5 words (shown in UI). Prompts must be self-contained — the agent has not seen this conversation.
- Foreground: multiple Agent calls in one assistant response run concurrently. Parent blocks until all foreground calls return and receives results inline.
- Background: run_in_background returns an agent ID immediately. Continue only non-overlapping work, supervise each agent, then collect via get_subagent_result; never poll or sleep.
- The result is not shown to the user — summarize it for them. Verify an agent's claimed code changes before reporting work done.
- resume continues a previous agent by ID; steer_subagent messages a running one.`;

  const fullAgentToolDescription = `Launch a new agent to handle complex, multi-step tasks autonomously.

Available agent types and configured defaults (not invocation overrides). Configuration only; runtime access depends on extension loading, authentication, and permissions:
${buildTypeListText()}

Custom agents can be defined in .pi/agents/<name>.md (project) or ${getAgentDir()}/agents/<name>.md (global) — they are picked up automatically. Project-level agents override global ones. Creating a .md file with the same name as a default agent overrides it.

When using the Agent tool, specify a subagent_type parameter to select which agent type to use.

## When not to use

If the target is already known, use a direct tool — \`read\` for a known path, \`grep\`/\`find\` for a specific symbol or string. Reserve this tool for open-ended questions that span the codebase, or tasks that match an available agent type.

## Usage notes

- Always include a short (3-5 word) description summarizing what the agent will do (shown in UI).
- Multiple Agent calls in one assistant response run concurrently. For foreground calls, the parent blocks until all return and receives results inline. If the user asks to run agents "in parallel", send one message with multiple tool calls.
- When the agent is done, it returns a single message back to you. The result is not visible to the user — to show the user, send a text message with a concise summary.
- Trust but verify: an agent's summary describes what it intended to do, not necessarily what it did. When an agent writes or edits code, check the actual changes before reporting work as done.
- Use run_in_background only for work you don't need immediately. Each call returns an agent ID immediately. Continue only non-overlapping work, supervise each agent, then collect via get_subagent_result. You will be notified when it completes — do NOT poll or sleep.
- Foreground vs background: use foreground (default) when you need results before proceeding. Use background only when you can continue non-overlapping work while supervising.
- Use resume with an agent ID to continue a previous agent's work. A new (non-resume) Agent call starts a fresh agent with no memory of prior runs, so the prompt must be self-contained.
- Use steer_subagent to send mid-run messages to a running background agent.
- Clearly tell the agent whether you expect it to write code or just to do research (search, file reads, etc.), since it is not aware of the user's intent.
- If an agent's description says it should be used proactively, try to use it without the user having to ask for it first.
- Use model to specify a different model (as "provider/modelId", or fuzzy e.g. "haiku", "sonnet").
- Use thinking to control extended thinking level.
- Use inherit_context if the agent needs the parent conversation history.

## Writing the prompt

Provide clear, detailed prompts so the agent can work autonomously. Brief it like a smart colleague who just walked into the room — it hasn't seen this conversation, doesn't know what you've tried, doesn't understand why this task matters.
- Explain what you're trying to accomplish and why.
- Describe what you've already learned or ruled out.
- Give enough context about the surrounding problem that the agent can make judgment calls rather than just following a narrow instruction.
- If you need a short response, say so ("report in under 200 words").
- Lookups: hand over the exact command. Investigations: hand over the question — prescribed steps become dead weight when the premise is wrong.

Terse command-style prompts produce shallow, generic work.

**Never delegate understanding.** Don't write "based on your findings, fix the bug" or "based on the research, implement it." Those phrases push synthesis onto the agent instead of doing it yourself. Write prompts that prove you understood: include file paths, line numbers, what specifically to change.`;

  const renderToolDescriptionTemplate = (template: string): string => {
    const vars: Record<string, () => string> = {
      typeList: buildTypeListText,
      compactTypeList: buildCompactTypeListText,
      agentDir: getAgentDir,
    };
    return template.replace(/\{\{(\w+)\}\}/g, (raw, name: string) => {
      if (vars[name]) return vars[name]();
      console.warn(`[pi-subagents] agent-tool-description.md: unknown placeholder ${raw} left as-is`);
      return raw;
    });
  };
  const loadCustomToolDescription = (): string | undefined => {
    for (const path of [
      join(process.cwd(), ".pi", "agent-tool-description.md"),
      join(getAgentDir(), "agent-tool-description.md"),
    ]) {
      try {
        if (!existsSync(path)) continue;
        const text = readFileSync(path, "utf-8").trim();
        if (text) return renderToolDescriptionTemplate(text);
        console.warn(`[pi-subagents] ${path} is empty — ignoring`);
      } catch (err) {
        console.warn(`[pi-subagents] failed to read ${path}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return undefined;
  };
  const agentToolDescription = (() => {
    const mode = settings.toolDescriptionMode;
    if (mode === "compact") return compactAgentToolDescription;
    if (mode === "custom") {
      const custom = loadCustomToolDescription();
      if (custom) return custom;
      console.warn('[pi-subagents] toolDescriptionMode is "custom" but no agent-tool-description.md found — using "full"');
    }
    return fullAgentToolDescription;
  })();

  return defineTool({
    name: SUBAGENT_TOOL_NAMES.AGENT,
    label: "Agent",
    description: agentToolDescription,
    promptSnippet: "Launch autonomous sub-agents for complex multi-step tasks",
    promptGuidelines: [
      "Use Agent with specialized agents when the task matches an agent type's description. Subagents are valuable for parallelizing independent queries or for protecting the main context window from excessive results, but should not be used excessively when not needed. Importantly, avoid duplicating work that subagents are already doing — if you delegate research to a subagent, do not also perform the same searches yourself.",
      "For broad codebase exploration or research, spawn Agent with an appropriate subagent_type (e.g. Explore). Otherwise use direct tools (read, grep, find) when the target is already known.",
      "When an agent runs in the background, you will be notified on completion — do not poll or sleep waiting for it. Continue with other work instead.",
      "Trust but verify: an agent's summary describes intent, not outcome. When an agent writes or edits code, check the actual changes before reporting work as done.",
    ],
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
          description: `Thinking level: ${THINKING_LEVELS.join(", ")}. Frontmatter and selected model suffix take precedence. Omitted: selected-model SDK default, not parent thinking.`,
        }),
      ),
      max_turns: Type.Optional(
        Type.Number({
          description: "Maximum number of agentic turns before stopping. Omit for unlimited (default).",
          minimum: 1,
        }),
      ),
      run_in_background: Type.Optional(
        Type.Boolean({
          description: "Set to true to run in background. Returns agent ID immediately. You will be notified on completion.",
        }),
      ),
      resume: Type.Optional(
        Type.String({
          description: "Optional agent ID to resume from. Continues from previous context.",
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
          description: "Skill names to inject into the agent for this call only. Unioned with the agent type's frontmatter preload_skills (deduped). Only applies to fresh spawns; ignored on resume and when isolated: true.",
        }),
      ),
    }),
    renderCall(args, theme) {
      return renderAgentToolCall(args, theme);
    },
    renderResult(result, options, theme) {
      return renderAgentToolResult(result, options, theme);
    },
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      widget.setUICtx(ctx.ui as UICtx);
      reloadCustomAgents();
      const rawType = params.subagent_type as SubagentType;
      const resolved = resolveType(rawType);
      const subagentType = resolved ?? "general-purpose";
      const fellBack = resolved === undefined;
      const delegation = resolveDelegation(ctx, subagentType);
      if (!delegation.decision.allowed) {
        return textResult(
          formatDelegationPolicyDenial(delegation, rawType),
          buildDelegationPolicyDenialDetails(delegation, rawType, params.description),
        );
      }
      const displayName = getDisplayName(subagentType);
      if (params.resume) {
        const existing = manager.getRecord(params.resume);
        if (!existing) return textResult(`Agent not found: "${params.resume}". It may have been cleaned up.`);
        if (!existing.session) return textResult(`Agent "${params.resume}" has no active session to resume.`);
        const record = await manager.resume(params.resume, params.prompt, signal);
        if (!record) return textResult(`Failed to resume agent "${params.resume}".`);
        const details = buildDetails({
          displayName: getDisplayName(record.type),
          description: record.description,
          subagentType: record.type,
        }, record);
        if (record.status === "error") return textResult(`Agent failed: ${record.error}${partialOutputSuffix(record)}`, details);
        return textResult(record.result?.trim() || "No output.", details);
      }
      const customConfig = getAgentConfig(subagentType);
      const resolvedConfig = resolveAgentInvocationConfig(customConfig, params);
      const selected = resolveAgentModel(resolvedConfig.modelInput, ctx.modelRegistry, ctx.model);
      const model = selected.model;
      if (settings.scopeModels && model) {
        const allowed = resolveEnabledModels(readEnabledModels(ctx.cwd), ctx.modelRegistry, ctx.cwd);
        if (allowed && !isModelInScope(model, allowed)) {
          if (resolvedConfig.modelFromParams) {
            const list = [...allowed].sort().map(m => `  ${m}`).join("\n");
            return textResult(
              `Model not in scope: "${resolvedConfig.modelInput}".\n\n` +
              `Allowed models (from enabledModels):\n${list}`,
            );
          }
          const agentLabel = customConfig?.displayName ?? subagentType;
          const modelLabel = resolvedConfig.modelInput ?? `${model.provider}/${model.id}`;
          ctx.ui.notify(
            `Agent "${agentLabel}" using out-of-scope model "${modelLabel}"`,
            "warning",
          );
        }
      }
      const thinking = resolveAgentInvocationConfig(customConfig, params, selected.thinkingLevel).thinking;
      const inheritContext = resolvedConfig.inheritContext;
      const runInBackground = resolvedConfig.runInBackground;
      const isolated = resolvedConfig.isolated;
      // Frontmatter wins; this is the sole gate for creating a transcript.
      const outputTranscript = customConfig?.outputTranscript ?? settings.outputTranscript;
      const attachTranscript = (rec: AgentRecord | undefined, agentId: string): void => {
        if (!rec || !outputTranscript) return;
        rec.outputFile = createOutputFilePath(ctx.cwd, agentId, ctx.sessionManager.getSessionId());
        writeInitialEntry(rec.outputFile, agentId, params.prompt, ctx.cwd);
      };
      const effectiveMaxTurns = normalizeMaxTurns(resolvedConfig.maxTurns ?? getDefaultMaxTurns());
      let requestedModel = params.model;
      if (requestedModel != null) {
        try {
          const requested = resolveFirstAvailable(parseModelChain(requestedModel), ctx.modelRegistry)?.model;
          if (requested) requestedModel = `${requested.provider}/${requested.id}`;
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          console.warn(`[pi-subagents] Could not resolve requested model for disclosure: ${reason}`);
          requestedModel = params.model;
        }
      }
      const requestedThinking = normalizeThinkingLevel(params.thinking?.trim().toLowerCase()) ?? thinking;
      const agentInvocation: AgentInvocation = {
        requestedModel,
        requestedThinking: THINKING_LEVELS.some((level) => level === requestedThinking) ? requestedThinking : undefined,
        thinkingDefault: thinking === undefined,
        maxTurns: normalizeMaxTurns(resolvedConfig.maxTurns),
        isolated,
        inheritContext,
        runInBackground,
      };
      const modeLabel = getPromptModeLabel(subagentType);
      const { tags: invocationTags } = buildInvocationTags(agentInvocation);
      const agentTags = modeLabel ? [modeLabel, ...invocationTags] : invocationTags;
      const detailBase = {
        displayName,
        description: params.description,
        subagentType,
        tags: agentTags.length > 0 ? agentTags : undefined,
      };

      if (runInBackground) {
        const { state: bgState, callbacks: bgCallbacks } = createActivityTracker(effectiveMaxTurns);
        let id: string;
        const origBgOnSession = bgCallbacks.onSessionCreated;
        bgCallbacks.onSessionCreated = (session: AgentSession) => {
          origBgOnSession(session);
          const rec = manager.getRecord(id);
          if (rec?.outputFile) rec.outputCleanup = streamToOutputFile(session, rec.outputFile, id, ctx.cwd);
        };
        try {
          id = manager.spawn(pi, ctx, subagentType, params.prompt, {
            description: params.description,
            model,
            selectedModel: { ...selected, modelInput: resolvedConfig.modelInput },
            maxTurns: effectiveMaxTurns,
            isolated,
            inheritContext,
            thinkingLevel: thinking,
            isBackground: true,
            invocation: agentInvocation,
            skills: params.skills,
            ...bgCallbacks,
          });
        } catch (err) {
          return textResult(err instanceof Error ? err.message : String(err));
        }
        // Set transcript/join metadata before async session creation can run.
        const joinMode = resolveJoinMode(settings.defaultJoinMode, true);
        const record = manager.getRecord(id);
        if (record && joinMode) {
          record.joinMode = joinMode;
          record.toolCallId = toolCallId;
          attachTranscript(record, id);
        }
        notifications.track(id, joinMode);
        agentActivity.set(id, bgState);
        widget.ensureTimer();
        widget.update();
        fleet.ensureTimer();
        fleet.update();
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
          (isQueued ? `Position: queued (max ${manager.getMaxConcurrent()} concurrent)\n` : "") +
          `\nYou will be notified when this agent completes.\n` +
          `Use get_subagent_result to retrieve full results, or steer_subagent to send it messages.\n` +
          `Do not duplicate this agent's work.`,
          record ? buildDetails(detailBase, record, { activity: bgState, overrides: { status: isQueued ? "queued" : "background" } }) : undefined,
        );
      }

      let spinnerFrame = 0;
      const startedAt = Date.now();
      let fgId: string | undefined;
      const streamUpdate = () => {
        const liveRecord = fgId ? manager.getRecord(fgId) : undefined;
        const details: AgentDetails = {
          ...detailBase,
          ...(liveRecord ? buildDetails(detailBase, liveRecord, { activity: fgState }) : {}),
          toolUses: fgState.toolUses,
          tokens: formatLifetimeTokens(fgState),
          turnCount: fgState.turnCount,
          maxTurns: fgState.maxTurns,
          durationMs: Date.now() - startedAt,
          status: "running",
          result: fgState.responseText,
          activity: describeActivity(fgState.activeTools, fgState.responseText),
          spinnerFrame: spinnerFrame % SPINNER.length,
        };
        onUpdate?.({
          content: [{ type: "text", text: `${fgState.toolUses} tool uses...` }],
          details,
        });
      };
      const { state: fgState, callbacks: fgCallbacks } = createActivityTracker(effectiveMaxTurns, streamUpdate);
      const origOnSession = fgCallbacks.onSessionCreated;
      fgCallbacks.onSessionCreated = (session: AgentSession) => {
        origOnSession(session);
        for (const a of manager.listAgents()) {
          if (a.session === session) {
            fgId = a.id;
            agentActivity.set(a.id, fgState);
            widget.ensureTimer();
            fleet.ensureTimer();
            fleet.update();
            break;
          }
        }
        if (fgId) {
          const rec = manager.getRecord(fgId);
          if (rec?.outputFile) rec.outputCleanup = streamToOutputFile(session, rec.outputFile, fgId, ctx.cwd);
        }
      };
      const spinnerInterval = setInterval(() => {
        spinnerFrame++;
        streamUpdate();
      }, 80);
      streamUpdate();
      let record: AgentRecord;
      try {
        const fgResult = await manager.spawnAndWait(pi, ctx, subagentType, params.prompt, {
          description: params.description,
          model,
          selectedModel: { ...selected, modelInput: resolvedConfig.modelInput },
          maxTurns: effectiveMaxTurns,
          isolated,
          inheritContext,
          thinkingLevel: thinking,
          invocation: agentInvocation,
          skills: params.skills,
          signal,
          ...fgCallbacks,
        }, (fgAgentId) => {
          const fgRec = manager.getRecord(fgAgentId);
          attachTranscript(fgRec, fgAgentId);
        });
        record = fgResult.record;
      } catch (err) {
        clearInterval(spinnerInterval);
        return textResult(err instanceof Error ? err.message : String(err));
      }
      clearInterval(spinnerInterval);
      if (fgId) {
        agentActivity.delete(fgId);
        widget.markFinished(fgId);
        fleet.onAgentFinished(fgId);
      }
      const tokenText = formatLifetimeTokens(fgState);
      const details = buildDetails(detailBase, record, { activity: fgState, overrides: { tokens: tokenText } });
      const fallbackNote = fellBack
        ? `Note: Unknown agent type "${rawType}" — using ${resolveType("general-purpose") ? "general-purpose" : "the fallback agent config"}.\n\n`
        : "";
      const foregroundAgentId = `Agent ID: ${record.id}\n`;
      if (record.status === "error") {
        return textResult(`${fallbackNote}${foregroundAgentId}Agent failed: ${record.error}${partialOutputSuffix(record)}`, details);
      }
      const durationMs = (record.completedAt ?? Date.now()) - record.startedAt;
      const statsParts = [`${record.toolUses} tool uses`];
      if (tokenText) statsParts.push(tokenText);
      return textResult(
        `${fallbackNote}${foregroundAgentId}Agent completed in ${formatMs(durationMs)} (${statsParts.join(", ")})${getForegroundOutcomeNote(record.status)}.\n\n` +
        (record.result?.trim() || "No output."),
        details,
      );
    },
  });
}
