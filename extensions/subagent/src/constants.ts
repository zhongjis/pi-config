/**
 * unit: ms
 * source: extensions/subagent/src/background-supervision.ts:1
 * rationale: preserve the supervision poll cadence.
 */
export const BACKGROUND_SUPERVISION_INTERVAL_MS = 30_000;

/**
 * unit: ms
 * source: extensions/subagent/src/background-supervision.ts:2
 * rationale: preserve the steer threshold.
 */
export const BACKGROUND_STALE_STEER_AFTER_MS = 2 * 60_000;

/**
 * unit: ms
 * source: extensions/subagent/src/background-supervision.ts:3
 * rationale: preserve the abort threshold.
 */
export const BACKGROUND_STALE_ABORT_AFTER_MS = 5 * 60_000;

/**
 * unit: ms
 * source: extensions/subagent/src/background-supervision.ts:4
 * rationale: preserve the supervision cooldown.
 */
export const BACKGROUND_SUPERVISION_COOLDOWN_MS = 2 * 60_000;

/**
 * unit: ms
 * source: extensions/subagent/src/background-supervision.ts:5
 * rationale: preserve the absolute supervision ceiling.
 */
export const DEFAULT_SUBAGENT_SUPERVISION_CEILING_MS = 30 * 60_000;

/**
 * unit: count
 * source: extensions/subagent/src/agent-manager.ts:21
 * rationale: preserve the default background concurrency limit.
 */
export const SUBAGENT_BACKGROUND_MAX_CONCURRENT = 4;

/**
 * unit: ms
 * source: extensions/subagent/src/agent-manager.ts:77
 * rationale: preserve the cleanup timer cadence.
 */
export const SUBAGENT_BACKGROUND_CLEANUP_INTERVAL_MS = 60_000;

/**
 * unit: ms
 * source: extensions/subagent/src/agent-manager.ts:398
 * rationale: preserve the completed-agent retention window.
 */
export const SUBAGENT_BACKGROUND_CLEANUP_AFTER_MS = 10 * 60_000;

/**
 * unit: ms
 * source: extensions/subagent/src/index.ts:413
 * rationale: preserve the recent-poll suppression window.
 */
export const SUBAGENT_POLLED_RECENTLY_MS = 60_000;

/**
 * unit: chars
 * source: extensions/subagent/src/index.ts:440
 * rationale: preserve the single-result truncation cap.
 */
export const SUBAGENT_INDIVIDUAL_NOTIFICATION_MAX_CHARS = 500;

/**
 * unit: chars
 * source: extensions/subagent/src/index.ts:524
 * rationale: preserve the grouped-result truncation cap.
 */
export const SUBAGENT_GROUP_NOTIFICATION_MAX_CHARS = 300;

/**
 * unit: ms
 * source: extensions/subagent/src/index.ts:918
 * rationale: preserve the wait loop poll interval.
 */
export const SUBAGENT_POLL_INTERVAL_MS = 1_000;

/**
 * unit: ms
 * source: extensions/subagent/src/index.ts:367
 * rationale: preserve the ping probe timeout.
 */
export const SUBAGENT_PING_TIMEOUT_MS = 5_000;

/**
 * unit: version
 * source: extensions/subagent/src/cross-extension-rpc.ts:24
 * rationale: preserve the eventbus RPC protocol contract.
 */
export const PROTOCOL_VERSION = 2;

/**
 * unit: radix
 * source: extensions/subagent/src/index.ts:2122
 * rationale: preserve decimal parsing for interactive numeric input.
 */
export const SUBAGENT_DECIMAL_RADIX = 10;

/**
 * unit: turns
 * source: extensions/subagent/src/index.ts:1954
 * rationale: preserve the agent generation turn cap.
 */
export const SUBAGENT_MAX_GENERATION_TURNS = 5;

/**
 * unit: ms
 * source: extensions/subagent/src/index.ts:62
 * rationale: preserve the foreground render cadence.
 */
export const SUBAGENT_FOREGROUND_RENDER_CADENCE_MS = 250;

/**
 * unit: lines
 * source: extensions/subagent/src/index.ts:331
 * rationale: preserve the expanded result preview line cap.
 */
export const SUBAGENT_RESULT_PREVIEW_LINES = 30;

/**
 * unit: ms
 * source: extensions/subagent/src/group-join.ts:26
 * rationale: preserve the straggler group timeout.
 */
export const SUBAGENT_GROUP_STRAGGLER_TIMEOUT_MS = 15_000;

/**
 * unit: ms
 * source: extensions/subagent/src/env.ts:13
 * rationale: preserve git environment probe timeouts.
 */
export const SUBAGENT_GIT_TIMEOUT_MS = 5_000;
