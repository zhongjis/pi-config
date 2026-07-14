import type { TaskStatus } from "./types.js";

export type TransitionSource = "agent" | "internal";
export type TransitionTarget = TaskStatus | "deleted";

export const ILLEGAL_TRANSITION_CODE = "tasks.fsm.illegal-transition";

/** User-facing transitions allowed through task tools and RPC updates. */
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
