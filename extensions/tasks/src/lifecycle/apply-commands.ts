/**
 * apply-commands.ts — the thin applier behind advanceTaskGraph.
 *
 * `advanceTaskGraph` decides WHAT should happen as data; this module performs it.
 * `runSpawn` is the one genuinely effectful primitive: the in_progress→spawn→
 * bind-or-revert sequence whose final `agentId` is only known after the async
 * RPC resolves. It is shared by both spawn sites — the cascade applier here and
 * the TaskExecute tool — so the sequence lives in exactly one place.
 */

import type { SubagentBridge } from "../bridge/subagent-bridge.js";
import type { Command } from "./advance-task-graph.js";
import { updateTask } from "./fsm-dispatch.js";
import { debug, type TaskRuntime } from "./store-glue.js";

/** The bridge surface a spawn needs — supplied by value (dependency injection). */
type SpawnBridge = Pick<SubagentBridge, "spawnSubagent" | "buildTaskPrompt">;

/** Everything needed to spawn one task as a subagent. */
export interface SpawnRequest {
  taskId: string;
  agentType: string;
  additionalContext?: string;
  spawnOptions: Record<string, unknown>;
}

/** Outcome of a single spawn, so request-driven callers (TaskExecute) can report it. */
export interface SpawnOutcome {
  taskId: string;
  ok: boolean;
  agentId?: string;
  error?: string;
}

/**
 * Spawn one task as a subagent, binding it on success or reverting it to pending
 * (with `lastError`) on failure. The caller must have already marked the task
 * `in_progress`. Returns the outcome; never throws on spawn failure.
 */
export async function runSpawn(runtime: TaskRuntime, bridge: SpawnBridge, req: SpawnRequest): Promise<SpawnOutcome> {
  const task = runtime.store.get(req.taskId);
  if (!task) return { taskId: req.taskId, ok: false, error: "task not found" };

  const prompt = bridge.buildTaskPrompt(task, req.additionalContext);
  try {
    const agentId = await bridge.spawnSubagent(req.agentType, prompt, req.spawnOptions);
    runtime.agentTaskMap.set(agentId, req.taskId);
    updateTask(runtime, req.taskId, { owner: agentId, metadata: { ...task.metadata, agentId } }, "internal");
    runtime.widget.setActiveTask(req.taskId);
    return { taskId: req.taskId, ok: true, agentId };
  } catch (err: any) {
    debug(`spawn:error task=#${req.taskId}`, err);
    updateTask(runtime, req.taskId, { status: "pending", metadata: { ...task.metadata, lastError: err.message } }, "internal");
    return { taskId: req.taskId, ok: false, error: err.message };
  }
}

/** Apply an ordered command list. `spawnTask` is awaited so order is preserved. */
export async function applyCommands(runtime: TaskRuntime, bridge: SpawnBridge, commands: Command[]): Promise<void> {
  for (const cmd of commands) {
    switch (cmd.kind) {
      case "deleteAgentMapping":
        runtime.agentTaskMap.delete(cmd.agentId);
        break;
      case "updateTask":
        updateTask(runtime, cmd.taskId, cmd.fields, "internal");
        break;
      case "setActiveTask":
        runtime.widget.setActiveTask(cmd.taskId, cmd.active);
        break;
      case "trackCompletion":
        runtime.autoClear.trackCompletion(cmd.taskId, runtime.currentTurn);
        break;
      case "resetBatchCountdown":
        runtime.autoClear.resetBatchCountdown();
        break;
      case "spawnTask":
        await runSpawn(runtime, bridge, cmd);
        break;
      case "widgetUpdate":
        runtime.widget.update();
        break;
    }
  }
}
