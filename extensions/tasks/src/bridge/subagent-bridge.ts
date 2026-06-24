import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { rpcCall } from "../../../lib/rpc.js";
import { SUBAGENTS_COMPLETED, SUBAGENTS_FAILED, SUBAGENTS_READY } from "../../../lib/subagent-channels.js";
import {
  DEPENDENCY_RESULT_TRUNCATION_CHARS,
  PROTOCOL_PING_TIMEOUT_MS,
  PROTOCOL_VERSION,
  SUBAGENT_CONSUME_TIMEOUT_MS,
  SUBAGENT_SPAWN_TIMEOUT_MS,
  SUBAGENT_STOP_TIMEOUT_MS,
} from "../constants.js";
import { advanceTaskGraph, type GraphSnapshot } from "../lifecycle/advance-task-graph.js";
import { applyCommands } from "../lifecycle/apply-commands.js";
import { debug, isPlanningTaskMetadataForSession, type TaskRuntime } from "../lifecycle/store-glue.js";
import type { Task } from "../types.js";
import type { ClearPlanningTasksReply } from "./rpc-handlers.js";

export type SubagentBridge = ReturnType<typeof createSubagentBridge>;

export function createSubagentBridge(pi: ExtensionAPI, runtime: TaskRuntime) {
  function spawnSubagent(type: string, prompt: string, options?: any): Promise<string> {
    debug("spawn:call", { type, options: { ...options, prompt: undefined } });
    return rpcCall<{ id: string }>(pi as any, "subagents", "spawn", { type, prompt, options }, { timeout: SUBAGENT_SPAWN_TIMEOUT_MS })
      .then(d => { debug("spawn:ok", d); return d.id; });
  }

  function stopSubagent(agentId: string): Promise<void> {
    return rpcCall<void>(pi as any, "subagents", "stop", { agentId }, { timeout: SUBAGENT_STOP_TIMEOUT_MS }).catch(() => {});
  }

  function consumeSubagentResult(agentId: string): Promise<void> {
    return rpcCall<void>(pi as any, "subagents", "consume", { agentId }, { timeout: SUBAGENT_CONSUME_TIMEOUT_MS }).catch(() => {});
  }

  function checkSubagentsVersion() {
    rpcCall<{ version?: number }>(pi as any, "subagents", "ping", {}, { timeout: PROTOCOL_PING_TIMEOUT_MS })
      .then((data) => {
        const remoteVersion = data?.version;
        if (remoteVersion === undefined) {
          runtime.pendingWarning =
            "@panda/pi-subagents is outdated — please update for task execution support.";
        } else if (remoteVersion > PROTOCOL_VERSION) {
          runtime.pendingWarning =
            `@panda/pi-tasks is outdated (protocol v${PROTOCOL_VERSION}, ` +
            `pi-subagents has v${remoteVersion}) — please update for task execution support.`;
        } else if (remoteVersion < PROTOCOL_VERSION) {
          runtime.pendingWarning =
            `@panda/pi-subagents is outdated (protocol v${remoteVersion}, ` +
            `pi-tasks has v${PROTOCOL_VERSION}) — please update for task execution support.`;
        } else {
          runtime.subagentsAvailable = true;
        }
      })
      .catch((err: Error) => {
        if (!err.message.includes("timed out")) {
          runtime.pendingWarning =
            "@panda/pi-subagents is outdated — please update for task execution support.";
        }
      });
  }

  function registerPresence() {
    checkSubagentsVersion();
    pi.events.on(SUBAGENTS_READY, () => checkSubagentsVersion());
  }

  function buildTaskPrompt(
    task: { id: string; subject: string; description: string; blockedBy?: string[] },
    additionalContext?: string,
  ): string {
    let prompt = `You are executing task #${task.id}: "${task.subject}"\n\n${task.description}`;

    if (task.blockedBy && task.blockedBy.length > 0) {
      const depResults: string[] = [];
      for (const depId of task.blockedBy) {
        const dep = runtime.store.get(depId);
        if (dep?.metadata?.result) {
          const result = dep.metadata.result.length > DEPENDENCY_RESULT_TRUNCATION_CHARS
            ? dep.metadata.result.slice(0, DEPENDENCY_RESULT_TRUNCATION_CHARS) + "\n\n[... truncated — use TaskGet for full output]"
            : dep.metadata.result;
          depResults.push(`### Task #${depId}: ${dep.subject}\n${result}`);
        }
      }
      if (depResults.length > 0) {
        prompt += `\n\n## Prerequisite task results\n\n${depResults.join("\n\n")}`;
      }
    }

    if (additionalContext) prompt += `\n\n${additionalContext}`;
    prompt += `\n\nComplete this task fully. Do not attempt to manage tasks yourself.`;
    return prompt;
  }

  function getBoundAgentId(task: Task): string | undefined {
    if (typeof task.metadata?.agentId === "string" && task.metadata.agentId) {
      return task.metadata.agentId;
    }

    for (const [agentId, taskId] of runtime.agentTaskMap) {
      if (taskId === task.id) return agentId;
    }

    return undefined;
  }

  async function retirePlanningTaskBindings(task: Task): Promise<void> {
    if (task.status !== "in_progress") return;

    const agentId = getBoundAgentId(task);
    if (agentId) {
      runtime.agentTaskMap.delete(agentId);
      await stopSubagent(agentId);
    }

    runtime.widget.setActiveTask(task.id, false);
  }

  async function clearPlanningTasksForHandoff(sessionId: string): Promise<ClearPlanningTasksReply> {
    const planningTasks = runtime.store.list().filter(task => isPlanningTaskMetadataForSession(task.metadata, sessionId));
    if (planningTasks.length === 0) {
      runtime.widget.update();
      return { status: "already_clean", removed: 0, removedIncomplete: 0 };
    }

    let removed = 0;
    let removedIncomplete = 0;

    for (const task of planningTasks) {
      if (task.status !== "completed") removedIncomplete++;
      await retirePlanningTaskBindings(task);
      if (runtime.store.delete(task.id)) removed++;
    }

    if (runtime.taskScope === "session") runtime.store.deleteFileIfEmpty();
    runtime.widget.update();

    if (removed > 0) return { status: "cleared", removed, removedIncomplete };
    return { status: "already_clean", removed: 0, removedIncomplete: 0 };
  }

  function registerCompletionListeners() {
    const snapshot = (): GraphSnapshot => ({
      tasks: runtime.store.list(),
      agentToTask: runtime.agentTaskMap,
      cascade:
        (runtime.cfg.autoCascade ?? false) && runtime.cascadeConfig && runtime.latestCtx
          ? runtime.cascadeConfig
          : undefined,
    });

    pi.events.on(SUBAGENTS_COMPLETED, async (data) => {
      const { id, result } = data as { id: string; result?: string };
      const commands = advanceTaskGraph({ kind: "completed", agentId: id, result }, snapshot());
      await applyCommands(runtime, { spawnSubagent, buildTaskPrompt }, commands);
    });

    pi.events.on(SUBAGENTS_FAILED, async (data) => {
      const { id, error, result, status } = data as { id: string; error?: string; result?: string; status: string };
      const commands = advanceTaskGraph({ kind: "failed", agentId: id, error, result, status }, snapshot());
      await applyCommands(runtime, { spawnSubagent, buildTaskPrompt }, commands);
    });
  }

  return {
    buildTaskPrompt,
    clearPlanningTasksForHandoff,
    consumeSubagentResult,
    getBoundAgentId,
    registerCompletionListeners,
    registerPresence,
    spawnSubagent,
    stopSubagent,
  };
}
