/**
 * `get_subagent_result` tool — check status / retrieve results from a background agent.
 */

import { defineTool, type AgentToolResult, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { renderToolCall, renderToolExpanded, renderToolSummary } from "../../../lib/tool-output.js";
import { getAgentConversation } from "../agent-runner.js";
import { getRecoveredResultText } from "../result-recovery.js";
import { describeActivity, formatDuration, getDisplayName } from "../ui/agent-widget.js";
import { textResult } from "../lifecycle/supervision.js";
import { formatLifetimeTokens } from "../usage.js";
import type { SubagentRuntimeContext } from "../lifecycle/supervision.js";

type GetSubagentResultArgs = {
  agent_id: string;
  wait?: boolean;
  verbose?: boolean;
};

type TextToolResult = AgentToolResult<unknown>;

type ResultSummary = {
  agentId?: string;
  agentType?: string;
  status?: string;
  turns?: string;
  toolUses?: string;
  tokens?: string;
  duration?: string;
  description?: string;
  activity?: string;
  resultPreview?: string;
  error?: string;
};

function getResultText(result: TextToolResult): string {
  return result.content
    .filter(part => part.type === "text")
    .map(part => part.text ?? "")
    .join("\n");
}

function getHeaderValue(text: string, label: string): string | undefined {
  const match = text.match(new RegExp(`^${label}: (.+)$`, "m"));
  return match?.[1]?.trim();
}

function parseTypeLine(line: string | undefined, summary: ResultSummary): void {
  if (!line?.startsWith("Type: ")) return;
  const parts = line.split(" | ").map(part => part.trim()).filter(Boolean);
  for (const part of parts) {
    if (part.startsWith("Type: ")) summary.agentType = part.slice("Type: ".length);
    else if (part.startsWith("Status: ")) summary.status = part.slice("Status: ".length);
    else if (part.startsWith("Turns: ")) summary.turns = part.slice("Turns: ".length);
    else if (part.startsWith("Tool uses: ")) summary.toolUses = part.slice("Tool uses: ".length);
    else if (part.startsWith("Duration: ")) summary.duration = part.slice("Duration: ".length);
    else if (/^[\d.]+[kM]?$/.test(part)) summary.tokens = part;
  }
}

function isBoilerplateLine(line: string): boolean {
  return line.startsWith("Agent is still running.") || line.startsWith("Agent is queued and has not started yet.");
}

function getBodyPreview(text: string): string | undefined {
  const sections = text.split(/\n\n+/);
  let body = sections.slice(1).join("\n\n").trim();
  if (!body) return undefined;
  if (body.startsWith("Turns:")) {
    body = body.split(/\n\n+/).slice(1).join("\n\n").trim();
  }
  return body.split("\n").map(line => line.trim()).find(line => line && !isBoilerplateLine(line));
}

function parseResultSummary(text: string): ResultSummary {
  const summary: ResultSummary = {};
  summary.agentId = getHeaderValue(text, "Agent");
  summary.description = getHeaderValue(text, "Description");
  summary.activity = getHeaderValue(text, "Current activity");
  parseTypeLine(text.split("\n").find(line => line.startsWith("Type: ")), summary);
  summary.resultPreview = getBodyPreview(text);

  if (!summary.agentId && text.trim()) {
    summary.error = text.split("\n").find(line => line.trim())?.trim();
  }
  return summary;
}

function isZeroStat(value: string | undefined): boolean {
  return value === "0" || value === "0.0";
}

function isZeroDuration(value: string | undefined): boolean {
  return value ? /^0(?:\.0)?s(?:\s|$)/.test(value) : false;
}

function getStatusSummary(status: string | undefined): string | undefined {
  if (status === "steered") return "completed (turn limit)";
  return status;
}

type ToolTheme = Pick<ExtensionContext["ui"]["theme"], "bold" | "fg">;

function renderSummaryLines(lines: string[], theme: ToolTheme) {
  return renderToolSummary(lines, theme, { expandable: true });
}

export function renderGetSubagentResultCall(args: GetSubagentResultArgs, theme: ToolTheme) {
  const flags = [args.wait ? "wait" : undefined, args.verbose ? "verbose" : undefined].filter(Boolean);
  const target = [args.agent_id, ...flags].filter(Boolean).join(" · ");
  return renderToolCall("get_subagent_result", target, theme);
}

export function renderGetSubagentResult(
  result: TextToolResult,
  options: { expanded?: boolean; isPartial?: boolean },
  theme: ToolTheme,
) {
  const rawText = getResultText(result);
  if (options.expanded) return renderToolExpanded(rawText);
  if (options.isPartial) return renderSummaryLines(["status: checking"], theme);

  const summary = parseResultSummary(rawText);
  if (summary.error) return renderSummaryLines([`error: ${summary.error}`], theme);

  const lines: string[] = [];
  const status = getStatusSummary(summary.status);
  if (status) lines.push(`status: ${status}`);
  if ((summary.status === "running" || summary.status === "queued") && summary.activity) lines.push(`activity: ${summary.activity}`);
  if (summary.agentType) lines.push(`agent: ${summary.agentType}`);
  if (summary.toolUses && !isZeroStat(summary.toolUses)) lines.push(`tools: ${summary.toolUses}`);
  if (summary.tokens) lines.push(`context: ${summary.tokens}`);
  if (summary.turns && !isZeroStat(summary.turns)) lines.push(`turns: ${summary.turns}`);
  if (summary.duration && !isZeroDuration(summary.duration)) lines.push(`duration: ${summary.duration}`);
  if (summary.resultPreview) lines.push(`result: ${summary.resultPreview}`);
  if ((summary.status === "running" || summary.status === "queued") && !summary.resultPreview) lines.push("next: wait true or check back later");
  return renderSummaryLines(lines.length > 0 ? lines : ["status: checked"], theme);
}

export function registerGetSubagentResultTool(ctx: SubagentRuntimeContext): void {
  const { pi, manager, agentActivity, getAbortSignal, bindTurnAbortSignal, waitForAgentCompletionWithSupervision, persistResumeTargetSnapshot } = ctx;

  pi.registerTool(defineTool({
    name: "get_subagent_result",
    label: "Get Agent Result",
    description:
      "Check status and retrieve results from a background agent. Use it to actively supervise long-running work started by Agent.",
    parameters: Type.Object({
      agent_id: Type.String({
        description: "The agent ID to check.",
      }),
      wait: Type.Optional(
        Type.Boolean({
          description: "If true, wait for the agent to complete before returning. Default: false.",
        }),
      ),
      verbose: Type.Optional(
        Type.Boolean({
          description: "If true, include the agent's full conversation (messages + tool calls). Default: false.",
        }),
      ),
    }),
    renderCall(args, theme) {
      return renderGetSubagentResultCall(args, theme);
    },
    renderResult(result, options, theme) {
      return renderGetSubagentResult(result as TextToolResult, options, theme);
    },
    execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
      const record = manager.getRecord(params.agent_id);
      if (!record) {
        return textResult(`Agent not found: "${params.agent_id}". It may have been cleaned up.`);
      }
      record.lastPolledAt = Date.now();
      // Wait for completion if requested, but keep a supervision window instead of a blind block.
      if (params.wait && (record.status === "running" || record.status === "queued")) {
        if (record.run) {
          record.run.publish({ kind: "waiter", delta: 1 });
        } else {
          record.waitingConsumers = (record.waitingConsumers ?? 0) + 1;
        }
        try {
          const waitSignal = getAbortSignal(ctx) ?? signal;
          bindTurnAbortSignal(waitSignal);
          await waitForAgentCompletionWithSupervision(record, waitSignal);
        } finally {
          if (record.run) {
            record.run.publish({ kind: "waiter", delta: -1 });
          } else {
            record.waitingConsumers = Math.max(0, (record.waitingConsumers ?? 1) - 1);
          }
        }
      }

      const displayName = getDisplayName(record.type);
      const duration = formatDuration(record.startedAt, record.completedAt);
      const ltUsage = record.lifetimeUsage;
      const ltTotal = ltUsage ? ltUsage.input + ltUsage.output + ltUsage.cacheWrite : 0;
      const tokens = ltTotal > 0 ? formatLifetimeTokens(ltUsage!) : "";
      const toolStats = tokens ? `Tool uses: ${record.toolUses} | ${tokens}` : `Tool uses: ${record.toolUses}`;
      const runtimeActivity = agentActivity.get(record.id);
      const maxTurns = runtimeActivity?.maxTurns;
      const turnCount = record.status === "queued" ? 0 : runtimeActivity?.turnCount;
      const turnSummary = turnCount != null
        ? ` | Turns: ${maxTurns != null ? `${turnCount}/${maxTurns}` : turnCount}`
        : "";
      const currentActivity = record.status === "queued"
        ? "waiting for an available background slot"
        : runtimeActivity
          ? describeActivity(runtimeActivity.activeTools, runtimeActivity.responseText)
          : undefined;

      let output =
        `Agent: ${record.id}\n` +
        `Type: ${displayName} | Status: ${record.status}${turnSummary} | ${toolStats} | Duration: ${duration}\n` +
        `Description: ${record.description}\n`;
      if (record.outputFile) output += `Output file: ${record.outputFile}\n`;
      if (record.sessionDir) output += `Session dir: ${record.sessionDir}\n`;
      if (record.sessionFile) output += `Session file: ${record.sessionFile}\n`;

      if (record.status === "running" || record.status === "queued") {
        const liveLines = [
          turnCount != null ? `Turns: ${turnCount}` : undefined,
          `Max turns: ${maxTurns != null ? maxTurns : "unlimited"}`,
          currentActivity ? `Current activity: ${currentActivity}` : undefined,
        ].filter(Boolean);
        output += `\n${liveLines.join("\n")}\n\n`;
      } else {
        output += "\n";
      }

      if (record.status === "queued") {
        output += "Agent is queued and has not started yet. Use wait: true or check back later.";
      } else if (record.status === "running") {
        output += "Agent is still running. Use wait: true or check back later.";
      } else {
        output += getRecoveredResultText(record);
      }

      // Mark result as consumed only after a terminal result is actually returned here.
      if (record.status !== "running" && record.status !== "queued") {
        if (record.run) {
          record.run.publish({ kind: "consumed" });
        } else {
          record.resultConsumed = true;
        }
        await persistResumeTargetSnapshot(record);
      }

      // Verbose: include full conversation
      if (params.verbose && record.session) {
        const conversation = getAgentConversation(record.session);
        if (conversation) {
          output += `\n\n--- Agent Conversation ---\n${conversation}`;
        }
      }

      return textResult(output);
    },
  }));
}
