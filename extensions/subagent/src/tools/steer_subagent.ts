/**
 * `steer_subagent` tool — send a steering message to a running agent.
 */

import { defineTool, type AgentToolResult, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { firstMeaningfulLine, renderToolCall, renderToolExpanded, renderToolSummary } from "../../../lib/tool-output.js";
import { SUBAGENTS_STEERED } from "../../../lib/subagent-channels.js";
import { steerAgent } from "../agent-runner.js";
import type { SubagentRuntimeContext } from "../lifecycle/supervision.js";
import { textResult } from "../lifecycle/supervision.js";
import { localUriHint } from "../local-uri-hint.js";

type SteerSubagentArgs = {
  agent_id: string;
  message: string;
};

type SteerSubagentRenderContext = {
  args?: Partial<SteerSubagentArgs>;
};

type ToolTheme = Pick<ExtensionContext["ui"]["theme"], "bold" | "fg">;
type TextToolResult = AgentToolResult<unknown>;

const MESSAGE_PREVIEW_CHARS = 72;

function compactMessage(message: string): string {
  return message.replace(/\s+/g, " ").trim();
}

function truncateMessage(message: string): string {
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

export function renderSteerSubagentCall(args: SteerSubagentArgs, theme: ToolTheme) {
  const message = truncateMessage(args.message);
  const target = `${args.agent_id} · "${message}"`;
  return renderToolCall("steer_subagent", target, theme);
}

export function renderSteerSubagentResult(
  result: TextToolResult,
  options: { expanded?: boolean; isPartial?: boolean },
  theme: ToolTheme,
  context: SteerSubagentRenderContext = {},
) {
  const rawText = result.content
    .filter(part => part.type === "text")
    .map(part => part.text ?? "")
    .join("\n");
  if (options.expanded) return renderToolExpanded(appendMessageSection(rawText, context.args?.message));
  if (options.isPartial) return renderToolSummary(["status: sending"], theme, { expandable: true });
  return renderToolSummary(getSteerSummary(rawText), theme, { expandable: true });
}

export function registerSteerSubagentTool(ctx: SubagentRuntimeContext): void {
  const { pi, manager } = ctx;

  pi.registerTool(defineTool({
    name: "steer_subagent",
    label: "Steer Agent",
    description:
      "Send a steering message to a running agent. The message will interrupt the agent after its current tool execution " +
      "and be injected into its conversation, allowing you to redirect its work mid-run while actively supervising background work. Only works on running agents.",
    parameters: Type.Object({
      agent_id: Type.String({
        description: "The agent ID to steer (must be currently running).",
      }),
      message: Type.String({
        description: "The steering message to send. This will appear as a user message in the agent's conversation.",
      }),
    }),
    renderCall(args, theme) {
      return renderSteerSubagentCall(args, theme);
    },
    renderResult(result, options, theme, context) {
      return renderSteerSubagentResult(result as TextToolResult, options, theme, context);
    },
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      const record = manager.getRecord(params.agent_id);
      if (!record) {
        return textResult(`Agent not found: "${params.agent_id}". It may have been cleaned up.`);
      }
      if (record.status !== "running") {
        return textResult(`Agent "${params.agent_id}" is not running (status: ${record.status}). Cannot steer a non-running agent.`);
      }
      if (!record.session) {
        // Session not ready yet — queue the steer for delivery once initialized
        if (!record.pendingSteers) record.pendingSteers = [];
        record.pendingSteers.push(params.message);
        pi.events.emit(SUBAGENTS_STEERED, { id: record.id, message: params.message });
        return textResult(`Steering message queued for agent ${record.id}. It will be delivered once the session initializes.` + localUriHint(params.message));
      }

      try {
        await steerAgent(record.session, params.message);
        pi.events.emit(SUBAGENTS_STEERED, { id: record.id, message: params.message });
        return textResult(`Steering message sent to agent ${record.id}. The agent will process it after its current tool execution.` + localUriHint(params.message));
      } catch (err) {
        return textResult(`Failed to steer agent: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  }));
}
