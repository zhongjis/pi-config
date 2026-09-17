/**
 * observability-panel.ts — the `/graph-runs` pane's default view.
 *
 * A run observability panel with three stacked zones — run switcher, stage-ordered
 * node roster + summary strip, and per-node detail with upstream/downstream — built
 * for triage in a narrow terminal column. Pure and terminal-free (it emits
 * {@link WorkflowCardLine}[] and is driven by keystrokes), so it is the single test
 * seam for the pane the same way `layoutWorkflowDialog` is for the roster overlay.
 *
 * It reuses the roster's own vocabulary: the progress-model helpers (`collapse`,
 * `displayState`, `header`, `buildPhaseGroups`, `formatDuration`), the dialog glyph
 * set (`dialogRowGlyph` + the unicode/ascii tiers), and the pane's width pipeline
 * (`clampLine` over pi-tui `visibleWidth`/`truncateToWidth`). The only new data it
 * needs is each node's `deps`/`dependents`, which the graph adapter already emits.
 */

import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  buildPhaseGroups,
  collapse,
  displayState,
  formatDuration,
  header,
  type WorkflowAgentEntry,
  type WorkflowDisplayState,
  type WorkflowRunStatus,
} from "../graph/progress.js";
import {
  clampLine,
  type WorkflowCardColor,
  type WorkflowCardLine,
  type WorkflowCardSegment,
} from "./workflow-card.js";
import {
  ASCII_DIALOG_GLYPHS,
  dialogRowGlyph,
  UNICODE_DIALOG_GLYPHS,
  type WorkflowDialogGlyphs,
  type WorkflowDialogSource,
} from "./workflow-dialog.js";

const DEFAULT_WIDTH = 80;

export interface PanelState {
  /** The node whose detail is shown; defaults to the first roster node when unset or stale. */
  selectedNodeId?: string;
  /** Which run the switcher points at (index into the run list). */
  runIndex: number;
  /** Body scroll offset, in rendered lines. */
  scroll: number;
}

export function initialPanelState(): PanelState {
  return { runIndex: 0, scroll: 0 };
}

/** One switchable run, built by the manager from a background task. */
export interface PanelRun {
  id: string;
  name: string;
  status: WorkflowRunStatus;
  source: WorkflowDialogSource;
}

export interface PanelOptions {
  width: number;
  rows?: number;
  ascii?: boolean;
  now?: number;
}

const clamp = (value: number, lo: number, hi: number): number =>
  Math.min(Math.max(lo, Math.trunc(value)), Math.max(lo, hi));

const isActive = (status: WorkflowRunStatus): boolean => status === "running" || status === "paused";

/* ------------------------------------------------------------------------- *
 * State → glyph / colour vocabulary (shared with the roster)
 * ------------------------------------------------------------------------- */

function stateColor(state: WorkflowDisplayState): WorkflowCardColor {
  switch (state) {
    case "done": return "success";
    case "failed": return "error";
    case "blocked": return "warning";
    case "running": return "accent";
    default: return "dim";
  }
}

function statusWord(state: WorkflowDisplayState): string {
  switch (state) {
    case "done": return "done";
    case "failed": return "failed";
    case "skipped": return "skipped";
    case "blocked": return "blocked";
    case "queued": return "queued";
    case "interrupted": return "stopped";
    case "running": return "running";
  }
}

function runStateColor(status: WorkflowRunStatus): WorkflowCardColor {
  switch (status) {
    case "running": return "accent";
    case "completed": return "success";
    case "failed": return "error";
    case "paused": return "warning";
    case "killed": return "dim";
  }
}

function runStatusDot(status: WorkflowRunStatus, glyphs: WorkflowDialogGlyphs, ascii: boolean): WorkflowCardSegment {
  switch (status) {
    case "running": return { text: ascii ? "*" : "●", color: "accent" };
    case "paused": return { text: glyphs.queued, color: "warning" };
    case "completed": return { text: glyphs.tick, color: "success" };
    case "failed": return { text: glyphs.cross, color: "error" };
    case "killed": return { text: glyphs.cross, color: "dim" };
  }
}

/* ------------------------------------------------------------------------- *
 * Topology-shaped grouping
 * ------------------------------------------------------------------------- */

interface StageGroup {
  stage: number;
  agents: WorkflowAgentEntry[];
  done: number;
  total: number;
}

/** Group nodes by topological stage (the adapter's `phaseIndex`), in dependency order. */
function stageGroups(agents: readonly WorkflowAgentEntry[]): StageGroup[] {
  const byStage = new Map<number, WorkflowAgentEntry[]>();
  for (const agent of agents) {
    const stage = agent.phaseIndex ?? 0;
    const list = byStage.get(stage) ?? [];
    list.push(agent);
    byStage.set(stage, list);
  }
  return [...byStage.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([stage, list]) => ({
      stage,
      agents: list,
      done: list.filter(agent => agent.state === "done").length,
      total: list.length,
    }));
}

/** Roster order: stage-ordered node ids, for `↑↓` selection. */
function orderedNodeIds(agents: readonly WorkflowAgentEntry[]): string[] {
  return stageGroups(agents).flatMap(group => group.agents.map(agent => agent.label));
}

interface Counts {
  running: number;
  queued: number;
  done: number;
  failed: number;
}

function countStates(agents: readonly WorkflowAgentEntry[], active: boolean): Counts {
  const counts: Counts = { running: 0, queued: 0, done: 0, failed: 0 };
  for (const agent of agents) {
    switch (displayState(agent, active)) {
      case "running": counts.running++; break;
      case "queued": counts.queued++; break;
      case "done": counts.done++; break;
      case "failed": counts.failed++; break;
    }
  }
  return counts;
}

/* ------------------------------------------------------------------------- *
 * Zone builders
 * ------------------------------------------------------------------------- */

function switcherLines(
  runs: readonly PanelRun[], index: number, glyphs: WorkflowDialogGlyphs, ascii: boolean, width: number,
): WorkflowCardLine[] {
  const current = runs[index];
  const open = ascii ? "<" : "‹";
  const close = ascii ? ">" : "›";
  const arrow = ascii ? "left/right" : "←→";
  const name = truncateToWidth(current.name, Math.max(4, Math.floor(width * 0.5)), glyphs.ellipsis);
  const lineA: WorkflowCardLine = [
    { text: `${open} `, color: "dim" },
    { text: name, color: "toolTitle", bold: true },
    { text: ` ${close}  `, color: "dim" },
    runStatusDot(current.status, glyphs, ascii),
    { text: ` ${current.status}`, color: runStateColor(current.status) },
    { text: `  ${index + 1}/${runs.length}`, color: "dim" },
  ];

  const chips: WorkflowCardSegment[] = [];
  runs.forEach((run, i) => {
    if (i === index) return;
    if (chips.length > 0) chips.push({ text: " · ", color: "dim" });
    chips.push(runStatusDot(run.status, glyphs, ascii), { text: ` ${run.name}`, color: "dim" });
  });
  const lineB: WorkflowCardLine = chips.length > 0
    ? [{ text: " " }, ...chips, { text: `   ${arrow} run`, color: "dim" }]
    : [{ text: ` ${arrow} run`, color: "dim" }];

  return [clampLine(lineA, width), clampLine(lineB, width)];
}

function summaryStrip(
  agents: readonly WorkflowAgentEntry[], active: boolean, glyphs: WorkflowDialogGlyphs, ascii: boolean, width: number,
): WorkflowCardLine {
  const counts = countStates(agents, active);
  const dot = ascii ? "*" : "●";
  const sep: WorkflowCardSegment = { text: "  ·  ", color: "dim" };
  return clampLine([
    { text: ` ${dot} running ${counts.running}`, color: "accent" },
    sep,
    { text: `${glyphs.queued} queued ${counts.queued}`, color: "dim" },
    sep,
    { text: `${glyphs.tick} done ${counts.done}`, color: "success" },
    sep,
    { text: `${glyphs.cross} failed ${counts.failed}`, color: "error" },
  ], width);
}

function rowActivity(entry: WorkflowAgentEntry, state: WorkflowDisplayState, now: number): string {
  if (state === "blocked" || state === "queued") {
    const waits = (entry.deps ?? []).join(", ");
    return waits ? `waits: ${waits}` : "";
  }
  if (state === "running" && entry.startedAt != null) return formatDuration(Math.max(0, now - entry.startedAt));
  if (entry.durationMs != null) return formatDuration(entry.durationMs);
  return "";
}

function agentRow(
  entry: WorkflowAgentEntry, selected: boolean, active: boolean, glyphs: WorkflowDialogGlyphs, width: number, now: number,
): WorkflowCardLine {
  const state = displayState(entry, active);
  const pointer = selected ? `${glyphs.pointer} ` : "  ";
  const model = entry.model ?? entry.modelId ?? "";
  const line: WorkflowCardLine = [
    { text: ` ${pointer}`, color: "accent" },
    dialogRowGlyph(state, glyphs),
    { text: ` ${entry.label}`, color: selected ? "accent" : undefined },
    { text: `  ${statusWord(state)}`, color: stateColor(state) },
  ];
  if (model) line.push({ text: `  ${model}`, color: "dim" });
  const activity = rowActivity(entry, state, now);
  if (activity) line.push({ text: `  ${activity}`, color: "dim" });
  return clampLine(line, width);
}

function rosterLines(
  groups: readonly StageGroup[], selectedId: string | undefined, active: boolean,
  glyphs: WorkflowDialogGlyphs, ascii: boolean, width: number, now: number,
): { lines: WorkflowCardLine[]; rowForNode: Map<string, number> } {
  const lines: WorkflowCardLine[] = [];
  const rowForNode = new Map<string, number>();
  const ruleChar = ascii ? "-" : "─";
  for (const group of groups) {
    const anyFailed = group.agents.some(agent => agent.state === "error" && !agent.skipped);
    const allDone = group.total > 0 && group.done === group.total;
    const headColor: WorkflowCardColor = allDone ? "success" : anyFailed ? "error" : "muted";
    const label = ` Stage ${group.stage + 1} `;
    const count = `${group.done}/${group.total}`;
    const ruleLen = Math.max(1, width - visibleWidth(label) - visibleWidth(count) - 2);
    lines.push(clampLine([
      { text: label, color: headColor, bold: true },
      { text: `${ruleChar.repeat(ruleLen)} `, color: "dim" },
      { text: count, color: "dim" },
    ], width));
    for (const agent of group.agents) {
      rowForNode.set(agent.label, lines.length);
      lines.push(agentRow(agent, agent.label === selectedId, active, glyphs, width, now));
    }
  }
  return { lines, rowForNode };
}

function outcomeText(entry: WorkflowAgentEntry, state: WorkflowDisplayState): string {
  switch (state) {
    case "failed":
    case "blocked": return entry.error ?? "";
    case "done": return entry.resultPreview ?? "";
    case "skipped": return "skipped by user";
    default: return "";
  }
}

function runtimeFacts(entry: WorkflowAgentEntry): string {
  const parts: string[] = [];
  if (entry.tokens) parts.push(`${entry.tokens} tok`);
  if (entry.toolCalls) parts.push(`${entry.toolCalls} tool${entry.toolCalls === 1 ? "" : "s"}`);
  if (entry.durationMs != null) parts.push(formatDuration(entry.durationMs));
  return parts.join(" · ");
}

function detailLines(
  entry: WorkflowAgentEntry, agents: readonly WorkflowAgentEntry[], active: boolean,
  glyphs: WorkflowDialogGlyphs, ascii: boolean, width: number,
): WorkflowCardLine[] {
  const lines: WorkflowCardLine[] = [];
  const sep = ascii ? "--" : "──";
  const arrow = ascii ? "->" : "→";
  const state = displayState(entry, active);
  const model = entry.model ?? entry.modelId ?? "model pending";

  lines.push(clampLine([{ text: " Node ", color: "muted", bold: true }, { text: `${sep} ${entry.label}`, color: "dim" }], width));
  lines.push(clampLine([
    { text: "  " },
    { text: statusWord(state), color: stateColor(state), bold: true },
    { text: ` · ${entry.agentType ?? "node"} · ${model}`, color: "dim" },
  ], width));

  // Waits on (upstream): each dependency joined against the collapsed roster for its live state.
  const byId = new Map(agents.map(agent => [agent.label, agent] as const));
  const deps = entry.deps ?? [];
  lines.push(clampLine([
    { text: "  Waits on (upstream):", color: "muted" },
    ...(deps.length === 0 ? [{ text: " entry node", color: "dim" as const }] : []),
  ], width));
  for (const depId of deps) {
    const dep = byId.get(depId);
    const depState = dep ? displayState(dep, active) : "queued";
    lines.push(clampLine([
      { text: "    " },
      dialogRowGlyph(depState, glyphs),
      { text: ` ${depId}  ${statusWord(depState)}`, color: dep ? stateColor(depState) : "dim" },
    ], width));
  }

  // Unblocks (downstream): what this node gates.
  const dependents = entry.dependents ?? [];
  const chain = dependents.length > 0 ? dependents.map(id => `${arrow} ${id}`).join(" ") : "—";
  lines.push(clampLine([{ text: "  Unblocks (downstream): ", color: "muted" }, { text: chain, color: "dim" }], width));

  const outcome = outcomeText(entry, state);
  if (outcome) {
    lines.push(clampLine([
      { text: `  ${state === "done" ? "Outcome" : "Error"}: `, color: "muted" },
      { text: outcome, color: state === "failed" || state === "blocked" ? "error" : "dim" },
    ], width));
  }
  const prompt = entry.promptPreview?.trim();
  if (prompt) lines.push(clampLine([{ text: "  Prompt: ", color: "muted" }, { text: prompt, color: "dim" }], width));
  const facts = runtimeFacts(entry);
  if (facts) lines.push(clampLine([{ text: "  Runtime: ", color: "muted" }, { text: facts, color: "dim" }], width));

  return lines;
}

function footerLine(
  run: PanelRun, scroll: number, bodyLength: number, capacity: number, ascii: boolean, width: number,
): WorkflowCardLine {
  const live = isActive(run.status);
  const dot = live ? (ascii ? "*" : "●") : (ascii ? "o" : "○");
  const end = Math.min(bodyLength, scroll + capacity);
  const range = bodyLength > 0 ? `${scroll + 1}-${end}/${bodyLength}` : "0/0";
  const upDown = ascii ? "up/down" : "↑↓";
  const arrow = ascii ? "left/right" : "←→";
  return clampLine([
    { text: ` ${dot} ${live ? "live" : "done"}`, color: live ? "accent" : "dim" },
    { text: `  ${range}`, color: "dim" },
    { text: `  ${upDown} node · ${arrow} run · esc close`, color: "dim" },
  ], width);
}

function padTo(lines: WorkflowCardLine[], rows: number): WorkflowCardLine[] {
  const out = [...lines];
  while (out.length < rows) out.push([]);
  if (out.length > rows) out.length = rows;
  return out;
}

/* ------------------------------------------------------------------------- *
 * Render
 * ------------------------------------------------------------------------- */

export function renderPanelLines(runs: readonly PanelRun[], state: PanelState, opts: PanelOptions): WorkflowCardLine[] {
  const ascii = opts.ascii ?? false;
  const glyphs = ascii ? ASCII_DIALOG_GLYPHS : UNICODE_DIALOG_GLYPHS;
  const width = Math.max(1, opts.width || DEFAULT_WIDTH);
  const now = opts.now ?? Date.now();
  const rows = opts.rows;

  if (runs.length === 0) {
    const lines: WorkflowCardLine[] = [[], clampLine([{ text: "  No graph runs in this session yet.", color: "dim" }], width)];
    return rows != null ? padTo(lines, rows) : lines;
  }

  const index = clamp(state.runIndex, 0, runs.length - 1);
  const run = runs[index];
  const source = run.source;
  const active = isActive(run.status);
  const agents = collapse(source.progress).agents;
  const groups = stageGroups(agents);

  const headerLines: WorkflowCardLine[] = [];
  headerLines.push(...switcherLines(runs, index, glyphs, ascii, width));
  const head = header(source.task, source.meta, buildPhaseGroups(source.progress, source.meta?.phases), source.agentCount ?? 0, now);
  headerLines.push(clampLine([{ text: " " }, { text: head.stats, color: "dim" }], width));
  headerLines.push(summaryStrip(agents, active, glyphs, ascii, width));

  const order = orderedNodeIds(agents);
  const selectedId = state.selectedNodeId != null && order.includes(state.selectedNodeId) ? state.selectedNodeId : order[0];
  const selectedEntry = selectedId != null ? agents.find(agent => agent.label === selectedId) : undefined;

  const { lines: roster, rowForNode } = rosterLines(groups, selectedId, active, glyphs, ascii, width, now);
  const bodyLines: WorkflowCardLine[] = [...roster];
  if (selectedEntry) {
    bodyLines.push([]);
    bodyLines.push(...detailLines(selectedEntry, agents, active, glyphs, ascii, width));
  }
  if (bodyLines.length === 0) bodyLines.push(clampLine([{ text: "  No nodes scheduled yet.", color: "dim" }], width));

  const capacity = rows != null ? Math.max(1, rows - headerLines.length - 1) : bodyLines.length;
  const maxScroll = Math.max(0, bodyLines.length - capacity);
  let scroll = clamp(state.scroll, 0, maxScroll);
  // Keep the selected node's roster row inside the scrolled window (auto-follow).
  const selRow = selectedId != null ? rowForNode.get(selectedId) : undefined;
  if (selRow != null) {
    if (selRow < scroll) scroll = selRow;
    else if (selRow >= scroll + capacity) scroll = selRow - capacity + 1;
    scroll = clamp(scroll, 0, maxScroll);
  }

  const out: WorkflowCardLine[] = [...headerLines, ...bodyLines.slice(scroll, scroll + capacity)];
  if (rows != null) {
    while (out.length < rows - 1) out.push([]);
  }
  out.push(footerLine(run, scroll, bodyLines.length, capacity, ascii, width));
  if (rows != null && out.length > rows) out.length = rows;
  return out.map(line => clampLine(line, width));
}

/* ------------------------------------------------------------------------- *
 * Keys (v1 subset)
 * ------------------------------------------------------------------------- */

/**
 * Apply one forwarded keystroke to the panel's read-only view state and re-render.
 *
 * Mirrors `applyPaneKey`: only `esc`/`q` at the top level closes; a key the panel
 * does not own leaves the state as-is and re-renders idempotently. Run switching
 * (`←/→`) resets node selection and scroll. `c` (open conversation) is deliberately
 * unhandled in v1 — the pure panel has no host, so conversation-open is wired by the
 * manager in a later slice.
 */
export function applyPanelKey(
  runs: readonly PanelRun[], state: PanelState, data: string, opts: PanelOptions,
): { state: PanelState; lines: WorkflowCardLine[]; close: boolean } {
  const render = (next: PanelState, close = false) => ({ state: next, lines: renderPanelLines(runs, next, opts), close });

  if (matchesKey(data, "escape") || matchesKey(data, "q")) return render(state, true);
  if (runs.length === 0) return render(state);

  const index = clamp(state.runIndex, 0, runs.length - 1);
  const run = runs[index];
  const order = orderedNodeIds(collapse(run.source.progress).agents);

  if (matchesKey(data, "left") || matchesKey(data, "right")) {
    const nextIndex = clamp(index + (matchesKey(data, "right") ? 1 : -1), 0, runs.length - 1);
    if (nextIndex === index) return render(state);
    return render({ runIndex: nextIndex, scroll: 0 });
  }

  if (matchesKey(data, "pageDown") || matchesKey(data, "pageUp")) {
    const delta = matchesKey(data, "pageDown") ? 5 : -5;
    return render({ ...state, runIndex: index, scroll: Math.max(0, state.scroll + delta) });
  }

  const down = matchesKey(data, "down") || matchesKey(data, "j");
  const up = matchesKey(data, "up") || matchesKey(data, "k");
  if (down || up) {
    if (order.length === 0) return render({ ...state, runIndex: index });
    const currentId = state.selectedNodeId != null && order.includes(state.selectedNodeId) ? state.selectedNodeId : order[0];
    const nextPos = clamp(order.indexOf(currentId) + (down ? 1 : -1), 0, order.length - 1);
    return render({ ...state, runIndex: index, selectedNodeId: order[nextPos] });
  }

  // A key the panel does not own leaves state unchanged.
  return render(state);
}
