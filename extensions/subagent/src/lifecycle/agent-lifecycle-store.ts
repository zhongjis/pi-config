import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { pandaWarn } from "../../../lib/warn.js";
import type { ResumeTargetState, ResumeTargetV1 } from "../types.js";

/** Stable public V1 custom-entry key. */
export const RESUME_TARGET_ENTRY_TYPE = "subagents:resume-target-v1";

export type AgentLifecycleSnapshotInput = Omit<ResumeTargetV1, "version" | "generation" | "revision">;

/** Opaque process-local authority for one agent generation. */
export interface AgentLifecycleLease {
  readonly agentId: string;
  readonly generation: number;
}

export interface AgentLifecycleCommit {
  lease: AgentLifecycleLease;
  snapshot: ResumeTargetV1;
}

type AppendCapablePi = Pick<ExtensionAPI, "appendEntry">;
type LeaseData = { agentId: string; generation: number; runtimeToken: symbol };

const leaseData = new WeakMap<AgentLifecycleLease, LeaseData>();
const SHA256_RE = /^[0-9a-f]{64}$/;
const RESUME_STATUSES = new Set<ResumeTargetState["status"]>([
  "queued",
  "running",
  "completed",
  "steered",
  "aborted",
  "stopped",
  "error",
]);
const TERMINAL_STATUSES = new Set<ResumeTargetState["status"]>([
  "completed",
  "steered",
  "aborted",
  "stopped",
  "error",
]);
const PROMPT_MODES = new Set(["replace", "append", "system_instructions"]);

export class AgentLifecycleTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentLifecycleTransitionError";
  }
}

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

/** Parse and normalize an existing V1 row without changing its public schema. */
export function parseResumeTargetV1(value: unknown): ResumeTargetV1 | undefined {
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
    !RESUME_STATUSES.has(String(state.status) as ResumeTargetState["status"]) ||
    typeof state.resultConsumed !== "boolean" || typeof state.notified !== "boolean" ||
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
    sessionSha256: String(value.sessionSha256),
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
      systemPromptHash: String(runtime.systemPromptHash),
      resourcePolicyHash: String(runtime.resourcePolicyHash),
      agentConfigHash: String(runtime.agentConfigHash),
      extensionIdentities: extensionIdentities.map((item) => ({
        name: String((item as Record<string, unknown>).name),
        contentHash: String((item as Record<string, unknown>).contentHash),
      })),
      activeToolNames: [...new Set(activeToolNames as string[])].sort(),
    },
    state: {
      status: state.status as ResumeTargetState["status"],
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

export function compareResumeTargetVersions(left: ResumeTargetV1, right: ResumeTargetV1): number {
  return left.generation - right.generation || left.revision - right.revision;
}

function cloneSnapshot(target: ResumeTargetV1): ResumeTargetV1 {
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

export function lifecycleSnapshotInput(target: ResumeTargetV1): AgentLifecycleSnapshotInput {
  const { version: _version, generation: _generation, revision: _revision, ...payload } = cloneSnapshot(target);
  return payload;
}

/** Build a normalized V1 view for existing child-session validation without exposing version allocation. */
export function resumeTargetForValidation(input: AgentLifecycleSnapshotInput): ResumeTargetV1 {
  const target = parseResumeTargetV1({ version: 1, generation: 0, revision: 0, ...input });
  if (!target) throw new TypeError("Invalid resume target v1 lifecycle input");
  return target;
}

function equalPayload(left: ResumeTargetV1, right: ResumeTargetV1): boolean {
  return JSON.stringify(lifecycleSnapshotInput(left)) === JSON.stringify(lifecycleSnapshotInput(right));
}

/** Sole durable V1 lifecycle writer for one stable agent ID. */
export class AgentLifecycleStore {
  private current: ResumeTargetV1 | undefined;
  private tail: Promise<void> = Promise.resolve();
  private runtimeToken: symbol | undefined;

  constructor(
    readonly id: string,
    private readonly pi: AppendCapablePi,
    replayedSnapshot?: ResumeTargetV1,
  ) {
    if (!isNonEmptyString(id)) throw new TypeError("Agent lifecycle id must be non-empty");
    if (replayedSnapshot) {
      const normalized = parseResumeTargetV1(replayedSnapshot);
      if (!normalized || normalized.id !== id) throw new TypeError("Invalid replayed resume target v1");
      this.current = normalized;
    }
  }

  initialize(input: AgentLifecycleSnapshotInput): Promise<AgentLifecycleCommit> {
    return this.serialize(async () => {
      if (this.current) throw new AgentLifecycleTransitionError(`Agent lifecycle ${this.id} is already initialized`);
      const snapshot = this.normalize(input, 0, 0);
      await this.append(snapshot);
      this.current = snapshot;
      const lease = this.rotateLease(0);
      return { lease, snapshot: cloneSnapshot(snapshot) };
    });
  }

  beginResume(input: AgentLifecycleSnapshotInput): Promise<AgentLifecycleCommit> {
    return this.serialize(async () => {
      const current = this.requireCurrent();
      if (current.state.status === "running" || current.state.status === "queued") {
        throw new AgentLifecycleTransitionError(`Cannot resume active lifecycle ${this.id}`);
      }
      const generation = current.generation + 1;
      const snapshot = this.normalize({
        ...input,
        createdAt: current.createdAt,
        state: {
          ...input.state,
          status: "running",
          resultConsumed: false,
          notified: false,
        },
      }, generation, 0);
      await this.append(snapshot);
      this.current = snapshot;
      const lease = this.rotateLease(generation);
      return { lease, snapshot: cloneSnapshot(snapshot) };
    });
  }

  checkpoint(
    lease: AgentLifecycleLease,
    input: AgentLifecycleSnapshotInput,
    options: { incrementCompaction?: boolean } = {},
  ): Promise<ResumeTargetV1> {
    return this.serialize(async () => {
      const current = this.requireLease(lease);
      if (current.state.status !== "running") {
        throw new AgentLifecycleTransitionError(`Cannot checkpoint terminal lifecycle ${this.id}`);
      }
      if (input.state.status !== "running" || input.state.resultConsumed !== current.state.resultConsumed || input.state.notified !== current.state.notified) {
        throw new AgentLifecycleTransitionError(`Checkpoint cannot change lifecycle state for ${this.id}`);
      }
      const snapshot = this.normalize({
        ...input,
        createdAt: current.createdAt,
        state: {
          ...input.state,
          toolUses: Math.max(current.state.toolUses, input.state.toolUses),
          lifetimeUsage: {
            input: Math.max(current.state.lifetimeUsage.input, input.state.lifetimeUsage.input),
            output: Math.max(current.state.lifetimeUsage.output, input.state.lifetimeUsage.output),
            cacheWrite: Math.max(current.state.lifetimeUsage.cacheWrite, input.state.lifetimeUsage.cacheWrite),
          },
          lifetimeCost: Math.max(current.state.lifetimeCost, input.state.lifetimeCost),
          compactionCount: options.incrementCompaction
            ? current.state.compactionCount + 1
            : Math.max(current.state.compactionCount, input.state.compactionCount),
        },
      }, current.generation, current.revision + 1);
      await this.append(snapshot);
      this.current = snapshot;
      return cloneSnapshot(snapshot);
    });
  }

  commitTerminal(lease: AgentLifecycleLease, input: AgentLifecycleSnapshotInput): Promise<ResumeTargetV1> {
    return this.serialize(async () => {
      const current = this.requireLease(lease);
      if (!TERMINAL_STATUSES.has(input.state.status)) {
        throw new AgentLifecycleTransitionError(`Terminal command requires terminal status for ${this.id}`);
      }
      const snapshot = this.normalize({ ...input, createdAt: current.createdAt }, current.generation, current.revision + 1);
      if (TERMINAL_STATUSES.has(current.state.status)) {
        if (equalPayload(current, snapshot)) return cloneSnapshot(current);
        throw new AgentLifecycleTransitionError(`Conflicting terminal command for ${this.id}`);
      }
      if (current.state.status !== "running") {
        throw new AgentLifecycleTransitionError(`Cannot commit terminal lifecycle from ${current.state.status}`);
      }
      await this.append(snapshot);
      this.current = snapshot;
      return cloneSnapshot(snapshot);
    });
  }

  markConsumed(lease: AgentLifecycleLease, updatedAt: number): Promise<ResumeTargetV1> {
    return this.markDelivery(lease, "resultConsumed", updatedAt);
  }

  markNotified(lease: AgentLifecycleLease, updatedAt: number): Promise<ResumeTargetV1> {
    return this.markDelivery(lease, "notified", updatedAt);
  }

  isNotificationPending(lease: AgentLifecycleLease): Promise<boolean> {
    return this.serialize(async () => {
      const current = this.requireLease(lease);
      return TERMINAL_STATUSES.has(current.state.status) && !current.state.resultConsumed && !current.state.notified;
    });
  }

  reemitCurrent(): Promise<ResumeTargetV1 | undefined> {
    return this.serialize(async () => {
      if (!this.current) return undefined;
      await this.append(this.current);
      return cloneSnapshot(this.current);
    });
  }

  getSnapshot(): ResumeTargetV1 | undefined {
    return this.current ? cloneSnapshot(this.current) : undefined;
  }

  private markDelivery(
    lease: AgentLifecycleLease,
    field: "resultConsumed" | "notified",
    updatedAt: number,
  ): Promise<ResumeTargetV1> {
    return this.serialize(async () => {
      const current = this.requireLease(lease);
      if (!TERMINAL_STATUSES.has(current.state.status)) {
        throw new AgentLifecycleTransitionError(`Cannot mark delivery for active lifecycle ${this.id}`);
      }
      if (current.state[field]) return cloneSnapshot(current);
      const snapshot = this.normalize({
        ...lifecycleSnapshotInput(current),
        updatedAt,
        state: { ...current.state, [field]: true },
      }, current.generation, current.revision + 1);
      await this.append(snapshot);
      this.current = snapshot;
      return cloneSnapshot(snapshot);
    });
  }

  private normalize(input: AgentLifecycleSnapshotInput, generation: number, revision: number): ResumeTargetV1 {
    if (input.id !== this.id) throw new AgentLifecycleTransitionError(`Lifecycle input id does not match ${this.id}`);
    const normalized = parseResumeTargetV1({ version: 1, generation, revision, ...input });
    if (!normalized) throw new TypeError("Invalid resume target v1 lifecycle input");
    return normalized;
  }

  private requireCurrent(): ResumeTargetV1 {
    if (!this.current) throw new AgentLifecycleTransitionError(`Agent lifecycle ${this.id} is not initialized`);
    return this.current;
  }

  private requireLease(lease: AgentLifecycleLease): ResumeTargetV1 {
    const current = this.requireCurrent();
    const data = leaseData.get(lease);
    if (!data || data.agentId !== this.id) throw new AgentLifecycleTransitionError(`Rejected foreign lifecycle lease for ${this.id}`);
    if (data.generation !== current.generation) throw new AgentLifecycleTransitionError(`Rejected stale lifecycle lease for ${this.id}`);
    if (data.runtimeToken !== this.runtimeToken) throw new AgentLifecycleTransitionError(`Rejected foreign lifecycle lease for ${this.id}`);
    return current;
  }

  private rotateLease(generation: number): AgentLifecycleLease {
    const runtimeToken = Symbol(`agent-lifecycle:${this.id}:${generation}`);
    this.runtimeToken = runtimeToken;
    const lease = Object.freeze({ agentId: this.id, generation });
    leaseData.set(lease, { agentId: this.id, generation, runtimeToken });
    return lease;
  }

  private async append(snapshot: ResumeTargetV1): Promise<void> {
    try {
      await this.pi.appendEntry(RESUME_TARGET_ENTRY_TYPE, cloneSnapshot(snapshot));
    } catch (error) {
      pandaWarn("subagent.recovery.persist-failed", {
        kind: "resume-target",
        id: this.id,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}
