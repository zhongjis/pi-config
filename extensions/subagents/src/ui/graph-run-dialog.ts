import { type HistoricalGraphRun, historyDisclosure } from "../graph/history-view.js";
/** `/agents → Graph runs`: stable phase-grouped roster with contextual agent detail. */

import {
  matchesKey,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { GraphRunMeta } from "../graph/graph-run-types.js";
import {
  buildPhaseGroups,
  displayState,
  formatDuration,
  type GraphRunAgentEntry,
  type GraphRunDisplayState,
  type GraphRunEntry,
  header,
  type PhaseGroup,
} from "../graph/progress.js";
import { SPINNER } from "./agent-widget.js";
import {
  ASCII_GLYPHS,
  clampLine,
  formatCompactTokens,
  type GraphRunCardColor,
  type GraphRunCardLine,
  type GraphRunCardSegment,
  type GraphRunCardTask,
  highlightRow,
  REPLAYED_ANNOTATION,
  UNICODE_GLYPHS,
} from "./graph-run-card.js";

const DEFAULT_WIDTH = 80;
const WIDE_LAYOUT_WIDTH = 72;
export const DEFAULT_PANE_BODY_ROWS = 22;
export const MIN_PANE_BODY_ROWS = 6;
export const GRAPH_RUN_DIALOG_REFRESH_MS = 500;

export interface GraphRunDialogGlyphs {
  tick: string;
  cross: string;
  queued: string;
  pointer: string;
  spinner: readonly string[];
  box: {
    topLeft: string;
    topRight: string;
    bottomLeft: string;
    bottomRight: string;
    horizontal: string;
    vertical: string;
    topTee: string;
    bottomTee: string;
  };
  ellipsis: string;
  upDown: string;
  enter: string;
}

export const UNICODE_DIALOG_GLYPHS: GraphRunDialogGlyphs = {
  tick: UNICODE_GLYPHS.tick,
  cross: UNICODE_GLYPHS.cross,
  queued: "◌",
  pointer: "❯",
  spinner: SPINNER,
  box: {
    topLeft: "╭", topRight: "╮", bottomLeft: "╰", bottomRight: "╯",
    horizontal: "─", vertical: "│", topTee: "┬", bottomTee: "┴",
  },
  ellipsis: "…",
  upDown: "↑↓",
  enter: "⏎",
};

export const ASCII_DIALOG_GLYPHS: GraphRunDialogGlyphs = {
  tick: ASCII_GLYPHS.tick,
  cross: ASCII_GLYPHS.cross,
  queued: "o",
  pointer: ">",
  spinner: ["-", "\\", "|", "/"],
  box: {
    topLeft: "+", topRight: "+", bottomLeft: "+", bottomRight: "+",
    horizontal: "-", vertical: "|", topTee: "+", bottomTee: "+",
  },
  ellipsis: "~",
  upDown: "up/down",
  enter: "enter",
};

export function dialogRowGlyph(
  state: GraphRunDisplayState,
  glyphs: GraphRunDialogGlyphs,
  spinnerFrame = 0,
): GraphRunCardSegment {
  switch (state) {
    case "done": return { text: glyphs.tick, color: "success" };
    case "failed": return { text: glyphs.cross, color: "error" };
    case "skipped": return { text: glyphs.cross, color: "dim" };
    case "blocked": return { text: glyphs.cross, color: "warning" };
    case "queued":
    case "interrupted": return { text: glyphs.queued, color: "dim" };
    case "running": return { text: glyphs.spinner[spinnerFrame % glyphs.spinner.length], color: "dim" };
  }
}

export const GRAPH_RUN_DIALOG_COPY = {
  waitingForSlot: "Waiting for an agent slot.",
  waitingForResume: "Run paused; running agents finish, but no new agents start.",
  stoppedEarly: "The graph run stopped before this agent finished.",
  skippedByUser: "Skipped by user.",
  noOutcome: "No retained outcome preview.",
  noAgents: "Waiting for the graph to schedule agents.",
} as const;

export type GraphRunDialogLevel = "roster" | "detail";

export interface GraphRunDialogState {
  /** Stable graph run entry index, never a visual row offset. */
  selectedIndex?: number;
  level: GraphRunDialogLevel;
  detailOffset: number;
  helpVisible: boolean;
}

export function initialGraphRunDialogState(selectedIndex?: number): GraphRunDialogState {
  return { selectedIndex, level: "roster", detailOffset: 0, helpVisible: false };
}

export interface GraphRunDialogSource {
  history?: HistoricalGraphRun["history"];
  /** Live graph input; history deliberately omits it. */
  input?: unknown;
  progress: readonly GraphRunEntry[];
  task: GraphRunCardTask;
  meta?: GraphRunMeta;
  agentCount?: number;
}

export interface GraphRunDialogInput extends GraphRunDialogSource {
  state: GraphRunDialogState;
  available?: Partial<Record<keyof GraphRunDialogActions, boolean>>;
  now?: number;
  width?: number;
  ascii?: boolean;
  spinnerFrame?: number;
  bodyRows?: number;
  fillBody?: boolean;
}

export interface GraphRunDialogActions {
  onKill?(): void;
  onPause?(): void;
  onResume?(): void;
  onSkipAgent?(index: number): void;
  onRetryAgent?(index: number): void;
  onOpenAgent?(recordId: string): void;
}

export type GraphRunDialogAction =
  | { kind: "cancel" }
  | { kind: "kill" }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "skip"; index: number }
  | { kind: "retry"; index: number }
  | { kind: "open"; recordId: string };

export interface ResolvedGraphRunDialog {
  readOnly?: boolean;
  groups: PhaseGroup[];
  agents: GraphRunAgentEntry[];
  selectedPosition: number;
  selectedEntry: GraphRunAgentEntry | undefined;
  graphRunActive: boolean;
  paused: boolean;
  narrow: boolean;
}

export function graphRunDialogContentWidth(terminalWidth: number): number {
  return Math.max(1, terminalWidth - 6);
}

const clampIndex = (index: number, length: number) =>
  length === 0 ? 0 : Math.min(Math.max(0, Math.trunc(index)), length - 1);

export function resolveGraphRunDialog(input: GraphRunDialogInput): ResolvedGraphRunDialog {
  const groups = buildPhaseGroups(input.progress, input.meta?.phases);
  const agents = groups.flatMap(group => group.agents);
  const wanted = input.state.selectedIndex;
  const found = wanted === undefined ? -1 : agents.findIndex(entry => entry.index === wanted);
  const selectedPosition = found >= 0 ? found : clampIndex(0, agents.length);
  return {
    groups,
    agents,
    readOnly: input.history !== undefined,
    selectedPosition,
    selectedEntry: agents[selectedPosition],
    graphRunActive: input.task.status === "running" || input.task.status === "paused",
    paused: input.task.status === "paused",
    narrow: graphRunDialogContentWidth(input.width ?? DEFAULT_WIDTH) < WIDE_LAYOUT_WIDTH,
  };
}

export function subStatusAnnotations(
  entry: GraphRunAgentEntry,
  state: GraphRunDisplayState,
  now: number,
): string[] {
  const parts: string[] = [];
  if (entry.cached) parts.push(REPLAYED_ANNOTATION);
  if ((entry.attempt ?? 0) > 1) parts.push(`attempt ${entry.attempt}`);
  if (entry.lastAttemptReason) parts.push(entry.lastAttemptReason === "user-retry" ? "user retry" : entry.lastAttemptReason);
  if (state === "queued" && entry.queuedAt != null) {
    parts.push(`waiting ${formatDuration(Math.max(0, now - entry.queuedAt))}`);
  }
  return parts;
}

/** Only effective session metadata is shown; requested chains stay in diagnostics. */
export function graphRunAgentModel(entry: GraphRunAgentEntry, state: GraphRunDisplayState): string {
  if (entry.modelId) return entry.modelId;
  if (entry.cached) return "model not run";
  if (state === "queued" || state === "running") return "model pending";
  return "model unavailable";
}

export function agentActions(
  entry: GraphRunAgentEntry | undefined,
  graphRunActive: boolean,
): { skip: boolean; retry: boolean } {
  if (!entry || !graphRunActive) return { skip: false, retry: false };
  const state = displayState(entry, graphRunActive);
  return { skip: state === "queued" || state === "running", retry: state === "running" };
}

function statusWord(state: GraphRunDisplayState): string {
  switch (state) {
    case "done": return "Completed";
    case "failed": return "Failed";
    case "skipped": return "Skipped";
    case "blocked": return "Blocked";
    case "queued": return "Queued";
    case "interrupted": return "Stopped";
    case "running": return "Running";
  }
}

function stateColor(state: GraphRunDisplayState): GraphRunCardColor {
  switch (state) {
    case "done": return "success";
    case "failed": return "error";
    case "blocked": return "warning";
    case "running": return "accent";
    default: return "dim";
  }
}

function graphRunStatusLine(task: GraphRunCardTask, width: number): GraphRunCardLine {
  const executionColor: GraphRunCardColor =
    task.status === "completed" ? "success"
    : task.status === "failed" ? "error"
    : task.status === "paused" ? "warning"
    : task.status === "running" ? "accent"
    : task.status === "killed" ? "warning"
    : "dim";
  const line: GraphRunCardLine = [
    { text: " Execution: ", color: "dim" },
    { text: task.status, color: executionColor, bold: true },
  ];
  if (task.outcome) {
    const outcomeColor: GraphRunCardColor =
      task.outcome.status === "succeeded" ? "success"
      : task.outcome.status === "failed" ? "error"
      : "warning";
    line.push(
      { text: " · Outcome: ", color: "dim" },
      { text: task.outcome.status, color: outcomeColor, bold: true },
      ...("reason" in task.outcome && task.outcome.reason
        ? [{ text: ` — ${task.outcome.reason}`, color: "dim" as const }]
        : []),
    );
  }
  return clampLine(line, width);
}

const lineWidth = (line: GraphRunCardLine) => line.reduce((sum, part) => sum + visibleWidth(part.text), 0);

function rightAlign(left: GraphRunCardLine, right: GraphRunCardLine, width: number): GraphRunCardLine {
  const rightWidth = lineWidth(right);
  const clampedLeft = clampLine(left, Math.max(0, width - rightWidth - 1));
  const gap = Math.max(1, width - lineWidth(clampedLeft) - rightWidth);
  return clampLine([...clampedLeft, { text: " ".repeat(gap) }, ...right], width);
}

function windowRange(selected: number, total: number, capacity: number): { start: number; end: number } {
  const visible = Math.min(capacity, total);
  const start = selected < visible ? 0 : selected - visible + 1;
  return { start, end: start + visible };
}

function padCell(line: GraphRunCardLine, width: number): GraphRunCardLine {
  const clamped = clampLine(line, width);
  return [...clamped, { text: " ".repeat(Math.max(0, width - lineWidth(clamped))) }];
}

function frameTitle(title: string, width: number, glyphs: GraphRunDialogGlyphs): GraphRunCardLine {
  const shown = stripTerminalSequences(truncateToWidth(title, Math.max(0, width - 2), glyphs.ellipsis));
  const rule = Math.max(0, width - visibleWidth(shown) - 2);
  return clampLine([
    { text: " ", color: "dim" },
    { text: shown, color: "muted", bold: true },
    { text: ` ${glyphs.box.horizontal.repeat(rule)}`, color: "dim" },
  ], width);
}

function singlePaneFrame(
  title: string,
  rows: GraphRunCardLine[],
  width: number,
  bodyRows: number,
  glyphs: GraphRunDialogGlyphs,
): GraphRunCardLine[] {
  const inner = Math.max(1, width - 2);
  const lines: GraphRunCardLine[] = [[
    { text: glyphs.box.topLeft, color: "dim" },
    ...frameTitle(title, inner, glyphs),
    { text: glyphs.box.topRight, color: "dim" },
  ]];
  for (let i = 0; i < bodyRows; i++) {
    lines.push([
      { text: glyphs.box.vertical, color: "dim" },
      ...padCell(rows[i] ?? [], inner),
      { text: glyphs.box.vertical, color: "dim" },
    ]);
  }
  lines.push([
    { text: glyphs.box.bottomLeft, color: "dim" },
    { text: glyphs.box.horizontal.repeat(inner), color: "dim" },
    { text: glyphs.box.bottomRight, color: "dim" },
  ]);
  return lines;
}

export function leftPaneWidth(width: number): number {
  const available = Math.max(2, width - 3);
  return Math.max(1, Math.min(42, Math.max(28, Math.floor(available * 0.42)), available - 1));
}

function twoPaneFrame(options: {
  leftTitle: string; rightTitle: string; leftRows: GraphRunCardLine[]; rightRows: GraphRunCardLine[];
  width: number; bodyRows: number; glyphs: GraphRunDialogGlyphs;
}): GraphRunCardLine[] {
  const { glyphs, width } = options;
  const left = leftPaneWidth(width);
  const right = Math.max(1, width - left - 3);
  const lines: GraphRunCardLine[] = [[
    { text: glyphs.box.topLeft, color: "dim" }, ...frameTitle(options.leftTitle, left, glyphs),
    { text: glyphs.box.topTee, color: "dim" }, ...frameTitle(options.rightTitle, right, glyphs),
    { text: glyphs.box.topRight, color: "dim" },
  ]];
  for (let i = 0; i < options.bodyRows; i++) {
    lines.push([
      { text: glyphs.box.vertical, color: "dim" }, ...padCell(options.leftRows[i] ?? [], left),
      { text: glyphs.box.vertical, color: "dim" }, ...padCell(options.rightRows[i] ?? [], right),
      { text: glyphs.box.vertical, color: "dim" },
    ]);
  }
  lines.push([
    { text: glyphs.box.bottomLeft, color: "dim" },
    { text: glyphs.box.horizontal.repeat(left), color: "dim" },
    { text: glyphs.box.bottomTee, color: "dim" },
    { text: glyphs.box.horizontal.repeat(right), color: "dim" },
    { text: glyphs.box.bottomRight, color: "dim" },
  ]);
  return lines;
}

type RosterItem =
  | { kind: "phase"; group: PhaseGroup }
  | { kind: "agent"; entry: GraphRunAgentEntry }
  | { kind: "empty"; text: string };

function rosterItems(groups: readonly PhaseGroup[]): RosterItem[] {
  if (groups.length === 0) return [{ kind: "empty", text: GRAPH_RUN_DIALOG_COPY.noAgents }];
  return groups.flatMap(group => [
    { kind: "phase", group } as const,
    ...(group.agents.length > 0
      ? group.agents.map(entry => ({ kind: "agent", entry }) as const)
      : [{ kind: "empty", text: GRAPH_RUN_DIALOG_COPY.noAgents } as const]),
  ]);
}

function phaseRow(group: PhaseGroup, width: number): GraphRunCardLine {
  const color: GraphRunCardColor = group.status === "done" ? "success" : group.status === "failed" ? "error" : "muted";
  const count = group.totalCount > 0 ? `${group.doneCount}/${group.totalCount} ` : "";
  return rightAlign(
    [{ text: ` ${group.title}`, color, bold: true }],
    count ? [{ text: count, color }] : [],
    width,
  );
}

function agentRow(options: {
  entry: GraphRunAgentEntry; selected: boolean; width: number; glyphs: GraphRunDialogGlyphs;
  graphRunActive: boolean; spinnerFrame: number; now: number;
}): GraphRunCardLine {
  const state = displayState(options.entry, options.graphRunActive);
  const color = stateColor(state);
  const status = (options.entry.cached ? "Replayed" : statusWord(state)).padEnd(9);
  const model = graphRunAgentModel(options.entry, state);
  const annotations = subStatusAnnotations(options.entry, state, options.now);
  const left: GraphRunCardLine = [
    { text: options.selected ? ` ${options.glyphs.pointer} ` : "   " },
    dialogRowGlyph(state, options.glyphs, options.spinnerFrame),
    { text: ` ${status} `, color },
    { text: options.entry.label },
  ];
  for (const note of annotations.filter(note => note !== REPLAYED_ANNOTATION)) {
    left.push({ text: " · ", color: "dim" }, { text: note, color: "dim" });
  }
  const right: GraphRunCardLine = [{ text: `${model} `, color: "dim" }];
  return rightAlign(left, right, options.width);
}

function renderRoster(
  view: ResolvedGraphRunDialog, width: number, capacity: number, glyphs: GraphRunDialogGlyphs, spinnerFrame: number, now: number,
): GraphRunCardLine[] {
  const items = rosterItems(view.groups);
  const selectedRow = Math.max(0, items.findIndex(item => item.kind === "agent" && item.entry.index === view.selectedEntry?.index));
  const range = windowRange(selectedRow, items.length, capacity);
  return items.slice(range.start, range.end).map(item => {
    if (item.kind === "phase") return phaseRow(item.group, width);
    if (item.kind === "empty") return clampLine([{ text: `   ${item.text}`, color: "dim" }], width);
    const selected = item.entry.index === view.selectedEntry?.index;
    const row = agentRow({ entry: item.entry, selected, width, glyphs, graphRunActive: view.graphRunActive, spinnerFrame, now });
    return selected ? highlightRow(row, width) : row;
  });
}

function section(lines: GraphRunCardLine[], title: string, body: string, width: number): void {
  lines.push([], clampLine([{ text: " " }, { text: title, color: "muted", bold: true }], width));
  const wrapped = wrapTextWithAnsi(body, Math.max(1, width - 4));
  for (const text of wrapped.length > 0 ? wrapped : [""]) {
    lines.push(clampLine([{ text: `   ${text}`, color: "dim" }], width));
  }
}

function outcomeBody(entry: GraphRunAgentEntry, state: GraphRunDisplayState): string {
  switch (state) {
    case "skipped": return GRAPH_RUN_DIALOG_COPY.skippedByUser;
    case "interrupted": return GRAPH_RUN_DIALOG_COPY.stoppedEarly;
    case "failed":
    case "blocked": return entry.error ?? GRAPH_RUN_DIALOG_COPY.noOutcome;
    case "done": return entry.resultPreview ?? GRAPH_RUN_DIALOG_COPY.noOutcome;
    case "queued": return GRAPH_RUN_DIALOG_COPY.waitingForSlot;
    case "running": return "Agent is running.";
  }
}

function detailRows(entry: GraphRunAgentEntry | undefined, view: ResolvedGraphRunDialog, width: number, now: number): GraphRunCardLine[] {
  if (!entry) return [[{ text: `   ${GRAPH_RUN_DIALOG_COPY.noAgents}`, color: "dim" }]];
  const state = displayState(entry, view.graphRunActive);
  const model = graphRunAgentModel(entry, state);
  const rows: GraphRunCardLine[] = [[
    { text: " " },
    { text: entry.cached ? "Replayed" : statusWord(state), color: stateColor(state), bold: true },
    { text: ` · ${model}`, color: "dim" },
  ]];
  if (state === "queued") {
    section(rows, "Waiting", view.paused ? GRAPH_RUN_DIALOG_COPY.waitingForResume : GRAPH_RUN_DIALOG_COPY.waitingForSlot, width);
  } else if (state === "running") {
    const facts = [`${entry.toolCalls ?? 0} tool call${entry.toolCalls === 1 ? "" : "s"}`];
    if (entry.lastProgressAt) facts.push(`updated ${formatDuration(Math.max(0, now - entry.lastProgressAt))} ago`);
    section(rows, "Current activity", facts.join(" · "), width);
  } else {
    section(rows, state === "done" ? "Outcome preview" : "Outcome", outcomeBody(entry, state), width);
  }
  const prompt = entry.promptPreview?.trim();
  section(rows, "Prompt preview", prompt || "Available once the agent starts.", width);
  const runtime = [entry.agentType, `active model: ${model}`];
  if (entry.thinking) runtime.push(`thinking: ${entry.thinking}`);
  if (entry.tokens) runtime.push(`${formatCompactTokens(entry.tokens)} tok`);
  if (entry.toolCalls) runtime.push(`${entry.toolCalls} tool call${entry.toolCalls === 1 ? "" : "s"}`);
  if (entry.durationMs != null) runtime.push(formatDuration(entry.durationMs));
  section(rows, "Runtime", runtime.filter(Boolean).join(" · "), width);
  if (entry.instanceId) section(rows, "Identity", `Key: ${entry.nodeKey}\nInstance: ${entry.instanceId}`, width);
  return rows;
}

function footerLines(
  input: GraphRunDialogInput, view: ResolvedGraphRunDialog, detailCount: number, detailOffset: number, width: number, glyphs: GraphRunDialogGlyphs,
): GraphRunCardLine[] {
  const can = (action: keyof GraphRunDialogActions) => !input.history && (input.available?.[action] ?? true);
  const inNarrowDetail = view.narrow && input.state.level === "detail";
  const primary = [
    inNarrowDetail ? `${glyphs.upDown} scroll` : `${glyphs.upDown} select`,
    ...(view.narrow && !inNarrowDetail && view.selectedEntry ? [`${glyphs.enter} details`] : []),
    ...(view.selectedEntry?.recordId && can("onOpenAgent") ? ["c conversation"] : []),
    ...(view.paused && can("onResume") ? ["p resume"] : view.graphRunActive && can("onPause") ? ["p pause"] : []),
  ];
  const actions = agentActions(view.selectedEntry, view.graphRunActive);
  const extra = [
    ...(actions.skip && can("onSkipAgent") ? ["s skip"] : []),
    ...(actions.retry && can("onRetryAgent") ? ["r retry"] : []),
    ...(view.graphRunActive && can("onKill") ? ["x stop"] : []),
    ...(detailCount > (input.bodyRows ?? DEFAULT_PANE_BODY_ROWS) ? [`pgup/pgdn ${detailOffset + 1}/${detailCount}`] : []),
  ];
  if (extra.length > 0) primary.push(input.state.helpVisible ? "? less" : "? controls");
  primary.push(inNarrowDetail ? "esc back" : "esc close");
  const text = ` ${[...primary, ...(input.state.helpVisible ? extra : [])].join(" · ")}`;
  return wrapTextWithAnsi(text, width).map(part => clampLine([{ text: part, color: "dim" }], width));
}

function resolveGraphRunLayout(input: GraphRunDialogInput): { lines: GraphRunCardLine[]; detailOffset: number } {
  const glyphs = input.ascii ? ASCII_DIALOG_GLYPHS : UNICODE_DIALOG_GLYPHS;
  const terminalWidth = Math.max(0, input.width ?? DEFAULT_WIDTH);
  const width = graphRunDialogContentWidth(terminalWidth);
  const now = input.now ?? Date.now();
  const view = resolveGraphRunDialog(input);
  const capacity = Math.max(1, input.bodyRows ?? DEFAULT_PANE_BODY_ROWS);
  const spinnerFrame = input.spinnerFrame ?? 0;
  const lines: GraphRunCardLine[] = [];
  const head = header(input.task, input.meta, view.groups, input.agentCount ?? 0, now);
  lines.push(clampLine([{ text: " " }, { text: head.name, color: "toolTitle", bold: true }], width));
  lines.push(rightAlign(head.subtext ? [{ text: " " }, { text: head.subtext, color: "dim" }] : [], [{ text: head.stats, color: "dim" }], width));
  lines.push(graphRunStatusLine(input.task, width), []);
  if (input.history) {
    for (const text of wrapTextWithAnsi(historyDisclosure(input.history), width)) lines.push(clampLine([{ text, color: "dim" }], width));
  }

  const frameWidth = Math.max(1, width - 1);
  const rosterWidth = view.narrow ? Math.max(1, frameWidth - 2) : leftPaneWidth(frameWidth);
  const detailWidth = view.narrow ? Math.max(1, frameWidth - 2) : Math.max(1, frameWidth - rosterWidth - 3);
  const roster = renderRoster(view, rosterWidth, capacity, glyphs, spinnerFrame, now);
  const allDetail = detailRows(view.selectedEntry, view, detailWidth, now);
  const detailOffset = Math.min(Math.max(0, input.state.detailOffset), Math.max(0, allDetail.length - capacity));
  const detail = allDetail.slice(detailOffset, detailOffset + capacity);
  const bodyRows = input.fillBody
    ? capacity
    : Math.min(
        capacity,
        Math.max(MIN_PANE_BODY_ROWS, roster.length, view.narrow && input.state.level !== "detail" ? 0 : detail.length),
      );
  const frame = view.narrow
    ? singlePaneFrame(
        input.state.level === "detail" ? (view.selectedEntry?.label ?? "Node detail") : "Graph nodes",
        input.state.level === "detail" ? detail : roster, frameWidth, bodyRows, glyphs,
      )
    : twoPaneFrame({
        leftTitle: "Graph nodes", rightTitle: view.selectedEntry?.label ?? "Node detail",
        leftRows: roster, rightRows: detail, width: frameWidth, bodyRows, glyphs,
      });
  lines.push(...frame.map(line => [{ text: " " }, ...line]));
  lines.push(...footerLines(input, view, allDetail.length, detailOffset, width, glyphs));
  return { lines: lines.map(line => clampLine(line, terminalWidth)), detailOffset };
}

export function layoutGraphRunDialog(input: GraphRunDialogInput): GraphRunCardLine[] {
  return resolveGraphRunLayout(input).lines;
}

export function handleGraphRunDialogKey(
  data: string,
  state: GraphRunDialogState,
  view: ResolvedGraphRunDialog,
): { state: GraphRunDialogState; action?: GraphRunDialogAction } | undefined {
  if (matchesKey(data, "ctrl+c") || matchesKey(data, "q")) return { state, action: { kind: "cancel" } };
  const narrowDetail = view.narrow && state.level === "detail";
  if (matchesKey(data, "escape")) {
    return narrowDetail ? { state: { ...state, level: "roster", detailOffset: 0 } } : { state, action: { kind: "cancel" } };
  }
  if (matchesKey(data, "left") && narrowDetail) return { state: { ...state, level: "roster", detailOffset: 0 } };
  if (matchesKey(data, "?")) return { state: { ...state, helpVisible: !state.helpVisible } };

  if (matchesKey(data, "pageDown") || matchesKey(data, "pageUp")) {
    const delta = matchesKey(data, "pageDown") ? 5 : -5;
    return { state: { ...state, detailOffset: Math.max(0, state.detailOffset + delta) } };
  }
  const down = matchesKey(data, "j") || matchesKey(data, "down");
  const up = matchesKey(data, "k") || matchesKey(data, "up");
  if (down || up) {
    const delta = down ? 1 : -1;
    if (narrowDetail) return { state: { ...state, detailOffset: Math.max(0, state.detailOffset + delta) } };
    const position = clampIndex(view.selectedPosition + delta, view.agents.length);
    const selected = view.agents[position];
    return { state: { ...state, selectedIndex: selected?.index, detailOffset: 0 } };
  }
  if ((matchesKey(data, "enter") || matchesKey(data, "right")) && view.narrow && !narrowDetail) {
    return view.selectedEntry ? { state: { ...state, level: "detail", detailOffset: 0 } } : { state };
  }
  if (view.readOnly) return undefined;
  if (matchesKey(data, "c")) {
    const recordId = view.selectedEntry?.recordId;
    return recordId ? { state, action: { kind: "open", recordId } } : undefined;
  }
  if (matchesKey(data, "x")) return view.graphRunActive ? { state, action: { kind: "kill" } } : undefined;
  if (matchesKey(data, "p")) {
    return view.graphRunActive ? { state, action: { kind: view.paused ? "resume" : "pause" } } : undefined;
  }
  const actions = agentActions(view.selectedEntry, view.graphRunActive);
  if (matchesKey(data, "s") && actions.skip && view.selectedEntry) return { state, action: { kind: "skip", index: view.selectedEntry.index } };
  if (matchesKey(data, "r") && actions.retry && view.selectedEntry) return { state, action: { kind: "retry", index: view.selectedEntry.index } };
  return undefined;
}

export function plainGraphRunDialogLines(lines: readonly GraphRunCardLine[]): string[] {
  return lines.map(line => line.map(segment => segment.text).join(""));
}
