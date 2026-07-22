import type { ExternalContractPi } from "../external-contract-adapter.js";
import { appendTerminalCompatibilityRecord } from "../external-contract-adapter.js";
import { AgentRun, project, type AgentRunTerminalEvent } from "../agent-run.js";
import { inspectPersistedChildSessionRecovery, SessionRestoreError } from "../session-restoration.js";
import type { AgentRecord, RestoreFailureReason, ResumeTargetV1 } from "../types.js";
import { lifecycleSnapshotInput } from "./agent-lifecycle-store.js";
import type { PersistentBgAgentRegistry } from "./registry-persistence.js";

export type RunningReconciliationOutcome =
  | { id: string; status: "skipped_live" }
  | { id: string; status: "recovered"; classification: "clean_final_assistant" | "completed_tool_chain" }
  | { id: string; status: "failed"; classification: string; reason: "unsafe_interrupted_operation" }
  | { id: string; status: "rejected"; reason: RestoreFailureReason };

interface RunningReconciliationOptions {
  registry: PersistentBgAgentRegistry;
  parentSessionId: string | undefined;
  getRecord: (id: string) => AgentRecord | undefined;
  pi: ExternalContractPi;
  now?: () => number;
}

function terminalStatus(candidate: AgentRunTerminalEvent | undefined): "completed" | "steered" | "aborted" | "stopped" | "error" {
  if (!candidate) return "completed";
  if (candidate.kind === "completed") return candidate.status;
  if (candidate.kind === "aborted") return candidate.status;
  return "error";
}

function terminalResult(candidate: AgentRunTerminalEvent | undefined, reconstructedResult: string): string {
  if (!candidate) return reconstructedResult;
  return candidate.result?.trim() || reconstructedResult;
}

function transientTerminalRecord(
  target: ResumeTargetV1,
  result: string | undefined,
  error: string | undefined,
  now: number,
): AgentRecord {
  const record: AgentRecord = {
    id: target.id,
    type: target.type,
    description: target.description,
    status: target.state.status,
    toolUses: target.state.toolUses,
    startedAt: target.createdAt,
    completedAt: target.updatedAt,
    resultConsumed: target.state.resultConsumed,
    notified: target.state.notified,
    isBackground: target.isBackground,
    parentSessionId: target.parentSessionId,
    sessionDir: target.sessionDir,
    sessionFile: target.sessionFile,
    lifetimeUsage: { ...target.state.lifetimeUsage },
    lifetimeCost: target.state.lifetimeCost,
    compactionCount: target.state.compactionCount,
  };
  const run = new AgentRun(target.id, { now: () => now });
  record.run = run;
  run.subscribe((_event, current) => project(current, record));
  run.publish({
    kind: "hydrated",
    type: target.type,
    description: target.description,
    isBackground: target.isBackground,
    parentSessionId: target.parentSessionId,
    sessionDir: target.sessionDir,
    sessionFile: target.sessionFile,
    session: undefined,
    createdAt: target.createdAt,
    completedAt: target.updatedAt,
    state: target.state,
  });
  run.publish({ kind: "result_amended", result: result ?? "", error });
  return record;
}

/** Repair orphaned durable running rows from authenticated child bytes only. */
export async function reconcileDurableRunningTargets(
  options: RunningReconciliationOptions,
): Promise<RunningReconciliationOutcome[]> {
  const outcomes: RunningReconciliationOutcome[] = [];
  for (const target of options.registry.listResumeTargets()) {
    if (target.state.status !== "running") continue;
    if (target.parentSessionId !== options.parentSessionId) {
      outcomes.push({ id: target.id, status: "rejected", reason: "scope_mismatch" });
      continue;
    }

    const liveRecord = options.getRecord(target.id);
    if ((liveRecord?.status === "running" || liveRecord?.status === "queued") && liveRecord.lifecycleLease &&
        options.registry.hasMatchingLifecycleLease(target.id, liveRecord.lifecycleLease, target.generation)) {
      outcomes.push({ id: target.id, status: "skipped_live" });
      continue;
    }

    let inspected: ReturnType<typeof inspectPersistedChildSessionRecovery>;
    try {
      inspected = inspectPersistedChildSessionRecovery(target, target.runtime);
    } catch (error) {
      const reason = error instanceof SessionRestoreError ? error.reason : "session_corrupt_or_unsupported";
      outcomes.push({ id: target.id, status: "rejected", reason });
      continue;
    }

    const classification = inspected.classification;
    if (classification.failureReason === "session_corrupt_or_unsupported") {
      outcomes.push({ id: target.id, status: "rejected", reason: classification.failureReason });
      continue;
    }
    const recoveredClassification = classification.outcome === "clean_final_assistant" || classification.outcome === "completed_tool_chain"
      ? classification.outcome
      : undefined;
    const reconstructedResult = classification.reconstructedResult?.trim();
    const pendingCandidate = liveRecord?.run?.pendingTerminal;
    const status = recoveredClassification && reconstructedResult
      ? terminalStatus(pendingCandidate)
      : "error";
    const error = status === "error"
      ? `unsafe_interrupted_operation: durable running generation ended as ${classification.outcome}`
      : undefined;
    const result = status === "error" || !reconstructedResult
      ? undefined
      : terminalResult(pendingCandidate, reconstructedResult);
    const updatedAt = options.now?.() ?? Date.now();
    const store = options.registry.getLifecycleStore(target.id);
    if (!store) {
      outcomes.push({ id: target.id, status: "rejected", reason: "target_unknown" });
      continue;
    }

    try {
      const committed = await store.reconcileRunning({
        ...lifecycleSnapshotInput(target),
        sessionFile: inspected.sessionFile,
        sessionDir: inspected.sessionDir,
        entryCount: inspected.entryCount,
        activeLeafId: inspected.activeLeafId,
        sessionSha256: inspected.sessionSha256,
        updatedAt,
        state: {
          ...target.state,
          status,
          resultConsumed: false,
          notified: false,
        },
      });
      if (pendingCandidate) liveRecord?.run?.clearPendingTerminal(pendingCandidate);
      const record = transientTerminalRecord(committed.snapshot, result, error, updatedAt);
      record.lifecycleLease = committed.lease;
      if (error) record.restoreFailureReason = "unsafe_interrupted_operation";
      await appendTerminalCompatibilityRecord(options.pi, record);
      if (status === "error") {
        outcomes.push({
          id: target.id,
          status: "failed",
          classification: classification.outcome,
          reason: "unsafe_interrupted_operation",
        });
      } else if (recoveredClassification) {
        outcomes.push({ id: target.id, status: "recovered", classification: recoveredClassification });
      }
    } catch {
      outcomes.push({ id: target.id, status: "rejected", reason: "persistence_failed" });
    }
  }
  return outcomes;
}
