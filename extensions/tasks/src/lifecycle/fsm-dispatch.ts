import { pandaWarn } from "../../../lib/warn.js";
import { assertTransition, isLateReplyTransition, type TransitionSource, type TransitionTarget } from "../fsm.js";
import { TaskStore } from "../task-store.js";
import type { Task } from "../types.js";
import type { TaskRuntime } from "./store-glue.js";

export type TaskUpdateFields = Parameters<TaskStore["update"]>[1];
export type TaskUpdateResult = ReturnType<TaskStore["update"]>;
export type ClaimBlockerReason = "dangling" | "pending";
export type ClaimBlockerFailure = { taskId: string; blockerId: string; reason: ClaimBlockerReason };
export type TaskStatusForUpdate = Task["status"];

const CLAIM_BLOCKER_NOT_SATISFIED_CODE = "tasks.claim.blocker-not-satisfied";

export function warnLateReplyDropped(taskId: string, from: TaskStatusForUpdate, to: TransitionTarget): void {
  pandaWarn("tasks.fsm.late-reply-dropped", { taskId, from, to });
}

export function warnClaimRejected(failure: ClaimBlockerFailure): void {
  pandaWarn("tasks.claim.rejected", { taskId: failure.taskId, blockerId: failure.blockerId, reason: failure.reason });
}

export function getClaimBlockerFailure(runtime: TaskRuntime, task: Task): ClaimBlockerFailure | undefined {
  for (const blockerId of task.blockedBy) {
    const blocker = runtime.store.get(blockerId);
    if (!blocker) return { taskId: task.id, blockerId, reason: "dangling" };
    if (blocker.status !== "completed") return { taskId: task.id, blockerId, reason: "pending" };
  }
  return undefined;
}

export function claimBlockerMessage(failure: ClaimBlockerFailure): string {
  return `${CLAIM_BLOCKER_NOT_SATISFIED_CODE}: blocked by #${failure.blockerId} (${failure.reason})`;
}

export function assertClaimBlockersSatisfied(runtime: TaskRuntime, task: Task): void {
  const failure = getClaimBlockerFailure(runtime, task);
  if (!failure) return;
  warnClaimRejected(failure);
  throw new Error(claimBlockerMessage(failure));
}

export function updateTask(runtime: TaskRuntime, taskId: string, fields: TaskUpdateFields, source: TransitionSource): TaskUpdateResult {
  const isClaim = fields.status === "in_progress" || fields.owner !== undefined;
  const current = fields.status !== undefined || isClaim ? runtime.store.get(taskId) : undefined;
  if (current && isClaim) assertClaimBlockersSatisfied(runtime, current);
  if (current && fields.status !== undefined) {
    assertTransition(current.status, fields.status, source);
  }
  return runtime.store.update(taskId, fields);
}

export function updateTaskFromRpc(runtime: TaskRuntime, taskId: string, fields: TaskUpdateFields): TaskUpdateResult {
  const current = fields.status !== undefined ? runtime.store.get(taskId) : undefined;
  if (current && fields.status !== undefined && isLateReplyTransition(current.status, fields.status)) {
    warnLateReplyDropped(taskId, current.status, fields.status);
    return { task: current, changedFields: [], warnings: ["late reply dropped"] };
  }
  return updateTask(runtime, taskId, fields, "agent");
}
