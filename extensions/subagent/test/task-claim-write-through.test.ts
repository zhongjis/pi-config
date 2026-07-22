import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PersistentBgAgentRegistry } from "../src/lifecycle/registry-persistence.js";

describe("PersistentBgAgentRegistry — write-through-first invariant", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("leaves the claim cache unchanged and surfaces the error when appendEntry fails", () => {
    const appendEntry = vi.fn(() => {
      throw new Error("disk full");
    });
    const registry = new PersistentBgAgentRegistry({ appendEntry });

    // Error must surface to the caller.
    expect(() => registry.claimTask({ taskId: "t1", sessionId: "sess-1", ts: 100 })).toThrow("disk full");

    // appendEntry was attempted exactly once, BEFORE any cache mutation.
    expect(appendEntry).toHaveBeenCalledTimes(1);

    // In-memory cache is untouched — no split-brain claim.
    expect(registry.getClaim("t1")).toBeUndefined();
    expect(registry.listClaims()).toHaveLength(0);

    // A structured persist-failure warning was emitted.
    const failCall = warnSpy.mock.calls.find(
      (call: unknown[]) => typeof call[1] === "string" && call[1].includes("subagent.recovery.persist-failed"),
    );
    expect(failCall).toBeDefined();
    expect(JSON.parse(failCall![1] as string)).toMatchObject({
      code: "subagent.recovery.persist-failed",
      kind: "task-claim",
      taskId: "t1",
      error: "disk full",
    });
  });

  it("leaves the bg-agent cache unchanged and surfaces the error when appendEntry fails", () => {
    const appendEntry = vi.fn(() => {
      throw new Error("io error");
    });
    const registry = new PersistentBgAgentRegistry({ appendEntry });

    expect(() =>
      registry.recordAgent({ id: "agent-x", status: "running", claimedTaskIds: [], lastSeenTs: 1 }),
    ).toThrow("io error");

    expect(appendEntry).toHaveBeenCalledTimes(1);
    expect(registry.getAgent("agent-x")).toBeUndefined();
    expect(registry.listAgents()).toHaveLength(0);

    const failCall = warnSpy.mock.calls.find(
      (call: unknown[]) => typeof call[1] === "string" && call[1].includes("subagent.recovery.persist-failed"),
    );
    expect(JSON.parse(failCall![1] as string)).toMatchObject({
      code: "subagent.recovery.persist-failed",
      kind: "bg-agent-registry",
      id: "agent-x",
    });
  });

  it("commits to the cache only after a successful append", () => {
    const persisted: Array<{ customType: string; data?: unknown }> = [];
    const appendEntry = vi.fn((customType: string, data?: unknown) => {
      persisted.push({ customType, data });
    });
    const registry = new PersistentBgAgentRegistry({ appendEntry });

    registry.claimTask({ taskId: "t1", sessionId: "sess-1", ts: 100 });
    registry.recordAgent({ id: "agent-x", parentSessionId: "sess-1", status: "running", claimedTaskIds: ["t1"], lastSeenTs: 5 });

    // Durable log written before cache observed the values.
    expect(persisted).toHaveLength(2);
    expect(registry.getClaim("t1")).toEqual({ taskId: "t1", sessionId: "sess-1", ts: 100 });
    expect(registry.getAgent("agent-x")).toEqual({
      id: "agent-x",
      parentSessionId: "sess-1",
      status: "running",
      claimedTaskIds: ["t1"],
      lastSeenTs: 5,
    });
  });

  it("does not let an earlier persisted entry leak when a later append fails", () => {
    let calls = 0;
    const appendEntry = vi.fn(() => {
      calls++;
      if (calls === 2) throw new Error("second write fails");
    });
    const registry = new PersistentBgAgentRegistry({ appendEntry });

    registry.claimTask({ taskId: "t1", sessionId: "sess-1", ts: 1 });
    expect(() => registry.claimTask({ taskId: "t2", sessionId: "sess-1", ts: 2 })).toThrow("second write fails");

    // First claim committed; second never reached the cache.
    expect(registry.getClaim("t1")).toBeDefined();
    expect(registry.getClaim("t2")).toBeUndefined();
    expect(registry.listClaims()).toHaveLength(1);
  });

});
