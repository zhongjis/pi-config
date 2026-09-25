import type { GraphRunOutcome } from "../graph/outcome.js";

/** Graph run transcript reports and formatting shared with the inspector. */

import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { GraphRunMeta } from "../graph/graph-run-types.js";
import {
  type GraphRunAgentEntry,
  type GraphRunEntry,
  type GraphRunStatus,
} from "../graph/progress.js";
import type { Theme } from "./agent-widget.js";


export interface GraphRunGlyphs {
  /** Tool-title pointer, matching the Agent tool's `▸`. */
  pointer: string;
  tick: string;
  cross: string;
  /** Running/queued. A static glyph, hence no spinner inline. */
  running: string;
  /** First and subsequent phase groups. */
  groupTop: string;
  /** A group that is neither the first nor the last. */
  groupMid: string;
  /** The last phase group. */
  groupBottom: string;
  /** Continuation rail under a non-final group. */
  vertical: string;
  branch: string;
  lastBranch: string;
  /** Log-line prefix, matching the Agent tool's result lines. */
  log: string;
  warning: string;
}

export const UNICODE_GLYPHS: GraphRunGlyphs = {
  pointer: "▸",
  tick: "✔",
  cross: "✘",
  running: "⟳",
  groupTop: "╭─",
  groupMid: "├─",
  groupBottom: "╰─",
  vertical: "│",
  branch: "├─",
  lastBranch: "└─",
  log: "⎿",
  warning: "⚠",
};

/**
 * The `figures` ASCII tier, for terminals that cannot draw the box set. Every
 * glyph keeps its unicode counterpart's column width so the tree stays aligned
 * either way.
 */
export const ASCII_GLYPHS: GraphRunGlyphs = {
  pointer: ">",
  tick: "√",
  cross: "×",
  running: "*",
  groupTop: ",-",
  groupMid: "|-",
  groupBottom: "`-",
  vertical: "|",
  branch: "|-",
  lastBranch: "`-",
  log: "\\",
  warning: "!",
};

/* ------------------------------------------------------------------------- *
 * Lines
 * ------------------------------------------------------------------------- */

/**
 * pi theme keys. Claude Code's palette maps as success→success, error→error,
 * subtle→dim, permission→warning for a blocked row and accent for selection;
 * an undefined colour means "leave it at the terminal default", which is what
 * the recovered inline mapping asks for on a running row.
 *
 * `accent` is unused by the card and exists for the graph runs dialog, which
 * shares these segment types.
 */
export type GraphRunCardColor = "success" | "error" | "warning" | "dim" | "muted" | "toolTitle" | "accent";

export interface GraphRunCardSegment {
  text: string;
  color?: GraphRunCardColor;
  bold?: boolean;
  /** Draw the segment as a monochrome reverse-video bar; ignores `color`/`bold`. */
  reverse?: boolean;
}

export type GraphRunCardLine = GraphRunCardSegment[];

/** The subset of the task record the card reads. */
export interface GraphRunCardTask {
  readonly id?: string;
  readonly scriptPath?: string;
  readonly resultPath?: string;
  readonly resultArtifactError?: string;
  readonly totalToolCalls?: number;
  readonly resumedFrom?: string;
  status: GraphRunStatus;
  graphRunName?: string;
  summary?: string;
  description?: string;
  startTime: number;
  endTime?: number;
  totalPausedMs?: number;
  pausedAt?: number;
  value?: unknown;
  outcome?: GraphRunOutcome;
  error?: string;
}

export interface GraphRunCardInput {
  progress: readonly GraphRunEntry[];
  task: GraphRunCardTask;
  meta?: GraphRunMeta;
  /** Agents the runtime has scheduled, which can exceed those that have reported. */
  agentCount?: number;
  /** Total tokens for the size warning; summed from the entries when omitted. */
  totalTokens?: number;
  agentCap?: number;
  tokenCap?: number;
  now?: number;
  /** Include graph run identity for standalone entries and notifications. */
  showToolTitle?: boolean;
  /** Compact by default; expansion preserves the entire retained report. */
  expanded?: boolean;
}

/* ------------------------------------------------------------------------- *
 * Formatting
 * ------------------------------------------------------------------------- */

/** `18.4k` / `1.2M` — bare magnitude, since the row already reads as a stat. */
export function formatCompactTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return `${count}`;
}

/**
 * One label for the model pair. A fallback that never differed from the primary
 * would just be noise, so it only shows when the run actually has two models in
 * play.
 */
export function formatModel(
  entry: GraphRunAgentEntry,
  opts?: { canonical?: boolean },
): string | undefined {
  const { fallbackModel, requestedModel } = entry;
  // `canonical` is for surfaces with the width for `provider/model-id`; the
  // tight rows take the short label. Chosen here rather than by the caller
  // swapping fields, which would leave `fallbackModel` in the other spelling.
  const model = opts?.canonical ? entry.modelId ?? entry.model : entry.model;
  const primary = model && fallbackModel && model !== fallbackModel ? `${model}→${fallbackModel}` : model ?? fallbackModel;
  if (primary === undefined) return undefined;
  // Disclosed rather than substituted: a model an agent file pinned over the
  // script's is still a model the script did not get (#182). Same rule as
  // `buildInvocationTags`' `asked()` — only when the two actually differ, so a
  // request that was honoured says nothing.
  return requestedModel !== undefined && requestedModel !== primary
    ? `${primary} (asked ${requestedModel})`
    : primary;
}

/**
 * The thinking level, and what was asked for when it was not honoured.
 *
 * Separate from {@link formatModel} because a row can have one without the
 * other: an `agent()` that named no model still runs at some level, and a level
 * pi clamped is worth saying so about even when the model is unremarkable.
 */
export function formatThinking(entry: GraphRunAgentEntry): string | undefined {
  const { thinking, requestedThinking } = entry;
  if (!thinking) return undefined;
  return requestedThinking !== undefined && requestedThinking !== thinking
    ? `thinking: ${thinking} (asked ${requestedThinking})`
    : `thinking: ${thinking}`;
}

/**
 * What a row replayed from a resume journal says instead of a duration.
 *
 * Shared with the dialog so both views name the same thing the same way — the
 * card shows it inline while the run happens, the dialog on the agent's row.
 */
export const REPLAYED_ANNOTATION = "from resume journal";

/** Trim a line to `width`, cutting inside whichever segment crosses the edge. */
export function clampLine(line: GraphRunCardLine, width: number): GraphRunCardLine {
  const clamped: GraphRunCardLine = [];
  let used = 0;
  for (const raw of line) {
    const segment = { ...raw, text: raw.text.replace(/\r\n?|\n/g, " ") };
    const segmentWidth = visibleWidth(segment.text);
    if (used + segmentWidth <= width) {
      clamped.push(segment);
      used += segmentWidth;
      continue;
    }
    const room = width - used;
    // truncateToWidth wraps its ellipsis in resets, which would leak escape
    // codes into a layout that is supposed to be plain text until it is themed.
    if (room > 0) {
      clamped.push({ ...segment, text: stripTerminalSequences(truncateToWidth(segment.text, room, "…")) });
    }
    return clamped;
  }
  return clamped;
}

/** Apply the theme. Nothing here changes the layout, only its colours. */
export function styleGraphRunCardLines(lines: readonly GraphRunCardLine[], theme: Theme): string[] {
  return lines.map(line =>
    line
      .map(segment => {
        if (segment.reverse) return `\x1b[7m${segment.text}\x1b[0m`;
        const text = segment.bold ? theme.bold(segment.text) : segment.text;
        return segment.color ? theme.fg(segment.color, text) : text;
      })
      .join(""),
  );
}

/**
 * Render one line as a full-width reverse-video bar: keep the text (glyph,
 * label, status), drop per-segment colour, and pad to `width` so the whole row
 * inverts. Shared "you are here" selection affordance for both roster surfaces —
 * theme-robust and unambiguous, so hue stays free to carry state, not selection.
 */
export function highlightRow(line: GraphRunCardLine, width: number): GraphRunCardLine {
  const clamped = clampLine(line, width);
  const used = clamped.reduce((sum, segment) => sum + visibleWidth(segment.text), 0);
  const reversed: GraphRunCardLine = clamped.map(segment => ({ text: segment.text, reverse: true }));
  if (used < width) reversed.push({ text: " ".repeat(width - used), reverse: true });
  return reversed;
}

/** Theme plus the optional Pi background the overlay fill uses. */
export type OverlayTheme = Theme & { getBgAnsi?(color: "customMessageBg"): string };

/**
 * Rounded overlay frame.
 *
 * Width that is non-finite or ≤ 0 yields nothing. Width below 6 returns the
 * body clamped to that width, with no border and no fill. At width ≥ 6 every
 * line is exactly `width` cells. When `theme.getBgAnsi` exists, each line is
 * painted with `customMessageBg`, and that fill is re-applied after `\x1b[0m`
 * and `\x1b[49m` so reverse-video and `theme.bg` resets do not punch holes.
 */
export function frameOverlay(
  body: readonly string[],
  width: number,
  theme: OverlayTheme,
  opts?: { title?: string; right?: string; footer?: readonly string[] },
): string[] {
  if (!Number.isFinite(width) || width <= 0) return [];
  if (width < 6) return body.map(line => truncateToWidth(line, width, ""));
  const lines = [
    topBorder(width, theme, opts?.title, opts?.right),
    ...body.map(line => frameRow(line, width, theme)),
  ];
  if (opts?.footer) {
    lines.push(theme.fg("border", `├${"─".repeat(width - 2)}┤`));
    for (const line of opts.footer) lines.push(frameRow(line, width, theme));
  }
  lines.push(theme.fg("border", `╰${"─".repeat(width - 2)}╯`));
  return lines.map(line => paintFill(line, theme));
}

function paintFill(line: string, theme: OverlayTheme): string {
  const bg = theme.getBgAnsi?.("customMessageBg");
  if (!bg) return line;
  return `${bg}${line.replaceAll("\x1b[0m", `\x1b[0m${bg}`).replaceAll("\x1b[49m", `\x1b[49m${bg}`)}\x1b[49m`;
}

function frameRow(content: string, width: number, theme: OverlayTheme): string {
  const innerW = width - 4;
  const clipped = truncateToWidth(content, innerW, "…");
  const pad = Math.max(0, innerW - visibleWidth(clipped));
  return `${theme.fg("border", "│")} ${clipped}${" ".repeat(pad)} ${theme.fg("border", "│")}`;
}

function topBorder(width: number, theme: OverlayTheme, title?: string, right?: string): string {
  const plain = theme.fg("border", `╭${"─".repeat(width - 2)}╮`);
  if (!title) return plain;
  const fitted = right ? titledBorder(width, theme, title, right) : undefined;
  if (fitted) return fitted;
  const maxTitle = width - 6;
  if (maxTitle < 1) return plain;
  const clipped = visibleWidth(title) <= maxTitle ? title : stripTerminalSequences(truncateToWidth(title, maxTitle, "…"));
  return titledBorder(width, theme, clipped) ?? plain;
}

function titledBorder(width: number, theme: OverlayTheme, title: string, right?: string): string | undefined {
  if (!title) return undefined;
  const titleW = visibleWidth(title);
  const rightW = right ? visibleWidth(right) : 0;
  const dashes = width - (right ? titleW + rightW + 8 : titleW + 5);
  if (dashes < 1) return undefined;
  const left = theme.fg("border", "╭─ ");
  const styledTitle = theme.bold(theme.fg("accent", title));
  if (!right) return `${left}${styledTitle}${theme.fg("border", ` ${"─".repeat(dashes)}╮`)}`;
  return `${left}${styledTitle}${theme.fg("border", ` ${"─".repeat(dashes)} `)}${theme.fg("dim", right)}${theme.fg("border", " ─╮")}`;
}
