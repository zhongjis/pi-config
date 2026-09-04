import { truncateToWidth } from "@earendil-works/pi-tui";
import {
  formatCompactions,
  formatDuration,
  formatTokens,
  formatTools,
  formatTurns,
  GLYPH,
  joinStats,
  SPINNER,
  spinnerGlyph,
  TREE,
} from "../../../lib/widget-style.js";
import type { AgentDetails } from "./agent-widget.js";

export type SubagentSummaryStatus = AgentDetails["status"];

export interface SubagentSummaryAgent {
  displayName: string;
  description?: string;
  status: SubagentSummaryStatus;
  activity?: string;
  resultPreview?: string;
  toolUses?: number;
  tokens?: string | number;
  totalTokens?: number;
  durationMs?: number;
  spinnerFrame?: number;
  modelName?: string;
  tags?: string[];
  turnCount?: number;
  maxTurns?: number | null;
  compactionCount?: number;
  error?: string;
  /** Pre-formatted cost string (e.g. "~$0.0042"). When set, appended after token count. */
  costText?: string;
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
  return joinStats(parts);
}

export function renderSubagentSummary(input: SubagentSummaryInput, options: SummaryRenderOptions = {}): string[] {
  if ("agents" in input) return renderSubagentSummaryGroup(input, options);
  return applyWidth(buildAgentLines(input), options.width);
}

export function renderSubagentSummaryGroup(
  group: SubagentSummaryGroup,
  options: SummaryRenderOptions = {},
): string[] {
  const status = group.status ?? inferGroupStatus(group.agents);
  const title = group.title ?? `${group.agents.length} agent${group.agents.length === 1 ? "" : "s"}`;
  const lines = [`${statusIcon(status)} ${title}`];

  group.agents.forEach((agent, index) => {
    const isLast = index === group.agents.length - 1;
    const connector = isLast ? TREE.last : TREE.mid;
    const continuation = isLast ? TREE.blank : TREE.pipe;
    const childLines = buildAgentLines(agent);

    lines.push(`${connector} ${childLines[0] ?? ""}`);
    for (const line of childLines.slice(1)) lines.push(`${continuation}${line}`);
  });

  return applyWidth(lines, options.width);
}

export function statusIcon(status: SubagentSummaryStatus, spinnerFrame = 0): string {
  switch (status) {
    case "running":
      return spinnerGlyph(spinnerFrame);
    case "queued":
      return GLYPH.queued;
    case "completed":
    case "steered":
      return GLYPH.done;
    case "stopped":
      return GLYPH.stopped;
    case "background":
      return GLYPH.pending;
    case "aborted":
    case "error":
      return GLYPH.error;
  }
}

function buildAgentLines(agent: SubagentSummaryAgent): string[] {
  const stats = getAgentStats(agent);
  const subject = [agent.displayName, agent.description].filter(Boolean).join(" ");
  const head = [`${statusIcon(agent.status, agent.spinnerFrame)} ${subject}`, stats, getStatusSuffix(agent)]
    .filter(Boolean)
    .join(" · ");
  const preview = getPreviewText(agent);

  return preview ? [head, `${TREE.last} ${preview}`] : [head];
}

function getAgentStats(agent: SubagentSummaryAgent): string {
  const parts: string[] = [];
  if (agent.modelName) parts.push(agent.modelName);
  if (agent.tags) parts.push(...agent.tags.filter(Boolean));
  if (isPositive(agent.turnCount)) parts.push(formatSummaryTurns(agent.turnCount, agent.maxTurns));
  if (isPositive(agent.compactionCount)) parts.push(formatCompactions(agent.compactionCount));
  if (isPositive(agent.toolUses)) parts.push(formatTools(agent.toolUses));
  const tokenText = getTokenText(agent);
  if (tokenText) parts.push(tokenText);
  if (agent.costText) parts.push(agent.costText);
  if (isPositive(agent.durationMs)) parts.push(formatSummaryMs(agent.durationMs));
  return formatSummaryStats(parts);
}

function getTokenText(agent: SubagentSummaryAgent): string | undefined {
  if (typeof agent.tokens === "number") {
    return isPositive(agent.tokens) ? formatSummaryTokens(agent.tokens) : undefined;
  }
  if (agent.tokens?.trim()) {
    const tokens = agent.tokens.trim();
    return /^0(?:\.0+)?(?:\s+tokens?)?$/i.test(tokens) ? undefined : tokens;
  }
  return isPositive(agent.totalTokens) ? formatSummaryTokens(agent.totalTokens) : undefined;
}

function getStatusSuffix(agent: SubagentSummaryAgent): string | undefined {
  if (agent.status === "steered") return "turn limit";
  if (agent.status === "stopped") return "stopped";
  if (agent.status === "aborted") return "aborted";
  if (agent.status === "error") {
    return `error${agent.error ? `: ${firstContentLine(agent.error)}` : ""}`;
  }
  return undefined;
}

function getPreviewText(agent: SubagentSummaryAgent): string | undefined {
  if (agent.status === "running" || agent.status === "queued" || agent.status === "background") {
    return firstContentLine(agent.activity) ?? "thinking…";
  }
  return firstContentLine(agent.resultPreview) ?? firstContentLine(agent.activity);
}

function firstContentLine(text?: string): string | undefined {
  return text?.split("\n").find((line) => line.trim())?.trim();
}

function inferGroupStatus(agents: SubagentSummaryAgent[]): SubagentSummaryStatus {
  if (agents.some((agent) => agent.status === "running" || agent.status === "queued")) return "running";
  if (agents.some((agent) => agent.status === "error" || agent.status === "aborted")) return "error";
  if (agents.some((agent) => agent.status === "steered")) return "steered";
  if (agents.some((agent) => agent.status === "stopped")) return "stopped";
  return "completed";
}

function applyWidth(lines: string[], width?: number): string[] {
  if (width == null) return lines;
  if (!Number.isFinite(width) || width <= 0) return lines.map(() => "");
  const safeWidth = Math.floor(width);
  return lines.map((line) => stripAnsi(truncateToWidth(line, safeWidth)));
}

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

function isPositive(value: number | undefined): value is number {
  return value != null && Number.isFinite(value) && value > 0;
}