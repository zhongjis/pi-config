/**
 * observability-panel.ts — the `/graph-runs` pane's default view.
 *
 * A run observability panel with a fixed header zone (run switcher, stats, summary
 * strip) over a body that is ALWAYS two stacked zones: an auto-fit stage-complete
 * node roster on top and an always-on, capped node/stage detail below, split by a
 * one-line blank divider. Focus moves between the two zones (`focus: "roster" |
 * "detail"`): the roster owns the cursor and folds, the detail owns a per-section
 * cursor that expands the Prompt / Outcome sections. Built for triage in a narrow
 * terminal column. Pure and terminal-free (it emits {@link WorkflowCardLine}[] and
 * is driven by keystrokes), so it is the single test seam for the pane the same way
 * `layoutWorkflowDialog` is for the roster overlay.
 *
 * Two problems the v3 layout fixes:
 *  1. A node's Outcome is often a huge blob. The detail is now ALWAYS visible but
 *     CAPPED; Prompt and Outcome collapse to two lines with a `⏎ expand` affordance,
 *     and `enter` moves the cursor INTO the detail to expand a section.
 *  2. Later stages used to hide until scrolled to. The roster now auto-fits: it
 *     shows every stage header always, expanding all node rows when they fit and
 *     otherwise only the focused stage's nodes, so no stage header is ever clipped.
 *
 * It reuses the roster's own vocabulary: the progress-model helpers (`collapse`,
 * `displayState`, `header`, `buildPhaseGroups`, `formatDuration`), the dialog glyph
 * set (`dialogRowGlyph` + the unicode/ascii tiers), and the pane's width pipeline
 * (`clampLine` over pi-tui `visibleWidth`/`truncateToWidth`). The only new data it
 * needs is each node's `deps`/`dependents`, which the graph adapter already emits.
 */

import {
  matchesKey,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
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

/** Minimum rows the detail zone asks for when the pane has room to give them. */
const MIN_DETAIL_ROWS = 5;

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
  /** Roster scroll offset, in rendered lines (pages the focused stage's node window). */
  scroll: number;
  /** The detail zone's own scroll offset. */
  detailScroll: number;
  /** Roster filter: show all nodes, only running, or only failed. (v1.5) */
  filter: "all" | "running" | "failed";
  /** Manually force-collapsed stage numbers (the adapter's `phaseIndex`); overrides auto-fit expansion. (v1.5) */
  collapsedStages: number[];
  /** Which zone owns the cursor: the roster overview (default) or the drilled-in detail. (v3) */
  focus: "roster" | "detail";
  /** Index into the detail's navigable (expandable) sections. (v3) */
  detailCursor: number;
  /** Section keys currently expanded, global across nodes: `"prompt"` / `"outcome"`. (v3) */
  expandedSections: string[];
}

export function initialPanelState(): PanelState {
  return {
    runIndex: 0,
    scroll: 0,
    detailScroll: 0,
    filter: "all",
    collapsedStages: [],
    focus: "roster",
    detailCursor: 0,
    expandedSections: [],
  };
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

/** A stage the filter leaves at least one node in, paired with the nodes it keeps. */
interface ShownStage {
  group: StageGroup;
  shown: WorkflowAgentEntry[];
}

/** Stages with any node passing the filter, in dependency order. Empty stages drop out. */
function shownStages(groups: readonly StageGroup[], active: boolean, filter: PanelFilter): ShownStage[] {
  const out: ShownStage[] = [];
  for (const group of groups) {
    const shown = group.agents.filter(agent => matchesFilter(displayState(agent, active), filter));
    if (shown.length > 0) out.push({ group, shown });
  }
  return out;
}

/** Total rendered roster height when the given stages show their node rows. */
function rosterHeight(shown: readonly ShownStage[], isExpanded: (stage: number) => boolean): number {
  let height = 0;
  for (const stage of shown) {
    height += 1;
    if (isExpanded(stage.group.stage)) height += stage.shown.length;
  }
  return height;
}

/**
 * Roster order for `↑↓` selection: a header target for each shown stage, then — when
 * that stage is expanded (per the shared auto-fit predicate) — each of its shown
 * nodes. This mirrors {@link rosterLines} exactly (both consume the same `isExpanded`
 * decision), so navigation and rendering never disagree and a collapsed stage keeps
 * a selectable header to re-expand from. A node target may be scrolled off-screen
 * (large focused stage); navigating to it re-windows the roster.
 */
function visibleTargets(shown: readonly ShownStage[], isExpanded: (stage: number) => boolean): Target[] {
  const targets: Target[] = [];
  for (const stage of shown) {
    targets.push({ kind: "stage", stage: stage.group.stage });
    if (isExpanded(stage.group.stage)) {
      for (const agent of stage.shown) targets.push({ kind: "node", id: agent.label });
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

/**
 * Resolve the raw cursor to a stable target WITHOUT the auto-fit expansion decision,
 * so it can drive the focused-stage choice that feeds that decision. A stage cursor
 * for a shown stage stays; a node cursor stays iff its node exists, passes the filter,
 * and its stage is not manually collapsed (its own stage is always the focused stage,
 * hence always expanded); otherwise it falls to the first shown stage header. Kept in
 * agreement with {@link visibleTargets}: whatever this returns is a valid target.
 */
function resolveCursor(
  cursor: Target | undefined,
  agents: readonly WorkflowAgentEntry[],
  active: boolean,
  filter: PanelFilter,
  collapsed: ReadonlySet<number>,
  shown: readonly ShownStage[],
): Target | undefined {
  if (shown.length === 0) return undefined;
  if (cursor?.kind === "stage" && shown.some(s => s.group.stage === cursor.stage)) return cursor;
  if (cursor?.kind === "node") {
    const node = agents.find(agent => agent.label === cursor.id);
    if (node && matchesFilter(displayState(node, active), filter)) {
      const stage = node.phaseIndex ?? 0;
      if (!collapsed.has(stage) && shown.some(s => s.group.stage === stage)) return cursor;
    }
  }
  return { kind: "stage", stage: shown[0].group.stage };
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
  if (model) line.push({ text: `  ${model}`, color: "muted" });
  const activity = rowActivity(entry, state, now);
  if (activity) line.push({ text: `  ${activity}`, color: "muted" });
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

/**
 * Build the stage-ordered roster and the rendered row of the cursor (for follow /
 * highlight). Every shown stage always emits a header; an expanded stage (per the
 * shared {@link visibleTargets} `isExpanded` predicate) emits its node rows too. In
 * compact mode only the focused stage expands, and — so no stage header is ever
 * clipped — its node rows are windowed to the budget left after every header, around
 * the cursor / `scroll`. With `rosterBudget == null` (no fixed height) nothing is
 * windowed. `highlightCursor` is false while the DETAIL zone owns focus, so the
 * roster keeps tracking the cursor for follow without drawing the reverse bar.
 */
function rosterLines(
  shown: readonly ShownStage[], cursor: Target | undefined, active: boolean,
  isExpanded: (stage: number) => boolean, highlightCursor: boolean, focusedStage: number | undefined,
  rosterBudget: number | null, scroll: number,
  glyphs: WorkflowDialogGlyphs, ascii: boolean, width: number, now: number,
): { lines: WorkflowCardLine[]; selectedRow: number | undefined } {
  const lines: WorkflowCardLine[] = [];
  let selectedRow: number | undefined;
  const ruleChar = ascii ? "-" : "─";
  const headerCount = shown.length;
  const nodeBudget = rosterBudget == null ? Number.POSITIVE_INFINITY : Math.max(0, rosterBudget - headerCount);
  for (const { group, shown: shownAgents } of shown) {
    const expanded = isExpanded(group.stage);
    const marker = ascii ? (expanded ? "v " : "> ") : expanded ? "▾ " : "▸ ";
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
    lines.push(headerSelected && highlightCursor ? highlightRow(headerLine, width) : headerLine);
    if (!expanded) continue;

    // Window the focused stage's nodes so all headers survive; other expanded stages
    // (only in the fits-everything case) render whole.
    let nodesToShow = shownAgents;
    if (rosterBudget != null && group.stage === focusedStage && shownAgents.length > nodeBudget) {
      const selIdx = cursor?.kind === "node" ? shownAgents.findIndex(agent => agent.label === cursor.id) : -1;
      const maxStart = Math.max(0, shownAgents.length - nodeBudget);
      let start = clamp(scroll, 0, maxStart);
      if (selIdx >= 0) {
        if (selIdx < start) start = selIdx;
        else if (selIdx >= start + nodeBudget) start = selIdx - nodeBudget + 1;
        start = clamp(start, 0, maxStart);
      }
      nodesToShow = shownAgents.slice(start, start + nodeBudget);
    }
    for (const agent of nodesToShow) {
      const nodeSelected = cursor?.kind === "node" && cursor.id === agent.label;
      const row = agentRow(agent, active, glyphs, width, now);
      if (nodeSelected) selectedRow = lines.length;
      lines.push(nodeSelected && highlightCursor ? highlightRow(row, width) : row);
    }
  }
  return { lines, selectedRow };
}

/**
 * The detail zone for a stage cursor: a `Stage <n>` header, a summary-strip count line, a
 * rolled-up facts line (Σ tokens · Σ tool calls · wall-clock), and — when the stage took any
 * damage — a failure rollup. Unlike the roster it never repeats the per-node rows. The node
 * counterpart is {@link nodeDetailSections}.
 */
function stageAggregateLines(
  group: StageGroup, active: boolean, glyphs: WorkflowDialogGlyphs, ascii: boolean, width: number,
): WorkflowCardLine[] {
  const lines: WorkflowCardLine[] = [];
  const sep = ascii ? "--" : "──";
  const dot = ascii ? "*" : "●";
  lines.push(clampLine([
    { text: " Stage ", color: "muted", bold: true },
    { text: `${sep} ${group.stage + 1}`, color: "dim" },
  ], width));
  // Live counts across the stage, coloured like the summary strip.
  const counts = countStates(group.agents, active);
  const countSep: WorkflowCardSegment = { text: "  ·  ", color: "dim" };
  lines.push(clampLine([
    { text: `  ${dot} running ${counts.running}`, color: "accent" },
    countSep,
    { text: `${glyphs.queued} queued ${counts.queued}`, color: "dim" },
    countSep,
    { text: `${glyphs.tick} done ${counts.done}`, color: "success" },
    countSep,
    { text: `${glyphs.cross} failed ${counts.failed}`, color: "error" },
  ], width));
  // Rolled-up facts: Σ tokens, Σ tool calls, and wall-clock across the stage. Agents overlap, so
  // the span is earliest start → latest progress, mirroring `summarize()` (not exported here).
  let tokens = 0;
  let tools = 0;
  let minStart = Number.POSITIVE_INFINITY;
  let maxProgress = 0;
  for (const agent of group.agents) {
    if (agent.tokens) tokens += agent.tokens;
    if (agent.toolCalls) tools += agent.toolCalls;
    if (agent.startedAt != null) {
      if (agent.startedAt < minStart) minStart = agent.startedAt;
      const last = agent.lastProgressAt ?? agent.startedAt;
      if (last > maxProgress) maxProgress = last;
    }
  }
  const wall = minStart < Number.POSITIVE_INFINITY ? maxProgress - minStart : 0;
  lines.push(clampLine([
    { text: `  Tokens: ${tokens} · Tools: ${tools} · ${formatDuration(wall)}`, color: "muted" },
  ], width));
  // Failure rollup, so a stage that took damage names its failures.
  const failed = group.agents.filter(agent => displayState(agent, active) === "failed").map(agent => agent.label);
  if (failed.length > 0) {
    lines.push(clampLine([
      { text: "  Failed: ", color: "muted" },
      { text: failed.join(", "), color: "error" },
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

/* ------------------------------------------------------------------------- *
 * Detail sections
 * ------------------------------------------------------------------------- */

/**
 * One block of the node/stage detail. `navigable` sections (Prompt, Outcome) accept
 * the detail cursor and expand/collapse via `key`; `pinned` keeps the outcome anchored
 * at the bottom of the detail zone while the rest of the body scrolls under it. Control
 * data stays typed here, never smuggled into the rendered strings.
 */
interface DetailSection {
  key: string;
  navigable: boolean;
  pinned?: boolean;
  lines: WorkflowCardLine[];
}

/**
 * A collapsible detail section: a `muted` label line, then `wrapTextWithAnsi` body lines
 * indented 4 and clamped to width. Collapsed (default) it caps the body at two lines and,
 * when it hid any, ends the second line with a `dim` `⏎ expand (+N)` affordance (room for
 * which is reserved so it survives the width clamp). Expanded, it shows the full wrap. An
 * undefined `bodyColor` leaves the body at the terminal default fg. Shared by Prompt/Outcome.
 */
function collapsibleSection(
  label: string, body: string, bodyColor: WorkflowCardColor | undefined,
  expanded: boolean, enterGlyph: string, width: number,
): WorkflowCardLine[] {
  const inner = Math.max(1, width - 4);
  const wrapped = wrapTextWithAnsi(body, inner);
  const lines: WorkflowCardLine[] = [clampLine([{ text: `  ${label}`, color: "muted" }], width)];
  const bodySeg = (text: string): WorkflowCardSegment => ({ text: `    ${text}`, ...(bodyColor ? { color: bodyColor } : {}) });
  if (expanded || wrapped.length <= 2) {
    for (const text of wrapped) lines.push(clampLine([bodySeg(text)], width));
    return lines;
  }
  lines.push(clampLine([bodySeg(wrapped[0])], width));
  const hidden = wrapped.length - 2;
  const affordance = `  ${enterGlyph} expand (+${hidden})`;
  const room = Math.max(1, inner - visibleWidth(affordance));
  const line2 = stripTerminalSequences(truncateToWidth(wrapped[1], room, "…"));
  lines.push(clampLine([bodySeg(line2), { text: affordance, color: "dim" }], width));
  return lines;
}

/**
 * The node cursor's detail as ordered {@link DetailSection}s so the caller can render
 * collapsed/expanded per `expandedSections`, highlight the focused navigable section, and
 * keep the Outcome/Error pinned at the bottom. Order: header, status, upstream, downstream,
 * blast radius (failed only), Prompt (navigable), runtime facts, Outcome/Error (navigable,
 * pinned). The stage counterpart is {@link stageAggregateLines}.
 */
function nodeDetailSections(
  entry: WorkflowAgentEntry, agents: readonly WorkflowAgentEntry[], active: boolean,
  glyphs: WorkflowDialogGlyphs, ascii: boolean, width: number, now: number,
  expandedSections: readonly string[],
): DetailSection[] {
  const sections: DetailSection[] = [];
  const sep = ascii ? "--" : "──";
  const arrow = ascii ? "->" : "→";
  const enterGlyph = ascii ? "enter" : "⏎";
  const state = displayState(entry, active);
  const model = entry.model ?? entry.modelId ?? "model pending";

  sections.push({ key: "", navigable: false, lines: [
    clampLine([{ text: " Node ", color: "muted", bold: true }, { text: `${sep} ${entry.label}`, color: "dim" }], width),
  ] });

  // Live per-node tool/token counts arrive on the entry (GraphRunReporter reads the record); the
  // status line keeps stage + elapsed, and `runtimeFacts` below surfaces the counts.
  const liveFacts = state === "running"
    ? ` · Stage ${(entry.phaseIndex ?? 0) + 1}${entry.startedAt != null ? ` · ${formatDuration(Math.max(0, now - entry.startedAt))}` : ""}`
    : "";
  sections.push({ key: "", navigable: false, lines: [
    clampLine([
      { text: "  " },
      { text: statusWord(state), color: stateColor(state), bold: true },
      { text: ` · ${entry.agentType ?? "node"} · ${model}${liveFacts}`, color: "muted" },
    ], width),
  ] });

  // Waits on (upstream): each dependency joined against the collapsed roster for its live state.
  const byId = new Map(agents.map(agent => [agent.label, agent] as const));
  const deps = entry.deps ?? [];
  const waits: WorkflowCardLine[] = [
    clampLine([
      { text: "  Waits on (upstream):", color: "muted" },
      ...(deps.length === 0 ? [{ text: " entry node", color: "muted" as const }] : []),
    ], width),
  ];
  for (const depId of deps) {
    const dep = byId.get(depId);
    const depState = dep ? displayState(dep, active) : "queued";
    waits.push(clampLine([
      { text: "    " },
      dialogRowGlyph(depState, glyphs),
      { text: ` ${depId}  ${statusWord(depState)}`, color: dep ? stateColor(depState) : "dim" },
    ], width));
  }
  sections.push({ key: "", navigable: false, lines: waits });

  // Unblocks (downstream): what this node gates.
  const dependents = entry.dependents ?? [];
  const chain = dependents.length > 0 ? dependents.map(id => `${arrow} ${id}`).join(" ") : "—";
  sections.push({ key: "", navigable: false, lines: [
    clampLine([{ text: "  Unblocks (downstream): ", color: "muted" }, { text: chain, color: "muted" }], width),
  ] });

  // Blast radius: the downstream nodes a failure skipped, walked transitively through the DAG.
  if (state === "failed") {
    const skipped = blastRadius(entry, byId, active);
    sections.push({ key: "", navigable: false, lines: [
      clampLine(
        skipped.length > 0
          ? [{ text: "  Blast radius: ", color: "muted" }, { text: skipped.join(", "), color: "warning" }]
          : [{ text: "  Blast radius: ", color: "muted" }, { text: "none yet", color: "dim" }],
        width,
      ),
    ] });
  }

  // Prompt: the node's real prompt template, left at the terminal default fg so it reads as content.
  const prompt = entry.promptPreview?.trim();
  if (prompt) {
    sections.push({
      key: "prompt", navigable: true,
      lines: collapsibleSection("Prompt", prompt, undefined, expandedSections.includes("prompt"), enterGlyph, width),
    });
  }

  const facts = runtimeFacts(entry);
  if (facts) {
    sections.push({ key: "", navigable: false, lines: [
      clampLine([{ text: "  Runtime: ", color: "muted" }, { text: facts, color: "muted" }], width),
    ] });
  }

  // Outcome LAST + pinned, so the node's result/error stays at the very bottom of the detail zone.
  const outcome = outcomeText(entry, state);
  if (outcome) {
    const isError = state === "failed" || state === "blocked";
    sections.push({
      key: "outcome", navigable: true, pinned: true,
      lines: collapsibleSection(
        state === "done" ? "Outcome" : "Error", outcome, isError ? "error" : "muted",
        expandedSections.includes("outcome"), enterGlyph, width,
      ),
    });
  }

  return sections;
}

/** Detail sections for the resolved cursor: node → {@link nodeDetailSections}; stage → one aggregate block. */
function buildDetailSections(
  cursor: Target | undefined, agents: readonly WorkflowAgentEntry[], groups: readonly StageGroup[],
  active: boolean, glyphs: WorkflowDialogGlyphs, ascii: boolean, width: number, now: number,
  expandedSections: readonly string[],
): DetailSection[] {
  if (cursor?.kind === "node") {
    const entry = agents.find(agent => agent.label === cursor.id);
    return entry ? nodeDetailSections(entry, agents, active, glyphs, ascii, width, now, expandedSections) : [];
  }
  if (cursor?.kind === "stage") {
    const group = groups.find(candidate => candidate.stage === cursor.stage);
    if (group) return [{ key: "", navigable: false, lines: stageAggregateLines(group, active, glyphs, ascii, width) }];
  }
  return [];
}

/** The recordId of the resolved cursor's node when it is a node that has one — the `c` (open) target. */
function openableRecordId(cursor: Target | undefined, agents: readonly WorkflowAgentEntry[]): string | undefined {
  if (cursor?.kind !== "node") return undefined;
  return agents.find(agent => agent.label === cursor.id)?.recordId;
}

function footerLine(
  run: PanelRun, focus: PanelState["focus"], scroll: number, bodyLength: number, capacity: number,
  ascii: boolean, width: number, canOpen: boolean,
): WorkflowCardLine {
  const live = isActive(run.status);
  const dot = live ? (ascii ? "*" : "●") : (ascii ? "o" : "○");
  const end = Math.min(bodyLength, scroll + capacity);
  const range = bodyLength > 0 ? `${scroll + 1}-${end}/${bodyLength}` : "0/0";
  const upDown = ascii ? "up/down" : "↑↓";
  const arrow = ascii ? "left/right" : "←→";
  const enter = ascii ? "enter" : "⏎";
  const convo = canOpen ? " · c convo" : "";
  const hints = focus === "detail"
    ? `${upDown} section · ${enter} expand · f filter${convo} · esc back`
    : `${upDown} move · ${enter} detail · space fold · f filter · ${arrow} run${convo} · esc close`;
  return clampLine([
    { text: ` ${dot} ${live ? "live" : "done"}`, color: live ? "accent" : "dim" },
    { text: `  ${range}`, color: "dim" },
    { text: `  ${hints}`, color: "dim" },
  ], width);
}

/** Scroll offset that keeps `selectedRow` inside a `cap`-tall window over `length` lines (auto-follow). */
function follow(length: number, selectedRow: number | undefined, scroll: number, cap: number): number {
  const maxScroll = Math.max(0, length - cap);
  let s = clamp(scroll, 0, maxScroll);
  if (selectedRow != null) {
    if (selectedRow < s) s = selectedRow;
    else if (selectedRow >= s + cap) s = selectedRow - cap + 1;
    s = clamp(s, 0, maxScroll);
  }
  return s;
}

function padTo(lines: WorkflowCardLine[], rows: number): WorkflowCardLine[] {
  const out = [...lines];
  while (out.length < rows) out.push([]);
  if (out.length > rows) out.length = rows;
  return out;
}

/* ------------------------------------------------------------------------- *
 * Plan — the one shared computation behind render and keys
 * ------------------------------------------------------------------------- */

/**
 * Everything both {@link renderPanelLines} and {@link applyPanelKey} need for one
 * snapshot, computed once so navigation and rendering can never disagree. The pivotal
 * shared decision is `isExpanded`: which stages show their node rows. It depends on the
 * resolved cursor (its stage is the focused stage) and on whether the fully-expanded
 * roster fits the roster budget — never on anything render-only — so `targets` (nav) and
 * the rendered roster expand exactly the same stages.
 */
interface PanelPlan {
  index: number;
  run: PanelRun;
  active: boolean;
  agents: WorkflowAgentEntry[];
  glyphs: WorkflowDialogGlyphs;
  ascii: boolean;
  width: number;
  now: number;
  headerLines: WorkflowCardLine[];
  shown: ShownStage[];
  resolvedCursor: Target | undefined;
  focusedStage: number | undefined;
  isExpanded: (stage: number) => boolean;
  targets: Target[];
  detailSections: DetailSection[];
  navigable: DetailSection[];
  detailContentLen: number;
  capacity: number | null;
  rosterBudget: number | null;
  detailCap: number | null;
}

function planPanel(runs: readonly PanelRun[], state: PanelState, opts: PanelOptions): PanelPlan | null {
  if (runs.length === 0) return null;
  const ascii = opts.ascii ?? false;
  const glyphs = ascii ? ASCII_DIALOG_GLYPHS : UNICODE_DIALOG_GLYPHS;
  const width = Math.max(1, opts.width || DEFAULT_WIDTH);
  const now = opts.now ?? Date.now();
  const rows = opts.rows;

  const index = clamp(state.runIndex, 0, runs.length - 1);
  const run = runs[index];
  const source = run.source;
  const active = isActive(run.status);
  const agents = collapse(source.progress).agents;
  const groups = stageGroups(agents);

  const head = header(source.task, source.meta, buildPhaseGroups(source.progress, source.meta?.phases), source.agentCount ?? 0, now);
  const headerLines: WorkflowCardLine[] = [
    ...switcherLines(runs, index, glyphs, ascii, width),
    clampLine([{ text: " " }, { text: head.stats, color: "muted" }], width),
    summaryStrip(agents, active, state.filter, glyphs, ascii, width),
  ];

  const shown = shownStages(groups, active, state.filter);
  const collapsedSet = new Set(state.collapsedStages);
  const resolvedCursor = resolveCursor(state.cursor, agents, active, state.filter, collapsedSet, shown);
  const focusedStage = resolvedCursor?.kind === "stage"
    ? resolvedCursor.stage
    : resolvedCursor?.kind === "node"
      ? (agents.find(agent => agent.label === resolvedCursor.id)?.phaseIndex ?? 0)
      : undefined;

  const detailSections = buildDetailSections(resolvedCursor, agents, groups, active, glyphs, ascii, width, now, state.expandedSections);
  const detailContentLen = detailSections.reduce((sum, section) => sum + section.lines.length, 0);
  const navigable = detailSections.filter(section => section.navigable);

  // Budget split: the header is fixed, then a 1-line divider separates the roster and detail
  // zones. Headers win first (every stage stays visible when there is room), the detail asks
  // for up to 40% (>= MIN_DETAIL_ROWS when the pane allows), and the roster keeps the rest.
  const capacity = rows != null ? Math.max(1, rows - headerLines.length - 1) : null;
  let rosterBudget: number | null = null;
  let detailCap: number | null = null;
  let fullFits = true;
  if (capacity != null) {
    const available = Math.max(1, capacity - 1);
    const rosterFloor = clamp(Math.min(Math.max(1, shown.length), available - 1), 1, available);
    detailCap = clamp(
      Math.min(detailContentLen, Math.floor(available * 0.4)),
      Math.min(MIN_DETAIL_ROWS, available - rosterFloor),
      available - rosterFloor,
    );
    rosterBudget = Math.max(rosterFloor, available - detailCap);
    const fullHeight = rosterHeight(shown, stage => !collapsedSet.has(stage));
    fullFits = fullHeight <= rosterBudget;
  }

  const isExpanded = (stage: number): boolean =>
    !collapsedSet.has(stage) && (fullFits || stage === focusedStage);

  const targets = visibleTargets(shown, isExpanded);

  return {
    index, run, active, agents, glyphs, ascii, width, now, headerLines, shown,
    resolvedCursor, focusedStage, isExpanded, targets, detailSections, navigable,
    detailContentLen, capacity, rosterBudget, detailCap,
  };
}

/* ------------------------------------------------------------------------- *
 * Render
 * ------------------------------------------------------------------------- */

export function renderPanelLines(runs: readonly PanelRun[], state: PanelState, opts: PanelOptions): WorkflowCardLine[] {
  const width = Math.max(1, opts.width || DEFAULT_WIDTH);
  const rows = opts.rows;
  const plan = planPanel(runs, state, opts);

  if (plan == null) {
    const lines: WorkflowCardLine[] = [[], clampLine([{ text: "  No graph runs in this session yet.", color: "dim" }], width)];
    return rows != null ? padTo(lines, rows) : lines;
  }

  const { ascii, glyphs, now, active, agents, headerLines, shown, resolvedCursor, focusedStage, isExpanded, detailSections, navigable, capacity, rosterBudget, detailCap } = plan;

  // Roster zone: auto-fit, always tracking the cursor. The reverse bar stays off while the
  // detail owns focus, so it moves to the focused detail section instead.
  const highlightCursor = state.focus === "roster";
  const { lines: rosterAll } = rosterLines(
    shown, resolvedCursor, active, isExpanded, highlightCursor, focusedStage,
    rosterBudget, state.scroll, glyphs, ascii, width, now,
  );
  const rosterBody: WorkflowCardLine[] = rosterAll.length > 0
    ? rosterAll
    : [clampLine([{ text: "  No nodes scheduled yet.", color: "dim" }], width)];

  // Detail zone: flatten the sections into a scrollable body plus a pinned outcome, moving the
  // reverse bar onto the focused navigable section's label line when the detail owns focus.
  const highlightSection = state.focus === "detail" && navigable.length > 0
    ? navigable[clamp(state.detailCursor, 0, navigable.length - 1)]
    : undefined;
  const detailBody: WorkflowCardLine[] = [];
  const pinned: WorkflowCardLine[] = [];
  let focusedBodyLine: number | undefined;
  for (const section of detailSections) {
    const sectionLines = section === highlightSection
      ? section.lines.map((line, i) => (i === 0 ? highlightRow(line, width) : line))
      : section.lines;
    if (section.pinned) {
      pinned.push(...sectionLines);
    } else {
      if (section === highlightSection) focusedBodyLine = detailBody.length;
      detailBody.push(...sectionLines);
    }
  }

  let bodyOut: WorkflowCardLine[];
  let footScroll: number;
  let footBodyLength: number;
  let footCapacity: number;

  if (capacity == null) {
    // No fixed height: paint both zones fully, the outcome still last in the detail.
    bodyOut = [...rosterBody, [], ...detailBody, ...pinned];
    footScroll = 0;
    footBodyLength = state.focus === "detail" ? detailBody.length + pinned.length : rosterBody.length;
    footCapacity = footBodyLength;
  } else {
    // Detail body scrolls under a pinned outcome; the focused section is auto-followed into view.
    const bodyCap = Math.max(1, (detailCap as number) - pinned.length);
    const detailScroll = follow(detailBody.length, focusedBodyLine, state.detailScroll, bodyCap);
    let bottomZone: WorkflowCardLine[] = [...detailBody.slice(detailScroll, detailScroll + bodyCap), ...pinned];
    // Guard the rare case where the outcome alone overruns its budget: keep the pinned tail visible.
    if (bottomZone.length > (detailCap as number)) bottomZone = bottomZone.slice(bottomZone.length - (detailCap as number));
    bodyOut = [...rosterBody, [], ...bottomZone];
    // Degenerate tiny panes can push past the window; never let the body eat the footer.
    if (bodyOut.length > capacity) bodyOut = bodyOut.slice(0, capacity);
    if (state.focus === "detail") {
      footScroll = detailScroll;
      footBodyLength = detailBody.length + pinned.length;
      footCapacity = detailCap as number;
    } else {
      footScroll = 0;
      footBodyLength = rosterBody.length;
      footCapacity = rosterBody.length;
    }
  }

  const out: WorkflowCardLine[] = [...headerLines, ...bodyOut];
  if (rows != null) {
    while (out.length < rows - 1) out.push([]);
  }
  out.push(footerLine(plan.run, state.focus, footScroll, footBodyLength, footCapacity, ascii, width, openableRecordId(resolvedCursor, agents) !== undefined));
  if (rows != null && out.length > rows) out.length = rows;
  return out.map(line => clampLine(line, width));
}

/* ------------------------------------------------------------------------- *
 * Keys
 * ------------------------------------------------------------------------- */

const toggleSection = (keys: readonly string[], key: string): string[] =>
  keys.includes(key) ? keys.filter(k => k !== key) : [...keys, key];

/**
 * Apply one forwarded keystroke to the panel's read-only view state and re-render.
 *
 * Two-level focus mirrors the always-on two-zone body. In `focus:"roster"`, `↑↓`/`j`/`k`
 * move the roster cursor (the detail below mirrors it), `enter` drills a node with an
 * expandable section INTO the detail, `space` folds the cursor's stage (landing the cursor
 * on the header so it stays re-expandable — the un-trap), and `esc`/`q` closes. In
 * `focus:"detail"`, `↑↓` move over the Prompt/Outcome sections, `enter`/`space` expand or
 * collapse the focused one, and `esc`/`q` backs out to the roster. `←/→` switches run
 * (resetting to the roster overview, keeping the filter), `f` cycles the filter, `pageUp`/
 * `pageDown` page the focused zone, and `c` opens the selected node's conversation when it
 * has a `recordId`. A key the panel does not own leaves the state as-is and re-renders.
 */
export function applyPanelKey(
  runs: readonly PanelRun[], state: PanelState, data: string, opts: PanelOptions,
): { state: PanelState; lines: WorkflowCardLine[]; close: boolean; action?: { kind: "open"; recordId: string } } {
  const render = (next: PanelState, close = false) => ({ state: next, lines: renderPanelLines(runs, next, opts), close });

  if (matchesKey(data, "escape") || matchesKey(data, "q")) {
    // esc backs out of the detail to the roster first; from the roster it closes.
    if (state.focus === "detail" && runs.length > 0) return render({ ...state, focus: "roster" });
    return render(state, true);
  }
  if (runs.length === 0) return render(state);

  const plan = planPanel(runs, state, opts);
  if (plan == null) return render(state);
  const { index, agents, targets, resolvedCursor, navigable } = plan;

  if (matchesKey(data, "left") || matchesKey(data, "right")) {
    const nextIndex = clamp(index + (matchesKey(data, "right") ? 1 : -1), 0, runs.length - 1);
    if (nextIndex === index) return render(state);
    // Persist the filter across a run switch; stages differ per graph, so reset to the overview.
    return render({
      runIndex: nextIndex, scroll: 0, detailScroll: 0, filter: state.filter,
      collapsedStages: [], focus: "roster", detailCursor: 0, expandedSections: [],
    });
  }

  if (matchesKey(data, "pageDown") || matchesKey(data, "pageUp")) {
    const delta = matchesKey(data, "pageDown") ? 5 : -5;
    // In detail focus the page keys scroll the detail zone; in roster focus, the roster.
    if (state.focus === "detail") return render({ ...state, runIndex: index, detailScroll: Math.max(0, state.detailScroll + delta) });
    return render({ ...state, runIndex: index, scroll: Math.max(0, state.scroll + delta) });
  }

  if (matchesKey(data, "f")) {
    const nextFilter: PanelFilter =
      state.filter === "all" ? "running" : state.filter === "running" ? "failed" : "all";
    // If the cursor's target no longer exists under the new filter, snap it to the first target.
    const nextTargets = planPanel(runs, { ...state, filter: nextFilter }, opts)?.targets ?? [];
    const stillVisible = targetIndex(nextTargets, state.cursor) >= 0;
    return render({
      ...state,
      runIndex: index,
      filter: nextFilter,
      cursor: stillVisible ? state.cursor : nextTargets[0],
    });
  }

  if (matchesKey(data, "enter")) {
    if (state.focus === "detail") {
      if (navigable.length === 0) return render({ ...state, runIndex: index });
      const key = navigable[clamp(state.detailCursor, 0, navigable.length - 1)].key;
      return render({ ...state, runIndex: index, expandedSections: toggleSection(state.expandedSections, key) });
    }
    // Roster focus: drill a node with an expandable section into the detail; else stay put.
    if (resolvedCursor?.kind === "node" && navigable.length > 0) {
      return render({ ...state, runIndex: index, focus: "detail", detailCursor: 0, detailScroll: 0, cursor: resolvedCursor });
    }
    return render({ ...state, runIndex: index });
  }

  if (matchesKey(data, "space")) {
    if (state.focus === "detail") {
      if (navigable.length === 0) return render({ ...state, runIndex: index });
      const key = navigable[clamp(state.detailCursor, 0, navigable.length - 1)].key;
      return render({ ...state, runIndex: index, expandedSections: toggleSection(state.expandedSections, key) });
    }
    // Roster focus: space folds the cursor's stage (the manual override over auto-fit).
    if (!resolvedCursor) return render({ ...state, runIndex: index });
    const stage = resolvedCursor.kind === "stage"
      ? resolvedCursor.stage
      : (agents.find(agent => agent.label === resolvedCursor.id)?.phaseIndex ?? 0);
    const collapsed = new Set(state.collapsedStages);
    let nextCursor: Target = resolvedCursor;
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
    if (state.focus === "detail") {
      if (navigable.length === 0) return render({ ...state, runIndex: index });
      const next = clamp(state.detailCursor + (down ? 1 : -1), 0, navigable.length - 1);
      return render({ ...state, runIndex: index, detailCursor: next });
    }
    if (targets.length === 0) return render({ ...state, runIndex: index });
    const current = targetIndex(targets, state.cursor);
    // Unset or stale cursor: down starts at the first target, up stays at the first.
    const nextPos = current < 0 ? 0 : clamp(current + (down ? 1 : -1), 0, targets.length - 1);
    // A fresh node starts its detail from the top of the (collapsed) sections.
    return render({ ...state, runIndex: index, cursor: targets[nextPos], detailCursor: 0, detailScroll: 0 });
  }

  if (matchesKey(data, "c")) {
    const recordId = openableRecordId(resolvedCursor, agents);
    // Only a node with a recordId can open; a stage cursor or record-less node leaves `c` unowned.
    if (recordId !== undefined) return { ...render(state), action: { kind: "open", recordId } };
  }

  // A key the panel does not own leaves state unchanged.
  return render(state);
}
