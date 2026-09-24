/**
 * render.ts — the pane's lines, built by the SAME layout as the in-Pi overlay.
 *
 * The whole point of Option F is that the extension keeps ownership of the
 * layout: this module calls the real `layoutGraphRunDialog` at the overview
 * level and themes it with an ANSI palette, so the side pane can never drift
 * from `/agents → Graph runs`. Nothing here reaches for a host — it imports only
 * pi-tui-backed pure modules — which is what lets it run in the extension
 * process and hand finished strings to the viewer.
 */

import type { Theme } from "../../ui/agent-widget.js";
import type { GraphRunCardColor } from "../../ui/graph-run-card.js";
import { styleGraphRunCardLines } from "../../ui/graph-run-card.js";
import {
  type GraphRunDialogActions,
  type GraphRunDialogInput,
  type GraphRunDialogSource,
  type GraphRunDialogState,
  handleGraphRunDialogKey,
  initialGraphRunDialogState,
  layoutGraphRunDialog,
  MIN_PANE_BODY_ROWS,
  resolveGraphRunDialog,
} from "../../ui/graph-run-dialog.js";
import {
  applyPanelKey,
  type PanelAction,
  type PanelOptions,
  type PanelRun,
  type PanelState,
  renderPanelLines,
} from "../../ui/observability-panel.js";
import type { GraphRun } from "../history-view.js";

const RESET = "\x1b[0m";

/** Header (name/subtext/status/blank) + frame borders + footer ≈ 9 rows of chrome; the rest is body. */
const PANE_CHROME_ROWS = 9;

/** SGR colour code per card colour. Kept legible over clever: one hue each. */
const SGR: Record<GraphRunCardColor, string> = {
  success: "32", // green
  error: "31", // red
  warning: "33", // yellow
  dim: "90", // bright black
  muted: "39", // default foreground — terminal-adaptive, legible on light and dark
  toolTitle: "36", // cyan — the run's name
  accent: "35", // magenta — the running state
};

/**
 * An ANSI theme shaped like the overlay's, so `styleGraphRunCardLines` colours
 * the pane the same way it colours the overlay. `fg` resets after each segment
 * so a colour never bleeds into the next; an unknown colour passes through
 * untouched rather than emitting a broken escape.
 */
export const PANE_ANSI_THEME: Theme = {
  fg(color: string, text: string): string {
    const code = SGR[color as GraphRunCardColor];
    return code ? `\x1b[${code}m${text}${RESET}` : text;
  },
  bold(text: string): string {
    return `\x1b[1m${text}\x1b[22m`;
  },
};

/**
 * The exact source shape the overlay reads (see `showGraphRunDialog.source()`),
 * built from a background task so the pane follows a run the same way the overlay
 * does.
 */
export function toPaneSource(task: GraphRun): GraphRunDialogSource {
  return {
    progress: task.graphRunProgress,
    task: {
      status: task.status,
      graphRunName: task.graphRunName,
      startTime: task.startTime,
      endTime: task.endTime,
      totalPausedMs: task.totalPausedMs,
      pausedAt: task.type === "local_graph_run" ? task.pausedAt : undefined,
    },
    meta: task.meta,
    agentCount: task.agentCount,
    history: task.type === "history" ? task.history : undefined,
    input: task.type === "local_graph_run" ? task.args : undefined,
  };
}

/**
 * The switchable-run shape the observability panel reads, built from a
 * background task. Shared so the pane manager and the in-Pi host map a run to a
 * {@link PanelRun} identically.
 */
export function toPanelRun(task: GraphRun): PanelRun {
  return {
    id: task.id,
    name: task.graphRunName ?? task.meta?.name ?? task.id,
    status: task.status,
    source: toPaneSource(task),
    ...(task.type === "history" ? { readHistoricalDetail: task.readNodeDetail } : {}),
  };
}

/**
 * The pane wires NONE of the mutating actions, so it must not advertise them.
 * Passed as `available` to the layout, this keeps the footer honest — nav only
 * (`↑↓ select · ⏎ open · f filter · esc`), never `p pause` / `x stop` / `s skip` /
 * `r retry` / `c convo`. Shared so the overview render and the nav render agree.
 */
const PANE_AVAILABLE: Partial<Record<keyof GraphRunDialogActions, boolean>> = {
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
 * {@link GraphRunDialogState} so a live progress update preserves the selection.
 */
export function renderGraphRunPaneLines(
  source: GraphRunDialogSource,
  opts: { width: number; ascii?: boolean; now?: number; state?: GraphRunDialogState; rows?: number },
): string[] {
  const bodyRows = opts.rows != null ? Math.max(MIN_PANE_BODY_ROWS, opts.rows - PANE_CHROME_ROWS) : undefined;
  const input: GraphRunDialogInput = {
    ...source,
    state: opts.state ?? initialGraphRunDialogState(),
    available: PANE_AVAILABLE,
    width: opts.width,
    ascii: opts.ascii,
    now: opts.now,
    bodyRows,
    fillBody: opts.rows != null,
  };
  return styleGraphRunCardLines(layoutGraphRunDialog(input), PANE_ANSI_THEME);
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
  source: GraphRunDialogSource,
  state: GraphRunDialogState,
  data: string,
  opts: { width: number; now?: number; ascii?: boolean; rows?: number },
): { state: GraphRunDialogState; lines: string[]; close: boolean } {
  const bodyRows = opts.rows != null ? Math.max(MIN_PANE_BODY_ROWS, opts.rows - PANE_CHROME_ROWS) : undefined;
  const input: GraphRunDialogInput = {
    ...source,
    state,
    available: PANE_AVAILABLE,
    width: opts.width,
    ascii: opts.ascii,
    now: opts.now,
    bodyRows,
    fillBody: opts.rows != null,
  };
  const view = resolveGraphRunDialog(input);
  const result = handleGraphRunDialogKey(data, state, view);
  const nextState = result?.state ?? state;
  // The pane wires no mutating actions, so every action is ignored EXCEPT
  // `cancel` (esc/q at the overview level), which the extension turns into a
  // real close. esc at the detail level only changes state (level → phases), so
  // it carries no action and never closes.
  const close = result?.action?.kind === "cancel";
  return {
    state: nextState,
    close,
    lines: renderGraphRunPaneLines(source, {
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
 * `width`. Mirrors {@link renderGraphRunPaneLines} but drives the panel renderer;
 * the manager falls back to the roster render on a throw.
 */
export function renderObservabilityPaneLines(
  runs: readonly PanelRun[],
  state: PanelState,
  opts: PanelOptions,
): string[] {
  return styleGraphRunCardLines(renderPanelLines(runs, state, opts), PANE_ANSI_THEME);
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
): { state: PanelState; lines: string[]; close: boolean; action?: PanelAction } {
  const result = applyPanelKey(runs, state, data, opts);
  return {
    state: result.state,
    lines: styleGraphRunCardLines(result.lines, PANE_ANSI_THEME),
    close: result.close,
    action: result.action,
  };
}
