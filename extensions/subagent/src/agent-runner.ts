/**
 * agent-runner.ts — Core execution engine: creates sessions, runs agents, collects results.
 */

import type { Model } from "@mariozechner/pi-ai";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  getAgentDir,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import { computeActiveToolNames } from "./active-tools.js";
import { BUILTIN_TOOL_NAMES, getAgentConfig, getConfig, getMemoryToolNames, getReadOnlyMemoryToolNames } from "./agent-types.js";
import { buildParentContext, extractText } from "./context.js";
import { DEFAULT_AGENTS } from "./default-agents.js";
import { detectEnv } from "./env.js";
import { buildMemoryBlock, buildReadOnlyMemoryBlock } from "./memory.js";
import { buildAgentPrompt, type PromptExtras } from "./prompts.js";
import { preloadSkills } from "./skill-loader.js";
import type { SubagentType, ThinkingLevel } from "./types.js";


/** Default max turns. undefined = unlimited (no turn limit). */
let defaultMaxTurns: number | undefined;

/** Normalize max turns. undefined or 0 = unlimited, otherwise minimum 1. */
export function normalizeMaxTurns(n: number | undefined): number | undefined {
  if (n == null || n === 0) return undefined;
  return Math.max(1, n);
}

/** Get the default max turns value. undefined = unlimited. */
export function getDefaultMaxTurns(): number | undefined { return defaultMaxTurns; }
/** Set the default max turns value. undefined or 0 = unlimited, otherwise minimum 1. */
export function setDefaultMaxTurns(n: number | undefined): void { defaultMaxTurns = normalizeMaxTurns(n); }

/** Additional turns allowed after the soft limit steer message. */
let graceTurns = 5;

/** Get the grace turns value. */
export function getGraceTurns(): number { return graceTurns; }
/** Set the grace turns value (minimum 1). */
export function setGraceTurns(n: number): void { graceTurns = Math.max(1, n); }

/**
 * Try to find the right model for an agent type.
 * Priority: explicit option > config.model > parent model.
 */
function resolveDefaultModel(
  parentModel: Model<any> | undefined,
  registry: { find(provider: string, modelId: string): Model<any> | undefined; getAvailable?(): Model<any>[] },
  configModel?: string,
): Model<any> | undefined {
  if (configModel) {
    const slashIdx = configModel.indexOf("/");
    if (slashIdx !== -1) {
      const provider = configModel.slice(0, slashIdx);
      const modelId = configModel.slice(slashIdx + 1);

      // Build a set of available model keys for fast lookup
      const available = registry.getAvailable?.();
      const availableKeys = available
        ? new Set(available.map((m: any) => `${m.provider}/${m.id}`))
        : undefined;
      const isAvailable = (p: string, id: string) =>
        !availableKeys || availableKeys.has(`${p}/${id}`);

      const found = registry.find(provider, modelId);
      if (found && isAvailable(provider, modelId)) return found;
    }
  }

  return parentModel;
}

/** Info about a tool event in the subagent. */
export interface ToolActivity {
  type: "start" | "end";
  toolName: string;
}

export interface RunOptions {
  /** ExtensionAPI instance — used for pi.exec() instead of execSync. */
  pi: ExtensionAPI;
  model?: Model<any>;
  maxTurns?: number;
  signal?: AbortSignal;
  isolated?: boolean;
  inheritContext?: boolean;
  thinkingLevel?: ThinkingLevel;
  /** Override working directory (e.g. for worktree isolation). */
  cwd?: string;
  /** Called on tool start/end with activity info. */
  onToolActivity?: (activity: ToolActivity) => void;
  /** Called on streaming text deltas from the assistant response. */
  onTextDelta?: (delta: string, fullText: string) => void;
  onSessionCreated?: (session: AgentSession) => void;
  /** Called at the end of each agentic turn with the cumulative count. */
  onTurnEnd?: (turnCount: number) => void;
}

export interface RunResult {
  responseText: string;
  session: AgentSession;
  /** True if the agent was hard-aborted (max_turns + grace exceeded). */
  aborted: boolean;
  /** True if the agent was steered to wrap up (hit soft turn limit) but finished in time. */
  steered: boolean;
}

/**
 * Subscribe to a session and collect the last assistant message text.
 * Returns an object with a `getText()` getter and an `unsubscribe` function.
 */
function collectResponseText(session: AgentSession) {
  let text = "";
  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "message_start") {
      text = "";
    }
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      text += event.assistantMessageEvent.delta;
    }
  });
  return { getText: () => text, unsubscribe };
}

/** Get the last assistant text from the completed session history. */
function getLastAssistantText(session: AgentSession): string {
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const msg = session.messages[i];
    if (msg.role !== "assistant") continue;
    const text = extractText(msg.content).trim();
    if (text) return text;
  }
  return "";
}

/**
 * Wire an AbortSignal to abort a session.
 * Returns a cleanup function to remove the listener.
 */
function forwardAbortSignal(session: AgentSession, signal?: AbortSignal): () => void {
  if (!signal) return () => {};
  const onAbort = () => session.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

export async function runAgent(
  ctx: ExtensionContext,
  type: SubagentType,
  prompt: string,
  options: RunOptions,
): Promise<RunResult> {
  const config = getConfig(type);
  const agentConfig = getAgentConfig(type);

  // Resolve working directory: worktree override > parent cwd
  const effectiveCwd = options.cwd ?? ctx.cwd;

  const env = await detectEnv(options.pi, effectiveCwd);

  // Get parent system prompt for append-mode agents
  const parentSystemPrompt = ctx.getSystemPrompt();

  // Build prompt extras (memory, skill preloading)
  const extras: PromptExtras = {};

  // Resolve extensions/skills: isolated overrides to false
  const extensions = options.isolated ? false : config.extensions;
  const skills = options.isolated ? false : config.skills;

  // Skill preloading: when skills is string[], preload their content into prompt
  if (Array.isArray(skills)) {
    const loaded = preloadSkills(skills, effectiveCwd);
    if (loaded.length > 0) {
      extras.skillBlocks = loaded;
    }
  }

  let toolNames = [...config.builtinToolNames];

  // Persistent memory: detect write capability and branch accordingly.
  // Memory may only use built-ins already permitted by builtin_tools/default built-ins.
  if (agentConfig?.memory) {
    const existingNames = new Set(toolNames);
    const hasWriteTools = existingNames.has("write") || existingNames.has("edit");
    const permittedMemoryTools = new Set(["read", "write", "edit"].filter((name) => existingNames.has(name)));

    if (hasWriteTools) {
      // Read-write memory: add any missing permitted memory tool names (read/write/edit).
      const extraNames = getMemoryToolNames(existingNames).filter((name) => permittedMemoryTools.has(name));
      if (extraNames.length > 0) toolNames = [...toolNames, ...extraNames];
      extras.memoryBlock = buildMemoryBlock(agentConfig.name, agentConfig.memory, effectiveCwd);
    } else {
      // Read-only memory: only add read when read is otherwise permitted.
      const extraNames = getReadOnlyMemoryToolNames(existingNames).filter((name) => permittedMemoryTools.has(name));
      if (extraNames.length > 0) toolNames = [...toolNames, ...extraNames];
      extras.memoryBlock = buildReadOnlyMemoryBlock(agentConfig.name, agentConfig.memory, effectiveCwd);
    }
  }

  // Build system prompt from agent config
  let systemPrompt: string;
  if (agentConfig) {
    systemPrompt = buildAgentPrompt(agentConfig, effectiveCwd, env, parentSystemPrompt, extras);
  } else {
    // Unknown type fallback: spread the canonical general-purpose config (defensive —
    // unreachable in practice since index.ts resolves unknown types before calling runAgent).
    const fallback = DEFAULT_AGENTS.get("general-purpose");
    if (!fallback) throw new Error(`No fallback config available for unknown type "${type}"`);
    systemPrompt = buildAgentPrompt({ ...fallback, name: type }, effectiveCwd, env, parentSystemPrompt, extras);
  }

  // When skills is string[], we've already preloaded them into the prompt.
  // Still pass noSkills: true since we don't need the skill loader to load them again.
  const noSkills = skills === false || Array.isArray(skills);

  const agentDir = getAgentDir();

  // Load extensions/skills: true or string[] → load; false → don't.
  // Suppress AGENTS.md/CLAUDE.md and APPEND_SYSTEM.md — upstream's
  // buildSystemPrompt() re-appends both AFTER systemPromptOverride, which
  // would defeat prompt_mode: replace and isolated: true. Parent context, if
  // wanted, reaches the subagent via prompt_mode: append (parentSystemPrompt
  // is embedded in systemPromptOverride) or inherit_context (conversation).
  const loader = new DefaultResourceLoader({
    cwd: effectiveCwd,
    agentDir,
    noExtensions: extensions === false,
    noSkills,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => systemPrompt,
    appendSystemPromptOverride: () => [],
  });
  await loader.reload();

  // Resolve model: explicit option > config.model > parent model
  const model = options.model ?? resolveDefaultModel(
    ctx.model, ctx.modelRegistry, agentConfig?.model,
  );

  // Resolve thinking level: explicit option > undefined (inherit)
  const thinkingLevel = options.thinkingLevel;

  const sessionOpts: Parameters<typeof createAgentSession>[0] = {
    cwd: effectiveCwd,
    agentDir,
    sessionManager: SessionManager.inMemory(effectiveCwd),
    settingsManager: SettingsManager.create(effectiveCwd, agentDir),
    modelRegistry: ctx.modelRegistry,
    model,
    resourceLoader: loader,
  };
  if (thinkingLevel) {
    sessionOpts.thinkingLevel = thinkingLevel;
  }

  const { session } = await createAgentSession(sessionOpts);

  // Bind extensions first so extension tools are visible, then apply the final
  // exact active-tool policy. Do not pass `tools` to createAgentSession here:
  // that SDK allowlist is built-in-only and would pre-strip extension tools.
  await session.bindExtensions({
    onError: (err) => {
      options.onToolActivity?.({
        type: "end",
        toolName: `extension-error:${err.extensionPath}`,
      });
    },
  });

  const activeTools = computeActiveToolNames({
    availableToolNames: session.getActiveToolNames(),
    builtinToolNames: toolNames,
    builtinToolUniverse: BUILTIN_TOOL_NAMES,
    extensions,
    extensionTools: agentConfig?.extensionToolNames,
    allowNesting: agentConfig?.allowNesting,
    isolated: options.isolated,
  });
  session.setActiveToolsByName(activeTools);

  options.onSessionCreated?.(session);

  // Track turns for graceful max_turns enforcement
  let turnCount = 0;
  const maxTurns = normalizeMaxTurns(options.maxTurns ?? agentConfig?.maxTurns ?? defaultMaxTurns);
  let softLimitReached = false;
  let aborted = false;

  let currentMessageText = "";
  const unsubTurns = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "turn_end") {
      turnCount++;
      options.onTurnEnd?.(turnCount);
      if (maxTurns != null) {
        if (!softLimitReached && turnCount >= maxTurns) {
          softLimitReached = true;
          session.steer("You have reached your turn limit. Wrap up immediately — provide your final answer now.");
        } else if (softLimitReached && turnCount >= maxTurns + graceTurns) {
          aborted = true;
          session.abort();
        }
      }
    }
    if (event.type === "message_start") {
      currentMessageText = "";
    }
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      currentMessageText += event.assistantMessageEvent.delta;
      options.onTextDelta?.(event.assistantMessageEvent.delta, currentMessageText);
    }
    if (event.type === "tool_execution_start") {
      options.onToolActivity?.({ type: "start", toolName: event.toolName });
    }
    if (event.type === "tool_execution_end") {
      options.onToolActivity?.({ type: "end", toolName: event.toolName });
    }
  });

  const collector = collectResponseText(session);
  const cleanupAbort = forwardAbortSignal(session, options.signal);

  // Build the effective prompt: optionally prepend parent context
  let effectivePrompt = prompt;
  if (options.inheritContext) {
    const parentContext = buildParentContext(ctx);
    if (parentContext) {
      effectivePrompt = parentContext + prompt;
    }
  }

  try {
    await session.prompt(effectivePrompt);
  } finally {
    unsubTurns();
    collector.unsubscribe();
    cleanupAbort();
  }

  const responseText = collector.getText().trim() || getLastAssistantText(session);
  return { responseText, session, aborted, steered: softLimitReached };
}

/**
 * Send a new prompt to an existing session (resume).
 */
export async function resumeAgent(
  session: AgentSession,
  prompt: string,
  options: { onToolActivity?: (activity: ToolActivity) => void; signal?: AbortSignal } = {},
): Promise<string> {
  const collector = collectResponseText(session);
  const cleanupAbort = forwardAbortSignal(session, options.signal);

  const unsubToolUse = options.onToolActivity
    ? session.subscribe((event: AgentSessionEvent) => {
        if (event.type === "tool_execution_start") options.onToolActivity!({ type: "start", toolName: event.toolName });
        if (event.type === "tool_execution_end") options.onToolActivity!({ type: "end", toolName: event.toolName });
      })
    : () => {};

  try {
    await session.prompt(prompt);
  } finally {
    collector.unsubscribe();
    unsubToolUse();
    cleanupAbort();
  }

  return collector.getText().trim() || getLastAssistantText(session);
}

/**
 * Send a steering message to a running subagent.
 * The message will interrupt the agent after its current tool execution.
 */
export async function steerAgent(
  session: AgentSession,
  message: string,
): Promise<void> {
  await session.steer(message);
}

type ToolCallSummary = {
  name?: unknown;
  toolName?: unknown;
};

function getToolCallDisplayName(content: ToolCallSummary): string {
  if (typeof content.name === "string") return content.name;
  if (typeof content.toolName === "string") return content.toolName;
  return "unknown";
}

/**
 * Get the subagent's conversation messages as formatted text.
 */
export function getAgentConversation(session: AgentSession): string {
  const parts: string[] = [];

  for (const msg of session.messages) {
    if (msg.role === "user") {
      const text = typeof msg.content === "string"
        ? msg.content
        : extractText(msg.content);
      if (text.trim()) parts.push(`[User]: ${text.trim()}`);
    } else if (msg.role === "assistant") {
      const textParts: string[] = [];
      const toolCalls: string[] = [];
      for (const c of msg.content) {
        if (c.type === "text" && c.text) textParts.push(c.text);
        else if (c.type === "toolCall") toolCalls.push(`  Tool: ${getToolCallDisplayName(c)}`);
      }
      if (textParts.length > 0) parts.push(`[Assistant]: ${textParts.join("\n")}`);
      if (toolCalls.length > 0) parts.push(`[Tool Calls]:\n${toolCalls.join("\n")}`);
    } else if (msg.role === "toolResult") {
      const text = extractText(msg.content);
      const truncated = text.length > 200 ? text.slice(0, 200) + "..." : text;
      parts.push(`[Tool Result (${msg.toolName})]: ${truncated}`);
    }
  }

  return parts.join("\n\n");
}
