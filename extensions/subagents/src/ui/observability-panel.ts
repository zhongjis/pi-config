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

import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
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

/**
 * A navigation target in the stage-ordered roster: a stage header or one of its
 * nodes. The cursor and `↑↓` move over the same {@link visibleTargets} order the
 * roster renders, so a collapsed stage's header stays selectable (re-expandable).
 */
export type Target =
  | { kind: "stage"; stage: number }
  | { kind: "node"; id: string };

export interface PanelState {
  /** The selected roster target (stage header or node); resolves to the first target when unset or stale. */
  cursor?: Target;
  /** Which run the switcher points at (index into the run list). */
  runIndex: number;
  /** Body scroll offset, in rendered lines. */
  scroll: number;
  /** Roster filter: show all nodes, only running, or only failed. (v1.5) */
  filter: "all" | "running" | "failed";
  /** Collapsed stage numbers (the adapter's `phaseIndex`); a collapsed stage renders only its header. (v1.5) */
  collapsedStages: number[];
}

export function initialPanelState(): PanelState {
  return { runIndex: 0, scroll: 0, filter: "all", collapsedStages: [] };
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

/** The roster filter mode. (v1.5) */
type PanelFilter = PanelState["filter"];

/** Whether a node's display state passes the active filter. (v1.5) */
function matchesFilter(state: WorkflowDisplayState, filter: PanelFilter): boolean {
  return filter === "all" || state === filter;
}

/**
 * Roster order for `↑↓` selection: for each stage (in dependency order) a header
 * target when the filter leaves it any node, then — unless the stage is collapsed —
 * each of those nodes. This mirrors {@link rosterLines} exactly (header iff shown>0;
 * nodes iff not collapsed), so navigation and rendering never disagree and a
 * collapsed stage keeps a selectable header to re-expand from.
 */
function visibleTargets(
  agents: readonly WorkflowAgentEntry[], active: boolean, filter: PanelFilter, collapsedStages: readonly number[],
): Target[] {
  const collapsed = new Set(collapsedStages);
  const targets: Target[] = [];
  for (const group of stageGroups(agents)) {
    const shown = group.agents.filter(agent => matchesFilter(displayState(agent, active), filter));
    if (shown.length === 0) continue;
    targets.push({ kind: "stage", stage: group.stage });
    if (!collapsed.has(group.stage)) {
      for (const agent of shown) targets.push({ kind: "node", id: agent.label });
    }
  }
  return targets;
}

/** Whether two targets point at the same stage header or node. */
function sameTarget(a: Target, b: Target): boolean {
  return a.kind === "stage" && b.kind === "stage"
    ? a.stage === b.stage
    : a.kind === "node" && b.kind === "node"
      ? a.id === b.id
      : false;
}

/** Index of `cursor` within `targets`, or -1 when unset or no longer present. */
function targetIndex(targets: readonly Target[], cursor: Target | undefined): number {
  return cursor ? targets.findIndex(target => sameTarget(target, cursor)) : -1;
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
  agents: readonly WorkflowAgentEntry[], active: boolean, filter: PanelFilter,
  glyphs: WorkflowDialogGlyphs, ascii: boolean, width: number,
): WorkflowCardLine {
  const counts = countStates(agents, active);
  const dot = ascii ? "*" : "●";
  const sep: WorkflowCardSegment = { text: "  ·  ", color: "dim" };
  const line: WorkflowCardLine = [
    { text: ` ${dot} running ${counts.running}`, color: "accent" },
    sep,
    { text: `${glyphs.queued} queued ${counts.queued}`, color: "dim" },
    sep,
    { text: `${glyphs.tick} done ${counts.done}`, color: "success" },
    sep,
    { text: `${glyphs.cross} failed ${counts.failed}`, color: "error" },
  ];
  // The counts are the true observability read; the filter is only a roster lens.
  if (filter !== "all") line.push({ text: ` · filter: ${filter}`, color: "warning" });
  return clampLine(line, width);
}

function rowActivity(entry: WorkflowAgentEntry, state: WorkflowDisplayState, now: number): string {
  if (state === "blocked" || state === "queued") {
    const waits = (entry.deps ?? []).join(", ");
    return waits ? `waits: ${waits}` : "";
  }
  if (state === "running" && entry.startedAt != null) {
    const elapsed = formatDuration(Math.max(0, now - entry.startedAt));
    return entry.toolCalls != null ? `${elapsed} · ${entry.toolCalls} tools` : elapsed;
  }
  if (entry.durationMs != null) return formatDuration(entry.durationMs);
  return "";
}

function agentRow(
  entry: WorkflowAgentEntry, active: boolean, glyphs: WorkflowDialogGlyphs, width: number, now: number,
): WorkflowCardLine {
  const state = displayState(entry, active);
  const model = entry.model ?? entry.modelId ?? "";
  const line: WorkflowCardLine = [
    { text: "   " },
    dialogRowGlyph(state, glyphs),
    { text: ` ${entry.label}` },
    { text: `  ${statusWord(state)}`, color: stateColor(state) },
  ];
  if (model) line.push({ text: `  ${model}`, color: "dim" });
  const activity = rowActivity(entry, state, now);
  if (activity) line.push({ text: `  ${activity}`, color: "dim" });
  return clampLine(line, width);
}

/**
 * The selected row as one continuous reverse-video bar: keep the text (glyph,
 * label, status), drop per-segment colour, and pad to the full width so the whole
 * row inverts. This is the panel's "you are here", replacing the faint pointer.
 */
function highlightRow(line: WorkflowCardLine, width: number): WorkflowCardLine {
  const clamped = clampLine(line, width);
  const used = clamped.reduce((sum, segment) => sum + visibleWidth(segment.text), 0);
  const reversed: WorkflowCardLine = clamped.map(segment => ({ text: segment.text, reverse: true }));
  if (used < width) reversed.push({ text: " ".repeat(width - used), reverse: true });
  return reversed;
}

function rosterLines(
  groups: readonly StageGroup[], cursor: Target | undefined, active: boolean, filter: PanelFilter,
  collapsedStages: readonly number[], glyphs: WorkflowDialogGlyphs, ascii: boolean, width: number, now: number,
): { lines: WorkflowCardLine[]; selectedRow: number | undefined } {
  const lines: WorkflowCardLine[] = [];
  let selectedRow: number | undefined;
  const ruleChar = ascii ? "-" : "─";
  const collapsed = new Set(collapsedStages);
  for (const group of groups) {
    const shown = group.agents.filter(agent => matchesFilter(displayState(agent, active), filter));
    // A filter that matches no node in this stage hides the whole stage.
    if (shown.length === 0) continue;
    const isCollapsed = collapsed.has(group.stage);
    const marker = ascii ? (isCollapsed ? "> " : "v ") : isCollapsed ? "▸ " : "▾ ";
    const anyFailed = group.agents.some(agent => agent.state === "error" && !agent.skipped);
    const allDone = group.total > 0 && group.done === group.total;
    const headColor: WorkflowCardColor = allDone ? "success" : anyFailed ? "error" : "muted";
    // The `done/total` rollup stays the TRUE totals even when the filter hides rows.
    const label = ` ${marker}Stage ${group.stage + 1} `;
    const count = `${group.done}/${group.total}`;
    const ruleLen = Math.max(1, width - visibleWidth(label) - visibleWidth(count) - 2);
    const headerLine = clampLine([
      { text: label, color: headColor, bold: true },
      { text: `${ruleChar.repeat(ruleLen)} `, color: "dim" },
      { text: count, color: "dim" },
    ], width);
    const headerSelected = cursor?.kind === "stage" && cursor.stage === group.stage;
    if (headerSelected) selectedRow = lines.length;
    lines.push(headerSelected ? highlightRow(headerLine, width) : headerLine);
    if (isCollapsed) continue;
    for (const agent of shown) {
      const nodeSelected = cursor?.kind === "node" && cursor.id === agent.label;
      const row = agentRow(agent, active, glyphs, width, now);
      if (nodeSelected) selectedRow = lines.length;
      lines.push(nodeSelected ? highlightRow(row, width) : row);
    }
  }
  return { lines, selectedRow };
}

/**
 * The detail zone for a stage cursor: a `Stage <n>` + `done/total` summary, then one
 * line per node in the stage with its live state. The node counterpart is
 * {@link detailLines}.
 */
function stageDetailLines(
  group: StageGroup, active: boolean, glyphs: WorkflowDialogGlyphs, ascii: boolean, width: number,
): WorkflowCardLine[] {
  const lines: WorkflowCardLine[] = [];
  const sep = ascii ? "--" : "──";
  lines.push(clampLine([
    { text: " Stage ", color: "muted", bold: true },
    { text: `${sep} ${group.stage + 1}  ${group.done}/${group.total}`, color: "dim" },
  ], width));
  for (const agent of group.agents) {
    const state = displayState(agent, active);
    lines.push(clampLine([
      { text: "  " },
      dialogRowGlyph(state, glyphs),
      { text: ` ${agent.label}  ${statusWord(state)}`, color: stateColor(state) },
    ], width));
  }
  return lines;
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

/**
 * Transitive downstream nodes a failed node took down: walk `dependents` from the
 * failure and collect every reachable node whose display state is `skipped`. A skip
 * cascades (a skipped node's own dependents skip too), so the walk is transitive, with
 * a visited-set that both bounds it and guards against cycles.
 */
function blastRadius(
  entry: WorkflowAgentEntry, byId: Map<string, WorkflowAgentEntry>, active: boolean,
): string[] {
  const skipped: string[] = [];
  const seen = new Set<string>([entry.label]);
  const queue = [...(entry.dependents ?? [])];
  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    const node = byId.get(id);
    if (!node) continue;
    if (displayState(node, active) === "skipped") skipped.push(id);
    for (const next of node.dependents ?? []) {
      if (!seen.has(next)) queue.push(next);
    }
  }
  return skipped;
}

/** A wrapped detail section: a `muted` label line, then `wrapTextWithAnsi` body lines indented 4 and clamped to width. */
function detailSection(lines: WorkflowCardLine[], label: string, body: string, bodyColor: WorkflowCardColor, width: number): void {
  lines.push(clampLine([{ text: `  ${label}`, color: "muted" }], width));
  for (const text of wrapTextWithAnsi(body, Math.max(1, width - 4))) {
    lines.push(clampLine([{ text: `    ${text}`, color: bodyColor }], width));
  }
}

function detailLines(
  entry: WorkflowAgentEntry, agents: readonly WorkflowAgentEntry[], active: boolean,
  glyphs: WorkflowDialogGlyphs, ascii: boolean, width: number, now: number,
): WorkflowCardLine[] {
  const lines: WorkflowCardLine[] = [];
  const sep = ascii ? "--" : "──";
  const arrow = ascii ? "->" : "→";
  const state = displayState(entry, active);
  const model = entry.model ?? entry.modelId ?? "model pending";

  lines.push(clampLine([{ text: " Node ", color: "muted", bold: true }, { text: `${sep} ${entry.label}`, color: "dim" }], width));
  // Live per-node tool/token counts arrive on the entry (GraphRunReporter reads the record); the
  // status line keeps stage + elapsed, and `runtimeFacts` below surfaces the counts.
  const liveFacts = state === "running"
    ? ` · Stage ${(entry.phaseIndex ?? 0) + 1}${entry.startedAt != null ? ` · ${formatDuration(Math.max(0, now - entry.startedAt))}` : ""}`
    : "";
  lines.push(clampLine([
    { text: "  " },
    { text: statusWord(state), color: stateColor(state), bold: true },
    { text: ` · ${entry.agentType ?? "node"} · ${model}${liveFacts}`, color: "dim" },
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

  // Blast radius: the downstream nodes a failure skipped, walked transitively through the DAG.
  if (state === "failed") {
    const skipped = blastRadius(entry, byId, active);
    lines.push(clampLine(
      skipped.length > 0
        ? [{ text: "  Blast radius: ", color: "muted" }, { text: skipped.join(", "), color: "warning" }]
        : [{ text: "  Blast radius: ", color: "muted" }, { text: "none yet", color: "dim" }],
      width,
    ));
  }

  const outcome = outcomeText(entry, state);
  if (outcome) {
    const isError = state === "failed" || state === "blocked";
    detailSection(lines, state === "done" ? "Outcome" : "Error", outcome, isError ? "error" : "dim", width);
  }
  const prompt = entry.promptPreview?.trim();
  if (prompt) detailSection(lines, "Prompt", prompt, "dim", width);
  const facts = runtimeFacts(entry);
  if (facts) lines.push(clampLine([{ text: "  Runtime: ", color: "muted" }, { text: facts, color: "dim" }], width));

  return lines;
}

/** The recordId of the resolved cursor's node when it is a node that has one — the `c` (open) target. */
function openableRecordId(cursor: Target | undefined, agents: readonly WorkflowAgentEntry[]): string | undefined {
  if (cursor?.kind !== "node") return undefined;
  return agents.find(agent => agent.label === cursor.id)?.recordId;
}

function footerLine(
  run: PanelRun, scroll: number, bodyLength: number, capacity: number, ascii: boolean, width: number, canOpen: boolean,
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
    { text: `  ${upDown} move · ${arrow} run · f filter · space fold${canOpen ? " · c convo" : ""} · esc close`, color: "dim" },
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
  headerLines.push(summaryStrip(agents, active, state.filter, glyphs, ascii, width));

  // The cursor resolves to a target still present in the visible order; otherwise it
  // falls to the first target. A stage cursor shows a stage summary, a node cursor its detail.
  const targets = visibleTargets(agents, active, state.filter, state.collapsedStages);
  const cursor: Target | undefined = state.cursor != null && targetIndex(targets, state.cursor) >= 0 ? state.cursor : targets[0];

  const { lines: roster, selectedRow } = rosterLines(groups, cursor, active, state.filter, state.collapsedStages, glyphs, ascii, width, now);
  const bodyLines: WorkflowCardLine[] = [...roster];
  if (cursor?.kind === "node") {
    const selectedEntry = agents.find(agent => agent.label === cursor.id);
    if (selectedEntry) {
      bodyLines.push([]);
      bodyLines.push(...detailLines(selectedEntry, agents, active, glyphs, ascii, width, now));
    }
  } else if (cursor?.kind === "stage") {
    const group = groups.find(candidate => candidate.stage === cursor.stage);
    if (group) {
      bodyLines.push([]);
      bodyLines.push(...stageDetailLines(group, active, glyphs, ascii, width));
    }
  }
  if (bodyLines.length === 0) bodyLines.push(clampLine([{ text: "  No nodes scheduled yet.", color: "dim" }], width));

  const capacity = rows != null ? Math.max(1, rows - headerLines.length - 1) : bodyLines.length;
  const maxScroll = Math.max(0, bodyLines.length - capacity);
  let scroll = clamp(state.scroll, 0, maxScroll);
  // Keep the selected roster row (stage header or node) inside the scrolled window (auto-follow).
  if (selectedRow != null) {
    if (selectedRow < scroll) scroll = selectedRow;
    else if (selectedRow >= scroll + capacity) scroll = selectedRow - capacity + 1;
    scroll = clamp(scroll, 0, maxScroll);
  }

  const out: WorkflowCardLine[] = [...headerLines, ...bodyLines.slice(scroll, scroll + capacity)];
  if (rows != null) {
    while (out.length < rows - 1) out.push([]);
  }
  out.push(footerLine(run, scroll, bodyLines.length, capacity, ascii, width, openableRecordId(cursor, agents) !== undefined));
  if (rows != null && out.length > rows) out.length = rows;
  return out.map(line => clampLine(line, width));
}

/* ------------------------------------------------------------------------- *
 * Keys
 * ------------------------------------------------------------------------- */

/**
 * Apply one forwarded keystroke to the panel's read-only view state and re-render.
 *
 * Mirrors `applyPaneKey`: only `esc`/`q` at the top level closes; a key the panel
 * does not own leaves the state as-is and re-renders idempotently. Run switching
 * (`←/→`) resets the cursor, scroll, and stage collapse but keeps the filter. `f`
 * cycles the roster filter, `space`/`enter` fold the cursor's stage, and `↑↓` move
 * the cursor over the visible stage-header/node targets so a collapsed stage keeps
 * a selectable header to re-expand from. `c` returns an `open` action for the
 * selected node when it has a `recordId`, which the manager turns into a
 * conversation overlay; a stage cursor or a record-less node leaves `c` unowned.
 */
export function applyPanelKey(
  runs: readonly PanelRun[], state: PanelState, data: string, opts: PanelOptions,
): { state: PanelState; lines: WorkflowCardLine[]; close: boolean; action?: { kind: "open"; recordId: string } } {
  const render = (next: PanelState, close = false) => ({ state: next, lines: renderPanelLines(runs, next, opts), close });

  if (matchesKey(data, "escape") || matchesKey(data, "q")) return render(state, true);
  if (runs.length === 0) return render(state);

  const index = clamp(state.runIndex, 0, runs.length - 1);
  const run = runs[index];
  const agents = collapse(run.source.progress).agents;
  const active = isActive(run.status);
  const targets = visibleTargets(agents, active, state.filter, state.collapsedStages);

  if (matchesKey(data, "left") || matchesKey(data, "right")) {
    const nextIndex = clamp(index + (matchesKey(data, "right") ? 1 : -1), 0, runs.length - 1);
    if (nextIndex === index) return render(state);
    // Persist the filter across a run switch; stages differ per graph, so reset collapse and cursor.
    return render({ runIndex: nextIndex, scroll: 0, filter: state.filter, collapsedStages: [] });
  }

  if (matchesKey(data, "pageDown") || matchesKey(data, "pageUp")) {
    const delta = matchesKey(data, "pageDown") ? 5 : -5;
    return render({ ...state, runIndex: index, scroll: Math.max(0, state.scroll + delta) });
  }

  if (matchesKey(data, "f")) {
    const nextFilter: PanelFilter =
      state.filter === "all" ? "running" : state.filter === "running" ? "failed" : "all";
    // If the cursor's target no longer exists under the new filter, snap it to the first target.
    const nextTargets = visibleTargets(agents, active, nextFilter, state.collapsedStages);
    const stillVisible = targetIndex(nextTargets, state.cursor) >= 0;
    return render({
      ...state,
      runIndex: index,
      filter: nextFilter,
      cursor: stillVisible ? state.cursor : nextTargets[0],
    });
  }

  if (matchesKey(data, "space") || matchesKey(data, "enter")) {
    const resolved = targetIndex(targets, state.cursor) >= 0 ? state.cursor : targets[0];
    if (!resolved) return render({ ...state, runIndex: index });
    const stage = resolved.kind === "stage"
      ? resolved.stage
      : (agents.find(agent => agent.label === resolved.id)?.phaseIndex ?? 0);
    const collapsed = new Set(state.collapsedStages);
    let nextCursor: Target = resolved;
    if (collapsed.has(stage)) {
      collapsed.delete(stage);
    } else {
      collapsed.add(stage);
      // Collapsing hides the node rows; land the cursor on the header it re-expands from.
      nextCursor = { kind: "stage", stage };
    }
    return render({ ...state, runIndex: index, collapsedStages: [...collapsed].sort((a, b) => a - b), cursor: nextCursor });
  }

  const down = matchesKey(data, "down") || matchesKey(data, "j");
  const up = matchesKey(data, "up") || matchesKey(data, "k");
  if (down || up) {
    if (targets.length === 0) return render({ ...state, runIndex: index });
    const current = targetIndex(targets, state.cursor);
    // Unset or stale cursor: down starts at the first target, up stays at the first.
    const nextPos = current < 0 ? 0 : clamp(current + (down ? 1 : -1), 0, targets.length - 1);
    return render({ ...state, runIndex: index, cursor: targets[nextPos] });
  }

  if (matchesKey(data, "c")) {
    const resolved = targetIndex(targets, state.cursor) >= 0 ? state.cursor : targets[0];
    const recordId = openableRecordId(resolved, agents);
    // Only a node with a recordId can open; a stage cursor or record-less node leaves `c` unowned.
    if (recordId !== undefined) return { ...render(state), action: { kind: "open", recordId } };
  }

  // A key the panel does not own leaves state unchanged.
  return render(state);
}
