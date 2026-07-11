/**
 * Message/event lifecycle handlers for the subagent extension.
 *
 * Owns turn-abort binding, session boot recovery + parent/child linkage scan,
 * compaction-survival hooks, and UI-context rebinding on turn/session start.
 */

import { pandaWarn } from "../../../lib/warn.js";
import { BG_AGENT_REGISTRY_ENTRY_TYPE, RESUME_TARGET_ENTRY_TYPE, TASK_CLAIM_ENTRY_TYPE } from "../lifecycle/registry-persistence.js";
import type { SubagentRuntimeContext } from "../lifecycle/supervision.js";
import type { UICtx } from "../ui/agent-widget.js";

export function registerSubagentMessageHandlers(ctx: SubagentRuntimeContext): void {
  const {
    pi,
    manager,
    persistentRegistry,
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
    manager.clearCompleted();           // preserve existing behavior
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

  // ---- Compaction survival hooks (Phase 4 / Task 28) ----
  // The durable bg-agent registry lives in the appendEntry log, which survives compaction;
  // these hooks keep replay correct across a compaction boundary.
  //
  // session_before_compact: drop an informational marker recording where compaction happened
  // and how large the live registry/claim caches were at that point. Sync + fast (in-memory
  // reads only); never blocks compaction.
  pi.on("session_before_compact", () => {
    pi.appendEntry("subagents:pre-compact-marker", {
      ts: Date.now(),
      registrySize: persistentRegistry.listAgents().length,
      claimsSize: persistentRegistry.listClaims().length,
      resumeTargetsSize: persistentRegistry.listResumeTargets().length,
    });
  });

  // session_compact: pi has compacted and pre-compact entries may be gone. Re-emit every live
  // registry/claim row as a fresh appendEntry so future replays rebuild from this post-compact
  // baseline instead of relying on entries compaction may have discarded. Sync + fast.
  pi.on("session_compact", () => {
    for (const agent of persistentRegistry.listAgents()) {
      pi.appendEntry(BG_AGENT_REGISTRY_ENTRY_TYPE, agent);
    }
    for (const claim of persistentRegistry.listClaims()) {
      pi.appendEntry(TASK_CLAIM_ENTRY_TYPE, claim);
    }
    for (const target of persistentRegistry.listResumeTargets()) {
      pi.appendEntry(RESUME_TARGET_ENTRY_TYPE, target);
    }
  });

  pi.on("session_before_switch", () => { manager.clearCompleted(true); });

  // Grab UI context from first tool execution + clear lingering widget on new turn
  pi.on("tool_execution_start", async (_event, ctx) => {
    setCurrentCtx(ctx);
    widget.setUICtx(ctx.ui as UICtx);
    widget.onTurnStart();
  });
}
