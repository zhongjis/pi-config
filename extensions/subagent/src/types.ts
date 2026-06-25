/**
 * types.ts — Type definitions for the subagent system.
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { AgentRun } from "./agent-run.js";
import type { LifetimeUsage } from "./usage.js";

export type { ThinkingLevel };

/** Agent type: any string name (built-in defaults or user-defined). */
export type SubagentType = string;


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
