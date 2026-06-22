/**
 * unit: turns
 * source: extensions/tasks/src/index.ts:47
 * rationale: preserve the task-tool reminder cadence.
 */
export const REMINDER_INTERVAL = 4;

/**
 * unit: turns
 * source: extensions/tasks/src/index.ts:50
 * rationale: preserve completed-task auto-clear delay.
 */
export const AUTO_CLEAR_DELAY = 4;

/**
 * unit: ms
 * source: extensions/tasks/src/index.ts:350
 * rationale: preserve the TaskExecute spawn RPC timeout.
 */
export const SUBAGENT_SPAWN_TIMEOUT_MS = 30_000;

/**
 * unit: ms
 * source: extensions/tasks/src/index.ts:356
 * rationale: preserve the TaskExecute stop RPC timeout.
 */
export const SUBAGENT_STOP_TIMEOUT_MS = 10_000;

/**
 * unit: ms
 * source: extensions/tasks/src/bridge/subagent-bridge.ts
 * rationale: preserve the TaskOutput consume RPC timeout.
 */
export const SUBAGENT_CONSUME_TIMEOUT_MS = 10_000;

/**
 * unit: number
 * source: extensions/tasks/src/index.ts:360
 * rationale: preserve the subagent protocol version contract.
 */
export const PROTOCOL_VERSION = 2;

/**
 * unit: ms
 * source: extensions/tasks/src/index.ts:367
 * rationale: preserve the ping reply timeout.
 */
export const PROTOCOL_PING_TIMEOUT_MS = 5_000;

/**
 * unit: chars
 * source: extensions/tasks/src/index.ts:407
 * rationale: preserve dependency-result truncation in TaskExecute.
 */
export const DEPENDENCY_RESULT_TRUNCATION_CHARS = 4_000;

/**
 * unit: count
 * source: extensions/tasks/src/index.ts:750
 * rationale: preserve task list sort ordering.
 */
export const TASK_STATUS_ORDER = {
  pending: 0,
  in_progress: 1,
  completed: 2,
} as const;

/**
 * unit: ms
 * source: extensions/tasks/src/index.ts:1015
 * rationale: preserve TaskOutput default wait timeout.
 */
export const TASK_OUTPUT_DEFAULT_TIMEOUT_MS = 30_000;

/**
 * unit: ms
 * source: extensions/tasks/src/index.ts:1060
 * rationale: preserve background-process wait timeout.
 */
export const TASK_PROCESS_WAIT_TIMEOUT_MS = 30_000;

/**
 * unit: ms
 * source: extensions/tasks/src/process-tracker.ts:122
 * rationale: preserve the SIGTERM-to-SIGKILL grace period.
 */
export const PROCESS_STOP_GRACE_PERIOD_MS = 5_000;

/**
 * unit: ms
 * source: extensions/tasks/src/ui/task-widget.ts:115
 * rationale: preserve the widget refresh cadence.
 */
export const TASK_WIDGET_REFRESH_INTERVAL_MS = 150;

/**
 * unit: count
 * source: extensions/tasks/src/ui/task-widget.ts:34
 * rationale: preserve the visible task cap.
 */
export const TASK_WIDGET_MAX_VISIBLE = 10;

/**
 * unit: count
 * source: extensions/tasks/src/ui/settings-menu.ts:67
 * rationale: preserve the settings menu visible row cap.
 */
export const TASK_SETTINGS_MAX_VISIBLE = 10;

/**
 * unit: radix
 * source: extensions/tasks/src/task-store.ts:60
 * rationale: preserve decimal parsing for lock PID reads and other numeric inputs.
 */
export const DECIMAL_RADIX = 10;

/**
 * unit: spaces
 * source: extensions/tasks/src/tasks-config.ts:22
 * rationale: preserve JSON pretty-print indentation.
 */
export const JSON_PRETTY_PRINT_SPACES = 2;
