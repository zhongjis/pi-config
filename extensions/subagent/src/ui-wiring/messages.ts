/**
 * Message/event lifecycle handlers for the subagent extension.
 *
 * Owns turn-abort binding, session boot recovery + parent/child linkage scan,
 * compaction-survival hooks, and UI-context rebinding on turn/session start.
 */

import { pandaWarn } from "../../../lib/warn.js";
import type { SubagentRuntimeContext } from "../lifecycle/supervision.js";
import type { UICtx } from "../ui/agent-widget.js";

const PARENT_COMPACTION_CHECKPOINT_TIMEOUT_MS = 5_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function awaitParentCompactionCheckpoint(
  checkpointAll: () => Promise<void>,
  signal: AbortSignal,
  timeoutMs = PARENT_COMPACTION_CHECKPOINT_TIMEOUT_MS,
): Promise<{ cancel: true } | undefined> {
  if (signal.aborted) {
    pandaWarn("subagent.compaction.checkpoint-failed", { reason: "aborted" });
    return { cancel: true };
  }

  let abortCheckpoint: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    abortCheckpoint = () => reject(new Error("Parent compaction checkpoint aborted"));
    signal.addEventListener("abort", abortCheckpoint, { once: true });
  });
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error("Parent compaction checkpoint timed out")), timeoutMs);
    timeoutHandle.unref?.();
  });

  try {
    await Promise.race([checkpointAll(), aborted, timedOut]);
    return undefined;
  } catch (error) {
    pandaWarn("subagent.compaction.checkpoint-failed", { reason: errorMessage(error) });
    return { cancel: true };
  } finally {
    if (abortCheckpoint) signal.removeEventListener("abort", abortCheckpoint);
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

export function registerSubagentMessageHandlers(ctx: SubagentRuntimeContext): void {
  const {
    pi,
    manager,
    persistentRegistry,
    checkpointAllResumeTargets,
    widget,
    bindTurnAbortSignal,
    getAbortSignal,
    syncSessionContext,
    setCurrentCtx,
  } = ctx;

  pi.on("agent_start", async (_event, ctx) => {
    bindTurnAbortSignal(getAbortSignal(ctx));
  });

  // Rebind session-local UI/state before any auto-started follow-up runs in the current session.
  // Pi 0.70 folds session replacement notifications into session_start reasons
  // (startup/reload/new/resume/fork), so this covers the old switch path too.
  pi.on("session_start", async (_event, ctx) => {
    await manager.clearCompleted();     // preserve existing behavior
    manager.resetLifetimeCost();        // new session → reset per-session subagent cost total
    // Boot recovery: rebuild the durable bg-agent registry + task claims from this
    // session's appendEntry log (emits subagent.recovery.replayed with { count }).
    try {
      persistentRegistry.replay(ctx.sessionManager.getEntries());
    } catch { /* replay is best-effort; never block session start */ }
    // Parent↔child session linkage (Task 29): once the registry is rebuilt, report whether each
    // registered bg-agent's recorded parent session is present in this session's registry.
    for (const agent of persistentRegistry.listAgents()) {
      const parentId = persistentRegistry.getParentSessionId(agent.id);
      if (parentId === null) continue; // orphan: no parent linkage recorded
      if (persistentRegistry.getAgent(parentId)) {
        pandaWarn("subagent.linkage.parent-resolved", { childId: agent.id, parentId });
      } else {
        pandaWarn("subagent.linkage.parent-missing", { childId: agent.id });
      }
    }
    syncSessionContext(ctx);
  });

  // Parent compaction cannot discard the current durable baseline until every active child
  // lifecycle checkpoint has crossed its store append barrier. Provider/listener/advisory work
  // is deliberately outside this bounded wait.
  pi.on("session_before_compact", async (event) => awaitParentCompactionCheckpoint(async () => {
    await checkpointAllResumeTargets();
    pi.appendEntry("subagents:pre-compact-marker", {
      ts: Date.now(),
      registrySize: persistentRegistry.listAgents().length,
      claimsSize: persistentRegistry.listClaims().length,
      resumeTargetsSize: persistentRegistry.listResumeTargets().length,
    });
  }, event.signal));

  // Pi emits this only after successful compaction. Re-emit repository state through store-owned
  // APIs so exact current V1 snapshots become the new post-compaction replay baseline.
  pi.on("session_compact", async () => {
    try {
      await persistentRegistry.reemitAll();
    } catch (error) {
      pandaWarn("subagent.compaction.reemit-failed", { reason: errorMessage(error) });
    }
  });

  pi.on("session_before_switch", async () => { await manager.clearCompleted(true); });

  // Grab UI context from first tool execution + clear lingering widget on new turn
  pi.on("tool_execution_start", async (_event, ctx) => {
    setCurrentCtx(ctx);
    widget.setUICtx(ctx.ui as UICtx);
    widget.onTurnStart();
  });
}
