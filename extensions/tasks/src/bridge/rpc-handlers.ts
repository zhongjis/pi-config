import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerRpcHandler } from "../../../lib/rpc.js";
import type { TransitionTarget } from "../fsm.js";
import type { TaskUpdateFields } from "../lifecycle/fsm-dispatch.js";
import { updateTaskFromRpc } from "../lifecycle/fsm-dispatch.js";
import { isPlanningTaskMetadataForSession, sanitizeUserMetadata, type TaskRuntime } from "../lifecycle/store-glue.js";

export type ClearPlanningTasksReply =
  | { status: "cleared"; removed: number; removedIncomplete: number }
  | { status: "already_clean"; removed: 0; removedIncomplete: 0 };

export type UpdateTaskRpcParams = {
  requestId: string;
  taskId: string;
  status?: TransitionTarget;
  subject?: string;
  description?: string;
  activeForm?: string;
  owner?: string;
  metadata?: Record<string, any>;
  addBlocks?: string[];
  addBlockedBy?: string[];
};

function clearPlanningTasksForHandoff(runtime: TaskRuntime, sessionId: string): ClearPlanningTasksReply {
  const planningTasks = runtime.store.list().filter(task => isPlanningTaskMetadataForSession(task.metadata, sessionId));
  let removed = 0;
  let removedIncomplete = 0;

  for (const task of planningTasks) {
    if (task.status !== "completed") removedIncomplete++;
    runtime.widget.setActiveTask(task.id, false);
    if (runtime.store.delete(task.id)) removed++;
  }

  if (runtime.taskScope === "session") runtime.store.deleteFileIfEmpty();
  runtime.widget.update();
  return removed > 0
    ? { status: "cleared", removed, removedIncomplete }
    : { status: "already_clean", removed: 0, removedIncomplete: 0 };
}

export function registerTaskRpcHandlers(pi: ExtensionAPI, runtime: TaskRuntime) {
  registerRpcHandler(pi as any, "tasks", "clear-planning-tasks", (raw) => {
    const { sessionId } = raw as { sessionId: string };
    return clearPlanningTasksForHandoff(runtime, sessionId);
  });

  registerRpcHandler(pi as any, "tasks", "update", (raw) => {
    const { requestId: _requestId, taskId, ...fields } = raw as UpdateTaskRpcParams;
    const nextFields: TaskUpdateFields = { ...fields };
    if (fields.metadata !== undefined) {
      nextFields.metadata = sanitizeUserMetadata(fields.metadata).metadata;
    }
    return updateTaskFromRpc(runtime, taskId, nextFields);
  });
}
