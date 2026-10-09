import { registerRuntimeModelFallback } from "../../lib/runtime-model-fallback.js";
/**
 * agent-runner.ts — Core execution engine: creates sessions, runs agents, collects results.
 */

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionContext, LoadExtensionsResult } from "@earendil-works/pi-coding-agent";
import {
  type AgentSession,
  type AgentSessionEvent,
  CONFIG_DIR_NAME,
  createAgentSession,
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  DefaultResourceLoader,
  type ExtensionAPI,
  type ExtensionFactory,
  getAgentDir,
  type ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  type AccessDiagnostic,
  type AccessRule,
  BUILTIN_TOOL_NAMES,
  createToolCeilingTool,
  type ExtensionCandidate,
  extensionIdsForPath,
  resolveExtensionAccess,
  resolveToolAccess,
  type ToolAccessGates,
  toolCandidates,
} from "../../lib/active-tools.js";
import { assertFastSupported, transformFastHeaders, transformFastPayload } from "../../lib/fast.js";
import { registerGuardScopeProvider } from "../../lib/guard-registration.js";
import sessionLocalTools from "../../session-local/index.js";
import { seedSessionLocalScope } from "../../session-local/storage.js";
import smartToolGuards from "../../smart-tool-guards/index.js";
import { installExtensionToolScope } from "./agent-tool-scope.js";
import { getAgentConfig, getConfig, resolveType } from "./agent-types.js";
import { buildParentContext, extractText } from "./context.js";
import { DEFAULT_AGENTS } from "./default-agents.js";
import { detectEnv } from "./env.js";
import type { CompiledSchema } from "./graph/json-schema.js";
import { resolveAgentModel, type SelectedAgentModel } from "./model-resolution.js";
import { buildAgentPrompt, type PromptExtras } from "./prompts.js";
import { sessionFastPolicies } from "./session-fast.js";
import { preloadSkills } from "./skill-loader.js";
import { createStructuredCapture, createStructuredOutputTool, rememberStructuredCapture, repairStructuredOutput, STRUCTURED_OUTPUT_TOOL_NAME, structuredFailure, takeStructuredCapture } from "./structured-output.js";
import type { AgentConfig, InterruptionCause, SubagentType, ThinkingLevel } from "./types.js";
import type { LifetimeUsage } from "./usage.js";

const TRUSTED_FALLBACK_EXTENSION_PATH = "<inline:subagent-model-fallback>";
const TRUSTED_FAST_EXTENSION_PATH = "<inline:subagent-fast>";
const TRUSTED_SESSION_LOCAL_EXTENSION_NAME = "session-local";
const TRUSTED_SESSION_LOCAL_EXTENSION_PATH = `<inline:${TRUSTED_SESSION_LOCAL_EXTENSION_NAME}>`;
const TRUSTED_SMART_TOOL_GUARDS_EXTENSION_NAME = "smart-tool-guards";
const TRUSTED_SMART_TOOL_GUARDS_EXTENSION_PATH = `<inline:${TRUSTED_SMART_TOOL_GUARDS_EXTENSION_NAME}>`;
const TRUSTED_NESTED_TOOL_SCOPE_EXTENSION_NAME = "subagent-nested-tool-scope";
const TRUSTED_NESTED_TOOL_SCOPE_EXTENSION_PATH = `<inline:${TRUSTED_NESTED_TOOL_SCOPE_EXTENSION_NAME}>`;
const TRUSTED_EXTENSION_PATHS = new Set([
  TRUSTED_SESSION_LOCAL_EXTENSION_PATH,
  TRUSTED_SMART_TOOL_GUARDS_EXTENSION_PATH,
  TRUSTED_NESTED_TOOL_SCOPE_EXTENSION_PATH,
  TRUSTED_FAST_EXTENSION_PATH,
  TRUSTED_FALLBACK_EXTENSION_PATH,
]);
/** Trusted model-only tool whose `prepareLoadout` hides ungranted declarations. */
const TOOL_CEILING_TOOL_NAME = "subagent_tool_ceiling";
/**
 * Pi's built-in extensions the runner can supply. SDK sessions do not load
 * them on their own; a factory passed with `builtin: true` loads as
 * `builtin:<name>` (honoring settings that disable it).
 * ponytail: Pi does not export its `llama.cpp` factory, and the parent's model
 * runtime already carries its providers, so `builtin:llama.cpp` never loads
 * here (a `+builtin:llama.cpp` rule just warns zero-match).
 */
const PI_BUILTIN_EXTENSIONS: ReadonlyArray<{ name: string; create: () => ExtensionFactory }> = [
  { name: "codemode", create: () => createCodemodeExtension({ models: false }) },
  { name: "tool-search", create: () => createToolSearchExtension() },
  { name: "mcp", create: () => createMcpExtension() },
];
/** Pi's MCP resource tools; not `mcp__*` names, and not exported from Pi's package entry. */
const MCP_RESOURCE_TOOL_NAMES = ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"];
/** Pi's `MCP_SERVERS_SECTION` prompt section key, not exported from Pi's package entry. */
const MCP_SERVERS_SECTION = "mcp_servers";

/** Pi's `mcpNamespace` (core/mcp-servers.js), not exported from Pi's package entry. */
function mcpNamespace(server: string): string {
  return `mcp__${server.replace(/-/g, "_")}`;
}

/** Server names in an `mcp.json`'s `mcpServers`; none when the file is missing or invalid. */
function mcpConfigServerNames(path: string): string[] {
  try {
    const servers: unknown = JSON.parse(readFileSync(path, "utf-8"))?.mcpServers;
    return typeof servers === "object" && servers !== null && !Array.isArray(servers) ? Object.keys(servers) : [];
  } catch {
    return [];
  }
}

/**
 * `excludeTools` entries for the MCP tools that `tools:` rules deny a child
 * loading `builtin:mcp`: `<namespace>__*` for every fully denied configured
 * server, plus every denied MCP tool in the parent's catalog by name (resource
 * tools count even when the parent lacks them). A server is fully denied when
 * its tools are denied and no `+` name/glob rule could grant one of them, so an
 * exact grant survives even before the server's tools are known.
 */
function mcpToolExcludes(
  toolRules: readonly AccessRule[],
  gates: ToolAccessGates,
  parentTools: readonly { name: string; sourceInfo?: { path?: string } }[],
  configPaths: readonly string[],
): { excludeTools: string[]; deniedNamespaces: string[] } {
  const builtinMcpTool = (name: string) => toolCandidates([{ name, sourceInfo: { path: "builtin:mcp" } }]);
  const candidates = toolCandidates(parentTools.filter(({ name }) => name.startsWith("mcp__") || MCP_RESOURCE_TOOL_NAMES.includes(name)));
  for (const name of MCP_RESOURCE_TOOL_NAMES) {
    if (!candidates.some((candidate) => candidate.name === name)) candidates.push(...builtinMcpTool(name));
  }
  const allowed = resolveToolAccess(toolRules, candidates, gates).allowed;
  const deniedNames = candidates.filter(({ name }) => !allowed.has(name)).map(({ name }) => name);

  const namespaces = new Set(configPaths.flatMap((path) => mcpConfigServerNames(path).map(mcpNamespace)));
  const deniedNamespaces = [...namespaces].filter((namespace) => {
    const prefix = `${namespace}__`;
    const probe = `${prefix}<probe>`;
    if (resolveToolAccess(toolRules, builtinMcpTool(probe), gates).allowed.has(probe)) return false;
    return !toolRules.some(({ sign, selector }) => {
      if (sign !== "+" || selector.startsWith("@")) return false;
      const star = selector.indexOf("*");
      if (star < 0) return selector.startsWith(prefix);
      const literal = selector.slice(0, star);
      return literal.startsWith(prefix) || prefix.startsWith(literal);
    });
  });
  return { excludeTools: [...deniedNamespaces.map((namespace) => `${namespace}__*`), ...deniedNames], deniedNamespaces };
}

const GUARDED_CANONICAL_AGENT_TYPES = new Set([
  "chengfeng",
  "direnjie",
  "taishang",
  "xuannv",
  "yanluo",
  "huayan",
]);

/**
 * Tool names registered by THIS extension. Single source of truth so the
 * registration sites (index.ts) and the subagent exclusion list below can't
 * drift apart. These are our own tools, not pi built-ins, so they can't be
 * derived from pi — but they only need defining once.
 */
export const SUBAGENT_TOOL_NAMES = {
  AGENT: "agent",
  GET_AGENT_RESULT: "get_agent_result",
  RESOLVE_GRAPH_GATE: "resolve_agent_graph_gate",
  STEER: "steer_subagent",
  AGENT_GRAPH: "agent_graph",
} as const;

/** Names of tools registered by this extension that subagents must NOT inherit. */
const EXCLUDED_TOOL_NAMES: string[] = Object.values(SUBAGENT_TOOL_NAMES);

/** Directory name under getAgentDir() used to store child session files. */
export const SUBAGENT_SESSION_DIR_NAME = "subagent-sessions";

/** Custom entry recording a fresh spawn's identity and per-call options; resume requires it. */
export const SUBAGENT_LAUNCH_ENTRY = "subagent-launch";

interface SubagentLaunch {
  version: 1;
  agentId?: string;
  type: string;
  isolated?: boolean;
  skills?: string[];
}

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

/** Info about a tool event in the subagent. */
export interface ToolActivity {
  type: "start" | "end" | "diagnostic";
  toolName: string;
}

export interface RunOptions {
  graphRun?: boolean;
  structuredOutput?: CompiledSchema;
  /** ExtensionAPI instance — used for pi.exec() instead of execSync. */
  pi: ExtensionAPI;
  /** Manager-assigned id; suffixes session name to disambiguate parallel spawns (e.g. `Explore#a1b2c3d4`). */
  agentId?: string;
  /** Internal unregistered definition replacing every registry lookup; never reachable from tool or RPC options. */
  agentConfig?: AgentConfig;
  model?: Model<any>;
  selectedModel?: SelectedAgentModel;
  maxTurns?: number;
  signal?: AbortSignal;
  isolated?: boolean;
  inheritContext?: boolean;
  thinkingLevel?: ThinkingLevel;
  /** Override working directory (e.g. a caller-supplied `SpawnOptions.cwd`). */
  cwd?: string;
  /**
   * Where .pi config is discovered (project extensions, skills, pi
   * settings). Default: same as the working directory. The manager sets
   * this to the parent session's cwd when `SpawnOptions.cwd` points the
   * working directory elsewhere — the agent works *there* but carries the
   * parent project's config (the target's `.pi` extensions never execute).
   *
   * WARNING for future callers: if you pass `cwd` pointing at a directory the
   * user didn't open, you almost certainly must pass `configCwd` too —
   * omitting it makes the target's `.pi` extensions execute in this process.
   */
  configCwd?: string;
  /** Called on tool start/end with activity info. */
  onToolActivity?: (activity: ToolActivity) => void;
  /** Called on streaming text deltas from the assistant response. */
  onTextDelta?: (delta: string, fullText: string) => void;
  /** Internal idle heartbeat for non-empty thinking/tool-call argument deltas; carries no payload. */
  onProgress?: () => void;
  onSessionCreated?: (session: AgentSession) => void;
  /** Called at the end of each agentic turn with the cumulative count. */
  onTurnEnd?: (turnCount: number) => void;
  /**
   * Called once per assistant message_end with that message's usage delta.
   * Lets callers accumulate observed billing deltas independently of history.
   * SDK session stats also retain pre-compaction usage via session entries.
   */
  onAssistantUsage?: (usage: LifetimeUsage) => void;
  /**
   * Called when the session successfully compacts. `tokensBefore` is upstream's
   * pre-compaction context size estimate. Aborted compactions don't fire.
   */
  onCompaction?: (info: { reason: "manual" | "threshold" | "overflow"; tokensBefore: number }) => void;
  /** Skill names to inject (preload) for this call only. Union with frontmatter preload_skills (deduped). Ignored when isolated: true. */
  skills?: string[];
  /**
   * Session ID of the parent session. When set, child session files are
   * stored under `<agentDir>/subagent-sessions/<parentSessionId>/` unless
   * frontmatter `session_dir` provides an explicit override.
   */
  parentSessionId?: string;
  /**
   * Existing child session file to reopen instead of creating a new session.
   * It must carry this agent's launch entry and the current parent lineage;
   * its launch-time isolated/skills replace the per-call options. A reopened run has no turn limit.
   */
  resumeSessionFile?: string;
}

export interface RunResult {
  interruptionCause?: InterruptionCause;
  structuredJson?: string;
  structuredRetried?: boolean;
  responseText: string;
  session: AgentSession;
  /** True when execution was interrupted rather than cleanly completed. */
  aborted: boolean;
  /** True if the agent was steered to wrap up (hit soft turn limit) but finished in time. */
  steered: boolean;
  /** Final provider/runtime failure; partial output remains available separately. */
  failure?: string;
}

/**
 * Subscribe to a session and collect the last assistant message text.
 * Returns an object with a `getText()` getter and an `unsubscribe` function.
 */
function collectResponseText(session: AgentSession, onTextDelta?: RunOptions["onTextDelta"], onProgress?: RunOptions["onProgress"]) {
  let text = "";
  let lastText = "";
  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    // message_start also fires for user and toolResult messages — resetting on
    // those would wipe assistant text already collected. Reset only when a new
    // ASSISTANT message begins, so getText() is the last assistant message's text.
    if (event.type === "message_start" && event.message.role === "assistant") {
      if (text.trim()) lastText = text;
      text = "";
    }
    if (event.type === "message_update") {
      const update = event.assistantMessageEvent;
      if ((update.type === "thinking_delta" || update.type === "toolcall_delta") && update.delta.length > 0) {
        onProgress?.();
      }
    }
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      text += event.assistantMessageEvent.delta;
      onTextDelta?.(event.assistantMessageEvent.delta, text);
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      const completedText = extractText(event.message.content ?? []);
      if (completedText.trim()) lastText = completedText;
    }
  });
  return { getText: () => text.trim() ? text : lastText, unsubscribe };
}

/**
 * Get the last non-empty assistant text produced during THIS invocation.
 * `startIndex` is the message count captured before the prompt, so the walk-back
 * never crosses into a previous turn: on a resume whose new turn failed empty,
 * this returns "" instead of the prior turn's answer (#144). Defaults to 0 (a
 * fresh spawn, where the whole history belongs to this run).
 */
function getLastAssistantText(session: AgentSession, startIndex = 0): string {
  for (let i = session.messages.length - 1; i >= startIndex; i--) {
    const msg = session.messages[i];
    if (msg.role !== "assistant") continue;
    const text = extractText(msg.content).trim();
    if (text) return text;
  }
  return "";
}

/**
 * Error message of THIS invocation's final assistant message, when that turn
 * failed. Two failure shapes, both keyed off how the final turn STOPPED:
 *   - stopReason "error": a provider failure pi resolved instead of rejecting
 *     (any text; partial output is surfaced separately).
 *   - stopReason "length" with NO text: a silent max-token death — the run hit
 *     the output-token ceiling before writing anything, which would otherwise
 *     land as a "completed" run with an empty result (the #144 symptom).
 * Everything else completes: a clean "stop"/"toolUse" final, and — crucially — a
 * "length" stop that DID produce text (a legitimate truncated-but-useful answer).
 * "aborted" is handled by the manager's abort flag / "stopped" guard, not here.
 * Bounded by `startIndex` (like the text fallback) so a resume that produced no
 * assistant message of its own never inherits a PRIOR turn's stop reason.
 */
function finalTurnError(session: AgentSession, startIndex = 0): string | undefined {
  for (let i = session.messages.length - 1; i >= startIndex; i--) {
    const msg = session.messages[i];
    if (msg.role !== "assistant") continue;
    if (msg.stopReason === "error") {
      return (msg as { errorMessage?: string }).errorMessage?.trim() || "provider error with no output";
    }
    if (msg.stopReason === "length" && !extractText(msg.content).trim()) {
      return "run hit the output token limit before producing any text";
    }
    return undefined;
  }
  return undefined;
}

/** SDK cancellation alone proves no human action; bound detection to this execution. */
function finalInterruption(session: AgentSession, startIndex: number): InterruptionCause | undefined {
  for (let i = session.messages.length - 1; i >= startIndex; i--) {
    const message = session.messages[i];
    if (message.role !== "assistant") continue;
    if (message.stopReason === "aborted") return "unknown";
    return undefined;
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

export function resolveConfiguredSessionDir(sessionDir: string | undefined, cwd: string): string | undefined {
  if (!sessionDir) return undefined;
  if (sessionDir === "~" || sessionDir.startsWith("~/")) return resolve(homedir(), sessionDir.slice(2));
  if (isAbsolute(sessionDir)) return sessionDir;
  return resolve(cwd, sessionDir);
}

export type OwnedSessionFile = { ok: true; file: string } | { ok: false; reason: string };

/**
 * Resolve an untrusted child session pointer to its real path only when it sits
 * inside a directory this parent owns: `<agentDir>/subagent-sessions/<parent
 * session id>` or the type's current `session_dir` (resolved against ctx.cwd).
 */
export function resolveOwnedSessionFile(ctx: ExtensionContext, type: string, sessionFile: string): OwnedSessionFile {
  let file: string;
  try {
    file = realpathSync(sessionFile);
  } catch {
    return { ok: false, reason: "session file is missing" };
  }
  const parentSessionId = ctx.sessionManager?.getSessionId?.();
  const roots = [
    parentSessionId ? join(getAgentDir(), SUBAGENT_SESSION_DIR_NAME, parentSessionId) : undefined,
    resolveConfiguredSessionDir(getAgentConfig(type)?.sessionDir, ctx.cwd),
  ];
  for (const root of roots) {
    if (!root) continue;
    let realRoot: string;
    try {
      realRoot = realpathSync(root);
    } catch {
      continue;
    }
    const rel = relative(realRoot, file);
    if (rel && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`)) return { ok: true, file };
  }
  return { ok: false, reason: "session file is outside this session's subagent session directories" };
}

/**
 * Reopen a persisted child session after proving it belongs to this agent and
 * parent. Every refusal throws before anything is created or modified.
 */
function reopenSubagentSession(
  file: string,
  agentId: string | undefined,
  type: string,
  parentFile: string | undefined,
): { sessionManager: SessionManager; launch: SubagentLaunch } {
  // SessionManager.open starts a new session at a missing path and rewrites an empty file.
  if (!existsSync(file) || statSync(file).size === 0) {
    throw new Error(`Cannot resume subagent session: ${file} is missing or empty.`);
  }
  const sessionManager = SessionManager.open(file);
  if (sessionManager.buildSessionContext().messages.length === 0) {
    throw new Error(`Cannot resume subagent session: ${file} has no conversation.`);
  }
  const launch = sessionManager.getEntries()
    .filter((entry) => entry.type === "custom" && entry.customType === SUBAGENT_LAUNCH_ENTRY)
    .at(-1) as { data?: Partial<SubagentLaunch> } | undefined;
  if (launch?.data?.version !== 1) {
    throw new Error(`Cannot resume subagent session: ${file} has no ${SUBAGENT_LAUNCH_ENTRY} entry.`);
  }
  if (launch.data.agentId !== agentId || launch.data.type !== type) {
    throw new Error(`Cannot resume subagent session: ${file} belongs to a different agent.`);
  }
  if (parentFile && sessionManager.getHeader()?.parentSession !== parentFile) {
    throw new Error(`Cannot resume subagent session: ${file} belongs to a different parent session.`);
  }
  return { sessionManager, launch: launch.data as SubagentLaunch };
}

export async function runAgent(
  ctx: ExtensionContext,
  type: SubagentType,
  prompt: string,
  options: RunOptions,
): Promise<RunResult> {
  // An internal definition replaces registry lookup, including the general-purpose fallback.
  const override = options.agentConfig;
  const canonicalType = override?.name ?? resolveType(type) ?? type;
  const guardBash = GUARDED_CANONICAL_AGENT_TYPES.has(canonicalType.toLowerCase());
  const config = override ?? getConfig(type);
  const agentConfig = override ?? getAgentConfig(type);
  // Preserve an already selected candidate, but never let direct options bypass frontmatter.
  const selected: SelectedAgentModel = options.selectedModel && options.selectedModel.modelInput === agentConfig?.model
    ? options.selectedModel
    : agentConfig?.model != null
      ? resolveAgentModel(agentConfig.model, ctx.modelRegistry, ctx.model)
      : options.selectedModel ?? { model: options.model ?? ctx.model };
  const model = selected.model;
  const usingOAuth = !!model && (ctx.modelRegistry.isUsingOAuth?.(model) ?? false);
  if (selected.fast) assertFastSupported(model, usingOAuth);
  const fastPolicy = { enabled: selected.fast === true, usingOAuth, strict: true };
  const thinkingLevel = options.thinkingLevel ?? agentConfig?.thinking ?? selected.thinkingLevel;

  const parentSessionFile = ctx.sessionManager?.getSessionFile?.();
  const parentFile = typeof parentSessionFile === "string" && parentSessionFile.length > 0 ? parentSessionFile : undefined;
  const reopened = options.resumeSessionFile
    ? reopenSubagentSession(options.resumeSessionFile, options.agentId, canonicalType, parentFile)
    : undefined;
  // A reopened session keeps its launch-time per-call options.
  const { isolated, skills } = reopened?.launch ?? options;

  // Resolve working directory: caller-supplied cwd override > reopened session cwd > parent cwd
  const effectiveCwd = options.cwd ?? reopened?.sessionManager.getCwd() ?? ctx.cwd;
  if (reopened && !statSync(effectiveCwd, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`Cannot resume subagent session: working directory ${effectiveCwd} does not exist.`);
  }
  // Filesystem work happens in effectiveCwd; config discovery in configCwd.
  // They differ for SpawnOptions.cwd spawns and reopened sessions (config stays with the parent).
  const configCwd = options.configCwd ?? (reopened ? ctx.cwd : effectiveCwd);

  const env = await detectEnv(options.pi, effectiveCwd);

  // Get parent system prompt for append-mode agents
  const parentSystemPrompt = ctx.getSystemPrompt();

  // Build prompt extras (skill preloading)
  const extras: PromptExtras = {};

  // Resolve access rules: isolated loads no extensions (built-in tools only).
  const extensionRules: readonly AccessRule[] = isolated ? [] : config.extensionRules;
  const toolRules: readonly AccessRule[] = agentConfig?.toolRules ?? config.toolRules;
  const gates: ToolAccessGates = { allowNesting: agentConfig?.allowNesting };
  // discover_skills gates the on-demand skill catalog; preload_skills are eagerly
  // injected into the prompt. They are independent — the catalog can be on while
  // some skills are preloaded. isolated overrides both to off.
  const discoverSkills = isolated ? false : config.discoverSkills;
  const preloadList = isolated ? [] : [...new Set([...config.preloadSkills, ...(skills ?? [])])];

  // Skill preloading: eagerly inject the listed skills' content into the prompt.
  if (preloadList.length > 0) {
    const loaded = preloadSkills(preloadList, configCwd);
    if (loaded.length > 0) {
      extras.skillBlocks = loaded;
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

  if (options.graphRun && !options.structuredOutput) {
    systemPrompt += `

<graph_run_child>
Your final message IS the return value of this task. An agent graph run captures it and passes it to the next stage.
Return only the answer, in exactly the shape the prompt asks for — no preamble, no summary of what you did, no offer to continue.
</graph_run_child>`;
  }

  // noSkills is driven only by discoverSkills; preloaded skills (if any) are already
  // injected into the prompt and are independent of the on-demand skill catalog.
  const noSkills = !discoverSkills;

  // prompt_mode: system_instructions opts in to having pi inject the AGENTS.md walk
  // (global agentDir + cwd→root ancestors) as `# Project Context` AFTER the
  // systemPromptOverride — subagents get project guardrails as a single source of
  // truth. isolated overrides to false (true isolation means no project context).
  const inheritContextFiles = !isolated && agentConfig?.promptMode === "system_instructions";

  const agentDir = getAgentDir();
  // One settings manager for the loader and the session, created with the
  // parent's project-trust decision so an untrusted parent's child never loads
  // project settings or resources. Partial SDK/test contexts keep Pi's default.
  const settingsManager = typeof ctx.isProjectTrusted === "function"
    ? SettingsManager.create(configCwd, agentDir, { projectTrusted: ctx.isProjectTrusted() })
    : SettingsManager.create(configCwd, agentDir);

  // Extension loading: `extensions:` signed rules (last match wins, empty =
  // none) select from discovered extensions plus Pi's built-in extensions.
  // Loading grants nothing — `tools:` rules decide the allowed tools. Rules
  // without a `+` entry load nothing, so the loader skips discovery. Trusted
  // inline hooks survive every rule set; discovered session-local/fast copies
  // never load. Excluded extensions are still evaluated once by Pi's loader
  // before the override filters them — the filter is not a sandbox.
  //
  // Suppress AGENTS.md/CLAUDE.md and APPEND_SYSTEM.md — upstream's
  // buildSystemPrompt() re-appends both AFTER systemPromptOverride, which
  // would defeat prompt_mode: replace and isolated: true. Parent context, if
  // wanted, reaches the subagent via prompt_mode: append (parentSystemPrompt
  // is embedded in systemPromptOverride) or inherit_context (conversation).
  const noExtensions = !extensionRules.some((rule) => rule.sign === "+");
  // Pre-pass over Pi's built-in extensions so unselected factories never run;
  // its diagnostics are ignored (the override reports the full resolution).
  const selectedBuiltins = noExtensions
    ? new Set<string>()
    : resolveExtensionAccess(extensionRules, PI_BUILTIN_EXTENSIONS.map(({ name }) => ({ key: `builtin:${name}`, ids: [`builtin:${name}`] }))).selected;
  // A child loading Pi's MCP extension excludes the MCP tools its rules deny,
  // so codemode and tool_search never list them. Server names come from the
  // same mcp.json files Pi's MCP extension reads (agent dir, child cwd).
  const mcpExcludes = selectedBuiltins.has("builtin:mcp")
    ? mcpToolExcludes(toolRules, gates, options.pi.getAllTools(), [
      join(agentDir, "mcp.json"),
      join(effectiveCwd, CONFIG_DIR_NAME, "mcp.json"),
    ])
    : { excludeTools: [], deniedNamespaces: [] };
  let extensionDiagnostics: AccessDiagnostic[] = [];
  const extensionsOverride = (base: LoadExtensionsResult): LoadExtensionsResult => {
    const candidates: ExtensionCandidate[] = [];
    for (const extension of base.extensions) {
      if (TRUSTED_EXTENSION_PATHS.has(extension.path)) continue;
      const ids = extensionIdsForPath(extension.path);
      if (ids.includes(TRUSTED_SESSION_LOCAL_EXTENSION_NAME) || ids.includes("fast")) continue;
      candidates.push({ key: extension.path, ids });
    }
    const { selected, diagnostics } = noExtensions
      ? { selected: new Set<string>(), diagnostics: [] }
      : resolveExtensionAccess(extensionRules, candidates);
    extensionDiagnostics = diagnostics;
    return {
      ...base,
      extensions: base.extensions.filter((extension) => TRUSTED_EXTENSION_PATHS.has(extension.path) || selected.has(extension.path)),
    };
  };

  const loader = new DefaultResourceLoader({
    cwd: configCwd,
    agentDir,
    settingsManager,
    noExtensions,
    extensionsOverride,
    extensionFactories: [
      ...PI_BUILTIN_EXTENSIONS.filter(({ name }) => selectedBuiltins.has(`builtin:${name}`)).map(({ name, create }) => ({
        name,
        factory: create(),
        builtin: true,
        replaceable: true,
      })),
      {
        name: "subagent-model-fallback",
        hidden: true,
        factory: (extensionPi: ExtensionAPI) => registerRuntimeModelFallback(extensionPi, {
          chain: () => selected.modelInput ?? agentConfig?.model,
          validate: (candidate, childCtx) => { if (candidate.fast) assertFastSupported(candidate.model, childCtx.modelRegistry.isUsingOAuth(candidate.model)); },
          apply: (candidate, childCtx) => {
            fastPolicy.enabled = candidate.fast === true;
            fastPolicy.usingOAuth = childCtx.modelRegistry.isUsingOAuth(candidate.model);
            const level = agentConfig?.thinking ?? candidate.thinkingLevel
              ?? (selected.thinkingLevel === undefined ? options.thinkingLevel : undefined);
            if (level) extensionPi.setThinkingLevel(level);
          },
        }),
      },
      {
        name: "subagent-fast",
        hidden: true,
        factory: (extensionPi: ExtensionAPI) => {
          extensionPi.on("before_provider_request", (event, childCtx) => transformFastPayload(event.payload, childCtx.model, fastPolicy));
          extensionPi.on("before_provider_headers", (event, childCtx) => {
            Object.assign(event.headers, transformFastHeaders(event.headers, childCtx.model, fastPolicy));
          });
        },
      },
      {
        name: TRUSTED_SESSION_LOCAL_EXTENSION_NAME,
        factory: sessionLocalTools,
        hidden: true,
      },
      ...(guardBash ? [{
        name: TRUSTED_SMART_TOOL_GUARDS_EXTENSION_NAME,
        factory: (extensionPi: ExtensionAPI) => {
          registerGuardScopeProvider(extensionPi, "subagents:guarded", () => ({
            decision: "guard",
            reason: "This guarded subagent requires read-only Bash.",
          }));
          smartToolGuards(extensionPi);
        },
        hidden: true,
      }] : []),
      // Enforces `tools:` rules where the session veto cannot reach, against the
      // live registry. Codemode scripts call tools through ctx.executeTool();
      // those nested calls bypass the session.agent.beforeToolCall veto and reach
      // only `tool_call`. The trusted ceiling tool (activated by Pi on
      // registration, re-ensured by the session scope) hides every ungranted
      // declaration from turn 1 on, including tools Pi or an extension
      // activates later.
      ...(noExtensions ? [] : [{
        name: TRUSTED_NESTED_TOOL_SCOPE_EXTENSION_NAME,
        factory: (extensionPi: ExtensionAPI) => {
          const allowedToolNames = () => resolveToolAccess(toolRules, toolCandidates(extensionPi.getAllTools()), gates).allowed;
          extensionPi.on("tool_call", (event) => {
            if (event.parentToolCallId === undefined || allowedToolNames().has(event.toolName)) return;
            return { block: true, reason: `Tool "${event.toolName}" is not available to this subagent.` };
          });
          extensionPi.registerTool(createToolCeilingTool(TOOL_CEILING_TOOL_NAME, allowedToolNames));
          // ponytail: Pi's MCP extension lists every enabled configured server in
          // `mcp_servers`, so drop the fully denied ones (inline factories load
          // after `builtin:mcp`). Removable once Pi lists the section from the
          // allowed tools at startup (earendil-works/pi#10635).
          if (mcpExcludes.deniedNamespaces.length > 0) {
            const deniedLines = mcpExcludes.deniedNamespaces.map((namespace) => `- ${namespace} (`);
            extensionPi.on("before_agent_start", (event) => {
              const { sections } = event.systemPromptOptions;
              const section = sections[MCP_SERVERS_SECTION];
              if (section === undefined) return;
              const lines = section.split("\n").filter((line) => !deniedLines.some((prefix) => line.startsWith(prefix)));
              if (lines.some((line) => line.startsWith("- mcp__"))) sections[MCP_SERVERS_SECTION] = lines.join("\n");
              else delete sections[MCP_SERVERS_SECTION];
            });
          }
        },
        hidden: true,
      }]),
    ],
    noSkills,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: !inheritContextFiles,
    systemPromptOverride: () => systemPrompt,
    appendSystemPromptOverride: () => [],
  });
  await loader.reload();

  // An ambiguous extension id fails the spawn before any session exists; a
  // zero-match id only warns.
  const extensionErrors = extensionDiagnostics.filter((d) => d.severity === "error");
  if (extensionErrors.length > 0) {
    throw new Error(`Agent "${type}" extensions: ${extensionErrors.map((d) => d.message).join("; ")}`);
  }
  for (const diagnostic of extensionDiagnostics) {
    options.onToolActivity?.({
      type: "diagnostic",
      toolName: `extension-warning:${diagnostic.message} (agent "${type}")`,
    });
  }

  // ─── Tool scoping ───────────────────────────────────────────────────────
  //
  // `tools:` rules decide the allowed set, independent of loading (an extension
  // that did not load contributes no tools). Built-in tools are name-only, so
  // their grant resolves up front.
  //
  // Some extensions register their tools ASYNCHRONOUSLY, long after the
  // `loader.reload()` above: pi-mcp calls registerTool from `session_start`
  // (once its MCP servers connect), context-mode from `before_agent_start`.
  // So the tool set cannot be snapshotted here. pi's `allowedToolNames` gates
  // tool *registration*, not merely the active set, and is frozen at
  // construction — a name absent from the snapshot is dropped forever, even
  // once the tool actually registers (#125).
  //
  // Whenever extensions are in play we therefore:
  //   - leave `allowedToolNames` unset, so pi's live gate admits tools whenever
  //     they register;
  //   - express the name-stable, permanent part of the scope (our own
  //     orchestration tools, ungranted built-ins, and the MCP tools the rules
  //     deny: whole servers by `mcp__<server>__*`, others by name) as
  //     `excludeTools`, which pi re-applies on every registry refresh, so
  //     those tools never reach the codemode or tool_search catalogs;
  //   - leave activation to Pi (defaults/`defaultTools`, extension tools on
  //     registration) and the owning extensions; `tools:` only permits;
  //   - re-resolve the rules against the live registry: top-level calls are
  //     vetoed, the hidden nested-tool-scope hook blocks nested calls, and its
  //     ceiling tool hides ungranted declarations (kept active after bind and
  //     on every turn_end).
  //
  // Without extensions (including `isolated`), the granted built-ins are a
  // static allowlist: nothing async can appear, and a hard registry gate is the
  // correct boundary.
  const grantedBuiltinSet = resolveToolAccess(toolRules, BUILTIN_TOOL_NAMES.map((name) => ({ name, extensionIds: [] })), gates).allowed;
  const grantedBuiltins = BUILTIN_TOOL_NAMES.filter((name) => grantedBuiltinSet.has(name));

  let sessionTools: string[] | undefined;
  let sessionExcludeTools: string[] | undefined;
  if (noExtensions) {
    sessionTools = grantedBuiltins;
  } else {
    sessionExcludeTools = [
      ...EXCLUDED_TOOL_NAMES,
      ...BUILTIN_TOOL_NAMES.filter((name) => !grantedBuiltinSet.has(name)),
      ...mcpExcludes.excludeTools,
    ];
  }

  let sessionManager: SessionManager;
  if (reopened) {
    sessionManager = reopened.sessionManager;
  } else {
    const configuredSessionDir = resolveConfiguredSessionDir(agentConfig?.sessionDir, effectiveCwd);
    const defaultSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR ?? settingsManager.getSessionDir?.();
    const subagentSessionsDir = options.parentSessionId
      ? join(getAgentDir(), SUBAGENT_SESSION_DIR_NAME, options.parentSessionId)
      : undefined;
    const sessionDir = configuredSessionDir ?? subagentSessionsDir ?? defaultSessionDir;
    sessionManager = SessionManager.create(effectiveCwd, sessionDir, parentFile ? { parentSession: parentFile } : undefined);
  }

  // Persist the parent branch's effective Agent-tree scope before the session
  // runtime exists, so session-local hooks observe it from their first bind.
  // Reopened sessions are re-seeded so the file cannot choose the root.
  // Direct SDK/test callers may provide a partial context; they retain the
  // historical child-local fallback instead of failing before session creation.
  if (ctx.sessionManager) {
    seedSessionLocalScope(ctx, sessionManager);
  }
  if (!reopened) {
    const launch: SubagentLaunch = {
      version: 1,
      agentId: options.agentId,
      type: canonicalType,
      isolated: options.isolated,
      skills: options.skills,
    };
    sessionManager.appendCustomEntry(SUBAGENT_LAUNCH_ENTRY, launch);
  }

  // Pi 0.80.8 replaced createAgentSession's modelRegistry option with
  // modelRuntime, but ExtensionContext still exposes only the registry facade.
  // Pass both so the full supported Pi range retains the parent's providers.
  const parentModelRuntime = (ctx.modelRegistry as unknown as { runtime?: ModelRuntime }).runtime;
  const sessionOpts: Parameters<typeof createAgentSession>[0] & {
    modelRegistry: ExtensionContext["modelRegistry"];
    modelRuntime?: ModelRuntime;
  } = {
    cwd: effectiveCwd,
    agentDir,
    sessionManager,
    settingsManager,
    modelRegistry: ctx.modelRegistry,
    ...(parentModelRuntime !== undefined && { modelRuntime: parentModelRuntime }),
    model,
    tools: sessionTools,
    resourceLoader: loader,
  };
  if (sessionExcludeTools) {
    sessionOpts.excludeTools = sessionExcludeTools;
  }
  if (thinkingLevel) {
    sessionOpts.thinkingLevel = thinkingLevel;
  }

  const structuredCapture = options.structuredOutput ? createStructuredCapture() : undefined;
  if (options.structuredOutput && structuredCapture) {
    sessionOpts.customTools = [createStructuredOutputTool(options.structuredOutput, structuredCapture)];
    sessionOpts.tools?.push(STRUCTURED_OUTPUT_TOOL_NAME);
  }
  const { session } = await createAgentSession(sessionOpts);
  sessionFastPolicies.set(session, fastPolicy);
  if (structuredCapture) rememberStructuredCapture(session, structuredCapture);

  const baseSessionName = agentConfig?.name ?? type;
  session.setSessionName(
    options.agentId ? `${baseSessionName}#${options.agentId.slice(0, 8)}` : baseSessionName,
  );

  // Bind extensions so that session_start fires and extensions can initialize
  // (e.g. loading credentials, setting up state). All ExtensionBindings fields
  // are optional.
  await session.bindExtensions({
    onError: (err) => {
      options.onToolActivity?.({
        type: "diagnostic",
        toolName: `extension-error:${err.extensionPath}`,
      });
    },
  });

  // With `allowedToolNames` unset, the registry is scoped by `excludeTools` and
  // Pi activates its default built-ins plus every direct/model-only extension
  // tool on registration. Rules over extension tools have no registry-level
  // expression (we can't deny the name of a tool that hasn't registered yet), so
  // scope is re-derived from the session's live tool list — `registerTool` grows
  // that list, so late arrivals are judged too.
  if (!noExtensions) {
    installExtensionToolScope(session, {
      toolRules,
      gates,
      ceilingToolName: TOOL_CEILING_TOOL_NAME,
      onDiagnostics: (diagnostics) => {
        for (const diagnostic of diagnostics) {
          options.onToolActivity?.({
            type: "diagnostic",
            toolName: `tools-${diagnostic.severity}:${diagnostic.message} (agent "${type}")`,
          });
        }
      },
    });
  }

  options.onSessionCreated?.(session);

  // Track turns for graceful max_turns enforcement
  let turnCount = 0;
  // A reopened run enforces no turn limit, like a live in-memory resume.
  const maxTurns = reopened ? undefined : normalizeMaxTurns(options.maxTurns ?? agentConfig?.maxTurns ?? defaultMaxTurns);
  let softLimitReached = false;
  let aborted = false;
  let interruptionCause: InterruptionCause | undefined;

  let currentMessageText = "";
  let completedTools = 0;
  let allToolsTerminate = true;
  const unsubTurns = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "turn_end") {
      turnCount++;
      options.onTurnEnd?.(turnCount);
      const unfinished = event.message.role === "assistant"
        && event.message.stopReason !== "error" && event.message.stopReason !== "aborted"
        && event.message.content.some((block) => block.type === "toolCall")
        && !(completedTools > 0 && allToolsTerminate);
      completedTools = 0;
      allToolsTerminate = true;
      if (maxTurns != null && unfinished) {
        if (!softLimitReached && turnCount >= maxTurns) {
          softLimitReached = true;
          session.steer("You have reached your turn limit. Wrap up immediately — provide your final answer now.");
        } else if (softLimitReached && turnCount >= maxTurns + graceTurns) {
          aborted = true;
          interruptionCause = "turn-limit";
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
      completedTools++;
      allToolsTerminate = allToolsTerminate && event.result?.terminate === true;
      options.onToolActivity?.({ type: "end", toolName: event.toolName });
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      const u = event.message.usage;
      if (u) options.onAssistantUsage?.({
        input: u.input ?? 0,
        output: u.output ?? 0,
        cacheWrite: u.cacheWrite ?? 0,
        cacheRead: u.cacheRead ?? 0,
        cost: u.cost?.total ?? 0,
      });
    }
    if (event.type === "compaction_end" && !event.aborted && event.result) {
      options.onCompaction?.({ reason: event.reason, tokensBefore: event.result.tokensBefore });
    }
  });

  const collector = collectResponseText(session, undefined, options.onProgress);
  const cleanupAbort = forwardAbortSignal(session, options.signal);

  // Build the effective prompt: optionally prepend parent context (fresh spawns only)
  let effectivePrompt = prompt;
  if (options.inheritContext && !reopened) {
    const parentContext = buildParentContext(ctx);
    if (parentContext) {
      effectivePrompt = parentContext + prompt;
    }
  }

  // Boundary for the history fallback: only assistant text produced from here
  // on counts as this run's output (0 for a fresh session).
  const startLen = session.messages.length;
  let structuredRetried = false;
  let failure: string | undefined;
  try {
    if (options.signal?.aborted) { aborted = true; interruptionCause = "unknown"; }
    else {
      await session.prompt(effectivePrompt);
      await session.waitForIdle();
      if (structuredCapture && !aborted && !options.signal?.aborted && !finalTurnError(session, startLen) && !finalInterruption(session, startLen)) {
        structuredRetried = await repairStructuredOutput(session, structuredCapture);
      }
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    // A rejected prompt or an abort request does not prove SDK settlement.
    try {
      await session.waitForIdle();
    } finally {
      unsubTurns();
      collector.unsubscribe();
      cleanupAbort();
    }
  }

  const responseText = collector.getText().trim() || getLastAssistantText(session, startLen);
  interruptionCause ??= options.signal?.aborted ? "unknown" : finalInterruption(session, startLen);
  return { responseText, session, aborted: interruptionCause !== undefined, interruptionCause, steered: softLimitReached,
    structuredJson: structuredCapture?.json, structuredRetried,
    failure: failure ?? finalTurnError(session, startLen) ?? structuredFailure(structuredCapture),
  };
}

/**
 * Send a new prompt to an existing session (resume).
 */
export async function resumeAgent(
  session: AgentSession,
  prompt: string,
  options: {
    onToolActivity?: (activity: ToolActivity) => void;
    onTextDelta?: RunOptions["onTextDelta"];
    onProgress?: RunOptions["onProgress"];
    onTurnEnd?: (turnCount: number) => void;
    onAssistantUsage?: (usage: LifetimeUsage) => void;
    onCompaction?: (info: { reason: "manual" | "threshold" | "overflow"; tokensBefore: number }) => void;
    signal?: AbortSignal;
  } = {},
): Promise<{ text: string; failure?: string; interruptionCause?: InterruptionCause; structuredJson?: string; structuredRetried?: boolean }> {
  // Boundary for the history fallback: the session already holds prior turns,
  // so only assistant text produced by THIS resume prompt counts as its output
  // — a failed resume must not surface the previous turn's answer (#144).
  const startLen = session.messages.length;
  const collector = collectResponseText(session, options.onTextDelta, options.onProgress);
  const cleanupAbort = forwardAbortSignal(session, options.signal);

  let turnCount = 0;
  const unsubEvents = (options.onToolActivity || options.onTurnEnd || options.onAssistantUsage || options.onCompaction)
    ? session.subscribe((event: AgentSessionEvent) => {
        if (event.type === "turn_end") options.onTurnEnd?.(++turnCount);
        if (event.type === "tool_execution_start") options.onToolActivity?.({ type: "start", toolName: event.toolName });
        if (event.type === "tool_execution_end") options.onToolActivity?.({ type: "end", toolName: event.toolName });
        if (event.type === "message_end" && event.message.role === "assistant") {
          const u = event.message.usage;
          if (u) options.onAssistantUsage?.({
            input: u.input ?? 0,
            output: u.output ?? 0,
            cacheWrite: u.cacheWrite ?? 0,
            cacheRead: u.cacheRead ?? 0,
            cost: u.cost?.total ?? 0,
          });
        }
        if (event.type === "compaction_end" && !event.aborted && event.result) {
          options.onCompaction?.({ reason: event.reason, tokensBefore: event.result.tokensBefore });
        }
      })
    : () => {};

  const capture = takeStructuredCapture(session);
  if (capture) { capture.json = undefined; capture.called = false; capture.lastError = undefined; }
  let structuredRetried = false;
  let failure: string | undefined;
  try {
    if (!options.signal?.aborted) {
      await session.prompt(prompt);
      await session.waitForIdle();
      if (capture && !options.signal?.aborted && !finalTurnError(session, startLen) && !finalInterruption(session, startLen)) {
        structuredRetried = await repairStructuredOutput(session, capture);
      }
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    try {
      await session.waitForIdle();
    } finally {
      collector.unsubscribe();
      unsubEvents();
      cleanupAbort();
    }
  }

  return {
    text: collector.getText().trim() || getLastAssistantText(session, startLen),
    interruptionCause: options.signal?.aborted ? "unknown" : finalInterruption(session, startLen),
    failure: failure ?? finalTurnError(session, startLen) ?? structuredFailure(capture),
    structuredJson: capture?.json, structuredRetried,
  };
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

/**
 * Get the subagent's conversation messages as formatted text.
 */
export function getAgentConversation(session: AgentSession): string {
  return formatAgentConversation(session.messages);
}

/** Format conversation messages (live session or read-only transcript) as text. */
export function formatAgentConversation(messages: readonly AgentSession["messages"][number][]): string {
  const parts: string[] = [];

  for (const msg of messages) {
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
        else if (c.type === "toolCall") toolCalls.push(`  Tool: ${(c as any).name ?? (c as any).toolName ?? "unknown"}`);
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
