/**
 * external-contract-adapter.ts — the SINGLE place that emits the frozen external
 * `subagents:*` contract (events + durable `subagents:record` snapshot).
 *
 * Phase 2a of the C/D revamp: the channel decision (completed vs failed) now flows
 * through the keystone mapping `toExternalEffects` instead of an inline `isError`
 * check, and the durable record field-set lives in one tested function. Behavior is
 * equivalent to the prior inline emission in supervision.ts (verified by tests);
 * future phases will drive this from an `AgentRun` terminal-event subscription, but
 * for now it is called from the manager's terminal `onComplete` exactly as before.
 *
 * This is the ONLY module that should touch `pi.events`/`appendEntry` for the
 * `subagents:*` contract — keeping the boundary that `tasks/` and compaction-replay
 * depend on contract-tested in isolation.
 */

import { type AgentRunEvent, toExternalEffects } from "./agent-run.js";
import type { AgentRecord } from "./types.js";
import { SUBAGENTS_COMPACTED } from "../../lib/subagent-channels.js";

/** Minimal pi surface the adapter needs (keeps the module unit-testable). */
export interface ExternalContractPi {
  events: { emit(event: string, data: unknown): void };
  appendEntry(type: string, data: unknown): void;
}

/**
 * The exact durable `subagents:record` field set (verified against supervision.ts:491-497).
 * Other extensions and compaction-replay reconstruct history from these keys.
 */
export function buildSubagentRecordEntry(record: AgentRecord) {
  return {
    id: record.id,
    type: record.type,
    description: record.description,
    status: record.status,
    result: record.result,
    error: record.error,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    outputFile: record.outputFile,
    sessionFile: record.sessionFile,
    sessionDir: record.sessionDir,
    parentSessionId: record.parentSessionId,
    toolCallId: record.toolCallId,
    modelLabel: record.modelLabel,
  };
}

/**
 * Map a terminal record status to the internal terminal AgentRunEvent, so the single
 * keystone mapping decides which external effects fire. Returns undefined for
 * non-terminal statuses (queued/running), which emit nothing.
 *
 * Payload fields (result/error/reason) are placeholders here — `toExternalEffects`
 * only switches on `kind` + background-ness, and the emitted event payload is the
 * caller-supplied `eventData` (built with live session stats).
 */
function terminalEventForStatus(status: AgentRecord["status"]): AgentRunEvent | undefined {
  switch (status) {
    case "completed":
      return { kind: "completed", result: "", status: "completed" };
    case "steered":
      return { kind: "completed", result: "", status: "steered" };
    case "error":
      return { kind: "failed", error: "" };
    case "stopped":
      return { kind: "aborted", status: "stopped", reason: "user" };
    case "aborted":
      return { kind: "aborted", status: "aborted", reason: "max_turns" };
    default:
      return undefined;
  }
}

/**
 * Emit the external contract for a terminal agent: the `subagents:completed` /
 * `subagents:failed` lifecycle event (payload = `eventData`) plus the durable
 * `subagents:record` snapshot. Channel + background-gating come from `toExternalEffects`.
 *
 * No-op for non-terminal statuses. Foreground runs emit nothing (matches the current
 * surface, where terminal emission is background-only).
 */
export function emitTerminalContract(pi: ExternalContractPi, record: AgentRecord, eventData: unknown): void {
  const event = terminalEventForStatus(record.status);
  if (!event) return;
  const effects = toExternalEffects(event, { isBackground: record.isBackground ?? false });
  for (const effect of effects) {
    if (effect.type === "event") {
      pi.events.emit(effect.name, eventData);
    } else {
      pi.appendEntry("subagents:record", buildSubagentRecordEntry(record));
    }
  }
}

/**
 * Emit the subagents:compacted lifecycle event for a successful session compaction.
 */
export function emitCompactedContract(
  pi: ExternalContractPi,
  record: { id: string; type: string },
  data: { reason: string; tokensBefore: number; compactionCount: number }
): void {
  pi.events.emit(SUBAGENTS_COMPACTED, {
    id: record.id,
    type: record.type,
    reason: data.reason,
    tokensBefore: data.tokensBefore,
    compactionCount: data.compactionCount,
  });
}
