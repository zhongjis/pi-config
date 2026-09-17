/**
 * render.ts — the pane's lines, built by the SAME layout as the in-Pi overlay.
 *
 * The whole point of Option F is that the extension keeps ownership of the
 * layout: this module calls the real `layoutWorkflowDialog` at the overview
 * level and themes it with an ANSI palette, so the side pane can never drift
 * from `/agents → Graph runs`. Nothing here reaches for a host — it imports only
 * pi-tui-backed pure modules — which is what lets it run in the extension
 * process and hand finished strings to the viewer.
 */

import type { Theme } from "../../ui/agent-widget.js";
import {
  applyPanelKey,
  type PanelOptions,
  type PanelRun,
  type PanelState,
  renderPanelLines,
} from "../../ui/observability-panel.js";
import type { WorkflowCardColor } from "../../ui/workflow-card.js";
import { styleWorkflowCardLines } from "../../ui/workflow-card.js";
import {
  handleWorkflowDialogKey,
  initialWorkflowDialogState,
  layoutWorkflowDialog,
  MIN_PANE_BODY_ROWS,
  resolveWorkflowDialog,
  type WorkflowDialogActions,
  type WorkflowDialogInput,
  type WorkflowDialogSource,
  type WorkflowDialogState,
} from "../../ui/workflow-dialog.js";
import type { WorkflowTask } from "../task.js";

const RESET = "\x1b[0m";

/** Header (name/subtext/status/blank) + frame borders + footer ≈ 9 rows of chrome; the rest is body. */
const PANE_CHROME_ROWS = 9;

/** SGR colour code per card colour. Kept legible over clever: one hue each. */
const SGR: Record<WorkflowCardColor, string> = {
  success: "32", // green
  error: "31", // red
  warning: "33", // yellow
  dim: "90", // bright black
  muted: "37", // grey/default foreground
  toolTitle: "36", // cyan — the run's name
  accent: "35", // magenta — the selection
};

/**
 * An ANSI theme shaped like the overlay's, so `styleWorkflowCardLines` colours
 * the pane the same way it colours the overlay. `fg` resets after each segment
 * so a colour never bleeds into the next; an unknown colour passes through
 * untouched rather than emitting a broken escape.
 */
export const PANE_ANSI_THEME: Theme = {
  fg(color: string, text: string): string {
    const code = SGR[color as WorkflowCardColor];
    return code ? `\x1b[${code}m${text}${RESET}` : text;
  },
  bold(text: string): string {
    return `\x1b[1m${text}\x1b[22m`;
  },
};

/**
 * The exact source shape the overlay reads (see `showWorkflowDialog.source()`),
 * built from a background task so the pane follows a run the same way the overlay
 * does.
 */
export function toPaneSource(task: WorkflowTask): WorkflowDialogSource {
  return {
    progress: task.workflowProgress,
    task: {
      status: task.status,
      workflowName: task.workflowName,
      startTime: task.startTime,
      endTime: task.endTime,
      totalPausedMs: task.totalPausedMs,
      pausedAt: task.pausedAt,
    },
    meta: task.meta,
    agentCount: task.agentCount,
  };
}

/**
 * The pane wires NONE of the mutating actions, so it must not advertise them.
 * Passed as `available` to the layout, this keeps the footer honest — nav only
 * (`↑↓ select · ⏎ open · f filter · esc`), never `p pause` / `x stop` / `s skip` /
 * `r retry` / `c convo`. Shared so the overview render and the nav render agree.
 */
const PANE_AVAILABLE: Partial<Record<keyof WorkflowDialogActions, boolean>> = {
  onKill: false,
  onPause: false,
  onResume: false,
  onSkipAgent: false,
  onRetryAgent: false,
  onOpenAgent: false,
};

/**
 * Render one snapshot for the pane, as ANSI strings clamped to `width`.
 *
 * Defaults to the overview level; a caller driving navigation passes the current
 * {@link WorkflowDialogState} so a live progress update preserves the selection.
 */
export function renderWorkflowPaneLines(
  source: WorkflowDialogSource,
  opts: { width: number; ascii?: boolean; now?: number; state?: WorkflowDialogState; rows?: number },
): string[] {
  const bodyRows = opts.rows != null ? Math.max(MIN_PANE_BODY_ROWS, opts.rows - PANE_CHROME_ROWS) : undefined;
  const input: WorkflowDialogInput = {
    ...source,
    state: opts.state ?? initialWorkflowDialogState(),
    available: PANE_AVAILABLE,
    width: opts.width,
    ascii: opts.ascii,
    now: opts.now,
    bodyRows,
    fillBody: opts.rows != null,
  };
  return styleWorkflowCardLines(layoutWorkflowDialog(input), PANE_ANSI_THEME);
}

/**
 * Apply one forwarded keystroke to the pane's view state and re-render.
 *
 * Reuses the overlay's pure key handler, so navigation (↑↓, enter, f, esc, page)
 * behaves identically to `/agents → Graph runs`. The pane is READ-ONLY: any
 * `action` the handler returns (kill/pause/resume/skip/retry/open/cancel) is
 * deliberately ignored. A key the handler does not own leaves the state as-is and
 * re-renders idempotently.
 */
export function applyPaneKey(
  source: WorkflowDialogSource,
  state: WorkflowDialogState,
  data: string,
  opts: { width: number; now?: number; ascii?: boolean; rows?: number },
): { state: WorkflowDialogState; lines: string[]; close: boolean } {
  const bodyRows = opts.rows != null ? Math.max(MIN_PANE_BODY_ROWS, opts.rows - PANE_CHROME_ROWS) : undefined;
  const input: WorkflowDialogInput = {
    ...source,
    state,
    available: PANE_AVAILABLE,
    width: opts.width,
    ascii: opts.ascii,
    now: opts.now,
    bodyRows,
    fillBody: opts.rows != null,
  };
  const view = resolveWorkflowDialog(input);
  const result = handleWorkflowDialogKey(data, state, view);
  const nextState = result?.state ?? state;
  // The pane wires no mutating actions, so every action is ignored EXCEPT
  // `cancel` (esc/q at the overview level), which the extension turns into a
  // real close. esc at the detail level only changes state (level → phases), so
  // it carries no action and never closes.
  const close = result?.action?.kind === "cancel";
  return {
    state: nextState,
    close,
    lines: renderWorkflowPaneLines(source, {
      width: opts.width,
      ascii: opts.ascii,
      now: opts.now,
      state: nextState,
      rows: opts.rows,
    }),
  };
}

/**
 * Render the run observability panel for the pane, as ANSI strings clamped to
 * `width`. Mirrors {@link renderWorkflowPaneLines} but drives the panel renderer;
 * the manager falls back to the roster render on a throw.
 */
export function renderObservabilityPaneLines(
  runs: readonly PanelRun[],
  state: PanelState,
  opts: PanelOptions,
): string[] {
  return styleWorkflowCardLines(renderPanelLines(runs, state, opts), PANE_ANSI_THEME);
}

/**
 * Apply one forwarded keystroke to the panel's view state and re-render. Mirrors
 * {@link applyPaneKey}: read-only, only `esc`/`q` at the top level closes.
 */
export function applyObservabilityPaneKey(
  runs: readonly PanelRun[],
  state: PanelState,
  data: string,
  opts: PanelOptions,
): { state: PanelState; lines: string[]; close: boolean; action?: { kind: "open"; recordId: string } } {
  const result = applyPanelKey(runs, state, data, opts);
  return {
    state: result.state,
    lines: styleWorkflowCardLines(result.lines, PANE_ANSI_THEME),
    close: result.close,
    action: result.action,
  };
}
