/**
 * external-contract-adapter.ts — owns terminal compatibility history plus frozen
 * background completed/failed effects; it also hosts the compacted-event helper.
 *
 * Phase 2a of the C/D revamp: the channel decision (completed vs failed) now flows
 * through the keystone mapping `toExternalEffects` instead of an inline `isError`
 * check, and the durable record field-set lives in one tested function. Behavior is
 * equivalent to the prior inline emission in supervision.ts (verified by tests);
 * future phases will drive this from an `AgentRun` terminal-event subscription, but
 * for now it is called from the manager's terminal `onComplete` exactly as before.
 *
 * Only terminal `subagents:record` plus completed/failed effects belong to this adapter.
 * Created, started, steered, and other lifecycle effects retain their existing owners.
 */

import { type AgentRunEvent, toExternalEffects } from "./agent-run.js";
import type { AgentRecord } from "./types.js";
import { SUBAGENTS_COMPACTED } from "../../lib/subagent-channels.js";

/** Minimal pi surface the adapter needs (keeps the module unit-testable). */
export interface ExternalContractPi {
  events: { emit(event: string, data: unknown): void };
  appendEntry(type: string, data: unknown): void | Promise<void>;
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

/** Append terminal compatibility history without replaying a historical lifecycle event. */
export function appendTerminalCompatibilityRecord(
  pi: ExternalContractPi,
  record: AgentRecord,
 ): Promise<void> {
  try {
    return Promise.resolve(pi.appendEntry("subagents:record", buildSubagentRecordEntry(record)));
  } catch (error) {
    return Promise.reject(error);
  }
}

/**
 * Commit compatibility history before emitting the advisory terminal event.
 * No-op for non-terminal or foreground records.
 */
export function emitTerminalContract(pi: ExternalContractPi, record: AgentRecord, eventData: unknown): Promise<void> {
  const event = terminalEventForStatus(record.status);
  if (!event) return Promise.resolve();
  const effects = toExternalEffects(event, { isBackground: record.isBackground ?? false });
  const compatibilityEffect = effects.find((effect) => effect.type === "record");
  const advisoryEffect = effects.find((effect) => effect.type === "event");
  if (!compatibilityEffect || !advisoryEffect || advisoryEffect.type !== "event") return Promise.resolve();

  let appended: void | Promise<void>;
  try {
    appended = pi.appendEntry("subagents:record", buildSubagentRecordEntry(record));
  } catch (error) {
    return Promise.reject(error);
  }

  const emitAdvisory = () => { pi.events.emit(advisoryEffect.name, eventData); };
  if (appended === undefined) {
    try {
      emitAdvisory();
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(error);
    }
  }
  return Promise.resolve(appended).then(emitAdvisory);
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
