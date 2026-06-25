/**
 * Subagent event channel contracts and RPC namespace.
 *
 * Defines the 8 lifecycle event channels (`pi.events.emit`), their payload
 * shapes, and the shared RPC namespace for subagent method calls. Frozen wire
 * contract (see extensions/CONVENTIONS.md). No runtime logic; declarations only.
 */

/** RPC namespace for subagent methods. */
export const SUBAGENTS_RPC_NAMESPACE = "subagents" as const;

/** Emitted when a new subagent is created. */
export const SUBAGENTS_CREATED = "subagents:created" as const;

/** Emitted when a subagent starts execution. */
export const SUBAGENTS_STARTED = "subagents:started" as const;

/** Emitted when a subagent is steered (mid-execution feedback). */
export const SUBAGENTS_STEERED = "subagents:steered" as const;

/** Emitted when a subagent completes successfully. */
export const SUBAGENTS_COMPLETED = "subagents:completed" as const;

/** Emitted when a subagent fails. */
export const SUBAGENTS_FAILED = "subagents:failed" as const;

/** Emitted when the subagent supervisor is ready. */
export const SUBAGENTS_READY = "subagents:ready" as const;

/** Emitted when subagent settings are loaded. */
export const SUBAGENTS_SETTINGS_LOADED = "subagents:settings_loaded" as const;

/** Emitted when subagent settings are changed. */
/** Emitted when subagent settings are changed. */
export const SUBAGENTS_SETTINGS_CHANGED = "subagents:settings_changed" as const;

/** Emitted when a subagent's session is compacted. */
export const SUBAGENTS_COMPACTED = "subagents:compacted" as const;

/**
 * Event payload type map, keyed by channel name.
 * Each channel name maps to its exact payload shape.
 */
export type SubagentEventPayloads = {
  "subagents:created": {
    id: string;
    type: string;
    description: string;
    isBackground: boolean;
  };
  "subagents:started": {
    id: string;
    type: string;
    description: string;
  };
  "subagents:steered": {
    id: string;
    message: string;
  };
  "subagents:completed": {
    id: string;
    type: string;
    description: string;
    result?: string;
    error?: string;
    status: string;
    toolUses: number;
    durationMs: number;
    tokens: string;
    outputFile?: string;
    sessionFile?: string;
    sessionDir?: string;
    parentSessionId?: string;
    toolCallId?: string;
    modelLabel?: string;
    contextPercent?: number | null;
  };
  "subagents:failed": {
    id: string;
    type: string;
    description: string;
    result?: string;
    error?: string;
    status: string;
    toolUses: number;
    durationMs: number;
    tokens: string;
    outputFile?: string;
    sessionFile?: string;
    sessionDir?: string;
    parentSessionId?: string;
    toolCallId?: string;
    modelLabel?: string;
    contextPercent?: number | null;
  };
  "subagents:ready": Record<string, never>;
  "subagents:settings_loaded": {
    settings: {
      maxConcurrent?: number;
      defaultMaxTurns?: number;
      graceTurns?: number;
    };
  };
  "subagents:settings_changed": {
    settings: {
      maxConcurrent?: number;
      defaultMaxTurns?: number;
      graceTurns?: number;
    };
    persisted: boolean;
  };
  "subagents:compacted": {
    id: string;
    type: string;
    reason: string;
    tokensBefore: number;
    compactionCount: number;
  };
};
