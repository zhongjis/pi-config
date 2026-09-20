import { Type } from "typebox";
import { Check } from "typebox/value";
import type { WorkflowEntryData } from "./entry.js";
import { isWorkflowOutcome } from "./outcome.js";

const text = Type.Optional(Type.String());
const number = Type.Optional(Type.Number());
const flag = Type.Optional(Type.Boolean());
const phase = Type.Object({ title: Type.String(), detail: text, model: text });
const progress = Type.Union([
  Type.Object({ type: Type.Literal("workflow_phase"), index: Type.Number(), title: Type.String() }),
  Type.Object({ type: Type.Literal("workflow_log"), message: Type.String() }),
  Type.Object({
    type: Type.Literal("workflow_agent"), index: Type.Number(), label: Type.String(),
    state: Type.Union([Type.Literal("start"), Type.Literal("progress"), Type.Literal("done"), Type.Literal("error")]),
    phaseIndex: number, phaseTitle: text, agentId: text, recordId: text, agentType: text,
    nodeKey: text, nodeBinding: text, instanceId: text, materializationOrdinal: Type.Optional(Type.Integer({ minimum: 0 })),
    deps: Type.Optional(Type.Array(Type.String())), dependents: Type.Optional(Type.Array(Type.String())),
    model: text, modelId: text, thinking: text, requestedThinking: text,
    requestedModel: text, fallbackModel: text, error: text,
    skipped: flag, blocked: flag, cached: flag, queuedAt: number, startedAt: number,
    lastProgressAt: number, attempt: number,
    lastAttemptReason: Type.Optional(Type.Union([Type.Literal("throttled"), Type.Literal("user-retry"), Type.Literal("stalled"), Type.Literal("loop"), Type.Literal("restore")])),
    promptPreview: text, resultPreview: text, tokens: number, toolCalls: number, durationMs: number,
  }),
]);
const snapshot = Type.Object({
  name: Type.String(), id: text, scriptPath: text, resultPath: text,
  resultArtifactError: text, totalToolCalls: number, resumedFrom: text,
  status: Type.Union([Type.Literal("running"), Type.Literal("paused"), Type.Literal("completed"), Type.Literal("failed"), Type.Literal("killed")]),
  startTime: Type.Number(), endTime: number, totalPausedMs: number, pausedAt: number,
  value: Type.Optional(Type.Unknown()), error: text, progress: Type.Array(progress),
  agentCount: Type.Number(), totalTokens: Type.Number(),
  meta: Type.Optional(Type.Object({ name: Type.String(), description: Type.String(), whenToUse: text, phases: Type.Optional(Type.Array(phase)) })),
});

/** Reject cyclic/non-JSON values before a historical payload reaches JSON rendering. */
function isJsonValue(value: unknown, ancestors = new Set<object>()): boolean {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || ancestors.has(value)) return false;
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
  ancestors.add(value);
  const valid = Object.values(value).every(child => isJsonValue(child, ancestors));
  ancestors.delete(value);
  return valid;
}

/** The entry and notification boundary; no live task lookup or restoration. */
export function isWorkflowEntryData(value: unknown): value is WorkflowEntryData {
  return isJsonValue(value) && Check(snapshot, value) &&
    (!("outcome" in value) || value.outcome === undefined || isWorkflowOutcome(value.outcome));
}
