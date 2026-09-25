/**
 * agent-monitor.ts — full-screen roster of this session's agent graph runs and
 * independent agents, including finished entries still retained in memory.
 *
 * Enter opens a graph run or an agent's conversation. `o` detaches graph runs only.
 */

import { type Component, matchesKey, stripTerminalSequences, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentRecord } from "../types.js";
import { getLifetimeTotal } from "../usage.js";
import { type AgentActivity, type Theme } from "./agent-widget.js";
import { type FleetGraphRun, formatFleetAgentRow, formatFleetGraphRunRow } from "./fleet-list.js";
import { frameOverlay, type OverlayTheme } from "./graph-run-card.js";
import type { GraphRunUIContext } from "./graph-run-menu.js";

export type MonitorFilter = "all" | "running" | "failed";
export const MONITOR_AGENT_CAP = 50;

const NEXT_FILTER: Record<MonitorFilter, MonitorFilter> = {
  all: "running",
  running: "failed",
  failed: "all",
};

export interface AgentMonitorDeps {
  listAgents(): AgentRecord[];
  agentActivity: Map<string, AgentActivity>;
  graphRuns(): readonly FleetGraphRun[];
  openGraphRun(ctx: GraphRunUIContext, id: string): Promise<void>;
  viewAgentConversation(ctx: GraphRunUIContext, record: AgentRecord): Promise<void>;
  detach?: { available(): boolean; open(runId: string): Promise<boolean> };
}

type MonitorRow =
  | { kind: "graph"; key: string; run: FleetGraphRun }
  | { kind: "agent"; key: string; record: AgentRecord };

type MonitorOverlay = { setHidden(hidden: boolean): void };

const graphLive = (run: FleetGraphRun) => run.status === "running" || run.status === "paused";
const agentLive = (agent: AgentRecord) => agent.status === "running" || agent.status === "queued";

function orderByRecency<T extends { startedAt: number; completedAt?: number }>(
  items: readonly T[],
  live: (item: T) => boolean,
): T[] {
  const active = items.filter(live).sort((a, b) => b.startedAt - a.startedAt);
  const rest = items.filter(item => !live(item)).sort(
    (a, b) => (b.completedAt ?? b.startedAt) - (a.completedAt ?? a.startedAt),
  );
  return [...active, ...rest];
}

/** Graph runs, then independent agents. Graph-owned children never appear here. */
export function monitorSections(
  graphRuns: readonly FleetGraphRun[],
  agents: readonly AgentRecord[],
  filter: MonitorFilter,
): { graphRuns: FleetGraphRun[]; agents: AgentRecord[] } {
  const runs = graphRuns.filter(run => {
    if (filter === "running") return graphLive(run);
    if (filter === "failed") return run.status === "failed";
    return true;
  });
  const independent = agents.filter(agent => !agent.graphRunId).filter(agent => {
    if (filter === "running") return agentLive(agent);
    if (filter === "failed") return agent.status === "error";
    return true;
  });
  return {
    graphRuns: orderByRecency(runs, graphLive),
    agents: orderByRecency(independent, agentLive).slice(0, MONITOR_AGENT_CAP),
  };
}

export function monitorStatusWord(entry: FleetGraphRun | AgentRecord): string {
  if ("doneCount" in entry) return graphStatusWord(entry.status);
  return agentStatusWord(entry.status);
}

function graphStatusWord(status: FleetGraphRun["status"]): string {
  switch (status) {
    case "running": return "running";
    case "paused": return "paused";
    case "completed": return "done";
    case "failed": return "failed";
    case "killed": return "stopped";
  }
}

function agentStatusWord(status: AgentRecord["status"]): string {
  switch (status) {
    case "queued": return "queued";
    case "running": return "running";
    case "completed": return "done";
    case "steered": return "steered";
    case "aborted": return "aborted";
    case "stopped": return "stopped";
    case "error": return "failed";
  }
}

function monitorRows(sections: { graphRuns: readonly FleetGraphRun[]; agents: readonly AgentRecord[] }): MonitorRow[] {
  return [
    ...sections.graphRuns.map(run => ({ kind: "graph" as const, key: `g:${run.id}`, run })),
    ...sections.agents.map(record => ({ kind: "agent" as const, key: `a:${record.id}`, record })),
  ];
}

function statusMark(entry: FleetGraphRun | AgentRecord): { glyph: string; color: string } {
  if ("doneCount" in entry) {
    switch (entry.status) {
      case "running": return { glyph: "●", color: "accent" };
      case "paused": return { glyph: "Ⅱ", color: "warning" };
      case "completed": return { glyph: "✓", color: "success" };
      case "failed": return { glyph: "×", color: "error" };
      case "killed": return { glyph: "■", color: "dim" };
    }
  }
  switch (entry.status) {
    case "queued": return { glyph: "○", color: "dim" };
    case "running": return { glyph: "●", color: "accent" };
    case "completed":
    case "steered": return { glyph: "✓", color: "success" };
    case "aborted":
    case "stopped": return { glyph: "■", color: "dim" };
    case "error": return { glyph: "×", color: "error" };
  }
}

function statusParts(entry: FleetGraphRun | AgentRecord, theme: Theme): { bullet: string; statusWord: string } {
  const mark = statusMark(entry);
  return { bullet: theme.fg(mark.color, mark.glyph), statusWord: theme.fg(mark.color, monitorStatusWord(entry)) };
}

function reverseRow(row: string, width: number): string {
  const plain = stripTerminalSequences(truncateToWidth(row, Math.max(0, width), ""));
  return `\x1b[7m${plain}${" ".repeat(Math.max(0, width - visibleWidth(plain)))}\x1b[27m`;
}

function liveCount<T>(items: readonly T[], live: (item: T) => boolean): { live: number; finished: number } {
  const active = items.filter(live).length;
  return { live: active, finished: items.length - active };
}

function sectionHeader(label: string, live: number, finished: number, width: number, theme: Theme): string {
  const title = theme.bold(theme.fg("text", label));
  const counts = theme.fg("dim", `${live} live · ${finished} finished`);
  const prefix = "─ ";
  const dashes = width - visibleWidth(prefix) - visibleWidth(title) - visibleWidth(counts) - 2;
  if (dashes >= 1) return `${prefix}${title} ${theme.fg("borderMuted", "─".repeat(dashes))} ${counts}`;
  return truncateToWidth(`${prefix}${title} ${counts}`, Math.max(0, width), "…");
}

function centerLine(text: string, width: number): string {
  const used = visibleWidth(text);
  if (used >= width) return truncateToWidth(text, Math.max(0, width), "…");
  return " ".repeat(Math.floor((width - used) / 2)) + text;
}

function padLines(lines: string[], min: number): string[] {
  return lines.length >= min ? lines : lines.concat(Array.from({ length: min - lines.length }, () => ""));
}

function rightAlign(left: string, right: string, width: number): string {
  const rightW = visibleWidth(right);
  const maxLeft = Math.max(0, width - rightW - 1);
  const leftClamped = truncateToWidth(left, maxLeft);
  const gap = Math.max(1, width - visibleWidth(leftClamped) - rightW);
  return truncateToWidth(leftClamped + " ".repeat(gap) + right, width);
}

function windowBody(lines: string[], focus: number, capacity: number, theme: Theme, width: number): string[] {
  if (lines.length <= capacity) return lines;
  const index = Math.min(Math.max(0, focus), lines.length - 1);
  let above = false;
  let below = false;
  let start = 0;
  let end = lines.length;
  for (let pass = 0; pass < 3; pass++) {
    const room = Math.max(1, capacity - (above ? 1 : 0) - (below ? 1 : 0));
    start = index < room ? 0 : index - room + 1;
    if (start + room > lines.length) start = Math.max(0, lines.length - room);
    end = Math.min(lines.length, start + room);
    if (index < start) start = index;
    if (index >= end) {
      end = Math.min(lines.length, index + 1);
      start = Math.max(0, end - room);
    }
    const nextAbove = start > 0;
    const nextBelow = end < lines.length;
    if (nextAbove === above && nextBelow === below) break;
    above = nextAbove;
    below = nextBelow;
  }
  const out: string[] = [];
  if (above) out.push(rightAlign("", theme.fg("dim", `↑ ${start} more`), width));
  out.push(...lines.slice(start, end));
  if (below) out.push(rightAlign("", theme.fg("dim", `↓ ${lines.length - end} more`), width));
  return out;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class AgentMonitor implements Component {
  private filter: MonitorFilter = "all";
  private selectedKey: string | undefined;
  private lastIndex = 0;
  private closed = false;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private tui: TUI,
    private theme: OverlayTheme,
    private done: (result: undefined) => void,
    private ctx: GraphRunUIContext,
    private deps: AgentMonitorDeps,
    private options: { viewportPct: number; getOverlay(): MonitorOverlay | undefined },
  ) {
    this.timer = setInterval(() => this.tui.requestRender(), 500);
    this.timer.unref?.();
  }

  handleInput(data: string): void {
    if (this.closed) return;
    if (matchesKey(data, "escape") || matchesKey(data, "q") || matchesKey(data, "ctrl+c")) {
      this.dispose();
      this.done(undefined);
      return;
    }
    if (matchesKey(data, "f")) {
      this.filter = NEXT_FILTER[this.filter];
      const rows = this.currentRows();
      this.selectedKey = rows[0]?.key;
      this.lastIndex = 0;
      this.tui.requestRender();
      return;
    }
    const rows = this.currentRows();
    const index = this.syncSelection(rows);
    if (matchesKey(data, "up") || matchesKey(data, "k")) {
      this.move(rows, index, -1);
      return;
    }
    if (matchesKey(data, "down") || matchesKey(data, "j")) {
      this.move(rows, index, 1);
      return;
    }
    if (matchesKey(data, "enter")) {
      const row = rows[index];
      if (row) void this.openRow(row);
      return;
    }
    if (matchesKey(data, "o")) {
      this.detachRow(rows[index]);
    }
  }

  render(width: number): string[] {
    const innerW = Math.max(0, width - 4);
    const sections = monitorSections(this.deps.graphRuns(), this.deps.listAgents(), this.filter);
    const rows = monitorRows(sections);
    const index = this.syncSelection(rows);
    const selectedKey = rows[index]?.key;
    const minBody = Math.min(this.bodyCapacity(), 10);
    const body: string[] = [];
    let focus = 0;
    const emptyAll = this.filter === "all" && sections.graphRuns.length === 0 && sections.agents.length === 0;
    if (emptyAll) {
      const message = centerLine(this.theme.fg("dim", "No agents or graph runs in this session yet."), innerW);
      const mid = Math.floor((minBody - 1) / 2);
      for (let row = 0; row < minBody; row++) body.push(row === mid ? message : "");
    } else {
      const pushRow = (key: string, line: string) => {
        if (key === selectedKey) focus = body.length;
        body.push(key === selectedKey ? reverseRow(line, innerW) : line);
      };
      const graphCounts = liveCount(sections.graphRuns, graphLive);
      body.push(sectionHeader("Agent graph runs", graphCounts.live, graphCounts.finished, innerW, this.theme));
      if (sections.graphRuns.length === 0) body.push(this.theme.fg("dim", "  (none)"));
      for (const run of sections.graphRuns) {
        const status = statusParts(run, this.theme);
        pushRow(`g:${run.id}`, formatFleetGraphRunRow(status.bullet, false, run, innerW, this.theme, status.statusWord));
      }
      body.push("");
      const agentCounts = liveCount(sections.agents, agentLive);
      body.push(sectionHeader("Independent agents", agentCounts.live, agentCounts.finished, innerW, this.theme));
      if (sections.agents.length === 0) body.push(this.theme.fg("dim", "  (none)"));
      for (const record of sections.agents) {
        const status = statusParts(record, this.theme);
        const tokens = getLifetimeTotal(this.deps.agentActivity.get(record.id)?.lifetimeUsage ?? record.lifetimeUsage);
        pushRow(`a:${record.id}`, formatFleetAgentRow(status.bullet, record, tokens, innerW, this.theme, status.statusWord));
      }
    }
    const windowed = emptyAll ? body : padLines(windowBody(body, focus, this.bodyCapacity(), this.theme, innerW), minBody);
    return frameOverlay(windowed, width, this.theme, {
      title: "Agent Monitor",
      right: this.filter === "all" ? undefined : `filter: ${this.filter}`,
      footer: [this.footer(rows[index])],
    });
  }

  invalidate(): void {}

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private footer(row: MonitorRow | undefined): string {
    const key = (text: string) => this.theme.fg("text", text);
    const label = (text: string) => this.theme.fg("dim", text);
    let text = key("↑↓") + label(" select") + label(" · ") + key("enter") + label(" open") + label(" · ") + key("f") + label(" filter");
    if (row?.kind === "graph" && this.deps.detach?.available()) text += label(" · ") + key("o") + label(" detach");
    return text + label(" · ") + key("esc") + label(" close");
  }

  private bodyCapacity(): number {
    return Math.max(8, Math.floor(((this.tui.terminal?.rows ?? 40) * this.options.viewportPct) / 100) - 4);
  }

  private currentRows(): MonitorRow[] {
    return monitorRows(monitorSections(this.deps.graphRuns(), this.deps.listAgents(), this.filter));
  }

  private syncSelection(rows: readonly MonitorRow[]): number {
    if (rows.length === 0) {
      this.selectedKey = undefined;
      this.lastIndex = 0;
      return 0;
    }
    const found = this.selectedKey === undefined ? -1 : rows.findIndex(row => row.key === this.selectedKey);
    const index = found >= 0 ? found : Math.min(this.lastIndex, rows.length - 1);
    this.selectedKey = rows[index].key;
    this.lastIndex = index;
    return index;
  }

  private move(rows: readonly MonitorRow[], index: number, delta: number): void {
    const next = index + delta;
    if (next < 0 || next >= rows.length) return;
    this.selectedKey = rows[next].key;
    this.lastIndex = next;
    this.tui.requestRender();
  }

  private openRow(row: MonitorRow): void {
    const overlay = this.options.getOverlay();
    overlay?.setHidden(true);
    const opening = row.kind === "graph"
      ? this.deps.openGraphRun(this.ctx, row.run.id)
      : this.deps.viewAgentConversation(this.ctx, row.record);
    void opening.catch((err: unknown) => {
      const message = errorMessage(err);
      this.ctx.ui.notify(
        row.kind === "graph" ? `Could not open the graph run: ${message}` : `Could not open the conversation: ${message}`,
        "warning",
      );
    }).finally(() => overlay?.setHidden(false));
  }

  private detachRow(row: MonitorRow | undefined): void {
    if (row === undefined) return;
    if (row.kind === "agent") {
      this.ctx.ui.notify("Detach supports agent graph runs only.", "info");
      return;
    }
    const detach = this.deps.detach;
    if (detach === undefined || !detach.available()) {
      this.ctx.ui.notify("Detach needs a Herdr-managed pane.", "warning");
      return;
    }
    void detach.open(row.run.id);
  }
}

/** Open the Agent Monitor. Activation supplies the deps; this only builds the overlay. */
export async function showAgentMonitor(ctx: GraphRunUIContext, deps: AgentMonitorDeps): Promise<void> {
  const { VIEWPORT_HEIGHT_PCT } = await import("./conversation-viewer.js");
  let overlay: MonitorOverlay | undefined;
  await ctx.ui.custom(
    (tui, theme, _keybindings, done) => new AgentMonitor(tui, theme, done, ctx, deps, {
      viewportPct: VIEWPORT_HEIGHT_PCT,
      getOverlay: () => overlay,
    }),
    {
      overlay: true,
      overlayOptions: { anchor: "center", width: "90%", maxHeight: `${VIEWPORT_HEIGHT_PCT}%` },
      onHandle: handle => { overlay = handle; },
    },
  );
}
