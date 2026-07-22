import { getMarkdownTheme, keyHint, type Theme } from "@earendil-works/pi-coding-agent";
import {
  Markdown,
  type MarkdownTheme,
  Text,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { sep } from "node:path";

type ToolTheme = Pick<Theme, "bold" | "fg">;

type ToolTextResult = {
  content?: readonly unknown[];
};

type ToolSummaryOptions = {
  expandable?: boolean;
  expandLabel?: string;
};

type ToolExpandedOptions =
  | { format?: "text" }
  | { format: "markdown"; markdownTheme?: MarkdownTheme };

function normalizeWidth(width: number): number {
  return Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
}

function fitRenderedLines(lines: readonly string[], width: number): string[] {
  if (width === 0) return [];

  const fitted: string[] = [];
  for (const line of lines) {
    const wrapped = visibleWidth(line) <= width ? [line] : wrapTextWithAnsi(line, width);
    for (const part of wrapped) {
      fitted.push(visibleWidth(part) <= width ? part : truncateToWidth(part, width, ""));
    }
  }
  return fitted;
}

class WidthSafeText extends Text {
  override render(width = 120): string[] {
    const safeWidth = normalizeWidth(width);
    if (safeWidth === 0) return [];
    return fitRenderedLines(super.render(safeWidth), safeWidth);
  }
}

class WidthSafeSummary extends Text {
  constructor(private readonly summaryText: string) {
    super(summaryText, 0, 0);
  }

  override render(width = 120): string[] {
    const safeWidth = normalizeWidth(width);
    if (safeWidth === 0) return [];
    return this.summaryText
      .split("\n")
      .map((line) => truncateToWidth(line, safeWidth, "…"));
  }
}

class WidthSafeMarkdown extends Markdown {
  override render(width = 120): string[] {
    const safeWidth = normalizeWidth(width);
    if (safeWidth === 0) return [];
    return fitRenderedLines(super.render(safeWidth), safeWidth);
  }
}

export function extractToolText(result: ToolTextResult | null | undefined): string {
  if (!Array.isArray(result?.content)) return "";

  return result.content
    .filter(
      (part): part is { type: "text"; text: string } =>
        typeof part === "object" &&
        part !== null &&
        "type" in part &&
        part.type === "text" &&
        "text" in part &&
        typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("\n");
}

export function firstMeaningfulLine(text: string): string {
  for (const line of text.split(/\r\n?|\n/)) {
    const trimmed = line.trim();
    if (visibleWidth(trimmed) > 0) return trimmed;
  }
  return "";
}

export function shortenHomePath(path: string, home: string = homedir()): string {
  if (!home) return path;

  const normalizedHome = home === sep ? home : home.replace(/[\\/]+$/, "");
  if (path === normalizedHome) return "~";
  if (normalizedHome === sep && path.startsWith(sep)) return `~${path}`;
  if (path.startsWith(`${normalizedHome}${sep}`)) return `~${path.slice(normalizedHome.length)}`;
  return path;
}

export function renderToolCall(name: string, target: string | undefined, theme: ToolTheme): Text {
  const title = theme.fg("toolTitle", theme.bold(name));
  const suffix = target ? ` ${theme.fg("dim", "·")} ${theme.fg("accent", target)}` : "";
  return new WidthSafeText(`▸ ${title}${suffix}`, 0, 0);
}

export function renderToolSummary(
  lines: readonly string[],
  theme: ToolTheme,
  options: ToolSummaryOptions = {},
): Text {
  const details = [...lines];
  if (options.expandable) {
    details.push(keyHint("app.tools.expand", options.expandLabel ?? "to expand full result"));
  }

  const text = details
    .map((line, index) => `${index === details.length - 1 ? "└─" : "├─"} ${line.replace(/\r\n?|\n/g, " ")}`)
    .map((line) => theme.fg("muted", line))
    .join("\n");
  return new WidthSafeSummary(text);
}

export function renderToolExpanded(text: string, options: ToolExpandedOptions = {}): Text | Markdown {
  if (options.format === "markdown") {
    return new WidthSafeMarkdown(text, 0, 0, options.markdownTheme ?? getMarkdownTheme());
  }
  return new WidthSafeText(text, 0, 0);
}
