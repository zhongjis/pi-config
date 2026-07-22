type BoomerangTheme = {
  fg(color: string, text: string): string;
  bold(text: string): string;
};
import { renderToolCall, renderToolExpanded, renderToolSummary, extractToolText, firstMeaningfulLine } from "../lib/tool-output.js";

export type BoomerangToolArgs = {
  task?: unknown;
};

type BoomerangToolResult = {
  content?: readonly unknown[];
  isError?: boolean;
};

type BoomerangRenderOptions = {
  expanded?: boolean;
  isPartial?: boolean;
};

type BoomerangRenderContext = {
  isError?: boolean;
};

type ParsedRethrow = {
  task: string;
  rethrowCount: number;
};

const EXACT_OUTCOMES = {
  disabled: "Boomerang tool is disabled. User must run `/boomerang tool on` to enable.",
  active: "A boomerang is already active. Wait for it to complete.",
  noContext: "No command context. Run any /boomerang command first to initialize.",
  queuedAlready: "A boomerang task is already queued. Wait for it to start before queueing another task.",
  noAnchorTarget: "Cannot set anchor: no session entries yet.",
  anchorSet: "Boomerang anchor set. Do your work, then call boomerang again to summarize the context.",
  completePending: "Boomerang complete. Context will be summarized when this turn ends.",
} as const;

function parseRecognizedRethrow(task: string): ParsedRethrow | null {
  const match = task.match(/^(?<task>.*?)(?:\s+--rethrow\s+(?<count>[1-9]\d{0,2}))(?=$|\s)/);
  if (!match?.groups) return null;

  const count = Number.parseInt(match.groups.count, 10);
  if (!Number.isInteger(count) || count < 1 || count > 999) return null;

  const taskWithoutFlag = `${match.groups.task}${task.slice(match[0].length)}`.replace(/\s+/g, " ").trim();
  if (!taskWithoutFlag) return null;

  return { task: taskWithoutFlag, rethrowCount: count };
}

function preview(value: string, max = 80): string {
  const normalized = value.replace(/\r\n?|\n/g, " ").replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1)}…`;
}

function taskQueuedOutcome(raw: string): { task: string } | null {
  const match = raw.match(/^Task queued: "(?<task>.*)"\. Will start autonomously when this turn ends\.$/s);
  if (!match?.groups) return null;
  return { task: match.groups.task };
}

function collapsedLines(raw: string, isError: boolean, isPartial: boolean, theme: BoomerangTheme): string[] {
  if (isPartial) {
    return [theme.fg("warning", "status: running · boomerang task active")];
  }

  if (isError) {
    const message = firstMeaningfulLine(raw) || "Boomerang failed.";
    return [theme.fg("error", `error: ${message}`)];
  }

  if (raw === EXACT_OUTCOMES.disabled) {
    return [theme.fg("warning", "status: disabled · run /boomerang tool on")];
  }
  if (raw === EXACT_OUTCOMES.active) {
    return [theme.fg("warning", "status: blocked · boomerang already active")];
  }
  if (raw === EXACT_OUTCOMES.noContext) {
    return [theme.fg("warning", "status: blocked · run any /boomerang command first")];
  }
  if (raw === EXACT_OUTCOMES.queuedAlready) {
    return [theme.fg("warning", "status: blocked · task already queued")];
  }
  if (raw === EXACT_OUTCOMES.noAnchorTarget) {
    return [theme.fg("error", "status: failed · no session entries for anchor")];
  }
  if (raw === EXACT_OUTCOMES.anchorSet) {
    return [theme.fg("success", "status: anchor set · call again after work to summarize")];
  }
  if (raw === EXACT_OUTCOMES.completePending) {
    return [theme.fg("success", "status: pending summary · will summarize after this turn")];
  }

  const queued = taskQueuedOutcome(raw);
  if (queued) {
    return [
      theme.fg("success", "status: queued · starts after current turn"),
      theme.fg("text", `task: ${preview(queued.task)}`),
    ];
  }

  const line = firstMeaningfulLine(raw);
  if (!line) return [theme.fg("muted", "result: no output")];
  return [theme.fg("text", `result: ${line}`)];
}

export function renderBoomerangCall(args: BoomerangToolArgs, theme: BoomerangTheme) {
  const rawTask = typeof args.task === "string" ? args.task.trim() : "";
  if (!rawTask) return renderToolCall("boomerang", "anchor mode", theme);

  const rethrow = parseRecognizedRethrow(rawTask);
  const taskText = rethrow ? rethrow.task : rawTask;
  const suffix = rethrow ? ` · --rethrow ${rethrow.rethrowCount}` : "";
  return renderToolCall("boomerang", `task: ${preview(taskText)}${suffix}`, theme);
}

export function renderBoomerangResult(
  result: BoomerangToolResult,
  options: BoomerangRenderOptions,
  theme: BoomerangTheme,
  context?: BoomerangRenderContext,
) {
  const raw = extractToolText(result);
  if (options.expanded) {
    return renderToolExpanded(raw || "No boomerang output.");
  }

  const isError = result.isError === true || context?.isError === true;
  const lines = collapsedLines(raw, isError, options.isPartial === true, theme);
  const expandable = raw.length > 0 && (lines.length !== 1 || firstMeaningfulLine(raw) !== firstMeaningfulLine(lines[0]));
  return renderToolSummary(lines, theme, {
    expandable,
    expandLabel: isError ? "diagnostics" : "full result",
  });
}
