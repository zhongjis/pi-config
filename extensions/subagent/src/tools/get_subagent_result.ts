/**
 * `get_subagent_result` tool — check status / retrieve results from a background agent.
 */

import { defineTool, keyHint, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { getAgentConversation } from "../agent-runner.js";
import { getRecoveredResultText } from "../result-recovery.js";
import { describeActivity, formatDuration, getDisplayName } from "../ui/agent-widget.js";
import { safeFormatTokens, textResult } from "../lifecycle/supervision.js";
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

function getBodyPreview(text: string): string | undefined {
  const sections = text.split(/\n\n+/);
  let body = sections.slice(1).join("\n\n").trim();
  if (!body) return undefined;
  if (body.startsWith("Turns:")) {
    body = body.split(/\n\n+/).slice(1).join("\n\n").trim();
  }
  return body.split("\n").find(line => line.trim())?.trim();
}

function parseResultSummary(text: string): ResultSummary {
  const summary: ResultSummary = {};
  summary.agentId = getHeaderValue(text, "Agent");
  summary.description = getHeaderValue(text, "Description");
  parseTypeLine(text.split("\n").find(line => line.startsWith("Type: ")), summary);
  summary.resultPreview = getBodyPreview(text);

  if (!summary.agentId && text.trim()) {
    summary.error = text.split("\n").find(line => line.trim())?.trim();
  }
  return summary;
}

function renderSummaryLines(lines: string[], theme: { fg: (color: any, text: string) => string }): Text {
  const allLines = [...lines, keyHint("app.tools.expand", "to expand full result")];
  const rendered = allLines
    .map((line, index) => `${index === allLines.length - 1 ? "└─" : "├─"} ${line}`)
    .map(line => theme.fg("muted", line))
    .join("\n");
  return new Text(rendered, 0, 0);
}

export function renderGetSubagentResultCall(args: GetSubagentResultArgs, theme: { fg: (color: any, text: string) => string; bold: (text: string) => string }): Text {
  const flags = [args.wait ? "wait" : undefined, args.verbose ? "verbose" : undefined].filter(Boolean);
  const suffix = [args.agent_id, ...flags].filter(Boolean).join(" · ");
  return new Text(`▸ ${theme.fg("toolTitle", theme.bold("get_subagent_result"))}${suffix ? ` · ${theme.fg("muted", suffix)}` : ""}`, 0, 0);
}

export function renderGetSubagentResult(
  result: TextToolResult,
  options: { expanded?: boolean; isPartial?: boolean },
  theme: { fg: (color: any, text: string) => string },
): Text {
  const rawText = getResultText(result);
  if (options.expanded) return new Text(rawText, 0, 0);
  if (options.isPartial) return renderSummaryLines(["status: checking"], theme);

  const summary = parseResultSummary(rawText);
  if (summary.error) return renderSummaryLines([`error: ${summary.error}`], theme);

  const lines: string[] = [];
  if (summary.status) lines.push(`status: ${summary.status}`);
  if (summary.agentType) lines.push(`agent: ${summary.agentType}`);
  const toolParts = [summary.toolUses, summary.tokens ? `context ${summary.tokens}` : undefined].filter(Boolean);
  if (toolParts.length > 0) lines.push(`tools: ${toolParts.join(" · ")}`);
  if (summary.turns) lines.push(`turns: ${summary.turns}`);
  if (summary.duration) lines.push(`duration: ${summary.duration}`);
  if (summary.resultPreview) lines.push(`result: ${summary.resultPreview}`);
  return renderSummaryLines(lines.length > 0 ? lines : ["status: checked"], theme);
}

export function registerGetSubagentResultTool(ctx: SubagentRuntimeContext): void {
  const { pi, manager, agentActivity, getAbortSignal, bindTurnAbortSignal, waitForAgentCompletionWithSupervision } = ctx;

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
      if (params.wait && record.status === "running" && record.promise) {
        record.waitingConsumers = (record.waitingConsumers ?? 0) + 1;
        try {
          const waitSignal = getAbortSignal(ctx) ?? signal;
          bindTurnAbortSignal(waitSignal);
          await waitForAgentCompletionWithSupervision(record, waitSignal);
        } finally {
          record.waitingConsumers = Math.max(0, (record.waitingConsumers ?? 1) - 1);
        }
      }

      const displayName = getDisplayName(record.type);
      const duration = formatDuration(record.startedAt, record.completedAt);
      const tokens = safeFormatTokens(record.session);
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
