/**
 * types.ts — Type definitions for the subagent system.
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { AgentRun } from "./agent-run.js";
import type { LifetimeUsage } from "./usage.js";

export type { ThinkingLevel };

/** Parent-visible outcome of a fresh invocation or resume attempt. */
export type AgentInvocationStatus = "started_new" | "resumed_live" | "restored_session" | "failed";

/** Stable machine-readable reason why persisted session restoration failed. */
export type RestoreFailureReason =
  | "target_unknown"
  | "target_busy"
  | "scope_mismatch"
  | "session_file_missing"
  | "session_corrupt_or_unsupported"
  | "cwd_unavailable"
  | "agent_config_unavailable"
  | "model_unavailable"
  | "tools_extensions_incompatible"
  | "unsafe_interrupted_operation"
  | "persistence_failed"
  | "runtime_initialization_failed";

/** Typed result of an explicit resume request; resume never starts a replacement. */
export type AgentResumeResult =
  | { status: "resumed_live"; id: string }
  | { status: "restored_session"; id: string }
  | { status: "failed"; id: string; reason: RestoreFailureReason; error: string };

/** Agent type: any string name (built-in defaults or user-defined). */
export type SubagentType = string;

/** Serializable extension identity used for runtime compatibility checks. */
export interface ResumeExtensionIdentity {
  name: string;
  contentHash: string;
}

/** Serializable runtime snapshot used to reject incompatible restored sessions. */
export interface ResumeRuntimeSnapshot {
  piVersion: string;
  model: { provider: string; id: string; api: string };
  thinkingLevel: ThinkingLevel;
  promptMode: "replace" | "append" | "system_instructions";
  isolated: boolean;
  inheritContext: boolean;
  systemPromptHash: string;
  resourcePolicyHash: string;
  agentConfigHash: string;
  extensionIdentities: ResumeExtensionIdentity[];
  activeToolNames: string[];
}

/** Last durable execution state for a resume target. */
export interface ResumeTargetState {
  status: "queued" | "running" | "completed" | "steered" | "aborted" | "stopped" | "error";
  resultConsumed: boolean;
  notified: boolean;
  toolUses: number;
  lifetimeUsage: LifetimeUsage;
  lifetimeCost: number;
  compactionCount: number;
}

/** Version 1 durable lookup metadata for one logical child conversation. */
export interface ResumeTargetV1 {
  version: 1;
  id: string;
  generation: number;
  revision: number;
  parentSessionId: string;
  sessionFile: string;
  sessionDir: string;
  childSessionId: string;
  entryCount: number;
  activeLeafId: string;
  sessionSha256: string;
  type: SubagentType;
  description: string;
  cwd: string;
  isBackground: boolean;
  createdAt: number;
  updatedAt: number;
  runtime: ResumeRuntimeSnapshot;
  state: ResumeTargetState;
}


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
  /** Built-in allowlist from `builtin_tools`; undefined = all built-ins. */
  builtinToolNames?: string[];
  /** Extension tool allowlist from `extension_tools`; undefined = all extension tools, [] = none. */
  extensionToolNames?: string[];
  /** Runtime-only compatibility for obsolete tool denylist behavior; frontmatter denylist fields are invalid. */
  disallowedTools?: string[];
  /** Agent allowlist — only these subagents may be delegated to. */
  allowDelegationTo?: string[];
  /** Agent denylist — these subagents may not be delegated to. */
  disallowDelegationTo?: string[];
  /** When true, subagent keeps Agent/get_subagent_result/steer_subagent tools (can delegate). */
  allowNesting?: boolean;
  /** true = inherit all, string[] = only listed, false = none */
  extensions: true | string[] | false;
  excludeExtensions?: string[];
  /** true = inherit all, string[] = only listed, false = none */
  skills: true | string[] | false;
  model?: string;
  maxTurns?: number;
  thinking?: ThinkingLevel;
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

export interface AgentRecord {
  id: string;
  type: SubagentType;
  description: string;
  status: "queued" | "running" | "completed" | "steered" | "aborted" | "stopped" | "error";
  result?: string;
  error?: string;
  toolUses: number;
  startedAt: number;
  completedAt?: number;
  /** Source of the current continuation epoch, when resumed. */
  resumeSource?: "live" | "restored";
  /** Stable restore failure code for the latest failed attempt. */
  restoreFailureReason?: RestoreFailureReason;
  session?: AgentSession;
  abortController?: AbortController;
  promise?: Promise<string>;
  /** Resolved provider/model label shown in the widget (e.g. "anthropic/claude-sonnet-4-6"). */
  modelLabel?: string;
  /** Set when result was already consumed via get_subagent_result — suppresses completion notification. */
  resultConsumed?: boolean;
  /** Set when completion notification was already sent — suppresses duplicate notification. */
  notified?: boolean;
  /** Number of active get_subagent_result waiters currently supervising this agent. */
  waitingConsumers?: number;
  /** Steering messages queued before the session was ready. */
  pendingSteers?: string[];
  /** The tool_use_id from the original Agent tool call. */
  toolCallId?: string;
  /** Path to the streaming output transcript file. */
  outputFile?: string;
  /** Directory containing this agent's persistent pi session JSONL. */
  sessionDir?: string;
  /** Path to the persistent pi session JSONL (normally under ~/.pi/agent/subagent-sessions/). */
  sessionFile?: string;
  /** Parent/main pi session id that launched this subagent. */
  parentSessionId?: string;
  /** Cleanup function for the output file stream subscription. */
  outputCleanup?: () => void;
  /** Cleanup function for any externally bound abort signal listener. */
  externalAbortCleanup?: () => void;
  /** Suppress completion/failure follow-up notifications for this record. */
  suppressNotification?: boolean;
  /** True when the agent was launched in background mode. */
  isBackground?: boolean;
  /** Last time background supervision auto-steered this agent for idleness. */
  lastSupervisionSteerAt?: number;
  /** Last time background supervision auto-aborted this agent for idleness. */
  lastSupervisionAbortAt?: number;
  /** Last time the parent called get_subagent_result for this agent. */
  lastPolledAt?: number;
  /** Phase 1 (dormant): single-source-of-truth run state, populated alongside this record. */
  run?: AgentRun;
  /** Accumulated token usage excluding cacheRead inflation. */
  lifetimeUsage?: LifetimeUsage;
  /** Accumulated per-message cost (USD, list pricing, includes cacheRead). Monotonic; survives compaction. */
  lifetimeCost?: number;
  /** Number of successful compactions for this agent's session. */
  compactionCount?: number;
}

/** Details attached to custom notification messages for visual rendering. */
export interface NotificationDetails {
  id: string;
  description: string;
  status: string;
  toolUses: number;
  turnCount: number;
  maxTurns?: number;
  totalTokens: number;
  contextPercent?: number | null;
  durationMs: number;
  outputFile?: string;
  sessionFile?: string;
  error?: string;
  resultPreview: string;
  /** Additional agents in a group notification. */
  others?: NotificationDetails[];
}

export interface EnvInfo {
  isGitRepo: boolean;
  branch: string;
  platform: string;
}
