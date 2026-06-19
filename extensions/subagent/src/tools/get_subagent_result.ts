/**
 * `get_subagent_result` tool — check status / retrieve results from a background agent.
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getAgentConversation } from "../agent-runner.js";
import { getRecoveredResultText } from "../result-recovery.js";
import { describeActivity, formatDuration, getDisplayName } from "../ui/agent-widget.js";
import { safeFormatTokens, textResult } from "../lifecycle/supervision.js";
import type { SubagentRuntimeContext } from "../lifecycle/supervision.js";

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
