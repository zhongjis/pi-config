import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { NotificationDetails } from "../types.js";
import type { GateRequest } from "./gate-handoff.js";
import type { GraphRunNotifications } from "./graph-runtime.js";
import type { GraphRunTask } from "./task.js";

/** Gate nudges use the existing held follow-up channel, never a second prompt UI. */
export function createGateNotifications(pi: ExtensionAPI, notifications: GraphRunNotifications,
  task: GraphRunTask, isPending: (gateId: string) => boolean) {
  const scheduled = new Map<string, string>();
  return {
    publish(gate: GateRequest) {
      const key = `${task.id}:gate:${gate.gate_id}:${gate.revision}`;
      scheduled.set(gate.gate_id, key);
      notifications.schedule(key, () => {
        if (!scheduled.delete(gate.gate_id) || !isPending(gate.gate_id)) return;
        const next = `Call get_agent_result with run_id "${task.id}" and wait:true; ask the human, then resolve_agent_graph_gate.`;
        pi.sendMessage<NotificationDetails>({
          customType: "subagent-notification", display: true,
          content: `<task-notification>\n<task-id>${task.id}</task-id>\n<status>Human input required</status>\n${next}\n</task-notification>`,
          details: { id: task.id, description: "Graph requires human input", status: "running", toolUses: task.totalToolCalls,
            turnCount: 0, totalTokens: task.totalTokens, durationMs: Date.now() - task.startTime, resultPreview: next },
        }, { deliverAs: "followUp", triggerTurn: true });
      });
    },
    observed(gateId: string) {
      const key = scheduled.get(gateId);
      if (key) notifications.cancel(key);
      scheduled.delete(gateId);
    },
    close() { for (const key of scheduled.values()) notifications.cancel(key); scheduled.clear(); },
  };
}
