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
