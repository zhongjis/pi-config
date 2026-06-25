/**
 * task-widget.ts — Persistent widget showing task list with status icons and progress.
 *
 * Shared style (extensions/lib/widget-style.ts) — light tree, ASCII glyphs:
 *   ✓ completed tasks (strikethrough + dim)
 *   ◐ in_progress tasks
 *   ○ pending tasks
 *   braille spinner for the actively executing task (with activeForm text)
 */

import { truncateToWidth } from "@earendil-works/pi-tui";
import { filterBlockers } from "../../../lib/blocker.js";
import { groupByStatus } from "../../../lib/status-group.js";
import { formatDuration, formatTokens, GLYPH, headingIcon, joinStats, SEPARATOR, spinnerGlyph, TREE } from "../../../lib/widget-style.js";
import { TASK_WIDGET_MAX_VISIBLE, TASK_WIDGET_REFRESH_INTERVAL_MS } from "../constants.js";
import type { TaskStore } from "../task-store.js";

// ---- Types ----

export type Theme = {
  fg(color: string, text: string): string;
  bold(text: string): string;
  strikethrough(text: string): string;
};

export type UICtx = {
  setStatus(key: string, text: string | undefined): void;
  setWidget(
    key: string,
    content: undefined | ((tui: any, theme: Theme) => { render(): string[]; invalidate(): void }),
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
};

/** Per-task runtime metrics (elapsed time, token usage). */
export interface TaskMetrics {
  startedAt: number;
  inputTokens: number;
  outputTokens: number;
}

// ---- Widget ----

export class TaskWidget {
  private uiCtx: UICtx | undefined;
  private widgetFrame = 0;
  private widgetInterval: ReturnType<typeof setInterval> | undefined;
  /** IDs of tasks currently being actively executed (show spinner). */
  private activeTaskIds = new Set<string>();
  /** Per-task runtime metrics keyed by task ID. */
  private metrics = new Map<string, TaskMetrics>();
  /** Cached TUI instance for requestRender() calls. */
  private tui: any | undefined;
  /** Whether the widget callback is currently registered. */
  private widgetRegistered = false;

  constructor(private store: TaskStore) {}

  setStore(store: TaskStore) {
    this.store = store;
  }

  setUICtx(ctx: UICtx) {
    this.uiCtx = ctx;
  }

  /** Add or remove a task from the active spinner set. */
  setActiveTask(taskId: string | undefined, active = true) {
    if (taskId && active) {
      this.activeTaskIds.add(taskId);
      if (!this.metrics.has(taskId)) {
        this.metrics.set(taskId, { startedAt: Date.now(), inputTokens: 0, outputTokens: 0 });
      }
      this.ensureTimer();
    } else if (taskId) {
      this.activeTaskIds.delete(taskId);
    }
    this.update();
  }

  /** Record token usage for the currently active task(s). */
  addTokenUsage(inputTokens: number, outputTokens: number) {
    // Distribute to all currently active tasks
    for (const id of this.activeTaskIds) {
      const m = this.metrics.get(id);
      if (m) {
        m.inputTokens += inputTokens;
        m.outputTokens += outputTokens;
      }
    }
  }

  /** Ensure the widget update timer is running. */
  ensureTimer() {
    if (!this.widgetInterval) {
      this.widgetInterval = setInterval(() => this.update(), TASK_WIDGET_REFRESH_INTERVAL_MS);
    }
  }

  /** Build widget lines from current live state. Called from the render callback. */
  private renderWidget(tui: any, theme: Theme): string[] {
    const tasks = this.store.list();
    const w = tui.terminal.columns;
    const truncate = (line: string) => truncateToWidth(line, w);

    if (tasks.length === 0) return [];

    const groupedTasks = groupByStatus(tasks);
    const completed = groupedTasks.completed ?? [];
    const inProgress = groupedTasks.in_progress ?? [];
    const pending = groupedTasks.pending ?? [];

    const summary = joinStats([
      completed.length > 0 ? `${completed.length} done` : "",
      inProgress.length > 0 ? `${inProgress.length} in progress` : "",
      pending.length > 0 ? `${pending.length} open` : "",
    ]);
    const active = inProgress.length > 0 || pending.length > 0;
    const headColor = active ? "accent" : "dim";

    const spinnerChar = spinnerGlyph(this.widgetFrame);
    const heading = summary
      ? `${theme.fg(headColor, headingIcon(active))} ${theme.fg(headColor, "Tasks")}${theme.fg("dim", SEPARATOR + summary)}`
      : `${theme.fg(headColor, headingIcon(active))} ${theme.fg(headColor, "Tasks")}`;
    const lines: string[] = [truncate(heading)];

    const hasOverflow = tasks.length > TASK_WIDGET_MAX_VISIBLE;
    const visible = tasks.slice(0, TASK_WIDGET_MAX_VISIBLE);
    for (let i = 0; i < visible.length; i++) {
      const task = visible[i];
      const isActive = this.activeTaskIds.has(task.id) && task.status === "in_progress";
      const isLastRow = !hasOverflow && i === visible.length - 1;
      const connector = theme.fg("dim", isLastRow ? TREE.last : TREE.mid);

      let icon: string;
      if (isActive) {
        icon = theme.fg("accent", spinnerChar);
      } else if (task.status === "completed") {
        icon = theme.fg("success", GLYPH.done);
      } else if (task.status === "in_progress") {
        icon = theme.fg("accent", GLYPH.active);
      } else {
        icon = theme.fg("dim", GLYPH.pending);
      }

	      let suffix = "";
	      if (task.status === "pending" && task.blockedBy.length > 0) {
	        const { unsatisfied: openBlockers } = filterBlockers(task.blockedBy, this.store);
	        if (openBlockers.length > 0) {
	          suffix = theme.fg("dim", ` › blocked by ${openBlockers.map(id => "#" + id).join(", ")}`);
	        }
      }

      let text: string;
      if (isActive) {
        const form = task.activeForm || task.subject;
        const agentId = task.metadata?.agentId;
        const agentLabel = agentId ? ` (agent ${agentId.slice(0, 5)})` : "";
        const m = this.metrics.get(task.id);
        let stats = "";
        if (m) {
          const elapsed = formatDuration(Date.now() - m.startedAt);
          const tokenParts: string[] = [];
          if (m.inputTokens > 0) tokenParts.push(`↑ ${formatTokens(m.inputTokens)}`);
          if (m.outputTokens > 0) tokenParts.push(`↓ ${formatTokens(m.outputTokens)}`);
          stats = tokenParts.length > 0
            ? ` ${theme.fg("dim", `(${elapsed} · ${tokenParts.join(" ")})`)}`
            : ` ${theme.fg("dim", `(${elapsed})`)}`;
        }
        text = `${connector} ${icon} ${theme.fg("dim", "#" + task.id)} ${theme.fg("accent", form + agentLabel + "…")}${stats}`;
      } else if (task.status === "completed") {
        text = `${connector} ${icon} ${theme.fg("dim", theme.strikethrough("#" + task.id + " " + task.subject))}`;
      } else {
        const agentSuffix = task.status === "in_progress" && task.metadata?.agentId
          ? theme.fg("dim", ` (agent ${task.metadata.agentId.slice(0, 5)})`)
          : "";
        text = `${connector} ${icon} ${theme.fg("dim", "#" + task.id)} ${task.subject}${agentSuffix}`;
      }

      lines.push(truncate(text + suffix));
    }

    if (hasOverflow) {
      lines.push(truncate(theme.fg("dim", `${TREE.last} … and ${tasks.length - TASK_WIDGET_MAX_VISIBLE} more`)));
    }

    return lines;
  }

  /** Force an immediate widget update. */
  update() {
    if (!this.uiCtx) return;
    const tasks = this.store.list();

    // Transition: visible → hidden
    if (tasks.length === 0) {
      if (this.widgetRegistered) {
        this.uiCtx.setWidget("tasks", undefined);
        this.widgetRegistered = false;
      }
      if (this.widgetInterval) {
        clearInterval(this.widgetInterval);
        this.widgetInterval = undefined;
      }
      return;
    }

    // Prune stale active IDs (deleted or no longer in_progress)
    for (const id of this.activeTaskIds) {
      const t = this.store.get(id);
      if (!t || t.status !== "in_progress") {
        this.activeTaskIds.delete(id);
        this.metrics.delete(id);
      }
    }

    // Check if any task needs animation
    const hasActiveSpinner = tasks.some(t => this.activeTaskIds.has(t.id) && t.status === "in_progress");
    if (hasActiveSpinner) {
      this.ensureTimer();
    } else if (!hasActiveSpinner && this.widgetInterval) {
      clearInterval(this.widgetInterval);
      this.widgetInterval = undefined;
    }

    this.widgetFrame++;

    // Transition: hidden → visible — register widget callback once
    if (!this.widgetRegistered) {
      this.uiCtx.setWidget("tasks", (tui, theme) => {
        this.tui = tui;
        return { render: () => this.renderWidget(tui, theme), invalidate: () => {} };
      }, { placement: "aboveEditor" });
      this.widgetRegistered = true;
    } else if (this.tui) {
      // Widget already registered — just request a re-render
      this.tui.requestRender();
    }
  }

  dispose() {
    if (this.widgetInterval) {
      clearInterval(this.widgetInterval);
      this.widgetInterval = undefined;
    }
    if (this.uiCtx) {
      this.uiCtx.setWidget("tasks", undefined);
    }
    this.widgetRegistered = false;
    this.tui = undefined;
  }
}
