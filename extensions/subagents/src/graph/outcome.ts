/** Explicit domain outcome, independent of execution lifecycle and user payload. */
export type WorkflowOutcome =
  | { status: "succeeded" }
  | { status: "partial" | "failed"; reason: string };

export const WORKFLOW_OUTCOME_KEY = "$subagentWorkflowOutcome";

/** Shared by the worker boundary and persisted snapshots; no inferred payload fields. */
export function isWorkflowOutcome(value: unknown): value is WorkflowOutcome {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (record.status === "succeeded") return keys.length === 1;
  return (record.status === "partial" || record.status === "failed") && keys.length === 2 &&
    typeof record.reason === "string" && record.reason.trim().length > 0;
}

export function outcomeLabel(outcome: WorkflowOutcome | undefined): string {
  if (outcome === undefined) return "Outcome not declared";
  return outcome.status === "succeeded" ? "Outcome succeeded" : `Outcome ${outcome.status}: ${outcome.reason}`;
}
