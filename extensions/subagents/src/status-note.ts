import type { InterruptionCause } from "./types.js";

const interruptionLabels: Record<InterruptionCause, string> = {
  user: "STOPPED BY THE USER",
  caller: "cancelled by caller",
  lifecycle: "interrupted by session lifecycle",
  "supervisor-idle": "interrupted by idle supervision",
  "supervisor-ceiling": "interrupted by supervision time ceiling",
  "turn-limit": "aborted at the turn limit",
  unknown: "interrupted (cause unknown)",
};

/** State only: neither stopped status nor an arbitrary AbortSignal proves a human stop. */
export function getStatusNote(status: string, cause?: InterruptionCause): string {
  if (status === "steered") return " (wrapped up at the turn limit — output may be partial)";
  if (status === "error") return " (failed — output may be partial; the task was NOT finished)";
  if (status !== "stopped" && status !== "aborted") return "";
  return ` (${interruptionLabels[cause ?? "unknown"]} before completion — output is partial; the task was NOT finished)`;
}

/** Inline results contain the full retained output, but an interruption is not completion. */
export function getForegroundOutcomeNote(status: string, cause?: InterruptionCause): string {
  if (status === "steered") return " (wrapped up at the turn limit — everything the agent produced is above; the task may be unfinished)";
  if (status !== "stopped" && status !== "aborted") return "";
  return ` (${interruptionLabels[cause ?? "unknown"]} — everything the agent produced is above; the task is unfinished)`;
}
