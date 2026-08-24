/**
 * unit: ms
 * rationale: preserve the supervision poll cadence.
 */
export const BACKGROUND_SUPERVISION_INTERVAL_MS = 30_000;

/**
 * unit: ms
 * rationale: preserve the steer threshold.
 */
export const BACKGROUND_STALE_STEER_AFTER_MS = 2 * 60_000;

/**
 * unit: ms
 * rationale: preserve the abort threshold.
 */
export const BACKGROUND_STALE_ABORT_AFTER_MS = 5 * 60_000;

/**
 * unit: ms
 * rationale: preserve the supervision cooldown.
 */
export const BACKGROUND_SUPERVISION_COOLDOWN_MS = 2 * 60_000;

/**
 * unit: ms
 * rationale: preserve the absolute supervision ceiling.
 */
export const DEFAULT_SUBAGENT_SUPERVISION_CEILING_MS = 30 * 60_000;

/** Maximum retained result lines shown in expanded completion notifications. */
export const SUBAGENT_RESULT_PREVIEW_LINES = 30;
