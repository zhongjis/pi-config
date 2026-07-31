import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { extractToolText, firstMeaningfulLine, renderToolCall, renderToolExpanded, renderToolSummary } from "../../lib/tool-output.js";
import type { AgentDetails } from "./ui/agent-widget.js";
import { formatMs, formatTurns, getDisplayName } from "./ui/agent-widget.js";

type ToolTheme = Pick<ExtensionContext["ui"]["theme"], "bold" | "fg">;
type TextToolResult = AgentToolResult<unknown>;

type AgentToolRenderArgs = {
  subagent_type?: string;
  description?: string;
  skills?: string[];
};

type GetSubagentResultArgs = {
  agent_id: string;
  wait?: boolean;
  verbose?: boolean;
};

type SteerSubagentArgs = {
  agent_id: string;
  message: string;
};

type SteerSubagentRenderContext = {
  args?: Partial<SteerSubagentArgs>;
};

type ResultSummary = {
  agentType?: string;
  status?: string;
  turns?: string;
  toolUses?: string;
  context?: string;
  duration?: string;
  activity?: string;
  resultPreview?: string;
  error?: string;
};

const AGENT_STATUSES = new Set<AgentDetails["status"]>([
  "queued",
  "running",
  "completed",
  "steered",
  "aborted",
  "stopped",
  "error",
  "background",
]);

function isAgentDetails(value: unknown): value is AgentDetails {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<AgentDetails>;
  return typeof candidate.status === "string"
    && AGENT_STATUSES.has(candidate.status as AgentDetails["status"])
    && typeof candidate.toolUses === "number"
    && typeof candidate.tokens === "string"
    && typeof candidate.durationMs === "number";
}

function getResultText(result: TextToolResult): string {
  return result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
}

function formatSkillsSummary(skills: string[] | undefined): string | undefined {
  if (!skills || skills.length === 0) return undefined;
  return `skills: ${skills.length} · ${skills.join(", ")}`;
}

function getStatusSummary(status: AgentDetails["status"]): string {
  if (status === "background") return "started";
  if (status === "steered") return "completed (turn limit)";
  return status;
}

function getModelSummary(details: AgentDetails): string | undefined {
  const tags = details.tags?.map((tag) => tag.replace(/^thinking:\s*/, "thinking ")) ?? [];
  const turns = details.turnCount != null && details.turnCount > 0
    ? formatTurns(details.turnCount, details.maxTurns)
    : undefined;
  const parts = [details.modelName, ...tags, turns].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

function getContextSummary(tokens: string): string | undefined {
  const normalized = tokens.trim().replace(/\s+tokens?$/i, "");
  return normalized || undefined;
}

function firstContentLine(text: string): string | undefined {
  return text.split(/\r\n?|\n/).map((line) => line.trim()).find(Boolean);
}

export function renderAgentToolCall(args: AgentToolRenderArgs, theme: ToolTheme) {
  const displayName = args.subagent_type ? getDisplayName(args.subagent_type) : "Agent";
  const target = [args.description, formatSkillsSummary(args.skills)]
    .filter((value): value is string => Boolean(value))
    .join(" · ");
  return renderToolCall(displayName, target, theme);
}

export function renderAgentToolResult(
  result: TextToolResult,
  options: { expanded?: boolean; isPartial?: boolean },
  theme: ToolTheme,
) {
  const rawText = getResultText(result);
  if (options.expanded) return renderToolExpanded(rawText);

  const details = result.details;
  if (!isAgentDetails(details)) return renderToolExpanded(rawText);

  const lines = [`status: ${getStatusSummary(details.status)}`];
  if ((options.isPartial || details.status === "running") && details.activity?.trim()) {
    lines.push(`activity: ${details.activity.trim()}`);
  }
  if ((details.status === "background" || details.status === "queued") && details.agentId) {
    lines.push(`agent: ${details.agentId}`);
    lines.push("next: get_subagent_result wait:false");
  }
  const model = getModelSummary(details);
  if (model) lines.push(`model: ${model}`);
  if (details.toolUses > 0) lines.push(`tools: ${details.toolUses}`);
  const context = getContextSummary(details.tokens);
  if (context) lines.push(`context: ${context}`);
  if (["completed", "steered", "stopped", "aborted"].includes(details.status)) {
    const preview = firstContentLine(rawText);
    if (preview) lines.push(`result: ${preview}`);
  }
  if (details.status === "error" && details.error) {
    lines.push(`error: ${firstContentLine(details.error) ?? "unknown"}`);
  }
  if (
    details.durationMs > 0
    && details.status !== "running"
    && details.status !== "background"
    && details.status !== "queued"
  ) {
    lines.push(`duration: ${formatMs(details.durationMs)}`);
  }
  return renderToolSummary(lines, theme, { expandable: true });
}

function parseTypeLine(line: string | undefined, summary: ResultSummary): void {
  if (!line?.startsWith("Type: ")) return;
  for (const part of line.split(" | ").map((value) => value.trim()).filter(Boolean)) {
    if (part.startsWith("Type: ")) summary.agentType = part.slice("Type: ".length);
    else if (part.startsWith("Status: ")) summary.status = part.slice("Status: ".length);
    else if (part.startsWith("Turns: ")) summary.turns = part.slice("Turns: ".length);
    else if (part.startsWith("Tool uses: ")) summary.toolUses = part.slice("Tool uses: ".length);
    else if (part.startsWith("Duration: ")) summary.duration = part.slice("Duration: ".length);
    else if (part.startsWith("Context: ") && !summary.context) {
      summary.context = part.slice("Context: ".length);
    } else if (/^[\d.]+[kM]?\s+tokens?$/i.test(part)) {
      summary.context = part.replace(/\s+tokens?$/i, "");
    }
  }
}

function isBoilerplateLine(line: string): boolean {
  return line.startsWith("Agent is still running.") || line.startsWith("Agent is queued and has not started yet.");
}

function getBodyPreview(text: string): string | undefined {
  const sections = text.split(/\n\n+/);
  let body = sections.slice(1).join("\n\n").trim();
  if (!body) return undefined;
  if (body.startsWith("Turns:")) body = body.split(/\n\n+/).slice(1).join("\n\n").trim();
  return body.split("\n").map((line) => line.trim()).find((line) => line && !isBoilerplateLine(line));
}

function parseResultSummary(text: string): ResultSummary {
  const summary: ResultSummary = {};
  parseTypeLine(text.split("\n").find((line) => line.startsWith("Type: ")), summary);
  const activity = text.match(/^Current activity: (.+)$/m)?.[1]?.trim();
  if (activity) summary.activity = activity;
  summary.resultPreview = getBodyPreview(text);
  if (!text.match(/^Agent: .+$/m) && text.trim()) summary.error = firstContentLine(text);
  return summary;
}

function isZero(value: string | undefined): boolean {
  return value === "0" || value === "0.0";
}

function isZeroDuration(value: string | undefined): boolean {
  return value ? /^0(?:\.0)?s(?:\s|$)/.test(value) : false;
}

function normalizeResultStatus(status: string | undefined): string | undefined {
  return status === "steered" ? "completed (turn limit)" : status;
}

export function renderGetSubagentResultCall(args: GetSubagentResultArgs, theme: ToolTheme) {
  const flags = [args.wait ? "wait" : undefined, args.verbose ? "verbose" : undefined].filter(Boolean);
  return renderToolCall("get_subagent_result", [args.agent_id, ...flags].join(" · "), theme);
}

export function renderGetSubagentResult(
  result: TextToolResult,
  options: { expanded?: boolean; isPartial?: boolean },
  theme: ToolTheme,
) {
  const rawText = getResultText(result);
  if (options.expanded) return renderToolExpanded(rawText);
  if (options.isPartial) return renderToolSummary(["status: checking"], theme, { expandable: true });

  const summary = parseResultSummary(rawText);
  if (summary.error) return renderToolSummary([`error: ${summary.error}`], theme, { expandable: true });

  const lines: string[] = [];
  const status = normalizeResultStatus(summary.status);
  if (status) lines.push(`status: ${status}`);
  if ((summary.status === "running" || summary.status === "queued") && summary.activity) {
    lines.push(`activity: ${summary.activity}`);
  }
  if (summary.agentType) lines.push(`agent: ${summary.agentType}`);
  if (summary.toolUses && !isZero(summary.toolUses)) lines.push(`tools: ${summary.toolUses}`);
  if (summary.context && !isZero(summary.context)) lines.push(`context: ${summary.context}`);
  if (summary.turns && !isZero(summary.turns)) lines.push(`turns: ${summary.turns}`);
  if (summary.duration && !isZeroDuration(summary.duration)) lines.push(`duration: ${summary.duration}`);
  if (summary.resultPreview) lines.push(`result: ${summary.resultPreview}`);
  if ((summary.status === "running" || summary.status === "queued") && !summary.resultPreview) {
    lines.push("next: wait true or check back later");
  }
  return renderToolSummary(lines.length > 0 ? lines : ["status: checked"], theme, { expandable: true });
}

const MESSAGE_PREVIEW_CHARS = 72;

function compactMessage(message: string | undefined): string {
  return (message ?? "").replace(/\s+/g, " ").trim();
}

function truncateMessage(message: string | undefined): string {
  const chars = Array.from(compactMessage(message));
  if (chars.length <= MESSAGE_PREVIEW_CHARS) return chars.join("");
  return `${chars.slice(0, MESSAGE_PREVIEW_CHARS - 1).join("")}…`;
}

function appendMessageSection(rawText: string, message: string | undefined): string {
  if (!message) return rawText;
  return `${rawText}\n\nMessage\n${message}`;
}

function getSteerSummary(rawText: string): string[] {
  const decisiveLine = firstMeaningfulLine(rawText);
  if (decisiveLine.startsWith("Steering message sent to agent ")) return ["status: delivered"];
  if (decisiveLine.startsWith("Steering message queued for agent ")) return ["status: queued"];
  if (decisiveLine.startsWith("Agent not found: ")) return ["status: missing-target", `reason: ${decisiveLine}`];
  if (decisiveLine.includes(" is not running ") && decisiveLine.includes("Cannot steer a non-running agent.")) {
    return ["status: rejected", `reason: ${decisiveLine}`];
  }
  if (decisiveLine.startsWith("Failed to steer agent:")) {
    return ["status: failed", `error: ${decisiveLine.slice("Failed to steer agent:".length).trim()}`];
  }
  return decisiveLine ? [`result: ${decisiveLine}`] : ["result: no output"];
}

export function renderSteerSubagentCall(args: Partial<SteerSubagentArgs>, theme: ToolTheme) {
  const message = truncateMessage(args.message);
  const target = [args.agent_id, message ? `"${message}"` : undefined]
    .filter((value): value is string => Boolean(value))
    .join(" · ");
  return renderToolCall("steer_subagent", target || undefined, theme);
}

export function renderSteerSubagentResult(
  result: TextToolResult,
  options: { expanded?: boolean; isPartial?: boolean },
  theme: ToolTheme,
  context: SteerSubagentRenderContext = {},
) {
  const rawText = extractToolText(result);
  if (options.expanded) return renderToolExpanded(appendMessageSection(rawText, context.args?.message));
  if (options.isPartial) return renderToolSummary(["status: sending"], theme, { expandable: true });
  return renderToolSummary(getSteerSummary(rawText), theme, { expandable: true });
}
