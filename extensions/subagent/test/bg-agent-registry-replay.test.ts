import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ResumeTargetV1 } from "../src/types.js";
import {
  BG_AGENT_REGISTRY_ENTRY_TYPE,
  type BgAgentRegistryEntry,
  PersistentBgAgentRegistry,
  RESUME_TARGET_ENTRY_TYPE,
  TASK_CLAIM_ENTRY_TYPE,
} from "../src/lifecycle/registry-persistence.js";
import type { AgentLifecycleSnapshotInput } from "../src/lifecycle/agent-lifecycle-store.js";

/** A minimal session JSONL log that records appended CustomEntry rows. */
function createSessionLog() {
  const entries: Array<{ type: "custom"; customType: string; data?: unknown }> = [];
  const pi = {
    appendEntry: vi.fn((customType: string, data?: unknown) => {
      entries.push({ type: "custom", customType, data });
    }),
  };
  return { entries, pi };
}

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function resumeTarget(
  id: string,
  generation: number,
  revision: number,
  overrides: Partial<ResumeTargetV1> = {},
): ResumeTargetV1 {
  return {
    version: 1,
    id,
    generation,
    revision,
    parentSessionId: "parent-1",
    sessionFile: `/sessions/${id}.jsonl`,
    sessionDir: "/sessions",
    childSessionId: `child-${id}`,
    entryCount: 12,
    activeLeafId: "leaf-1",
    sessionSha256: HASH_A,
    type: "jintong",
    description: "Fix exact resume schema",
    cwd: "/repo",
    isBackground: true,
    createdAt: 100,
    updatedAt: 200,
    runtime: {
      piVersion: "1.2.3",
      model: { provider: "provider", id: "model", api: "messages" },
      thinkingLevel: "off",
      promptMode: "system_instructions",
      isolated: false,
      inheritContext: true,
      systemPromptHash: HASH_B,
      resourcePolicyHash: HASH_A,
      agentConfigHash: HASH_B,
      extensionIdentities: [
        { name: "ext-z", contentHash: HASH_A },
        { name: "ext-a", contentHash: HASH_B },
      ],
      activeToolNames: ["write", "read", "write"],
    },
    state: {
      status: "completed",
      resultConsumed: false,
      notified: true,
      toolUses: 4,
      lifetimeUsage: { input: 10, output: 20, cacheWrite: 30 },
      lifetimeCost: 1.25,
      compactionCount: 2,
    },
    ...overrides,
  };
}

function lifecycleInput(target: ResumeTargetV1): AgentLifecycleSnapshotInput {
  const { version: _version, generation: _generation, revision: _revision, ...input } = target;
  return input;
}

describe("PersistentBgAgentRegistry — boot replay", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("rebuilds the bg-agent registry from 3 persisted entries on boot", () => {
    const log = createSessionLog();

    // ---- First process: write 3 bg-agent registry entries (write-through) ----
    const writer = new PersistentBgAgentRegistry(log.pi);
    const written: BgAgentRegistryEntry[] = [
      { id: "agent-a", parentSessionId: "sess-1", status: "running", claimedTaskIds: ["t1"], lastSeenTs: 1000 },
      { id: "agent-b", parentSessionId: "sess-1", status: "completed", claimedTaskIds: [], lastSeenTs: 2000 },
      { id: "agent-c", parentSessionId: "sess-2", status: "running", claimedTaskIds: ["t2", "t3"], lastSeenTs: 3000 },
    ];
    for (const entry of written) writer.recordAgent(entry);

    expect(log.pi.appendEntry).toHaveBeenCalledTimes(3);
    expect(log.entries.every((e) => e.customType === BG_AGENT_REGISTRY_ENTRY_TYPE)).toBe(true);

    // ---- Simulate boot: a fresh registry replays the durable log ----
    const booted = new PersistentBgAgentRegistry(log.pi);
    const count = booted.replay(log.entries);

    expect(count).toBe(3);
    expect(booted.listAgents()).toHaveLength(3);
    expect(booted.getAgent("agent-a")).toEqual(written[0]);
    expect(booted.getAgent("agent-b")).toEqual(written[1]);
    expect(booted.getAgent("agent-c")).toEqual(written[2]);
  });

  it("emits subagent.recovery.replayed with the replayed count", () => {
    const log = createSessionLog();
    const writer = new PersistentBgAgentRegistry(log.pi);
    writer.recordAgent({ id: "a1", status: "running", claimedTaskIds: [], lastSeenTs: 1 });
    writer.claimTask({ taskId: "t1", sessionId: "sess-1", ts: 5 });
    writer.recordAgent({ id: "a2", status: "completed", claimedTaskIds: [], lastSeenTs: 9 });

    warnSpy.mockClear();
    const booted = new PersistentBgAgentRegistry(log.pi);
    const count = booted.replay(log.entries);

    expect(count).toBe(3);
    const replayedCall = warnSpy.mock.calls.find(
      (call: unknown[]) => typeof call[1] === "string" && call[1].includes("subagent.recovery.replayed"),
    );
    expect(replayedCall).toBeDefined();
    expect(JSON.parse(replayedCall![1] as string)).toMatchObject({
      code: "subagent.recovery.replayed",
      count: 3,
    });

    // Claims rebuilt alongside agents.
    expect(booted.listAgents().map((a) => a.id).sort()).toEqual(["a1", "a2"]);
    expect(booted.getClaim("t1")).toEqual({ taskId: "t1", sessionId: "sess-1", ts: 5 });
  });

  it("applies last-write-wins per id and ignores unrelated/malformed entries", () => {
    const booted = new PersistentBgAgentRegistry(createSessionLog().pi);
    const count = booted.replay([
      { type: "custom", customType: BG_AGENT_REGISTRY_ENTRY_TYPE, data: { id: "a1", status: "running", claimedTaskIds: [], lastSeenTs: 1 } },
      { type: "custom", customType: BG_AGENT_REGISTRY_ENTRY_TYPE, data: { id: "a1", status: "completed", claimedTaskIds: ["t9"], lastSeenTs: 7 } },
      { type: "custom", customType: "subagents:record", data: { id: "ignored" } },
      { type: "custom", customType: BG_AGENT_REGISTRY_ENTRY_TYPE, data: { status: "no-id" } },
      { type: "custom", customType: TASK_CLAIM_ENTRY_TYPE, data: { taskId: "t1", ts: 3 } },
      { type: "custom", customType: TASK_CLAIM_ENTRY_TYPE, data: { ts: 3 } },
    ]);

    // a1 (twice, last wins) + t1 claim = 3 consumed rows.
    expect(count).toBe(3);
    expect(booted.listAgents()).toHaveLength(1);
    expect(booted.getAgent("a1")).toEqual({ id: "a1", status: "completed", claimedTaskIds: ["t9"], lastSeenTs: 7 });
    expect(booted.listClaims()).toHaveLength(1);
    expect(booted.getClaim("t1")).toEqual({ taskId: "t1", sessionId: undefined, ts: 3 });
  });

  it("rebuilds idempotently: a second replay reflects only the latest log", () => {
    const log = createSessionLog();
    const registry = new PersistentBgAgentRegistry(log.pi);
    registry.recordAgent({ id: "a1", status: "running", claimedTaskIds: [], lastSeenTs: 1 });

    expect(registry.replay(log.entries)).toBe(1);
    // Replaying an empty (fresh-session) log clears the cache.
    expect(registry.replay([])).toBe(0);
    expect(registry.listAgents()).toHaveLength(0);
  });

  it("replays resume targets by highest generation/revision and uses physical order only for exact ties", () => {
    const registry = new PersistentBgAgentRegistry(createSessionLog().pi);
    const entries = [
      resumeTarget("agent-a", 1, 8, { sessionFile: "/old-high-revision" }),
      resumeTarget("agent-a", 2, 0, { sessionFile: "/new-generation" }),
      resumeTarget("agent-a", 1, 99, { sessionFile: "/stale-generation" }),
      resumeTarget("agent-a", 2, 0, { sessionFile: "/exact-tie-later" }),
    ].map((data) => ({ type: "custom" as const, customType: RESUME_TARGET_ENTRY_TYPE, data }));

    expect(registry.replay(entries)).toBe(4);
    expect(registry.getResumeTarget("agent-a")?.sessionFile).toBe("/exact-tie-later");
    expect(registry.getResumeTarget("agent-a")?.runtime).toMatchObject({
      extensionIdentities: [
        { name: "ext-z", contentHash: HASH_A },
        { name: "ext-a", contentHash: HASH_B },
      ],
      activeToolNames: ["read", "write"],
    });
    expect(registry.getResumeTarget("agent-a")).toMatchObject({
      childSessionId: "child-agent-a",
      entryCount: 12,
      activeLeafId: "leaf-1",
      sessionSha256: HASH_A,
      description: "Fix exact resume schema",
      createdAt: 100,
      updatedAt: 200,
      state: { lifetimeUsage: { input: 10, output: 20, cacheWrite: 30 }, lifetimeCost: 1.25, compactionCount: 2 },
    });
  });

  it("warns and excludes malformed, uppercase-hash, and version-mismatched rows", () => {
    const registry = new PersistentBgAgentRegistry(createSessionLog().pi);
    const badHash = resumeTarget("bad-hash", 1, 0, { sessionSha256: "A".repeat(64) });
    const badExtensionHash = resumeTarget("bad-extension-hash", 1, 0);
    badExtensionHash.runtime.extensionIdentities[0].contentHash = "A".repeat(64);
    const missingField = { ...resumeTarget("missing", 1, 0) } as Partial<ResumeTargetV1>;
    delete missingField.sessionDir;
    const wrongVersion = { ...resumeTarget("wrong-version", 1, 0), version: 2 };

    expect(registry.replay([
      { type: "custom", customType: RESUME_TARGET_ENTRY_TYPE, data: badHash },
      { type: "custom", customType: RESUME_TARGET_ENTRY_TYPE, data: badExtensionHash },
      { type: "custom", customType: RESUME_TARGET_ENTRY_TYPE, data: missingField },
      { type: "custom", customType: RESUME_TARGET_ENTRY_TYPE, data: wrongVersion },
      { type: "custom", customType: RESUME_TARGET_ENTRY_TYPE, data: { version: 1, id: "partial" } },
    ])).toBe(0);
    expect(registry.listResumeTargets()).toEqual([]);
    expect(warnSpy.mock.calls.filter((call: unknown[]) => String(call[1]).includes("subagent.resume-target.invalid-row"))).toHaveLength(5);
  });

  it("keeps foreground and background targets independent", () => {
    const registry = new PersistentBgAgentRegistry(createSessionLog().pi);
    registry.replay([
      { type: "custom", customType: RESUME_TARGET_ENTRY_TYPE, data: resumeTarget("foreground", 1, 0, { isBackground: false }) },
      { type: "custom", customType: RESUME_TARGET_ENTRY_TYPE, data: resumeTarget("background", 1, 0) },
    ]);

    expect(registry.getResumeTarget("foreground")?.isBackground).toBe(false);
    expect(registry.getResumeTarget("background")?.isBackground).toBe(true);
  });

  it("continues exact replayed V1 rows through store-owned revisions", async () => {
    const log = createSessionLog();
    const registry = new PersistentBgAgentRegistry(log.pi);
    const legacy = resumeTarget("agent-a", 2, 7, {
      state: { ...resumeTarget("agent-a", 2, 7).state, status: "completed", resultConsumed: false, notified: false },
    });
    expect(registry.replay([{ type: "custom", customType: RESUME_TARGET_ENTRY_TYPE, data: legacy }])).toBe(1);
    const store = registry.getLifecycleStore("agent-a")!;

    const begun = await store.beginResume(lifecycleInput(resumeTarget("agent-a", 0, 0, {
      updatedAt: 201,
      state: { ...legacy.state, status: "running", resultConsumed: false, notified: false },
    })));
    const terminal = await store.commitTerminal(begun.lease, lifecycleInput(resumeTarget("agent-a", 0, 0, {
      updatedAt: 202,
      state: { ...legacy.state, status: "completed", resultConsumed: false, notified: false },
    })));
    const consumed = await store.markConsumed(begun.lease, 203);
    const notified = await store.markNotified(begun.lease, 204);

    expect(begun.snapshot).toMatchObject({ generation: 3, revision: 0, state: { status: "running" } });
    expect(terminal.revision).toBe(1);
    expect(consumed.revision).toBe(2);
    expect(notified).toMatchObject({ generation: 3, revision: 3, state: { resultConsumed: true, notified: true } });
    const persisted = log.entries.filter((entry) => entry.customType === RESUME_TARGET_ENTRY_TYPE);
    expect(persisted).toHaveLength(4);
    expect(Object.keys(persisted.at(-1)?.data as ResumeTargetV1).sort()).toEqual(Object.keys(legacy).sort());
  });
});
