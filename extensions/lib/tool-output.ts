import { getMarkdownTheme, keyHint, type Theme } from "@earendil-works/pi-coding-agent";
import {
  Box,
  type Component,
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
export type CustomMessageTheme = Pick<Theme, "bg" | "bold" | "fg">;

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
      fitted.push(keepRowBackground(visibleWidth(part) <= width ? part : truncateToWidth(part, width, "")));
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
      .map((line) => keepRowBackground(truncateToWidth(line, safeWidth, "…")));
  }
}

class WidthSafeMarkdown extends Markdown {
  override render(width = 120): string[] {
    const safeWidth = normalizeWidth(width);
    if (safeWidth === 0) return [];
    return fitRenderedLines(super.render(safeWidth), safeWidth);
  }
}

/** The escape sequence a theme wrapper emits before its text, sampled with a sentinel. */
function openingSequence(sample: string): string {
  return sample.split("\u0000")[0] ?? "";
}

function reopenAfterResets(line: string, resets: RegExp, opening: string): string {
  return opening ? line.replace(resets, reset => `${reset}${opening}`) : line;
}

// Pi's tool-row Box opens its background once per line, so a full reset (e.g. truncateToWidth's
// `\x1b[0m` at a cut) clears it to the edge. Reset every attribute except background; 39 stays
// separate so custom-message cards still re-open their text color after it.
// ponytail: only bare `0m`/`m` resets are rewritten, and content that sets its own background keeps
// it to the row end; delete once pi-tui's Box re-opens its background after child resets.
const RESET_KEEP_BG = "\u001b[22;23;24;25;27;28;29m\u001b[39m";

function keepRowBackground(line: string): string {
  return line.replace(/\u001b\[0?m/g, RESET_KEEP_BG);
}

class ThemedCustomMessageContent implements Component {
  private readonly fgOn: string;

  constructor(
    private readonly content: Component,
    private readonly theme: CustomMessageTheme,
  ) {
    this.fgOn = openingSequence(theme.fg("customMessageText", "\u0000"));
  }

  render(width: number): string[] {
    return this.content.render(width).map(line =>
      this.theme.fg("customMessageText", reopenAfterResets(line, /\u001b\[(?:0?|39)m/g, this.fgOn)));
  }

  invalidate(): void {
    this.content.invalidate();
  }
}

class CustomMessageCard implements Component {
  private readonly box: Box;

  constructor(label: string, content: Component, theme: CustomMessageTheme) {
    // Child resets (e.g. truncateToWidth's `\x1b[0m` before an ellipsis) would clear the
    // card background for the rest of the line, so re-open it after each one.
    const bgOn = openingSequence(theme.bg("customMessageBg", "\u0000"));
    this.box = new Box(1, 1, line =>
      theme.bg("customMessageBg", reopenAfterResets(line, /\u001b\[(?:0?|49)m/g, bgOn)));
    this.box.addChild(new Text(`${theme.fg("customMessageLabel", theme.bold(`[${label}]`))}\n`, 0, 0));
    this.box.addChild(new ThemedCustomMessageContent(content, theme));
  }

  render(width: number): string[] {
    const safeWidth = normalizeWidth(width);
    if (safeWidth === 0) return [];
    return this.box.render(safeWidth).map(line => truncateToWidth(line, safeWidth, ""));
  }

  invalidate(): void {
    this.box.invalidate();
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

/** Render passive custom-message content with Pi's themed message shell. */
export function createCustomMessageCard(label: string, content: Component, theme: CustomMessageTheme): Component {
  return new CustomMessageCard(label, content, theme);
}

export function renderToolExpanded(text: string, options: ToolExpandedOptions = {}): Text | Markdown {
  if (options.format === "markdown") {
    return new WidthSafeMarkdown(text, 0, 0, options.markdownTheme ?? getMarkdownTheme());
  }
  return new WidthSafeText(text, 0, 0);
}
