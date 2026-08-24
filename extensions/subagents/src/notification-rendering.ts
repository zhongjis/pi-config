import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { SUBAGENT_RESULT_PREVIEW_LINES } from "./constants.js";
import type { NotificationDetails } from "./types.js";
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
  const firstLine = text.split("\n")[0]?.slice(0, maxLength) ?? "";
  return firstLine || undefined;
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
  });

  if (expanded) {
    for (const line of detail.resultPreview.split("\n").slice(0, SUBAGENT_RESULT_PREVIEW_LINES)) {
      lines.push(`  ${line}`);
    }
  }

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
    (message, { expanded }) => {
      const detail = message.details;
      if (!isNotificationDetails(detail)) return undefined;
      return new NotificationSummaryComponent([detail, ...(detail.others ?? [])], expanded);
    },
  );
}
