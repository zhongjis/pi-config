import type { InterruptionCause } from "./types.js";

const FORCE_STEERED_NOTE = " (reached the turn ceiling and wrapped up after a reminder. Verify this output before you use it: it may be partial or overdone. Usually the task was too large for one agent, so split similar work into smaller tasks. If the task was small, the agent likely looped, so read its transcript first. This session is spent: start a new agent for any follow-up.)";

const interruptionLabels: Record<InterruptionCause, string> = {
  user: "STOPPED BY THE USER",
  caller: "cancelled by caller",
  lifecycle: "interrupted by session lifecycle",
  "supervisor-idle": "interrupted by idle supervision",
  "supervisor-ceiling": "interrupted by supervision time ceiling",
  "turn-limit": "aborted at the turn ceiling",
  unknown: "interrupted (cause unknown)",
};

/** State only: neither stopped status nor an arbitrary AbortSignal proves a human stop. */
export function getStatusNote(status: string, cause?: InterruptionCause): string {
  if (status === "force_steered") return FORCE_STEERED_NOTE;
  if (status === "error") return " (failed — output may be partial; the task was NOT finished)";
  if (status !== "stopped" && status !== "aborted") return "";
  return ` (${interruptionLabels[cause ?? "unknown"]} before completion — output is partial; the task was NOT finished)`;
}

/** Inline results contain the full retained output, but an interruption is not completion. */
export function getForegroundOutcomeNote(status: string, cause?: InterruptionCause): string {
  if (status === "force_steered") return FORCE_STEERED_NOTE;
  if (status !== "stopped" && status !== "aborted") return "";
  return ` (${interruptionLabels[cause ?? "unknown"]} — everything the agent produced is above; the task is unfinished)`;
}
