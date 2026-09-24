/** Explicit domain outcome, independent of execution lifecycle and user payload. */
export type GraphRunOutcome =
  | { status: "succeeded" }
  | { status: "partial" | "failed"; reason: string };

export const GRAPH_OUTCOME_KEY = "$agentGraphOutcome";

/** Shared by the worker boundary and persisted snapshots; no inferred payload fields. */
export function isGraphRunOutcome(value: unknown): value is GraphRunOutcome {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (record.status === "succeeded") return keys.length === 1;
  return (record.status === "partial" || record.status === "failed") && keys.length === 2 &&
    typeof record.reason === "string" && record.reason.trim().length > 0;
}

export function outcomeLabel(outcome: GraphRunOutcome | undefined): string {
  if (outcome === undefined) return "Completed";
  return outcome.status === "succeeded" ? "Outcome succeeded" : `Outcome ${outcome.status}: ${outcome.reason}`;
}
