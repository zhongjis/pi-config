/**
 * registry-persistence.ts — appendEntry-backed durable bg-agent registry + task-claim store.
 *
 * Phase 4 (Task 27): replaces volatile in-memory tracking of background-agent state and
 * task claims with a write-through-first persistence layer backed by `pi.appendEntry`.
 *
 * Durability model:
 *   - Each mutation is persisted to the session JSONL via `pi.appendEntry(<customType>, data)`
 *     BEFORE the in-memory cache is touched. If the append throws, the in-memory cache is left
 *     unchanged and the error is surfaced (re-thrown) so callers never observe split-brain state
 *     where the cache claims something the durable log does not (Metis edge case (d)).
 *   - The on-disk log is append-only — past entries are never rewritten. State is reconstructed
 *     on boot by replaying the log (`replay`) and applying last-write-wins per id/taskId.
 *   - CustomEntry survives restart and compaction (compaction only affects LLM-context messages),
 *     so the durable log outlives both.
 *
 * Custom entry types (stable; do not rename without a migration):
 *   - `subagents:bg-agent-registry` — one entry per bg-agent state transition.
 *   - `subagents:task-claim`        — one entry per task claim.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { pandaWarn } from "../../../lib/warn.js";

/** Stable custom-entry type for bg-agent registry rows. */
export const BG_AGENT_REGISTRY_ENTRY_TYPE = "subagents:bg-agent-registry";
/** Stable custom-entry type for task-claim rows. */
export const TASK_CLAIM_ENTRY_TYPE = "subagents:task-claim";

/** Durable shape for a background-agent registry entry. */
export interface BgAgentRegistryEntry {
  id: string;
  parentSessionId?: string;
  status: string;
  claimedTaskIds: string[];
  lastSeenTs: number;
}

/** Durable shape for a task claim. */
export interface TaskClaim {
  taskId: string;
  sessionId?: string;
  ts: number;
}

/** Minimal session-entry shape we read during replay (matches `CustomEntry`). */
interface CustomEntryLike {
  type?: string;
  customType?: string;
  data?: unknown;
}

/** Only the `appendEntry` action is required for write-through. */
type AppendCapablePi = Pick<ExtensionAPI, "appendEntry">;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Durable, write-through-first registry of background agents and task claims.
 *
 * In-memory Maps are pure caches over the appendEntry log; they are only mutated AFTER a
 * successful append, and fully rebuilt from the log via `replay()` on boot.
 */
export class PersistentBgAgentRegistry {
  private readonly agents = new Map<string, BgAgentRegistryEntry>();
  private readonly claims = new Map<string, TaskClaim>();

  constructor(private readonly pi: AppendCapablePi) {}

  /**
   * Persist a bg-agent registry entry, then update the in-memory cache.
   *
   * Write-through-first: `pi.appendEntry` is called BEFORE the cache mutation. If it throws,
   * the cache is left untouched, a `subagent.recovery.persist-failed` warning is emitted, and
   * the error is re-thrown so the caller can decide how to surface it.
   */
  recordAgent(entry: BgAgentRegistryEntry): void {
    const normalized: BgAgentRegistryEntry = {
      id: entry.id,
      parentSessionId: entry.parentSessionId,
      status: entry.status,
      claimedTaskIds: [...(entry.claimedTaskIds ?? [])],
      lastSeenTs: entry.lastSeenTs,
    };
    try {
      this.pi.appendEntry(BG_AGENT_REGISTRY_ENTRY_TYPE, normalized);
    } catch (err) {
      pandaWarn("subagent.recovery.persist-failed", {
        kind: "bg-agent-registry",
        id: normalized.id,
        error: errorMessage(err),
      });
      throw err;
    }
    this.agents.set(normalized.id, normalized);
  }

  /**
   * Persist a task claim, then update the in-memory cache.
   *
   * Write-through-first with the same failure semantics as {@link recordAgent}: on append
   * failure the cache is unchanged, a warning is emitted, and the error is re-thrown.
   */
  claimTask(claim: TaskClaim): void {
    const normalized: TaskClaim = {
      taskId: claim.taskId,
      sessionId: claim.sessionId,
      ts: claim.ts,
    };
    try {
      this.pi.appendEntry(TASK_CLAIM_ENTRY_TYPE, normalized);
    } catch (err) {
      pandaWarn("subagent.recovery.persist-failed", {
        kind: "task-claim",
        taskId: normalized.taskId,
        error: errorMessage(err),
      });
      throw err;
    }
    this.claims.set(normalized.taskId, normalized);
  }

  getAgent(id: string): BgAgentRegistryEntry | undefined {
    return this.agents.get(id);
  }

  /**
   * Resolve the parent session id recorded for a child bg-agent.
   *
   * Returns the durable `parentSessionId` captured when the agent was registered, or `null`
   * when the agent is unknown or has no parent linkage (orphan).
   */
  getParentSessionId(childId: string): string | null {
    return this.getAgent(childId)?.parentSessionId ?? null;
  }

  listAgents(): BgAgentRegistryEntry[] {
    return [...this.agents.values()];
  }

  getClaim(taskId: string): TaskClaim | undefined {
    return this.claims.get(taskId);
  }

  listClaims(): TaskClaim[] {
    return [...this.claims.values()];
  }

  /**
   * Rebuild in-memory state from the appendEntry log.
   *
   * Clears the caches first, then applies entries in log order (last-write-wins per id/taskId),
   * so a replay is session-scoped and idempotent. Always emits `subagent.recovery.replayed`
   * with the number of registry/claim rows consumed.
   */
  replay(entries: Iterable<CustomEntryLike>): number {
    this.agents.clear();
    this.claims.clear();
    let count = 0;
    for (const entry of entries) {
      if (!entry || entry.type !== "custom") continue;
      if (entry.customType === BG_AGENT_REGISTRY_ENTRY_TYPE) {
        const data = entry.data as Partial<BgAgentRegistryEntry> | undefined;
        if (!data || typeof data.id !== "string") continue;
        this.agents.set(data.id, {
          id: data.id,
          parentSessionId: typeof data.parentSessionId === "string" ? data.parentSessionId : undefined,
          status: typeof data.status === "string" ? data.status : "unknown",
          claimedTaskIds: Array.isArray(data.claimedTaskIds) ? data.claimedTaskIds.filter((t): t is string => typeof t === "string") : [],
          lastSeenTs: typeof data.lastSeenTs === "number" ? data.lastSeenTs : 0,
        });
        count++;
      } else if (entry.customType === TASK_CLAIM_ENTRY_TYPE) {
        const data = entry.data as Partial<TaskClaim> | undefined;
        if (!data || typeof data.taskId !== "string") continue;
        this.claims.set(data.taskId, {
          taskId: data.taskId,
          sessionId: typeof data.sessionId === "string" ? data.sessionId : undefined,
          ts: typeof data.ts === "number" ? data.ts : 0,
        });
        count++;
      }
    }
    pandaWarn("subagent.recovery.replayed", { count });
    return count;
  }
}
