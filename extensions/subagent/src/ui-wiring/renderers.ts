/**
 * Renderer wiring for the subagent extension.
 *
 * Owns the custom `subagent-notification` message renderer plus the shared
 * summary-rendering helpers (`renderNotificationSummary`, `renderAgentSummary`).
 */

import { Text } from "@earendil-works/pi-tui";
import { SUBAGENT_RESULT_PREVIEW_LINES } from "../constants.js";
import type { SubagentRuntimeContext } from "../lifecycle/supervision.js";
import type { AgentDetails } from "../ui/agent-widget.js";
import { renderSubagentSummary } from "../ui/summary-renderer.js";
import type { SubagentSummaryAgent, SubagentSummaryStatus } from "../ui/summary-renderer.js";
import type { NotificationDetails } from "../types.js";

const SUMMARY_STATUS_VALUES = new Set<SubagentSummaryStatus>([
  "queued",
  "running",
  "completed",
  "steered",
  "aborted",
  "stopped",
  "error",
  "background",
]);

function toSummaryStatus(status: string): SubagentSummaryStatus {
  return SUMMARY_STATUS_VALUES.has(status as SubagentSummaryStatus)
    ? (status as SubagentSummaryStatus)
    : "completed";
}

function compactResultPreview(text: string, maxLength = 80): string | undefined {
  const firstLine = text.split("\n")[0]?.slice(0, maxLength) ?? "";
  return firstLine || undefined;
}

function renderNotificationSummary(detail: NotificationDetails, expanded: boolean): string {
  const lines = renderSubagentSummary({
    displayName: detail.description,
    status: toSummaryStatus(detail.status),
    resultPreview: expanded ? undefined : compactResultPreview(detail.resultPreview),
    toolUses: detail.toolUses,
    totalTokens: detail.totalTokens > 0 ? detail.totalTokens : undefined,
    durationMs: detail.durationMs > 0 ? detail.durationMs : undefined,
    turnCount: detail.turnCount > 0 ? detail.turnCount : undefined,
    maxTurns: detail.maxTurns,
    error: detail.error,
  });

  if (expanded) {
    for (const line of detail.resultPreview.split("\n").slice(0, SUBAGENT_RESULT_PREVIEW_LINES)) {
      lines.push(`  ${line}`);
    }
  }

  if (detail.outputFile) lines.push(`  transcript: ${detail.outputFile}`);
  if (detail.sessionFile) lines.push(`  session: ${detail.sessionFile}`);

  return lines.join("\n");
}

export function renderAgentSummary(details: AgentDetails, overrides: Partial<SubagentSummaryAgent> = {}): string[] {
  return renderSubagentSummary({
    displayName: details.displayName,
    description: details.description,
    status: toSummaryStatus(details.status),
    activity: details.activity,
    resultPreview: details.activity,
    toolUses: details.toolUses,
    tokens: details.tokens || undefined,
    cost: details.cost,
    durationMs: details.durationMs,
    spinnerFrame: details.spinnerFrame,
    modelName: details.modelName,
    tags: details.tags,
    turnCount: details.turnCount,
    maxTurns: details.maxTurns,
    error: details.error,
    ...overrides,
  });
}

/** Register the custom notification renderer. */
export function registerSubagentRenderers(ctx: SubagentRuntimeContext): void {
  const { pi } = ctx;

  pi.registerMessageRenderer<NotificationDetails>(
    "subagent-notification",
    (message, { expanded }, _theme) => {
      const d = message.details;
      if (!d) return undefined;

      const all = [d, ...(d.others ?? [])];
      return new Text(all.map(detail => renderNotificationSummary(detail, expanded)).join("\n"), 0, 0);
    }
  );
}
