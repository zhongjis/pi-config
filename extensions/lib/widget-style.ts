/**
 * widget-style.ts — Shared visual vocabulary for the above-editor status
 * widgets (tasks + subagent). Single source of truth so the two widgets stay
 * consistent and can't silently drift apart again.
 *
 * ASCIIish by design: only BMP glyphs that render without a patched Nerd Font
 * (no private-use codepoints like 󰾆/󱁤). Layout follows the upstream
 * pi-subagents look — a light ├─└─ tree plus a braille spinner — rather than
 * the heavier Claude-Code presentation.
 */

/** Braille spinner frames for animated running/active indicators. */
export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Field separator used between every stat on a widget line. */
export const SEPARATOR = " · ";

/** Light tree connectors shared across widgets. */
export const TREE = {
  /** Non-last item connector. */
  mid: "├─",
  /** Last item connector. */
  last: "└─",
  /** Continuation pipe for a non-last item's sub-line. */
  pipe: "│  ",
  /** Continuation blank for a last item's sub-line. */
  blank: "   ",
} as const;

/** Status glyphs — BMP only, no Nerd Font private-use codepoints. */
export const GLYPH = {
  /** Completed / succeeded. */
  done: "✓",
  /** Pending / not started. */
  pending: "○",
  /** In progress (claimed, not actively streaming). */
  active: "◐",
  /** Queued, waiting to start. */
  queued: "◦",
  /** Stopped by the user. */
  stopped: "■",
  /** Errored / aborted / failed. */
  error: "✗",
  /** Heading bullet — active. */
  headActive: "●",
  /** Heading bullet — idle. */
  headIdle: "○",
} as const;

/** Heading bullet: filled when active, hollow when idle. */
export function headingIcon(active: boolean): string {
  return active ? GLYPH.headActive : GLYPH.headIdle;
}

/** Resolve the spinner glyph for a given animation tick. */
export function spinnerGlyph(frame: number): string {
  return SPINNER[frame % SPINNER.length] ?? SPINNER[0];
}

/** Compact token count: "850", "4.1k", "12.3k", "1.2M" (drops trailing .0). */
export function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${count}`;
}

/** Turn counter: "↻5" or "↻5≤30". */
export function formatTurns(turnCount: number, maxTurns?: number | null): string {
  return maxTurns != null ? `↻${turnCount}≤${maxTurns}` : `↻${turnCount}`;
}

/** Tool-use counter: "1 tool" / "5 tools". */
export function formatTools(count: number): string {
  return `${count} tool${count === 1 ? "" : "s"}`;
}

/** Compaction counter: "⇲2" — number of times context was compacted. */
export function formatCompactions(count: number): string {
  return `⇲${count}`;
}

/**
 * Human-readable duration, compact for dense stat lines:
 *   < 10s  → "4.1s"
 *   < 60s  → "45s"
 *   < 60m  → "1m12s" / "3m"
 *   else   → "1h3m" / "2h"
 */
export function formatDuration(ms: number): string {
  const totalSec = ms / 1000;
  if (totalSec < 10) return Number.isInteger(totalSec) ? `${totalSec}s` : `${totalSec.toFixed(1)}s`;
  if (totalSec < 60) return `${Math.round(totalSec)}s`;
  const totalMin = Math.floor(totalSec / 60);
  const sec = Math.round(totalSec % 60);
  if (totalMin < 60) return sec > 0 ? `${totalMin}m${sec}s` : `${totalMin}m`;
  const hr = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  return min > 0 ? `${hr}h${min}m` : `${hr}h`;
}

/** Join non-empty stat fields with the shared separator. */
export function joinStats(parts: Array<string | undefined | null | false>): string {
  return parts.filter(Boolean).join(SEPARATOR);
}
