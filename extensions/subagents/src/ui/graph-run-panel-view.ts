/**
 * graph-run-panel-view.ts — the observability panel hosted as the in-Pi graph
 * inspector.
 *
 * The same pure renderer the Herdr pane uses (`renderPanelLines` /
 * `applyPanelKey`), wrapped as a Pi `Component`. The pane stays read-only; this
 * host is the only place `controls`/`detach` are enabled, so
 * `c`/`p`/`s`/`r`/`x`/`o` dispatch through `options.onAction` against the run
 * currently shown.
 */

import type { Component, TUI } from "@earendil-works/pi-tui";
import type { GraphRun } from "../graph/history-view.js";
import { toPanelRun } from "../graph/pane/render.js";
import type { Theme } from "./agent-widget.js";
import { styleGraphRunCardLines } from "./graph-run-card.js";
import { GRAPH_RUN_DIALOG_REFRESH_MS } from "./graph-run-dialog.js";
import {
  applyPanelKey,
  initialPanelState,
  type PanelAction,
  type PanelOptions,
  type PanelRun,
  type PanelState,
  renderPanelLines,
} from "./observability-panel.js";

interface GraphRunPanelViewOptions {
  controls: boolean;
  detach: boolean;
  viewportPct: number;
  onAction(action: PanelAction, run: GraphRun): void;
}

export class GraphRunPanelView implements Component {
  private state: PanelState = initialPanelState();
  private shownRunId: string;
  private lastWidth = 80;
  private timer: ReturnType<typeof setInterval> | undefined;
  private closed = false;

  constructor(
    private tui: TUI,
    private runs: () => readonly GraphRun[],
    initialRunId: string,
    private theme: Theme,
    private done: (result: undefined) => void,
    private options: GraphRunPanelViewOptions,
  ) {
    this.shownRunId = initialRunId;
    if (this.hasLiveRun()) {
      this.timer = setInterval(() => {
        if (!this.hasLiveRun()) this.stopTimer();
        if (!this.closed) this.tui.requestRender();
      }, GRAPH_RUN_DIALOG_REFRESH_MS);
      this.timer.unref?.();
    }
  }

  render(width: number): string[] {
    if (!Number.isFinite(width) || width <= 0) return [];
    this.lastWidth = width;
    const panelRuns = this.trackShownRun(this.runs());
    return styleGraphRunCardLines(renderPanelLines(panelRuns, this.state, this.opts(width)), this.theme);
  }

  handleInput(data: string): void {
    if (this.closed) return;
    const list = this.runs();
    const panelRuns = this.trackShownRun(list);
    const result = applyPanelKey(panelRuns, this.state, data, this.opts(this.lastWidth));
    this.state = result.state;
    this.shownRunId = list[this.state.runIndex]?.id ?? this.shownRunId;
    if (result.close) {
      this.dispose();
      this.done(undefined);
      return;
    }
    if (result.action) this.options.onAction(result.action, list[this.state.runIndex]);
    this.tui.requestRender();
  }

  invalidate(): void {}

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopTimer();
  }

  /** Point the panel at the currently shown run and project the list to {@link PanelRun}s. */
  private trackShownRun(list: readonly GraphRun[]): PanelRun[] {
    this.state.runIndex = Math.max(0, list.findIndex(run => run.id === this.shownRunId));
    return list.map(toPanelRun);
  }

  private opts(width: number): PanelOptions {
    const rows = Math.max(12, Math.floor(((this.tui.terminal?.rows ?? 40) * this.options.viewportPct) / 100) - 2);
    return { width, rows, controls: this.options.controls, detach: this.options.detach };
  }

  private hasLiveRun(): boolean {
    return this.runs().some(run => run.status === "running" || run.status === "paused");
  }

  private stopTimer(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
