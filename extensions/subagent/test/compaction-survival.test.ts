import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ResumeTargetV1 } from "../src/types.js";
import {
  BG_AGENT_REGISTRY_ENTRY_TYPE,
  PersistentBgAgentRegistry,
  RESUME_TARGET_ENTRY_TYPE,
  TASK_CLAIM_ENTRY_TYPE,
} from "../src/lifecycle/registry-persistence.js";

/** A mutable session JSONL log that records appended CustomEntry rows. */
function createSessionLog() {
  const entries: Array<{ type: "custom"; customType: string; data?: unknown }> = [];
  const pi = {
    appendEntry: vi.fn((customType: string, data?: unknown) => {
      entries.push({ type: "custom", customType, data });
    }),
  };
  return { entries, pi };
}

function resumeTarget(): ResumeTargetV1 {
  const hash = "a".repeat(64);
  return {
    version: 1, id: "agent-a", generation: 1, revision: 2, parentSessionId: "sess-1",
    sessionFile: "/sessions/agent-a.jsonl", sessionDir: "/sessions", childSessionId: "child-a",
    entryCount: 4, activeLeafId: "leaf-a", sessionSha256: hash, type: "jintong",
    description: "persist lifecycle", cwd: "/repo", isBackground: true, createdAt: 1, updatedAt: 2,
    runtime: { piVersion: "1", model: { provider: "p", id: "m", api: "a" }, thinkingLevel: "off",
      promptMode: "replace", isolated: false, inheritContext: false, systemPromptHash: hash,
      resourcePolicyHash: hash, agentConfigHash: hash, extensionIdentities: [], activeToolNames: [] },
    state: { status: "completed", resultConsumed: true, notified: true, toolUses: 3,
      lifetimeUsage: { input: 1, output: 2, cacheWrite: 3 }, lifetimeCost: 0.5, compactionCount: 1 },
  };
}

/**
 * Mirrors the `session_before_compact` handler registered in
 * `supervision.ts` (Task 28): writes a single informational marker.
 */
function onBeforeCompact(pi: { appendEntry: (t: string, d?: unknown) => void }, registry: PersistentBgAgentRegistry) {
  pi.appendEntry("subagents:pre-compact-marker", {
    ts: Date.now(),
    registrySize: registry.listAgents().length,
    claimsSize: registry.listClaims().length,
  });
}

/**
 * Mirrors the `session_compact` handler registered in `supervision.ts`
 * (Task 28): re-emits every live registry/claim row as a fresh baseline.
 */
function onCompact(pi: { appendEntry: (t: string, d?: unknown) => void }, registry: PersistentBgAgentRegistry) {
  for (const agent of registry.listAgents()) {
    pi.appendEntry(BG_AGENT_REGISTRY_ENTRY_TYPE, agent);
  }
  for (const claim of registry.listClaims()) {
    pi.appendEntry(TASK_CLAIM_ENTRY_TYPE, claim);
  }
  for (const target of registry.listResumeTargets()) {
    pi.appendEntry(RESUME_TARGET_ENTRY_TYPE, target);
  }
}

describe("Compaction survival hooks (Task 28)", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("survives compaction: post-compact baseline replays to the same state", async () => {
    const log = createSessionLog();
    const registry = new PersistentBgAgentRegistry(log.pi);

    // ---- Pre-compact: populate the durable registry (write-through) ----
    registry.recordAgent({ id: "agent-a", parentSessionId: "sess-1", status: "running", claimedTaskIds: ["t1"], lastSeenTs: 1000 });
    registry.recordAgent({ id: "agent-b", parentSessionId: "sess-1", status: "completed", claimedTaskIds: [], lastSeenTs: 2000 });
    registry.recordAgent({ id: "agent-c", parentSessionId: "sess-2", status: "running", claimedTaskIds: ["t2"], lastSeenTs: 3000 });
    registry.claimTask({ taskId: "t1", sessionId: "sess-1", ts: 1500 });
    registry.claimTask({ taskId: "t2", sessionId: "sess-2", ts: 2500 });
    await registry.recordResumeTarget(resumeTarget());

    const preCompactAgents = registry.listAgents();
    const preCompactClaims = registry.listClaims();
    const preCompactTargets = registry.listResumeTargets();
    expect(preCompactAgents).toHaveLength(3);
    expect(preCompactClaims).toHaveLength(2);
    expect(preCompactTargets).toHaveLength(1);

    // ---- session_before_compact: an informational marker is written ----
    onBeforeCompact(log.pi, registry);
    const marker = log.entries.find((e) => e.customType === "subagents:pre-compact-marker");
    expect(marker).toBeDefined();
    expect(marker!.data).toMatchObject({ registrySize: 3, claimsSize: 2 });

    // ---- Compaction discards old entries: the durable log is wiped ----
    log.entries.length = 0;

    // ---- session_compact: re-emit the live state as a fresh baseline ----
    onCompact(log.pi, registry);

    // Only the re-emitted baseline rows remain in the post-compact log.
    expect(log.entries.filter((e) => e.customType === BG_AGENT_REGISTRY_ENTRY_TYPE)).toHaveLength(3);
    expect(log.entries.filter((e) => e.customType === TASK_CLAIM_ENTRY_TYPE)).toHaveLength(2);
    expect(log.entries.filter((e) => e.customType === RESUME_TARGET_ENTRY_TYPE)).toHaveLength(1);

    // ---- A fresh registry replays ONLY the post-compact entries ----
    const recovered = new PersistentBgAgentRegistry(log.pi);
    const count = recovered.replay(log.entries);

    expect(count).toBe(6);
    expect(recovered.listAgents()).toHaveLength(3);
    expect(recovered.listClaims()).toHaveLength(2);
    expect(recovered.listResumeTargets()).toEqual(preCompactTargets);
    expect([...recovered.listAgents()].sort((a, b) => a.id.localeCompare(b.id))).toEqual(
      [...preCompactAgents].sort((a, b) => a.id.localeCompare(b.id)),
    );
    expect([...recovered.listClaims()].sort((a, b) => a.taskId.localeCompare(b.taskId))).toEqual(
      [...preCompactClaims].sort((a, b) => a.taskId.localeCompare(b.taskId)),
    );
  });

  it("re-emits nothing for an empty registry and the marker reports zero sizes", () => {
    const log = createSessionLog();
    const registry = new PersistentBgAgentRegistry(log.pi);

    onBeforeCompact(log.pi, registry);
    onCompact(log.pi, registry);

    const marker = log.entries.find((e) => e.customType === "subagents:pre-compact-marker");
    expect(marker!.data).toMatchObject({ registrySize: 0, claimsSize: 0 });
    expect(log.entries.filter((e) => e.customType === BG_AGENT_REGISTRY_ENTRY_TYPE)).toHaveLength(0);
    expect(log.entries.filter((e) => e.customType === TASK_CLAIM_ENTRY_TYPE)).toHaveLength(0);
    expect(log.entries.filter((e) => e.customType === RESUME_TARGET_ENTRY_TYPE)).toHaveLength(0);
  });

  it("both hooks complete well under the 100ms latency budget", () => {
    const log = createSessionLog();
    const registry = new PersistentBgAgentRegistry(log.pi);
    for (let i = 0; i < 50; i++) {
      registry.recordAgent({ id: `agent-${i}`, status: "running", claimedTaskIds: [], lastSeenTs: i });
      registry.claimTask({ taskId: `task-${i}`, sessionId: "sess", ts: i });
    }

    const startBefore = Date.now();
    onBeforeCompact(log.pi, registry);
    const beforeLatency = Date.now() - startBefore;

    const startCompact = Date.now();
    onCompact(log.pi, registry);
    const compactLatency = Date.now() - startCompact;

    expect(beforeLatency).toBeLessThan(100);
    expect(compactLatency).toBeLessThan(100);
  });
});
