import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { createCustomMessageCard, extractToolText, firstMeaningfulLine, renderToolExpanded, renderToolSummary } from "../../lib/tool-output.js";
import { isWorkflowEntryData } from "./graph/entry-validation.js";
import type { NotificationDetails } from "./types.js";
import { renderGraphRunEntryCard } from "./ui/graph-run-report.js";
import {
  renderSubagentSummary,
  type SubagentSummaryStatus,
} from "./ui/summary-renderer.js";

function toSummaryStatus(status: string): SubagentSummaryStatus {
  switch (status) {
    case "queued":
    case "running":
    case "completed":
    case "steered":
    case "aborted":
    case "stopped":
    case "error":
    case "background":
      return status;
    default:
      return "completed";
  }
}

function compactResultPreview(text: string, maxLength = 80): string | undefined {
  return truncateToWidth(text.replace(/\s+/g, " ").trim(), maxLength, "…") || undefined;
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

function renderNotificationSummary(detail: NotificationDetails, expanded: boolean): string[] {
  const lines = renderSubagentSummary({
    displayName: detail.description,
    status: toSummaryStatus(detail.status),
    resultPreview: expanded ? undefined : compactResultPreview(detail.resultPreview),
    toolUses: detail.toolUses,
    totalTokens: detail.totalTokens,
    durationMs: detail.durationMs,
    turnCount: detail.turnCount,
    maxTurns: detail.maxTurns,
    error: detail.error,
  }).map(stripNotificationTreeConnector);

  if (expanded) lines.push(...detail.resultPreview.split("\n").map(line => `  ${line}`));

  if (detail.outputFile) lines.push(`  transcript: ${detail.outputFile}`);
  return lines;
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
    return this.details
      .flatMap((detail) => renderNotificationSummary(detail, this.expanded))
      .flatMap((line) => fitLine(line, width));
  }

  invalidate(): void {}
}

export function registerSubagentNotificationRenderer(pi: ExtensionAPI): void {
  pi.registerMessageRenderer<NotificationDetails>(
    "subagent-notification",
    (message, { expanded }, theme) => {
      const detail = message.details;
      if (!isNotificationDetails(detail)) return undefined;
      if (detail.workflow !== undefined) {
        if (isWorkflowEntryData(detail.workflow)) {
          return createCustomMessageCard("notification", renderGraphRunEntryCard(detail.workflow, theme, expanded)!, theme);
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
