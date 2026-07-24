import { truncateToWidth } from "@earendil-works/pi-tui";
import { formatCompactions, formatDuration, formatTokens, formatTools, formatTurns, SEPARATOR, SPINNER } from "../../../lib/widget-style.js";
import type { CompletionDisposition } from "../types.js";

export type SubagentSummaryStatus =
  | "queued"
  | "running"
  | "completed"
  | "steered"
  | "aborted"
  | "stopped"
  | "error"
  | "background";

export interface SubagentSummaryAgent {
  displayName: string;
  description?: string;
  status: SubagentSummaryStatus;
  activity?: string;
  resultPreview?: string;
  toolUses?: number;
  tokens?: string | number;
  totalTokens?: number;
  /** Pre-formatted cost segment (e.g. "$0.340" or "$0.340 (sub)"). */
  cost?: string;
  durationMs?: number;
  spinnerFrame?: number;
  modelName?: string;
  tags?: string[];
  turnCount?: number;
  maxTurns?: number | null;
  compactionCount?: number;
  error?: string;
  completionDisposition?: CompletionDisposition;
}

export interface SubagentSummaryGroup {
  title?: string;
  status?: SubagentSummaryStatus;
  agents: SubagentSummaryAgent[];
}

export type SubagentSummaryInput = SubagentSummaryAgent | SubagentSummaryGroup;

export interface SummaryRenderOptions {
  width?: number;
}

export const SUMMARY_SPINNER = SPINNER;

export const SUMMARY_ERROR_STATUSES = new Set<SubagentSummaryStatus>([
  "error",
  "aborted",
  "steered",
  "stopped",
]);

export function formatSummaryTokens(count: number): string {
  return formatTokens(count);
}

export function formatSummaryTurns(turnCount: number, maxTurns?: number | null): string {
  return formatTurns(turnCount, maxTurns);
}

export function formatSummaryMs(ms: number): string {
  return formatDuration(ms);
}

export function formatSummaryStats(parts: string[]): string {
  return parts.filter(Boolean).join(SEPARATOR);
}

export function renderSubagentSummary(input: SubagentSummaryInput, options: SummaryRenderOptions = {}): string[] {
  if ("agents" in input) return renderSubagentSummaryGroup(input, options);
  return applyWidth(buildAgentLines(input), options.width);
}

export function renderSubagentSummaryGroup(group: SubagentSummaryGroup, options: SummaryRenderOptions = {}): string[] {
  const status = group.status ?? inferGroupStatus(group.agents);
  const title = group.title ?? `${group.agents.length} agent${group.agents.length === 1 ? "" : "s"}`;
  const lines = [`${statusIcon(status)} ${title}`];

  group.agents.forEach((agent, index) => {
    const isLast = index === group.agents.length - 1;
    const connector = isLast ? "└─" : "├─";
    const continuation = isLast ? "   " : "│  ";
    const childLines = buildAgentLines(agent);

    lines.push(`${connector} ${childLines[0] ?? ""}`);
    for (const line of childLines.slice(1)) {
      lines.push(`${continuation}${line}`);
    }
  });

  return applyWidth(lines, options.width);
}

export function statusIcon(status: SubagentSummaryStatus, spinnerFrame = 0): string {
  switch (status) {
    case "running":
      return SUMMARY_SPINNER[spinnerFrame % SUMMARY_SPINNER.length] ?? SUMMARY_SPINNER[0];
    case "queued":
      return "◦";
    case "completed":
      return "✓";
    case "steered":
      return "✓";
    case "stopped":
      return "■";
    case "background":
      return "○";
    case "aborted":
    case "error":
      return "✗";
  }
}

function isRecoveredCompletion(agent: SubagentSummaryAgent): boolean {
  return agent.completionDisposition === "recovered" && agent.status === "completed";
}

function hasRecoveredSuffix(agent: SubagentSummaryAgent): boolean {
  return agent.completionDisposition === "recovered"
    && agent.status !== "completed"
    && agent.status !== "error"
    && agent.status !== "aborted";
}

function summaryStatusLead(agent: SubagentSummaryAgent, subject: string): string {
  if (isRecoveredCompletion(agent)) return `⚠ recovered · ${subject}`;
  return `${statusIcon(agent.status, agent.spinnerFrame)} ${subject}`;
}

function buildAgentLines(agent: SubagentSummaryAgent): string[] {
  const stats = getAgentStats(agent);
  const subject = [agent.displayName, agent.description].filter(Boolean).join(" ");
  const statusSuffix = getStatusSuffix(agent);
  const head = [
    summaryStatusLead(agent, subject),
    stats,
    statusSuffix,
  ].filter(Boolean).join(" · ");
  const preview = getPreviewText(agent);

  return preview ? [head, `└─ ${preview}`] : [head];
}

function getAgentStats(agent: SubagentSummaryAgent): string {
  const parts: string[] = [];
  if (agent.modelName) parts.push(agent.modelName);
  if (agent.tags) parts.push(...agent.tags);
  if (agent.turnCount != null) parts.push(formatSummaryTurns(agent.turnCount, agent.maxTurns));
  if (agent.compactionCount && agent.compactionCount > 0) parts.push(formatCompactions(agent.compactionCount));
  if (agent.toolUses && agent.toolUses > 0) parts.push(formatTools(agent.toolUses));
  const tokenText = getTokenText(agent);
  if (tokenText) parts.push(tokenText);
  if (agent.cost) parts.push(agent.cost);
  if (agent.durationMs != null) parts.push(formatSummaryMs(agent.durationMs));
  return formatSummaryStats(parts);
}

function getTokenText(agent: SubagentSummaryAgent): string | undefined {
  if (typeof agent.tokens === "number") return formatSummaryTokens(agent.tokens);
  if (agent.tokens?.trim()) return agent.tokens.trim();
  if (agent.totalTokens != null) return formatSummaryTokens(agent.totalTokens);
  return undefined;
}

function getStatusSuffix(agent: SubagentSummaryAgent): string | undefined {
  if (agent.status === "aborted") return "aborted";
  if (agent.status === "error") return `error${agent.error ? `: ${firstContentLine(agent.error)}` : ""}`;

  const lifecycleSuffix = agent.status === "steered"
    ? "turn limit"
    : agent.status === "stopped"
      ? "stopped"
      : undefined;

  if (!hasRecoveredSuffix(agent)) return lifecycleSuffix;
  return lifecycleSuffix ? `${lifecycleSuffix} · recovered` : "recovered";
}

function getPreviewText(agent: SubagentSummaryAgent): string | undefined {
  if (agent.status === "running" || agent.status === "queued" || agent.status === "background") {
    return firstContentLine(agent.activity) ?? "thinking…";
  }
  return firstContentLine(agent.resultPreview) ?? firstContentLine(agent.activity);
}

function firstContentLine(text?: string): string | undefined {
  return text?.split("\n").find(line => line.trim())?.trim();
}

function inferGroupStatus(agents: SubagentSummaryAgent[]): SubagentSummaryStatus {
  if (agents.some(agent => agent.status === "running" || agent.status === "queued")) return "running";
  if (agents.some(agent => agent.status === "error" || agent.status === "aborted")) return "error";
  if (agents.some(agent => agent.status === "steered")) return "steered";
  if (agents.some(agent => agent.status === "stopped")) return "stopped";
  return "completed";
}

function applyWidth(lines: string[], width?: number): string[] {
  if (width == null) return lines;
  if (!Number.isFinite(width) || width <= 0) return lines.map(() => "");
  const safeWidth = Math.floor(width);
  return lines.map(line => stripAnsi(truncateToWidth(line, safeWidth)));
}

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}
