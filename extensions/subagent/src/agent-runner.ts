/**
 * agent-runner.ts — Core execution engine: creates sessions, runs agents, collects results.
 */

import { basename, dirname } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  getAgentDir,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { computeActiveToolNames } from "./active-tools.js";
import { BUILTIN_TOOL_NAMES, getAgentConfig, getAvailableTypes, getConfig } from "./agent-types.js";
import { buildParentContext, extractText } from "./context.js";
import { detectEnv } from "./env.js";
import { buildAgentPrompt, type PromptExtras } from "./prompts.js";
import { preloadSkills } from "./skill-loader.js";
import { parseModelChain, resolveFirstAvailable, type ModelRegistry } from "./model-resolver.js";
import type { ResumeTargetV1, SubagentType, ThinkingLevel } from "./types.js";
import {
  buildRuntimeCompatibilitySnapshot,
  prepareAgentSessionRestore,
  SessionRestoreError,
  type PreparedAgentSessionRestore,
} from "./session-restoration.js";


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
 * Priority: explicit option > config.model chain > parent model.
 */
function resolveDefaultModel(
  parentModel: Model<any> | undefined,
  registry: ModelRegistry,
  configModel?: string,
): Model<any> | undefined {
  if (configModel) {
    const candidates = parseModelChain(configModel);
    const result = resolveFirstAvailable(candidates, registry);
    if (result) {
      if (result.thinkingLevel && !result.model?.thinkingLevel) {
        result.model.thinkingLevel = result.thinkingLevel;
      }
      return result.model;
    }
    // Fallback: exact find in full registry even if getAvailable() filters it out.
    for (const candidate of candidates) {
      const input = candidate.model;
      const slashIdx = input.indexOf("/");
      if (slashIdx !== -1) {
        const provider = input.slice(0, slashIdx);
        const modelId = input.slice(slashIdx + 1);
        const found = registry.find(provider, modelId);
        if (found) {
          if (candidate.thinkingLevel && !found.thinkingLevel) {
            found.thinkingLevel = candidate.thinkingLevel;
          }
          return found;
        }
      }
    }
    console.warn(
      `[subagent] Could not resolve any model from agent config chain "${configModel}". ` +
      `Falling back to parent model (${parentModel?.provider ?? "unknown"}/${parentModel?.id ?? "unknown"}).`
    );
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
  /** Directory for persistent subagent session JSONL files. Defaults to pi's normal session tree. */
  sessionDir?: string;
  /** Called on tool start/end with activity info. */
  onToolActivity?: (activity: ToolActivity) => void;
  /** Called on streaming text deltas from the assistant response. */
  onTextDelta?: (delta: string, fullText: string) => void;
  /** Called when non-text assistant deltas still indicate model progress. */
  onProgress?: () => void;
  /** Called when a new assistant message starts. */
  onMessageStart?: () => void;
  onSessionCreated?: (session: AgentSession) => void;
  /** Called at the end of each agentic turn with the cumulative count. */
  onTurnEnd?: (turnCount: number) => void;
  /** Called on each completed assistant message with token usage (excludes cacheRead) plus per-message cost (USD, includes cacheRead). */
  onAssistantUsage?: (usage: { input: number; output: number; cacheWrite: number; cost: number }) => void;
}

export interface RunResult {
  responseText: string;
  session: AgentSession;
  /** Provider/runtime failure resolved by the session instead of thrown. */
  failure?: string;
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

type AssistantSessionMessage = Extract<AgentSession["messages"][number], { role: "assistant" }>;

/** Last assistant message appended at index >= `start` (snapshot-bounded). */
function getLastAssistantMessageSince(session: AgentSession, start: number): AssistantSessionMessage | undefined {
  for (let i = session.messages.length - 1; i >= start; i--) {
    const msg = session.messages[i];
    if (msg.role === "assistant") return msg as AssistantSessionMessage;
  }
  return undefined;
}

/** Last assistant text from messages appended at index >= `start` (snapshot-bounded — avoids the full-history leak). */
function getLastAssistantTextSince(session: AgentSession, start: number): string {
  for (let i = session.messages.length - 1; i >= start; i--) {
    const msg = session.messages[i];
    if (msg.role !== "assistant") continue;
    const text = extractText(msg.content).trim();
    if (text) return text;
  }
  return "";
}

function getResolvedRunFailure(message: AssistantSessionMessage | undefined, responseText: string): string | undefined {
  if (!message) return undefined;
  const providerError = message.errorMessage?.trim();
  if (message.stopReason === "error") {
    return providerError || "Assistant response ended with stop reason \"error\".";
  }
  if (message.stopReason === "length" && !responseText) {
    return providerError || "Assistant response ended with stop reason \"length\" without usable text.";
  }
  return undefined;
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

function isThinkingProgressDelta(type: string): boolean {
  return type === "thinking_delta" || type === "reasoning_delta";
}

/**
 * Canonical lowercase name for an extension path.
 * Directory extensions (foo/index.ts) → parent dir name;
 * single-file extensions → basename minus .ts/.js.
 */
export function extensionCanonicalName(extPath: string): string {
  const base = basename(extPath);
  const name = base === "index.ts" || base === "index.js"
    ? basename(dirname(extPath))
    : base.replace(/\.(ts|js)$/, "");
  return name.toLowerCase();
}

/**
 * Build the extensionsOverride filter for DefaultResourceLoader.
 * Returns undefined when no filtering is needed (fast path).
 *
 * keep(ext) ⇔ !excluded.has(name) && (loadAll || allow.has(name))
 */
type ExtensionsOverrideFn = NonNullable<ConstructorParameters<typeof DefaultResourceLoader>[0]["extensionsOverride"]>;
export function buildExtensionsOverride(opts: {
  extensions: true | string[] | false;
  excludeExtensions: string[] | undefined;
  isolated: boolean;
}): ExtensionsOverrideFn | undefined {
  const { extensions, excludeExtensions, isolated } = opts;

  if (extensions === false) return undefined;
  if (isolated) return undefined;

  const loadAll = extensions === true;
  const allow = loadAll ? undefined : new Set((extensions as string[]).map((n) => n.toLowerCase()));
  const excluded = new Set((excludeExtensions ?? []).map((n) => n.toLowerCase()));
  const hasExcludes = excluded.size > 0;

  if (loadAll && !hasExcludes) return undefined;

  return (base) => ({
    ...base,
    extensions: base.extensions.filter((e) => {
      const name = extensionCanonicalName(e.path);
      if (excluded.has(name)) return false;
      return loadAll || allow!.has(name);
    }),
  });
}

export interface AgentSessionRuntimeOptions {
  cwd: string;
  agentDir: string;
  sessionManager: SessionManager;
  settingsManager: ReturnType<typeof SettingsManager.create>;
  modelRegistry: ExtensionContext["modelRegistry"];
  model: Model<any> | undefined;
  resourceLoader: DefaultResourceLoader;
  thinkingLevel?: ThinkingLevel;
  builtinToolNames: string[];
  extensions: true | string[] | false;
  extensionToolNames?: string[];
  allowNesting?: boolean;
  isolated?: boolean;
  onExtensionError?: (extensionPath: string) => void;
}

/** Create an opened/fresh session without binding extensions or applying tool policy. */
export async function createUnboundAgentSessionRuntime(options: AgentSessionRuntimeOptions): Promise<AgentSession> {
  const sessionOpts: NonNullable<Parameters<typeof createAgentSession>[0]> = {
    cwd: options.cwd,
    agentDir: options.agentDir,
    sessionManager: options.sessionManager,
    settingsManager: options.settingsManager,
    modelRegistry: options.modelRegistry,
    model: options.model,
    resourceLoader: options.resourceLoader,
  };
  if (options.thinkingLevel) sessionOpts.thinkingLevel = options.thinkingLevel;
  const { session } = await createAgentSession(sessionOpts);
  return session;
}

/** Bind extensions, then apply exact tool policy to an already-created session. */
export async function bindAndApplyAgentSessionPolicy(
  session: AgentSession,
  options: AgentSessionRuntimeOptions,
): Promise<void> {
  await session.bindExtensions({
    onError: (err) => options.onExtensionError?.(err.extensionPath),
  });
  const activeTools = computeActiveToolNames({
    availableToolNames: session.getActiveToolNames(),
    builtinToolNames: options.builtinToolNames,
    builtinToolUniverse: BUILTIN_TOOL_NAMES,
    extensions: options.extensions,
    extensionTools: options.extensionToolNames,
    allowNesting: options.allowNesting,
    isolated: options.isolated,
  });
  session.setActiveToolsByName(activeTools);
}

/** Shared fresh initialization: construction, extension binding, exact tool policy. */
export async function buildAgentSessionRuntime(options: AgentSessionRuntimeOptions): Promise<AgentSession> {
  const session = await createUnboundAgentSessionRuntime(options);
  await bindAndApplyAgentSessionPolicy(session, options);
  return session;
}

export interface PrepareAgentRestoreRuntimeOptions
  extends Pick<RunOptions, "pi" | "model" | "isolated" | "inheritContext" | "thinkingLevel" | "onToolActivity"> {
  target: ResumeTargetV1;
}

/** Prepare exact current runtime compatibility plus a strict restore callback. */
export async function prepareAgentRestoreRuntime(
  ctx: ExtensionContext,
  type: SubagentType,
  options: PrepareAgentRestoreRuntimeOptions,
 ): Promise<PreparedAgentSessionRestore> {
  const config = getConfig(type);
  const agentConfig = getAgentConfig(type);
  if (!agentConfig) {
    throw new SessionRestoreError("agent_config_unavailable", `Agent type '${type}' is unavailable`);
  }

  const effectiveCwd = ctx.cwd;
  const env = await detectEnv(options.pi, effectiveCwd);
  const extras: PromptExtras = {};
  const extensions = options.isolated ? false : config.extensions;
  const excludeExtensions = options.isolated ? undefined : config.excludeExtensions;
  const discoverSkills = options.isolated ? false : config.discoverSkills;
  const preloadList = options.isolated ? [] : config.preloadSkills;
  if (preloadList.length > 0) {
    const loaded = preloadSkills(preloadList, effectiveCwd);
    if (loaded.length > 0) extras.skillBlocks = loaded;
  }
  const systemPrompt = buildAgentPrompt(agentConfig, effectiveCwd, env, ctx.getSystemPrompt(), extras);
  const noSkills = !discoverSkills;
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(effectiveCwd, agentDir);
  const resourcePolicy = {
    noExtensions: extensions === false,
    extensions,
    excludeExtensions,
    noSkills,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: options.isolated || agentConfig.promptMode !== "system_instructions",
  };
  const resourceLoader = new DefaultResourceLoader({
    cwd: effectiveCwd,
    agentDir,
    noExtensions: resourcePolicy.noExtensions,
    extensionsOverride: buildExtensionsOverride({ extensions, excludeExtensions, isolated: !!options.isolated }),
    noSkills,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: resourcePolicy.noContextFiles,
    systemPromptOverride: () => systemPrompt,
    appendSystemPromptOverride: () => [],
  });
  await resourceLoader.reload();

  const model = options.model ?? resolveDefaultModel(ctx.model, ctx.modelRegistry, agentConfig.model);
  if (!model) throw new SessionRestoreError("model_unavailable", "Agent model is unavailable in current runtime");
  const thinkingLevel = options.thinkingLevel ?? settingsManager.getDefaultThinkingLevel() ?? "off";
  const loadedExtensions = resourceLoader.getExtensions().extensions;
  const availableToolNames = [
    ...BUILTIN_TOOL_NAMES,
    ...loadedExtensions.flatMap((extension) => [...extension.tools.keys()]),
  ];
  const activeToolNames = computeActiveToolNames({
    availableToolNames,
    builtinToolNames: config.builtinToolNames,
    builtinToolUniverse: BUILTIN_TOOL_NAMES,
    extensions,
    extensionTools: agentConfig.extensionToolNames,
    allowNesting: agentConfig.allowNesting,
    isolated: options.isolated,
  });
  const runtime = buildRuntimeCompatibilitySnapshot({
    model: { provider: model.provider, id: model.id, api: model.api },
    thinkingLevel,
    promptMode: agentConfig.promptMode,
    isolated: !!options.isolated,
    inheritContext: !!options.inheritContext,
    systemPrompt,
    resourcePolicy,
    agentConfig,
    extensions: loadedExtensions.map((extension) => ({
      name: extensionCanonicalName(extension.path),
      path: extension.resolvedPath,
    })),
    activeToolNames,
  });

  const runtimeOptions = (sessionManager: SessionManager): AgentSessionRuntimeOptions => ({
    cwd: effectiveCwd,
    agentDir,
    sessionManager,
    settingsManager,
    modelRegistry: ctx.modelRegistry,
    model,
    resourceLoader,
    thinkingLevel: options.thinkingLevel,
    builtinToolNames: config.builtinToolNames,
    extensions,
    extensionToolNames: agentConfig.extensionToolNames,
    allowNesting: agentConfig.allowNesting,
    isolated: options.isolated,
    onExtensionError: (extensionPath) => {
      options.onToolActivity?.({ type: "end", toolName: `extension-error:${extensionPath}` });
    },
  });
  let openedManager: SessionManager | undefined;
  return prepareAgentSessionRestore({
    target: options.target,
    runtime,
    createSession: (sessionManager) => {
      openedManager = sessionManager;
      return createUnboundAgentSessionRuntime(runtimeOptions(sessionManager));
    },
    bindAndApplyPolicy: (session) => {
      if (!openedManager) throw new Error("Restored session manager is unavailable");
      return bindAndApplyAgentSessionPolicy(session, runtimeOptions(openedManager));
    },
  });
}

export async function runAgent(
  ctx: ExtensionContext,
  type: SubagentType,
  prompt: string,
  options: RunOptions,
): Promise<RunResult> {
  const config = getConfig(type);
  const agentConfig = getAgentConfig(type);

  const effectiveCwd = ctx.cwd;

  const env = await detectEnv(options.pi, effectiveCwd);

  // Get parent system prompt for append-mode agents
  const parentSystemPrompt = ctx.getSystemPrompt();

  // Build prompt extras (memory, skill preloading)
  const extras: PromptExtras = {};

  // Resolve extensions/skills: isolated overrides to false
  const extensions = options.isolated ? false : config.extensions;
  const excludeExtensions = options.isolated ? undefined : config.excludeExtensions;
  const discoverSkills = options.isolated ? false : config.discoverSkills;
  const preloadList = options.isolated ? [] : config.preloadSkills;

  // Skill preloading: eagerly inject listed skills' content into the prompt.
  // Independent of discoverSkills — the catalog can be on while some skills are preloaded.
  if (preloadList.length > 0) {
    const loaded = preloadSkills(preloadList, effectiveCwd);
    if (loaded.length > 0) {
      extras.skillBlocks = loaded;
    }
  }

  const toolNames = [...config.builtinToolNames];

  // Build system prompt from agent config
  let systemPrompt: string;
  if (agentConfig) {
    systemPrompt = buildAgentPrompt(agentConfig, effectiveCwd, env, parentSystemPrompt, extras);
  } else {
    const available = getAvailableTypes();
    throw new Error(`Agent type '${type}' not found. Available: ${available.join(', ') || '(none)'}`);
  }

  // noSkills is driven only by discoverSkills; preloaded skills (if any) are already
  // injected into the prompt and are independent of the on-demand skill catalog.
  const noSkills = !discoverSkills;

  const agentDir = getAgentDir();

  // Resolve AGENTS.md inheritance: prompt_mode: system_instructions opts in to having pi
  // inject the AGENTS.md walk (global agentDir + cwd→root ancestors) as `# Project Context`
  // AFTER systemPromptOverride. This gives subagents project guardrails as a single source of
  // truth (no kuafu mode body bleed, no bridge-text duplication of AGENTS.md content).
  // isolated overrides to false (true isolation means no project context).
  const inheritContextFiles = !options.isolated && agentConfig?.promptMode === "system_instructions";

  // Load extensions: true/string[] → load, false → don't. Skill catalog is gated by noSkills (= !discoverSkills).
  // Suppress AGENTS.md/CLAUDE.md (unless system_instructions) and APPEND_SYSTEM.md — upstream's
  // buildSystemPrompt() re-appends both AFTER systemPromptOverride, which would defeat
  // prompt_mode: replace and isolated: true. Parent context, if wanted, reaches the subagent via
  // prompt_mode: append (parentSystemPrompt is embedded in systemPromptOverride),
  // inherit_context (conversation), or prompt_mode: system_instructions (AGENTS.md only).
  const loader = new DefaultResourceLoader({
    cwd: effectiveCwd,
    agentDir,
    noExtensions: extensions === false,
    extensionsOverride: buildExtensionsOverride({ extensions, excludeExtensions, isolated: !!options.isolated }),
    noSkills,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: !inheritContextFiles,
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

  const session = await buildAgentSessionRuntime({
    cwd: effectiveCwd,
    agentDir,
    sessionManager: SessionManager.create(effectiveCwd, options.sessionDir),
    settingsManager: SettingsManager.create(effectiveCwd, agentDir),
    modelRegistry: ctx.modelRegistry,
    model,
    resourceLoader: loader,
    thinkingLevel,
    builtinToolNames: toolNames,
    extensions,
    extensionToolNames: agentConfig?.extensionToolNames,
    allowNesting: agentConfig?.allowNesting,
    isolated: options.isolated,
    onExtensionError: (extensionPath) => {
      options.onToolActivity?.({ type: "end", toolName: `extension-error:${extensionPath}` });
    },
  });

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
      options.onMessageStart?.();
    }
    if (event.type === "message_update") {
      if (event.assistantMessageEvent.type === "text_delta") {
        currentMessageText += event.assistantMessageEvent.delta;
        options.onTextDelta?.(event.assistantMessageEvent.delta, currentMessageText);
      } else if (isThinkingProgressDelta((event.assistantMessageEvent as { type: string }).type)) {
        options.onProgress?.();
      }
    }
    if (event.type === "tool_execution_start") {
      options.onToolActivity?.({ type: "start", toolName: event.toolName });
    }
    if (event.type === "tool_execution_end") {
      options.onToolActivity?.({ type: "end", toolName: event.toolName });
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      const u = event.message.usage;
      options.onAssistantUsage?.({ input: u.input ?? 0, output: u.output ?? 0, cacheWrite: u.cacheWrite ?? 0, cost: u.cost?.total ?? 0 });
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

  const invocationStart = session.messages.length;
  try {
    await session.prompt(effectivePrompt);
  } finally {
    unsubTurns();
    collector.unsubscribe();
    cleanupAbort();
  }

  const responseText = collector.getText().trim() || getLastAssistantTextSince(session, invocationStart);
  const failure = getResolvedRunFailure(getLastAssistantMessageSince(session, invocationStart), responseText);
  return { responseText, session, failure, aborted, steered: softLimitReached };
}

/** Discriminated result of a resumed turn: usable fresh text, or a real failure. */
export type ResumeOutcome = { ok: true; text: string } | { ok: false; reason: string };

/**
 * Send a new prompt to an existing session (resume).
 *
 * Returns a discriminated outcome so an empty or failed resumed turn surfaces as a
 * real failure instead of silently echoing a prior assistant summary. Previously a
 * stale resume that produced no fresh output fell through to getLastAssistantText,
 * which scans the WHOLE history and leaked the prior turn's summary as a
 * false-positive success.
 */
export async function resumeAgent(
  session: AgentSession,
  prompt: string,
  options: { onToolActivity?: (activity: ToolActivity) => void; signal?: AbortSignal } = {},
): Promise<ResumeOutcome> {
  const collector = collectResponseText(session);
  const cleanupAbort = forwardAbortSignal(session, options.signal);

  const unsubToolUse = options.onToolActivity
    ? session.subscribe((event: AgentSessionEvent) => {
        if (event.type === "tool_execution_start") options.onToolActivity!({ type: "start", toolName: event.toolName });
        if (event.type === "tool_execution_end") options.onToolActivity!({ type: "end", toolName: event.toolName });
      })
    : () => {};

  const before = session.messages.length;
  try {
    await session.prompt(prompt);
  } finally {
    collector.unsubscribe();
    unsubToolUse();
    cleanupAbort();
  }

  const reason = "empty_or_failed_resume_turn";

  // (1) The resumed turn appended no assistant message at all.
  let newest: AgentSession["messages"][number] | undefined;
  for (let i = session.messages.length - 1; i >= before; i--) {
    if (session.messages[i].role === "assistant") {
      newest = session.messages[i];
      break;
    }
  }
  if (!newest) return { ok: false, reason };

  // (2) The newest terminal assistant message ended abnormally.
  const stopReason = (newest as { stopReason?: string }).stopReason;
  if (stopReason === "error" || stopReason === "aborted" || stopReason === "length") {
    return { ok: false, reason };
  }

  // (3) No streamed text and the turn produced no usable content. The fallback is
  // snapshot-bounded (index >= before): never scan prior history — that is the leak.
  const collectorText = collector.getText().trim();
  const text = collectorText || getLastAssistantTextSince(session, before);
  if (!text) return { ok: false, reason };

  return { ok: true, text };
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
