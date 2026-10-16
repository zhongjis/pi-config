import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { createCustomMessageCard, extractToolText, firstMeaningfulLine, renderToolExpanded, renderToolSummary } from "../../lib/tool-output.js";
import { formatTools } from "../../lib/widget-style.js";
import { isGraphRunEntryData } from "./graph/entry-validation.js";
import type { NotificationDetails } from "./types.js";
import { renderGraphRunEntryCard } from "./ui/graph-run-report.js";
import {
  formatSummaryMs,
  formatSummaryTokens,
  formatSummaryTurns,
  getStatusSuffix,
  statusIcon,
  type SubagentSummaryStatus,
} from "./ui/summary-renderer.js";

const NAME_MAX_WIDTH = 32;
const COLUMN_GAP = "  ";
const INDENT = "  ";

function toSummaryStatus(status: string): SubagentSummaryStatus {
  switch (status) {
    case "queued":
    case "running":
    case "completed":
    case "force_steered":
    case "aborted":
    case "stopped":
    case "error":
    case "background":
      return status;
    default:
      return "completed";
  }
}

/** Flatten a multiline result into one row; markdown headings become `Heading:` and bullet markers drop. */
function flattenPreview(text: string): string {
  return text
    .split(/\r\n?|\n/)
    .map(line => line.trim())
    // The coordinator's omission marker points at expanded output; the expand hint covers it here.
    .filter(line => line && !/^… \d+ characters? omitted · full output: /.test(line))
    .map(line => {
      const heading = /^#{1,6}\s+(.+)$/.exec(line)?.[1];
      if (heading !== undefined) return heading.endsWith(":") ? heading : `${heading}:`;
      return line.replace(/^[-*+]\s+/, "");
    })
    .join(" ")
    .replace(/\s+/g, " ");
}

function padToWidth(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

function stripNotificationTreeConnector(line: string): string {
  return line.replace(/^((?:\u001B\[[0-?]*[ -/]*[@-~])*)[├└]─ /, "$1");
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNotificationDetails(value: unknown): value is NotificationDetails {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const detail = value as Record<string, unknown>;
  if (
    typeof detail.id !== "string" ||
    typeof detail.description !== "string" ||
    typeof detail.status !== "string" ||
    !isFiniteNumber(detail.toolUses) ||
    !isFiniteNumber(detail.turnCount) ||
    !isFiniteNumber(detail.totalTokens) ||
    !isFiniteNumber(detail.durationMs) ||
    typeof detail.resultPreview !== "string"
  ) {
    return false;
  }
  if (detail.maxTurns !== undefined && !isFiniteNumber(detail.maxTurns)) return false;
  if (detail.outputFile !== undefined && typeof detail.outputFile !== "string") return false;
  if (detail.error !== undefined && typeof detail.error !== "string") return false;
  if (detail.others !== undefined) {
    if (!Array.isArray(detail.others) || !detail.others.every(isNotificationDetails)) return false;
  }
  return true;
}

/** Stat cells in fixed column order; empty when the stat is zero so columns stay aligned across agents. */
function statCells(detail: NotificationDetails): string[] {
  const positive = (value: number) => Number.isFinite(value) && value > 0;
  return [
    positive(detail.turnCount) ? formatSummaryTurns(detail.turnCount) : "",
    positive(detail.toolUses) ? formatTools(detail.toolUses) : "",
    positive(detail.totalTokens) ? formatSummaryTokens(detail.totalTokens) : "",
    positive(detail.durationMs) ? formatSummaryMs(detail.durationMs) : "",
  ];
}

function headRows(details: NotificationDetails[]): string[] {
  const names = details.map(detail => {
    const name = detail.description.replace(/\s+/g, " ").trim();
    return visibleWidth(name) > NAME_MAX_WIDTH ? truncateToWidth(name, NAME_MAX_WIDTH, "…") : name;
  });
  const cells = details.map(statCells);
  const nameWidth = Math.max(...names.map(name => visibleWidth(name)));
  const columnWidths = cells[0].map((_, column) => Math.max(...cells.map(row => visibleWidth(row[column]))));
  return details.map((detail, index) => {
    const status = toSummaryStatus(detail.status);
    const columns = cells[index].flatMap((cell, column) => (columnWidths[column] > 0 ? [padToWidth(cell, columnWidths[column])] : []));
    const suffix = getStatusSuffix({ status, error: detail.error });
    return [`${statusIcon(status)} ${padToWidth(names[index], nameWidth)}`, ...columns, suffix ?? ""].join(COLUMN_GAP).trimEnd();
  });
}

/** Wrap `text` under a two-space indent so continuation rows stay aligned with the first. */
function indented(text: string, width: number): string[] {
  const inner = width - INDENT.length;
  if (inner <= 0) return fitLine(`${INDENT}${text}`, width);
  const wrapped = wrapTextWithAnsi(text, inner);
  return (wrapped.length > 0 ? wrapped : [text]).map(line => `${INDENT}${truncateToWidth(line, inner, "")}`);
}

function renderCollapsed(details: NotificationDetails[], width: number): string[] {
  const heads = headRows(details);
  return details.flatMap((detail, index) => {
    const head = truncateToWidth(heads[index], width, "…");
    const preview = flattenPreview(detail.resultPreview);
    if (!preview) return [head];
    const inner = Math.max(1, width - INDENT.length);
    return [head, truncateToWidth(`${INDENT}${truncateToWidth(preview, inner, "…")}`, width, "")];
  });
}

function renderExpanded(details: NotificationDetails[], width: number): string[] {
  const heads = headRows(details);
  return details.flatMap((detail, index) => [
    ...(index > 0 ? [""] : []),
    ...fitLine(heads[index], width),
    ...(detail.resultPreview.trim() ? detail.resultPreview.split("\n").flatMap(line => indented(line, width)) : []),
    ...(detail.outputFile ? indented(`transcript: ${detail.outputFile}`, width) : []),
  ]);
}

function fitLine(line: string, width: number): string[] {
  if (!Number.isFinite(width) || width <= 0) return [""];
  const safeWidth = Math.floor(width);
  const wrapped = wrapTextWithAnsi(line, safeWidth);
  const lines = wrapped.length > 0 ? wrapped : [line];
  return lines.map((wrappedLine) => truncateToWidth(wrappedLine, safeWidth, ""));
}

class FlatNotificationContent implements Component {
  constructor(private readonly content: Component) {}

  render(width: number): string[] {
    return this.content.render(width).map(stripNotificationTreeConnector);
  }

  invalidate(): void {
    this.content.invalidate();
  }
}

class NotificationSummaryComponent implements Component {
  constructor(
    private readonly details: NotificationDetails[],
    private readonly expanded: boolean,
  ) {}

  render(width: number): string[] {
    if (!Number.isFinite(width) || width <= 0) return [];
    const safeWidth = Math.floor(width);
    const title = this.details.length > 1 ? fitLine(`${this.details.length} agents finished`, safeWidth) : [];
    return [...title, ...(this.expanded ? renderExpanded : renderCollapsed)(this.details, safeWidth)];
  }

  invalidate(): void {}
}

export function registerSubagentNotificationRenderer(pi: ExtensionAPI): void {
  pi.registerMessageRenderer<NotificationDetails>(
    "subagent-notification",
    (message, { expanded }, theme) => {
      const detail = message.details;
      if (!isNotificationDetails(detail)) return undefined;
      if (detail.graphRun !== undefined) {
        if (isGraphRunEntryData(detail.graphRun)) {
          return createCustomMessageCard("notification", renderGraphRunEntryCard(detail.graphRun, theme, expanded)!, theme);
        }
        const raw = typeof message.content === "string" ? message.content : extractToolText({ content: message.content });
        const fallback = expanded
          ? renderToolExpanded(raw)
          : new FlatNotificationContent(renderToolSummary([firstMeaningfulLine(raw) || "No output"], theme, { expandable: true }));
        return createCustomMessageCard("notification", fallback, theme);
      }
      return createCustomMessageCard("notification", new NotificationSummaryComponent([detail, ...(detail.others ?? [])], expanded), theme);
    },
  );
}
