import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import { extractToolText, firstMeaningfulLine, renderToolCall, renderToolExpanded, renderToolSummary } from "../../lib/tool-output.js";
import type { AgentDetails } from "./ui/agent-widget.js";
import { formatMs, getDisplayName } from "./ui/agent-widget.js";

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
    && typeof candidate.result === "string"
    && typeof candidate.tokens === "string"
    && [candidate.toolUses, candidate.durationMs].every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0)
    && [candidate.turnCount, candidate.maxTurns].every((v) => v === undefined || (typeof v === "number" && Number.isFinite(v) && v >= 0))
    && [candidate.error, candidate.activity, candidate.modelName, candidate.thinking, candidate.outputFile, candidate.agentId, candidate.conversation, candidate.delivery]
      .every((v) => v === undefined || typeof v === "string")
    && [candidate.tags, candidate.diagnostics].every((v) => v === undefined || (Array.isArray(v) && v.every((s) => typeof s === "string")));
}

function getResultText(result: TextToolResult): string {
  return extractToolText(result);
}

function formatSkillsSummary(skills: string[] | undefined): string | undefined {
  if (!skills || skills.length === 0) return undefined;
  return `skills: ${skills.length} · ${skills.join(", ")}`;
}

function getStatusSummary(status: AgentDetails["status"]): string {
  if (status === "background") return "started in background";
  if (status === "steered") return "completed at turn limit";
  if (status === "aborted") return "aborted at hard limit";
  if (status === "error") return "failed";
  return status;
}

function getRunMetadata(details: AgentDetails): string[] {
  const lines: string[] = [];
  if (details.modelName) lines.push(`model: ${details.modelName}`);
  if (details.thinking) lines.push(`thinking: ${details.thinking}`);
  if (details.turnCount) lines.push(`turns: ${details.turnCount}`);
  if (details.maxTurns) lines.push(`soft limit: ${details.maxTurns}`);
  if (details.toolUses > 0) lines.push(`tools: ${details.toolUses}`);
  const tokens = details.tokens.trim().replace(/\s+tokens?$/i, "");
  if (tokens && !/^0(?:\.0)?$/.test(tokens)) lines.push(`tokens: ${tokens}`);
  if (details.durationMs > 0) lines.push(`duration: ${formatMs(details.durationMs)}`);
  return lines;
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
  const details = result.details;
  if (!isAgentDetails(details)) {
    return options.expanded
      ? renderToolExpanded(rawText)
      : renderToolSummary([firstMeaningfulLine(rawText) || "No output."], theme, { expandable: true });
  }

  const status = details.category === "delegation_policy_denied" ? "denied by policy" : getStatusSummary(details.status);
  const active = options.isPartial || details.status === "running";
  const waiting = details.status === "queued" || details.status === "background";
  const error = details.error;
  const primary = error || (waiting
    ? `${details.status === "queued" ? "waiting for a slot" : "started in background"} · id: ${details.agentId ?? "unavailable"} · next: get_subagent_result`
    : active ? details.activity || "starting session" : details.result?.trim() || "No output.");
  const metadata = getRunMetadata(details);

  if (!options.expanded) {
    const label = error ? "error" : active ? "activity" : waiting ? "next" : "result";
    const lines = [`status: ${status} · ${label}: ${firstMeaningfulLine(primary)}`];
    if (metadata.length) lines.push(metadata.join(" · "));
    return renderToolSummary(lines, theme, { expandable: true });
  }

  const report = new Container();
  // Markdown owns the complete answer; plain text owns selectable metadata/artifact paths.
  report.addChild(renderToolExpanded(primary, { format: error || active || waiting ? "text" : "markdown" }));
  if (error && details.result?.trim()) {
    report.addChild(renderToolExpanded("\nPartial output before the failure"));
    report.addChild(renderToolExpanded(details.result, { format: "markdown" }));
  }
  const run = [`status: ${status}`, ...metadata];
  if (details.toolUses === 0) run.push("tools: 0");
  if (details.agentId) run.push(`id: ${details.agentId}`);
  if (details.delivery) run.push(`delivery: ${details.delivery}`);
  const tags = details.tags?.filter((tag) => !/^(thinking:|max turns:|background$)/.test(tag));
  if (tags?.length) run.push(`configuration: ${tags.join(" · ")}`);
  report.addChild(renderToolExpanded(`\nRun\n${run.join("\n")}`));
  if (details.diagnostics?.length) {
    report.addChild(renderToolExpanded(`\nDiagnostics\n${details.diagnostics.join("\n")}`));
  }
  if (details.outputFile) report.addChild(renderToolExpanded(`\nArtifacts\ntranscript: ${details.outputFile}`));
  if (details.conversation) report.addChild(renderToolExpanded(`\nAgent Conversation\n${details.conversation}`));
  return report;
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
  return renderAgentToolResult(result, options, theme);
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
