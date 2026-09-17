/** `/agents → Workflows`: stable phase-grouped roster with contextual agent detail. */

import {
  type Component,
  matchesKey,
  stripTerminalSequences,
  type TUI,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
  buildPhaseGroups,
  displayState,
  formatDuration,
  header,
  type PhaseGroup,
  type WorkflowAgentEntry,
  type WorkflowDisplayState,
  type WorkflowEntry,
} from "../graph/progress.js";
import type { WorkflowMeta } from "../graph/workflow-types.js";
import { SPINNER, type Theme } from "./agent-widget.js";
import {
  ASCII_GLYPHS,
  clampLine,
  formatCompactTokens,
  REPLAYED_ANNOTATION,
  styleWorkflowCardLines,
  UNICODE_GLYPHS,
  type WorkflowCardColor,
  type WorkflowCardLine,
  type WorkflowCardSegment,
  type WorkflowCardTask,
} from "./workflow-card.js";

const DEFAULT_WIDTH = 80;
const WIDE_LAYOUT_WIDTH = 72;
export const DEFAULT_PANE_BODY_ROWS = 22;
export const MIN_PANE_BODY_ROWS = 6;
export const WORKFLOW_DIALOG_REFRESH_MS = 500;

export interface WorkflowDialogGlyphs {
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

export const UNICODE_DIALOG_GLYPHS: WorkflowDialogGlyphs = {
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

export const ASCII_DIALOG_GLYPHS: WorkflowDialogGlyphs = {
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
  state: WorkflowDisplayState,
  glyphs: WorkflowDialogGlyphs,
  spinnerFrame = 0,
): WorkflowCardSegment {
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

export const WORKFLOW_DIALOG_COPY = {
  waitingForSlot: "Waiting for an agent slot.",
  waitingForResume: "Workflow paused; running agents finish, but no new agents start.",
  stoppedEarly: "The workflow stopped before this agent finished.",
  skippedByUser: "Skipped by user.",
  noOutcome: "No retained outcome preview.",
  noAgents: "Waiting for workflow to schedule agents.",
} as const;

export type WorkflowDialogLevel = "roster" | "detail";

export interface WorkflowDialogState {
  /** Stable workflow entry index, never a visual row offset. */
  selectedIndex?: number;
  level: WorkflowDialogLevel;
  detailOffset: number;
  helpVisible: boolean;
}

export function initialWorkflowDialogState(selectedIndex?: number): WorkflowDialogState {
  return { selectedIndex, level: "roster", detailOffset: 0, helpVisible: false };
}

export interface WorkflowDialogSource {
  progress: readonly WorkflowEntry[];
  task: WorkflowCardTask;
  meta?: WorkflowMeta;
  agentCount?: number;
}

export interface WorkflowDialogInput extends WorkflowDialogSource {
  state: WorkflowDialogState;
  available?: Partial<Record<keyof WorkflowDialogActions, boolean>>;
  now?: number;
  width?: number;
  ascii?: boolean;
  spinnerFrame?: number;
  bodyRows?: number;
}

export interface WorkflowDialogActions {
  onKill?(): void;
  onPause?(): void;
  onResume?(): void;
  onSkipAgent?(index: number): void;
  onRetryAgent?(index: number): void;
  onOpenAgent?(recordId: string): void;
}

export type WorkflowDialogAction =
  | { kind: "cancel" }
  | { kind: "kill" }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "skip"; index: number }
  | { kind: "retry"; index: number }
  | { kind: "open"; recordId: string };

export interface ResolvedWorkflowDialog {
  groups: PhaseGroup[];
  agents: WorkflowAgentEntry[];
  selectedPosition: number;
  selectedEntry: WorkflowAgentEntry | undefined;
  workflowActive: boolean;
  paused: boolean;
  narrow: boolean;
}

export function workflowDialogContentWidth(terminalWidth: number): number {
  return Math.max(1, terminalWidth - 6);
}

const clampIndex = (index: number, length: number) =>
  length === 0 ? 0 : Math.min(Math.max(0, Math.trunc(index)), length - 1);

export function resolveWorkflowDialog(input: WorkflowDialogInput): ResolvedWorkflowDialog {
  const groups = buildPhaseGroups(input.progress, input.meta?.phases);
  const agents = groups.flatMap(group => group.agents);
  const wanted = input.state.selectedIndex;
  const found = wanted === undefined ? -1 : agents.findIndex(entry => entry.index === wanted);
  const selectedPosition = found >= 0 ? found : clampIndex(0, agents.length);
  return {
    groups,
    agents,
    selectedPosition,
    selectedEntry: agents[selectedPosition],
    workflowActive: input.task.status === "running" || input.task.status === "paused",
    paused: input.task.status === "paused",
    narrow: workflowDialogContentWidth(input.width ?? DEFAULT_WIDTH) < WIDE_LAYOUT_WIDTH,
  };
}

export function subStatusAnnotations(
  entry: WorkflowAgentEntry,
  state: WorkflowDisplayState,
  now: number,
): string[] {
  const parts: string[] = [];
  if (entry.cached) parts.push(REPLAYED_ANNOTATION);
  if (entry.lastAttemptReason) parts.push(entry.lastAttemptReason === "user-retry" ? "user retry" : entry.lastAttemptReason);
  if ((entry.attempt ?? 0) > 1) parts.push(`attempt ${entry.attempt}`);
  if (state === "queued" && entry.queuedAt != null) {
    parts.push(`waiting ${formatDuration(Math.max(0, now - entry.queuedAt))}`);
  }
  return parts;
}

/** Only effective session metadata is shown; requested chains stay in diagnostics. */
export function workflowAgentModel(entry: WorkflowAgentEntry, state: WorkflowDisplayState): string {
  if (entry.modelId) return entry.modelId;
  if (entry.cached) return "model not run";
  if (state === "queued" || state === "running") return "model pending";
  return "model unavailable";
}

export function agentActions(
  entry: WorkflowAgentEntry | undefined,
  workflowActive: boolean,
): { skip: boolean; retry: boolean } {
  if (!entry || !workflowActive) return { skip: false, retry: false };
  const state = displayState(entry, workflowActive);
  return { skip: state === "queued" || state === "running", retry: state === "running" };
}

function statusWord(state: WorkflowDisplayState): string {
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

function stateColor(state: WorkflowDisplayState): WorkflowCardColor {
  switch (state) {
    case "done": return "success";
    case "failed": return "error";
    case "blocked": return "warning";
    case "running": return "accent";
    default: return "dim";
  }
}

function workflowStatusLine(task: WorkflowCardTask, width: number): WorkflowCardLine {
  const executionColor: WorkflowCardColor =
    task.status === "completed" ? "success"
    : task.status === "failed" ? "error"
    : task.status === "paused" ? "warning"
    : task.status === "running" ? "accent"
    : "dim";
  const line: WorkflowCardLine = [
    { text: " Execution: ", color: "dim" },
    { text: task.status, color: executionColor, bold: true },
  ];
  if (task.outcome) {
    const outcomeColor: WorkflowCardColor =
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

const lineWidth = (line: WorkflowCardLine) => line.reduce((sum, part) => sum + visibleWidth(part.text), 0);

function rightAlign(left: WorkflowCardLine, right: WorkflowCardLine, width: number): WorkflowCardLine {
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

function padCell(line: WorkflowCardLine, width: number): WorkflowCardLine {
  const clamped = clampLine(line, width);
  return [...clamped, { text: " ".repeat(Math.max(0, width - lineWidth(clamped))) }];
}

function frameTitle(title: string, width: number, glyphs: WorkflowDialogGlyphs): WorkflowCardLine {
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
  rows: WorkflowCardLine[],
  width: number,
  bodyRows: number,
  glyphs: WorkflowDialogGlyphs,
): WorkflowCardLine[] {
  const inner = Math.max(1, width - 2);
  const lines: WorkflowCardLine[] = [[
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
  leftTitle: string; rightTitle: string; leftRows: WorkflowCardLine[]; rightRows: WorkflowCardLine[];
  width: number; bodyRows: number; glyphs: WorkflowDialogGlyphs;
}): WorkflowCardLine[] {
  const { glyphs, width } = options;
  const left = leftPaneWidth(width);
  const right = Math.max(1, width - left - 3);
  const lines: WorkflowCardLine[] = [[
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
  | { kind: "agent"; entry: WorkflowAgentEntry }
  | { kind: "empty"; text: string };

function rosterItems(groups: readonly PhaseGroup[]): RosterItem[] {
  if (groups.length === 0) return [{ kind: "empty", text: WORKFLOW_DIALOG_COPY.noAgents }];
  return groups.flatMap(group => [
    { kind: "phase", group } as const,
    ...(group.agents.length > 0
      ? group.agents.map(entry => ({ kind: "agent", entry }) as const)
      : [{ kind: "empty", text: WORKFLOW_DIALOG_COPY.noAgents } as const]),
  ]);
}

function phaseRow(group: PhaseGroup, width: number): WorkflowCardLine {
  const color: WorkflowCardColor = group.status === "done" ? "success" : group.status === "failed" ? "error" : "muted";
  const count = group.totalCount > 0 ? `${group.doneCount}/${group.totalCount} ` : "";
  return rightAlign(
    [{ text: ` ${group.title}`, color, bold: true }],
    count ? [{ text: count, color }] : [],
    width,
  );
}

function agentRow(options: {
  entry: WorkflowAgentEntry; selected: boolean; width: number; glyphs: WorkflowDialogGlyphs;
  workflowActive: boolean; spinnerFrame: number; now: number;
}): WorkflowCardLine {
  const state = displayState(options.entry, options.workflowActive);
  const color = stateColor(state);
  const status = (options.entry.cached ? "Replayed" : statusWord(state)).padEnd(9);
  const model = workflowAgentModel(options.entry, state);
  const annotations = subStatusAnnotations(options.entry, state, options.now);
  const left: WorkflowCardLine = [
    { text: options.selected ? ` ${options.glyphs.pointer} ` : "   ", color: "accent" },
    dialogRowGlyph(state, options.glyphs, options.spinnerFrame),
    { text: ` ${status} `, color },
    { text: options.entry.label, color: options.selected ? "accent" : undefined },
  ];
  for (const note of annotations.filter(note => note !== REPLAYED_ANNOTATION)) {
    left.push({ text: " · ", color: "dim" }, { text: note, color: "dim" });
  }
  const right: WorkflowCardLine = [{ text: `${model} `, color: "dim" }];
  return rightAlign(left, right, options.width);
}

function renderRoster(
  view: ResolvedWorkflowDialog, width: number, capacity: number, glyphs: WorkflowDialogGlyphs, spinnerFrame: number, now: number,
): WorkflowCardLine[] {
  const items = rosterItems(view.groups);
  const selectedRow = Math.max(0, items.findIndex(item => item.kind === "agent" && item.entry.index === view.selectedEntry?.index));
  const range = windowRange(selectedRow, items.length, capacity);
  return items.slice(range.start, range.end).map(item => {
    if (item.kind === "phase") return phaseRow(item.group, width);
    if (item.kind === "empty") return clampLine([{ text: `   ${item.text}`, color: "dim" }], width);
    return agentRow({
      entry: item.entry, selected: item.entry.index === view.selectedEntry?.index, width, glyphs,
      workflowActive: view.workflowActive, spinnerFrame, now,
    });
  });
}

function section(lines: WorkflowCardLine[], title: string, body: string, width: number): void {
  lines.push([], clampLine([{ text: " " }, { text: title, color: "muted", bold: true }], width));
  const wrapped = wrapTextWithAnsi(body, Math.max(1, width - 4));
  for (const text of wrapped.length > 0 ? wrapped : [""]) {
    lines.push(clampLine([{ text: `   ${text}`, color: "dim" }], width));
  }
}

function outcomeBody(entry: WorkflowAgentEntry, state: WorkflowDisplayState): string {
  switch (state) {
    case "skipped": return WORKFLOW_DIALOG_COPY.skippedByUser;
    case "interrupted": return WORKFLOW_DIALOG_COPY.stoppedEarly;
    case "failed":
    case "blocked": return entry.error ?? WORKFLOW_DIALOG_COPY.noOutcome;
    case "done": return entry.resultPreview ?? WORKFLOW_DIALOG_COPY.noOutcome;
    case "queued": return WORKFLOW_DIALOG_COPY.waitingForSlot;
    case "running": return "Agent is running.";
  }
}

function detailRows(entry: WorkflowAgentEntry | undefined, view: ResolvedWorkflowDialog, width: number, now: number): WorkflowCardLine[] {
  if (!entry) return [[{ text: `   ${WORKFLOW_DIALOG_COPY.noAgents}`, color: "dim" }]];
  const state = displayState(entry, view.workflowActive);
  const model = workflowAgentModel(entry, state);
  const rows: WorkflowCardLine[] = [[
    { text: " " },
    { text: entry.cached ? "Replayed" : statusWord(state), color: stateColor(state), bold: true },
    { text: ` · ${model}`, color: "dim" },
  ]];
  if (state === "queued") {
    section(rows, "Waiting", view.paused ? WORKFLOW_DIALOG_COPY.waitingForResume : WORKFLOW_DIALOG_COPY.waitingForSlot, width);
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
  return rows;
}

function footerLines(
  input: WorkflowDialogInput, view: ResolvedWorkflowDialog, detailCount: number, detailOffset: number, width: number, glyphs: WorkflowDialogGlyphs,
): WorkflowCardLine[] {
  const can = (action: keyof WorkflowDialogActions) => input.available?.[action] ?? true;
  const inNarrowDetail = view.narrow && input.state.level === "detail";
  const primary = [
    inNarrowDetail ? `${glyphs.upDown} scroll` : `${glyphs.upDown} select`,
    ...(view.narrow && !inNarrowDetail && view.selectedEntry ? [`${glyphs.enter} details`] : []),
    ...(view.selectedEntry?.recordId && can("onOpenAgent") ? ["c conversation"] : []),
    ...(view.paused && can("onResume") ? ["p resume"] : view.workflowActive && can("onPause") ? ["p pause"] : []),
  ];
  const actions = agentActions(view.selectedEntry, view.workflowActive);
  const extra = [
    ...(actions.skip && can("onSkipAgent") ? ["s skip"] : []),
    ...(actions.retry && can("onRetryAgent") ? ["r retry"] : []),
    ...(view.workflowActive && can("onKill") ? ["x stop"] : []),
    ...(detailCount > (input.bodyRows ?? DEFAULT_PANE_BODY_ROWS) ? [`pgup/pgdn ${detailOffset + 1}/${detailCount}`] : []),
  ];
  if (extra.length > 0) primary.push(input.state.helpVisible ? "? less" : "? controls");
  primary.push(inNarrowDetail ? "esc back" : "esc close");
  const text = ` ${[...primary, ...(input.state.helpVisible ? extra : [])].join(" · ")}`;
  return wrapTextWithAnsi(text, width).map(part => clampLine([{ text: part, color: "dim" }], width));
}

function resolveWorkflowLayout(input: WorkflowDialogInput): { lines: WorkflowCardLine[]; detailOffset: number } {
  const glyphs = input.ascii ? ASCII_DIALOG_GLYPHS : UNICODE_DIALOG_GLYPHS;
  const terminalWidth = Math.max(0, input.width ?? DEFAULT_WIDTH);
  const width = workflowDialogContentWidth(terminalWidth);
  const now = input.now ?? Date.now();
  const view = resolveWorkflowDialog(input);
  const capacity = Math.max(1, input.bodyRows ?? DEFAULT_PANE_BODY_ROWS);
  const spinnerFrame = input.spinnerFrame ?? 0;
  const lines: WorkflowCardLine[] = [];
  const head = header(input.task, input.meta, view.groups, input.agentCount ?? 0, now);
  lines.push(clampLine([{ text: " " }, { text: head.name, color: "toolTitle", bold: true }], width));
  lines.push(rightAlign(head.subtext ? [{ text: " " }, { text: head.subtext, color: "dim" }] : [], [{ text: head.stats, color: "dim" }], width));
  lines.push(workflowStatusLine(input.task, width), []);

  const frameWidth = Math.max(1, width - 1);
  const rosterWidth = view.narrow ? Math.max(1, frameWidth - 2) : leftPaneWidth(frameWidth);
  const detailWidth = view.narrow ? Math.max(1, frameWidth - 2) : Math.max(1, frameWidth - rosterWidth - 3);
  const roster = renderRoster(view, rosterWidth, capacity, glyphs, spinnerFrame, now);
  const allDetail = detailRows(view.selectedEntry, view, detailWidth, now);
  const detailOffset = Math.min(Math.max(0, input.state.detailOffset), Math.max(0, allDetail.length - capacity));
  const detail = allDetail.slice(detailOffset, detailOffset + capacity);
  const bodyRows = Math.min(
    capacity,
    Math.max(MIN_PANE_BODY_ROWS, roster.length, view.narrow && input.state.level !== "detail" ? 0 : detail.length),
  );
  const frame = view.narrow
    ? singlePaneFrame(
        input.state.level === "detail" ? (view.selectedEntry?.label ?? "Agent detail") : "Workflow agents",
        input.state.level === "detail" ? detail : roster, frameWidth, bodyRows, glyphs,
      )
    : twoPaneFrame({
        leftTitle: "Workflow agents", rightTitle: view.selectedEntry?.label ?? "Agent detail",
        leftRows: roster, rightRows: detail, width: frameWidth, bodyRows, glyphs,
      });
  lines.push(...frame.map(line => [{ text: " " }, ...line]));
  lines.push(...footerLines(input, view, allDetail.length, detailOffset, width, glyphs));
  return { lines: lines.map(line => clampLine(line, terminalWidth)), detailOffset };
}

export function layoutWorkflowDialog(input: WorkflowDialogInput): WorkflowCardLine[] {
  return resolveWorkflowLayout(input).lines;
}

export function handleWorkflowDialogKey(
  data: string,
  state: WorkflowDialogState,
  view: ResolvedWorkflowDialog,
): { state: WorkflowDialogState; action?: WorkflowDialogAction } | undefined {
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
  if (matchesKey(data, "c")) {
    const recordId = view.selectedEntry?.recordId;
    return recordId ? { state, action: { kind: "open", recordId } } : undefined;
  }
  if (matchesKey(data, "x")) return view.workflowActive ? { state, action: { kind: "kill" } } : undefined;
  if (matchesKey(data, "p")) {
    return view.workflowActive ? { state, action: { kind: view.paused ? "resume" : "pause" } } : undefined;
  }
  const actions = agentActions(view.selectedEntry, view.workflowActive);
  if (matchesKey(data, "s") && actions.skip && view.selectedEntry) return { state, action: { kind: "skip", index: view.selectedEntry.index } };
  if (matchesKey(data, "r") && actions.retry && view.selectedEntry) return { state, action: { kind: "retry", index: view.selectedEntry.index } };
  return undefined;
}

export function plainWorkflowDialogLines(lines: readonly WorkflowCardLine[]): string[] {
  return lines.map(line => line.map(segment => segment.text).join(""));
}

const taskIsLive = (task: WorkflowCardTask) => task.status === "running" || task.status === "paused";

export class WorkflowDialog implements Component {
  private state = initialWorkflowDialogState();
  private spinnerFrame = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private closed = false;
  private lastWidth = DEFAULT_WIDTH;

  constructor(
    private tui: TUI,
    private source: () => WorkflowDialogSource,
    private theme: Theme,
    private done: (result: undefined) => void,
    private actions: WorkflowDialogActions = {},
  ) {
    if (taskIsLive(this.source().task)) {
      this.timer = setInterval(() => {
        if (!taskIsLive(this.source().task)) this.stopTimer();
        if (!this.closed) { this.spinnerFrame++; this.tui.requestRender(); }
      }, WORKFLOW_DIALOG_REFRESH_MS);
      this.timer.unref?.();
    }
  }

  handleInput(data: string): void {
    if (this.closed) return;
    const input: WorkflowDialogInput = { ...this.source(), state: this.state, width: this.lastWidth };
    const result = handleWorkflowDialogKey(data, this.state, resolveWorkflowDialog(input));
    if (!result) return;
    this.state = result.state;
    if (result.action) this.dispatch(result.action);
    if (!this.closed) this.tui.requestRender();
  }

  render(width: number): string[] {
    if (!Number.isFinite(width) || width <= 0) return [];
    this.lastWidth = width;
    const layout = resolveWorkflowLayout({
      ...this.source(),
      state: this.state,
      available: {
        onKill: !!this.actions.onKill, onPause: !!this.actions.onPause, onResume: !!this.actions.onResume,
        onSkipAgent: !!this.actions.onSkipAgent, onRetryAgent: !!this.actions.onRetryAgent,
        onOpenAgent: !!this.actions.onOpenAgent,
      },
      width,
      bodyRows: Math.max(1, Math.min(DEFAULT_PANE_BODY_ROWS, Math.floor((this.tui.terminal?.rows ?? 40) * 0.8) - 10)),
      spinnerFrame: this.spinnerFrame,
    });
    this.state.detailOffset = layout.detailOffset;
    return styleWorkflowCardLines(layout.lines, this.theme);
  }

  invalidate(): void {}

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopTimer();
  }

  private stopTimer(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private dispatch(action: WorkflowDialogAction): void {
    switch (action.kind) {
      case "cancel": this.dispose(); this.done(undefined); return;
      case "kill": this.actions.onKill?.(); return;
      case "pause": this.actions.onPause?.(); return;
      case "resume": this.actions.onResume?.(); return;
      case "skip": this.actions.onSkipAgent?.(action.index); return;
      case "retry": this.actions.onRetryAgent?.(action.index); return;
      case "open": this.actions.onOpenAgent?.(action.recordId); return;
    }
  }
}
