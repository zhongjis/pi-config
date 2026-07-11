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

import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ResumeTargetV1 } from "../types.js";
import { pandaWarn } from "../../../lib/warn.js";

/** Stable custom-entry type for bg-agent registry rows. */
export const BG_AGENT_REGISTRY_ENTRY_TYPE = "subagents:bg-agent-registry";
/** Stable custom-entry type for task-claim rows. */
export const TASK_CLAIM_ENTRY_TYPE = "subagents:task-claim";
/** Stable custom-entry type for version 1 resume targets. */
export const RESUME_TARGET_ENTRY_TYPE = "subagents:resume-target-v1";

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

const SHA256_RE = /^[0-9a-f]{64}$/;
const RESUME_STATUSES = new Set(["queued", "running", "completed", "steered", "aborted", "stopped", "error"]);
const PROMPT_MODES = new Set(["replace", "append", "system_instructions"]);

type ResumeTargetPatch = Partial<Omit<ResumeTargetV1, "version" | "id" | "generation" | "revision">>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isCanonicalPath(value: unknown): value is string {
  return isNonEmptyString(value) && resolve(value) === value;
}

function parseResumeTarget(value: unknown): ResumeTargetV1 | undefined {
  if (!isRecord(value) || value.version !== 1) return undefined;
  const runtime = value.runtime;
  const state = value.state;
  if (!isRecord(runtime) || !isRecord(state) || !isRecord(runtime.model) || !isRecord(state.lifetimeUsage)) return undefined;

  const extensionIdentities = runtime.extensionIdentities;
  const activeToolNames = runtime.activeToolNames;
  if (
    !isNonEmptyString(value.id) || !isNonNegativeInteger(value.generation) || !isNonNegativeInteger(value.revision) ||
    !isNonEmptyString(value.parentSessionId) || !isCanonicalPath(value.sessionFile) || !isCanonicalPath(value.sessionDir) ||
    !isNonEmptyString(value.childSessionId) || !isNonNegativeInteger(value.entryCount) || !isNonEmptyString(value.activeLeafId) ||
    !SHA256_RE.test(String(value.sessionSha256)) || !isNonEmptyString(value.type) || !isNonEmptyString(value.description) ||
    !isNonEmptyString(value.cwd) || typeof value.isBackground !== "boolean" ||
    !isNonNegativeInteger(value.createdAt) || !isNonNegativeInteger(value.updatedAt) ||
    !isNonEmptyString(runtime.piVersion) || !isNonEmptyString(runtime.model.provider) ||
    !isNonEmptyString(runtime.model.id) || !isNonEmptyString(runtime.model.api) ||
    typeof runtime.thinkingLevel !== "string" || !PROMPT_MODES.has(String(runtime.promptMode)) ||
    typeof runtime.isolated !== "boolean" || typeof runtime.inheritContext !== "boolean" ||
    !SHA256_RE.test(String(runtime.systemPromptHash)) || !SHA256_RE.test(String(runtime.resourcePolicyHash)) ||
    !SHA256_RE.test(String(runtime.agentConfigHash)) || !Array.isArray(extensionIdentities) ||
    !extensionIdentities.every((item) => isRecord(item) && isNonEmptyString(item.name) && SHA256_RE.test(String(item.contentHash))) ||
    !Array.isArray(activeToolNames) || !activeToolNames.every(isNonEmptyString) ||
    !RESUME_STATUSES.has(String(state.status)) || typeof state.resultConsumed !== "boolean" || typeof state.notified !== "boolean" ||
    !isNonNegativeInteger(state.toolUses) || !isNonNegativeInteger(state.lifetimeUsage.input) ||
    !isNonNegativeInteger(state.lifetimeUsage.output) || !isNonNegativeInteger(state.lifetimeUsage.cacheWrite) ||
    !isNonNegativeNumber(state.lifetimeCost) || !isNonNegativeInteger(state.compactionCount)
  ) return undefined;

  return {
    version: 1,
    id: value.id,
    generation: value.generation,
    revision: value.revision,
    parentSessionId: value.parentSessionId,
    sessionFile: value.sessionFile,
    sessionDir: value.sessionDir,
    childSessionId: value.childSessionId,
    entryCount: value.entryCount,
    activeLeafId: value.activeLeafId,
    sessionSha256: value.sessionSha256 as string,
    type: value.type,
    description: value.description,
    cwd: value.cwd,
    isBackground: value.isBackground,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    runtime: {
      piVersion: runtime.piVersion,
      model: { provider: runtime.model.provider, id: runtime.model.id, api: runtime.model.api },
      thinkingLevel: runtime.thinkingLevel as ResumeTargetV1["runtime"]["thinkingLevel"],
      promptMode: runtime.promptMode as ResumeTargetV1["runtime"]["promptMode"],
      isolated: runtime.isolated,
      inheritContext: runtime.inheritContext,
      systemPromptHash: runtime.systemPromptHash as string,
      resourcePolicyHash: runtime.resourcePolicyHash as string,
      agentConfigHash: runtime.agentConfigHash as string,
      extensionIdentities: extensionIdentities.map((item) => ({ name: item.name as string, contentHash: item.contentHash as string })),
      activeToolNames: [...new Set(activeToolNames as string[])].sort(),
    },
    state: {
      status: state.status as ResumeTargetV1["state"]["status"],
      resultConsumed: state.resultConsumed,
      notified: state.notified,
      toolUses: state.toolUses,
      lifetimeUsage: {
        input: state.lifetimeUsage.input,
        output: state.lifetimeUsage.output,
        cacheWrite: state.lifetimeUsage.cacheWrite,
      },
      lifetimeCost: state.lifetimeCost,
      compactionCount: state.compactionCount,
    },
  };
}

function compareResumeTargetVersion(left: ResumeTargetV1, right: ResumeTargetV1): number {
  return left.generation - right.generation || left.revision - right.revision;
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
  private readonly resumeTargets = new Map<string, ResumeTargetV1>();
  private readonly resumeTargetWrites = new Map<string, Promise<void>>();

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

  /** Persist one validated target unless its generation/revision is stale. */
  recordResumeTarget(target: ResumeTargetV1): Promise<boolean> {
    return this.serializeResumeTargetWrite(target.id, () => {
      const normalized = parseResumeTarget(target);
      if (!normalized) throw new TypeError("Invalid resume target v1");
      const current = this.resumeTargets.get(normalized.id);
      if (current && compareResumeTargetVersion(normalized, current) <= 0) return false;
      this.persistResumeTarget(normalized);
      return true;
    });
  }

  /** Guarded patch: applies only to the expected current generation/revision. */
  updateResumeTarget(
    id: string,
    expected: Pick<ResumeTargetV1, "generation" | "revision">,
    patch: ResumeTargetPatch,
  ): Promise<ResumeTargetV1 | undefined> {
    return this.serializeResumeTargetWrite(id, () => {
      const current = this.resumeTargets.get(id);
      if (!current || current.generation !== expected.generation || current.revision !== expected.revision) return undefined;
      const normalized = parseResumeTarget({ ...current, ...patch, id, version: 1, revision: current.revision + 1 });
      if (!normalized) throw new TypeError("Invalid resume target v1 patch");
      this.persistResumeTarget(normalized);
      return this.cloneResumeTarget(normalized);
    });
  }

  getResumeTarget(id: string): ResumeTargetV1 | undefined {
    const target = this.resumeTargets.get(id);
    return target ? this.cloneResumeTarget(target) : undefined;
  }

  listResumeTargets(): ResumeTargetV1[] {
    return [...this.resumeTargets.values()].map((target) => this.cloneResumeTarget(target));
  }

  private persistResumeTarget(target: ResumeTargetV1): void {
    try {
      this.pi.appendEntry(RESUME_TARGET_ENTRY_TYPE, target);
    } catch (err) {
      pandaWarn("subagent.recovery.persist-failed", {
        kind: "resume-target",
        id: target.id,
        error: errorMessage(err),
      });
      throw err;
    }
    this.resumeTargets.set(target.id, target);
  }

  private serializeResumeTargetWrite<T>(id: string, write: () => T): Promise<T> {
    const previous = this.resumeTargetWrites.get(id) ?? Promise.resolve();
    const result = previous.then(write, write);
    const tail = result.then(() => undefined, () => undefined);
    this.resumeTargetWrites.set(id, tail);
    void tail.finally(() => {
      if (this.resumeTargetWrites.get(id) === tail) this.resumeTargetWrites.delete(id);
    });
    return result;
  }

  private cloneResumeTarget(target: ResumeTargetV1): ResumeTargetV1 {
    return {
      ...target,
      runtime: {
        ...target.runtime,
        model: { ...target.runtime.model },
        extensionIdentities: target.runtime.extensionIdentities.map((item) => ({ ...item })),
        activeToolNames: [...target.runtime.activeToolNames],
      },
      state: {
        ...target.state,
        lifetimeUsage: { ...target.state.lifetimeUsage },
      },
    };
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
    this.resumeTargets.clear();
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
      } else if (entry.customType === RESUME_TARGET_ENTRY_TYPE) {
        const version = isRecord(entry.data) ? entry.data.version : undefined;
        const target = parseResumeTarget(entry.data);
        if (!target) {
          pandaWarn("subagent.resume-target.invalid-row", {
            reason: version === undefined ? "malformed" : version === 1 ? "malformed" : "version-mismatch",
          });
          continue;
        }
        const current = this.resumeTargets.get(target.id);
        if (!current || compareResumeTargetVersion(target, current) >= 0) {
          this.resumeTargets.set(target.id, target);
        }
        count++;
      }
    }
    pandaWarn("subagent.recovery.replayed", { count });
    return count;
  }
}
