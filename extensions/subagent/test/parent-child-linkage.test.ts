import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pandaWarn } from "../../lib/warn.js";
import { type BgAgentRegistryEntry, PersistentBgAgentRegistry } from "../src/lifecycle/registry-persistence.js";

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

/**
 * Mirror of the parent↔child linkage scan run in supervision.ts `session_start`
 * (the handler is an inline closure, not exported). Kept byte-for-byte equivalent
 * to the production loop so this test locks the warn wire format.
 */
function runLinkageScan(registry: PersistentBgAgentRegistry): void {
  for (const agent of registry.listAgents()) {
    const parentId = registry.getParentSessionId(agent.id);
    if (parentId === null) continue; // orphan: no parent linkage recorded
    if (registry.getAgent(parentId)) {
      pandaWarn("subagent.linkage.parent-resolved", { childId: agent.id, parentId });
    } else {
      pandaWarn("subagent.linkage.parent-missing", { childId: agent.id });
    }
  }
}

/** Extract parsed `[panda-warn]` payloads matching a given code from a console.warn spy. */
function warnsWithCode(spy: ReturnType<typeof vi.spyOn>, code: string): Array<Record<string, unknown>> {
  return spy.mock.calls
    .filter((call) => typeof call[1] === "string" && (call[1] as string).includes(code))
    .map((call) => JSON.parse(call[1] as string) as Record<string, unknown>);
}

describe("PersistentBgAgentRegistry — parent↔child linkage", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  describe("getParentSessionId accessor", () => {
    it("returns the recorded parent session id for a linked child", () => {
      const registry = new PersistentBgAgentRegistry(createSessionLog().pi);
      registry.recordAgent({ id: "child-1", parentSessionId: "sess-parent", status: "running", claimedTaskIds: [], lastSeenTs: 1 });
      expect(registry.getParentSessionId("child-1")).toBe("sess-parent");
    });

    it("returns null for an orphan agent with no parentSessionId", () => {
      const registry = new PersistentBgAgentRegistry(createSessionLog().pi);
      registry.recordAgent({ id: "orphan-1", status: "running", claimedTaskIds: [], lastSeenTs: 1 });
      expect(registry.getParentSessionId("orphan-1")).toBeNull();
    });

    it("returns null for an unknown agent id", () => {
      const registry = new PersistentBgAgentRegistry(createSessionLog().pi);
      expect(registry.getParentSessionId("does-not-exist")).toBeNull();
    });
  });

  describe("session_start linkage scan", () => {
    it("emits parent-resolved when the parent session is present in the registry", () => {
      const log = createSessionLog();
      const registry = new PersistentBgAgentRegistry(log.pi);
      const written: BgAgentRegistryEntry[] = [
        { id: "parent-a", status: "running", claimedTaskIds: [], lastSeenTs: 1000 },
        { id: "child-a", parentSessionId: "parent-a", status: "running", claimedTaskIds: [], lastSeenTs: 2000 },
      ];
      for (const entry of written) registry.recordAgent(entry);

      warnSpy.mockClear();
      runLinkageScan(registry);

      const resolved = warnsWithCode(warnSpy, "subagent.linkage.parent-resolved");
      expect(resolved).toHaveLength(1);
      expect(resolved[0]).toMatchObject({
        code: "subagent.linkage.parent-resolved",
        childId: "child-a",
        parentId: "parent-a",
      });
      expect(warnsWithCode(warnSpy, "subagent.linkage.parent-missing")).toHaveLength(0);
    });

    it("emits parent-missing when parentSessionId is set but the parent is absent from the registry", () => {
      const log = createSessionLog();
      const registry = new PersistentBgAgentRegistry(log.pi);
      registry.recordAgent({ id: "child-b", parentSessionId: "sess-gone", status: "running", claimedTaskIds: [], lastSeenTs: 5 });

      warnSpy.mockClear();
      runLinkageScan(registry);

      const missing = warnsWithCode(warnSpy, "subagent.linkage.parent-missing");
      expect(missing).toHaveLength(1);
      expect(missing[0]).toMatchObject({ code: "subagent.linkage.parent-missing", childId: "child-b" });
      expect(missing[0]).not.toHaveProperty("parentId");
      expect(warnsWithCode(warnSpy, "subagent.linkage.parent-resolved")).toHaveLength(0);
    });

    it("emits no linkage warn for an orphan agent with no parentSessionId", () => {
      const log = createSessionLog();
      const registry = new PersistentBgAgentRegistry(log.pi);
      registry.recordAgent({ id: "orphan-c", status: "completed", claimedTaskIds: [], lastSeenTs: 9 });

      warnSpy.mockClear();
      runLinkageScan(registry);

      expect(warnsWithCode(warnSpy, "subagent.linkage.parent-resolved")).toHaveLength(0);
      expect(warnsWithCode(warnSpy, "subagent.linkage.parent-missing")).toHaveLength(0);
    });

    it("classifies a mixed registry (resolved + missing + orphan) per agent", () => {
      const log = createSessionLog();
      const registry = new PersistentBgAgentRegistry(log.pi);
      const written: BgAgentRegistryEntry[] = [
        { id: "parent-x", status: "running", claimedTaskIds: [], lastSeenTs: 1 },
        { id: "child-resolved", parentSessionId: "parent-x", status: "running", claimedTaskIds: [], lastSeenTs: 2 },
        { id: "child-missing", parentSessionId: "parent-vanished", status: "running", claimedTaskIds: [], lastSeenTs: 3 },
        { id: "orphan", status: "running", claimedTaskIds: [], lastSeenTs: 4 },
      ];
      for (const entry of written) registry.recordAgent(entry);

      warnSpy.mockClear();
      runLinkageScan(registry);

      const resolved = warnsWithCode(warnSpy, "subagent.linkage.parent-resolved");
      const missing = warnsWithCode(warnSpy, "subagent.linkage.parent-missing");
      expect(resolved.map((w) => w.childId)).toEqual(["child-resolved"]);
      expect(missing.map((w) => w.childId)).toEqual(["child-missing"]);
    });
  });
});
