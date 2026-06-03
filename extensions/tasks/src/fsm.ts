import type { TaskStatus } from "./types.js";

export type TransitionSource = "agent" | "internal";
export type TransitionTarget = TaskStatus | "deleted";

export const ILLEGAL_TRANSITION_CODE = "tasks.fsm.illegal-transition";

/**
 * Existing internal transitions preserved from src/index.ts:
 * - 359: in_progress -> completed when subagents:completed arrives.
 * - 371: pending -> in_progress when auto-cascade starts an unblocked task.
 * - 384: in_progress -> pending when auto-cascade spawn fails.
 * - 404: in_progress -> completed when subagents:failed reports stopped.
 * - 408: in_progress -> pending when subagents:failed reports an error.
 * - 1012: in_progress -> completed when TaskStop stops a subagent task.
 * - 1022: any task status -> completed when TaskStop stops a process task.
 * - 1098: pending -> in_progress when TaskExecute starts a subagent.
 * - 1113: in_progress -> pending when TaskExecute spawn fails.
 * - 1233/1238/1244: command UI moves pending -> in_progress,
 *   in_progress -> completed, and any visible task -> deleted.
 */
const AGENT_TRANSITIONS: Record<TaskStatus, readonly TransitionTarget[]> = {
  pending: ["pending", "in_progress", "completed", "deleted"],
  in_progress: ["in_progress", "completed", "deleted"],
  completed: ["completed", "deleted"],
};

export function assertTransition(from: TaskStatus, to: TransitionTarget, source: TransitionSource): void {
  if (source === "internal") return;
  if (AGENT_TRANSITIONS[from].includes(to)) return;

  throw new Error(`${ILLEGAL_TRANSITION_CODE}: ${from} -> ${to}`);
}

export function isLateReplyTransition(from: TaskStatus, to: TransitionTarget): boolean {
  return from === "completed" && to !== "completed" && to !== "deleted";
}
