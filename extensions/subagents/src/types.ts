/**
 * types.ts — Type definitions for the subagent system.
 */

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { AccessRule } from "../../lib/active-tools.js";
import type { GraphRunEntryData } from "./graph/entry.js";
import type { LifetimeUsage, SessionLike } from "./usage.js";

export type ThinkingLevel = AgentSession["thinkingLevel"];

/** Agent type: any string name (built-in defaults or user-defined). */
export type SubagentType = string;

/** Names of the three embedded default agents. */
export const DEFAULT_AGENT_NAMES = ["general-purpose", "Explore", "Plan"] as const;

/** Structured diagnostic emitted while loading agent frontmatter. */
export interface AgentDefinitionDiagnostic {
  file: string;
  agentName: string;
  field: string;
  severity: "warning" | "error";
  message: string;
}

/** Result from loading custom agents with diagnostics. */
export interface CustomAgentsLoadResult {
  agents: Map<string, AgentConfig>;
  diagnostics: AgentDefinitionDiagnostic[];
}

/** Unified agent configuration — used for both default and user-defined agents. */
export interface AgentConfig {
  name: string;
  displayName?: string;
  description: string;
  /** Signed `extensions:` rules deciding which extensions load; last match wins, empty = none load. */
  extensionRules: AccessRule[];
  /** Signed `tools:` rules deciding which tools the agent may use; last match wins, empty = no tools. */
  toolRules: AccessRule[];
  /** Agent allowlist — only these subagents may be delegated to. */
  allowDelegationTo?: string[];
  /** Agent denylist — these subagents may not be delegated to. */
  disallowDelegationTo?: string[];
  /** Permits allowlisted nested launch, retrieval, steering, and graph-gate resolution tools. */
  allowNesting?: boolean;
  /** When true, pi's skill catalog is discoverable on demand. Default true. */
  discoverSkills: boolean;
  /** Skill names whose full content is eagerly injected into the system prompt. Default []. */
  preloadSkills: string[];
  model?: string;
  thinking?: ThinkingLevel;
  maxTurns?: number;
  /** Write the subagent's .output transcript. Defaults to true; false suppresses only that transcript. */
  outputTranscript?: boolean;
  /** Session file directory override; when set it always wins over the default subagent session location. */
  sessionDir?: string;
  systemPrompt: string;
  promptMode: "replace" | "append" | "system_instructions";
  /** Default for spawn: fork parent conversation. undefined = caller decides. */
  inheritContext?: boolean;
  /** Default for spawn: run in background. undefined = caller decides. */
  runInBackground?: boolean;
  /** Default for spawn: no extension tools. undefined = caller decides. */
  isolated?: boolean;
  /** true = this is an embedded default agent (informational) */
  isDefault?: boolean;
  /** false = agent is hidden from the registry */
  enabled?: boolean;
  /** Where this agent was loaded from */
  source?: "default" | "project" | "global";
}

export type JoinMode = 'async' | 'group' | 'smart';

/**
 * Display mode for the persistent above-editor agent widget.
 * - `all`: show every agent (foreground + background).
 * - `background`: hide foreground agents (they already render inline as the
 *   `agent` tool result, #118); show background/queued/scheduled/RPC.
 * - `off`: hide the widget entirely.
 */
export type WidgetMode = 'all' | 'background' | 'off';

/** Per-agent live activity state. */
export interface AgentActivity {
  activeTools: Map<string, string>;
  toolUses: number;
  responseText: string;
  session?: SessionLike;
  /** Current turn count. */
  turnCount: number;
  /** Effective max turns for this agent (undefined = unlimited). */
  maxTurns?: number;
  /** Lifetime usage breakdown — see LifetimeUsage docs. */
  lifetimeUsage: LifetimeUsage;
  /** Wall-clock ms of the last observed progress signal (tool activity, text delta,
   * turn end, or assistant usage). Consumed by background supervision to detect idle. */
  lastProgressAt?: number;
}

export type InterruptionCause = "user" | "caller" | "lifecycle" | "supervisor-idle" | "supervisor-ceiling" | "turn-limit" | "unknown";

export interface AgentRecord {
  interruptionCause?: InterruptionCause;
  /** Internal execution correlation; changes on resume, not the public agent ID. */
  executionId?: string;
  /** Manager-owned activity for the most recently started execution; queued resumes retain it. */
  activity?: AgentActivity;
  /** Graph-run-owned children retain accounting but report through their graph run. */
  graphRunId?: string;
  cwd?: string;
  structuredJson?: string;
  structuredRetried?: boolean;
  id: string;
  type: SubagentType;
  description: string;
  status: "queued" | "running" | "completed" | "steered" | "aborted" | "stopped" | "error";
  result?: string;
  error?: string;
  toolUses: number;
  diagnostics?: string[];
  turnCount?: number;
  maxTurns?: number;
  startedAt: number;
  completedAt?: number;
  session?: AgentSession;
  /** Persisted child session JSONL path; set only when the child session is persisted. */
  sessionFile?: string;
  abortController?: AbortController;
  promise?: Promise<string>;
  groupId?: string;
  joinMode?: JoinMode;
  /** Set when retrieval consumed the result via get_agent_result — suppresses completion notification. */
  resultConsumed?: boolean;
  /** Steering messages queued before the session was ready. */
  pendingSteers?: string[];
  /** The tool_use_id from the original `agent` tool call. */
  toolCallId?: string;
  /** Path to the streaming output transcript file. */
  outputFile?: string;
  /** Cleanup function for the output file stream subscription. */
  outputCleanup?: () => void;
  /**
   * Lifetime usage breakdown, accumulated via `message_end` events. Survives
   * compaction. Total = input + output + cacheWrite (cacheRead deliberately
   * excluded — see issue #38). Initialized to zeros at spawn.
   */
  lifetimeUsage: LifetimeUsage;
  /** Lifetime cost in USD, accumulated via `message_end` events. Separate from lifetimeUsage (tokens-only). */
  lifetimeCost?: number;
  /** Number of times this agent's session has compacted. Initialized to 0 at spawn. */
  compactionCount: number;
  /**
   * Whether this agent was spawned to run in the background. Tri-state, set at
   * spawn from `SpawnOptions.isBackground`: `true` = background, `false` =
   * foreground (has an inline `agent` tool-result surface), `undefined` = the
   * caller never declared it (e.g. a cross-extension RPC spawn, which is detached
   * and has no inline surface). The widget's background-only filter keys off this
   * — and excludes only explicit `false`, so `undefined` agents stay visible.
   * Reliable across ALL spawn paths, unlike the UI-only `invocation` snapshot,
   * which only the `agent` tool path populates.
   */
  isBackground?: boolean;
  /** Effective runtime metadata, refreshed from the retained session. */
  invocation?: AgentInvocation;
  /** Wall-clock ms of the last auto-steer emitted by background supervision (cooldown gate). */
  lastSupervisionSteerAt?: number;
  /** Wall-clock ms of the last auto-abort emitted by background supervision (one-shot gate). */
  lastSupervisionAbortAt?: number;
}

/**
 * Agent-history index entry for a run no longer in the live map. Structurally
 * the persisted history run, so the manager never imports agent-history.
 * The session file pointer is untrusted until containment is checked.
 */
export interface EvictedAgent {
  id: string;
  type: string;
  description: string;
  status: "running" | "completed" | "steered" | "aborted" | "stopped" | "error";
  startedAt: number;
  completedAt?: number;
  toolUses: number;
  lifetimeUsage: { input: number; output: number; cacheWrite: number };
  sessionFile: string;
}

export function agentExecutionKey(record: Pick<AgentRecord, "id" | "executionId">): string {
  return record.executionId ? `${record.id}:${record.executionId}` : record.id;
}

export interface AgentInvocation {
  /** Original caller/configuration intent, retained across resume. */
  requestedModel?: string;
  requestedThinking?: ThinkingLevel;
  /** Actual provider/model ID; absent until a session exists. */
  modelName?: string;
  thinking?: AgentSession["thinkingLevel"];
  /** Captured runner Fast policy; absent before session creation. */
  fast?: boolean;
  /** Configuration intent only: omitted thinking uses SDK defaults, not an actual level. */
  thinkingDefault?: boolean;
  maxTurns?: number;
  isolated?: boolean;
  inheritContext?: boolean;
  runInBackground?: boolean;
}

/** Details attached to custom notification messages for visual rendering. */
export interface NotificationDetails {
  interruptionCause?: InterruptionCause;
  id: string;
  description: string;
  status: string;
  toolUses: number;
  turnCount: number;
  maxTurns?: number;
  totalTokens: number;
  durationMs: number;
  outputFile?: string;
  error?: string;
  resultPreview: string;
  /** Complete graph run presentation, independent of live task retention. */
  graphRun?: GraphRunEntryData;
  /** Additional agents in a group notification. */
  others?: NotificationDetails[];
}

export interface EnvInfo {
  isGitRepo: boolean;
  branch: string;
  platform: string;
}
