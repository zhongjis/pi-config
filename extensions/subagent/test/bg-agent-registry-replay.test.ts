import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BG_AGENT_REGISTRY_ENTRY_TYPE,
  type BgAgentRegistryEntry,
  PersistentBgAgentRegistry,
  TASK_CLAIM_ENTRY_TYPE,
} from "../src/lifecycle/registry-persistence.js";

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
      (call) => typeof call[1] === "string" && call[1].includes("subagent.recovery.replayed"),
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
});
