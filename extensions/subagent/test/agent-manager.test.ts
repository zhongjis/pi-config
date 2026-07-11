import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RestoreFailureReason } from "../src/types.js";

const runAgentMock = vi.fn();
const resumeAgentMock = vi.fn();

vi.mock("../src/agent-runner.js", () => ({
  runAgent: (...args: any[]) => runAgentMock(...args),
  resumeAgent: (...args: any[]) => resumeAgentMock(...args),
  getAgentConversation: () => "",
}));

const { AgentManager } = await import("../src/agent-manager.js");
const { toExternalEffects } = await import("../src/agent-run.js");

const RESTORE_FAILURE_MATRIX: Record<RestoreFailureReason, true> = {
  target_unknown: true,
  target_busy: true,
  scope_mismatch: true,
  session_file_missing: true,
  session_corrupt_or_unsupported: true,
  cwd_unavailable: true,
  agent_config_unavailable: true,
  model_unavailable: true,
  tools_extensions_incompatible: true,
  unsafe_interrupted_operation: true,
  persistence_failed: true,
  runtime_initialization_failed: true,
};

function durableTarget(id = "stable-agent") {
  return {
    version: 1 as const, id, generation: 1, revision: 1, parentSessionId: "parent-1",
    sessionFile: "/tmp/stable-session.jsonl", sessionDir: "/tmp", childSessionId: "child-session-12345678",
    entryCount: 2, activeLeafId: "leaf-2", sessionSha256: "a".repeat(64), type: "general-purpose",
    description: "restored agent", cwd: process.cwd(), isBackground: true, createdAt: 1, updatedAt: 2,
    runtime: {
      piVersion: "1", model: { provider: "p", id: "m", api: "a" }, thinkingLevel: "off" as const,
      promptMode: "replace" as const, isolated: false, inheritContext: false, systemPromptHash: "b".repeat(64),
      resourcePolicyHash: "c".repeat(64), agentConfigHash: "d".repeat(64), extensionIdentities: [], activeToolNames: [],
    },
    state: {
      status: "completed" as const, resultConsumed: false, notified: false, toolUses: 3,
      lifetimeUsage: { input: 1, output: 2, cacheWrite: 0 }, lifetimeCost: 0.1, compactionCount: 1,
    },
  };
}

describe("AgentManager", () => {
  afterEach(() => {
    runAgentMock.mockReset();
    resumeAgentMock.mockReset();
  });

  it("stops a foreground agent when the outer tool signal aborts", async () => {
    const session = { steer: vi.fn(), abort: vi.fn(), dispose: vi.fn() } as any;
    runAgentMock.mockImplementation((_ctx: any, _type: any, _prompt: any, options: any) => {
      return new Promise((resolve) => {
        const finish = () => resolve({
          responseText: "",
          session,
          aborted: false,
          steered: false,
        });

        if (options.signal?.aborted) {
          finish();
          return;
        }

        options.signal?.addEventListener("abort", finish, { once: true });
      });
    });

    const manager = new AgentManager();
    const controller = new AbortController();

    try {
      const recordPromise = manager.spawnAndWait(
        {} as any,
        { cwd: process.cwd() } as any,
        "general-purpose",
        "Test prompt",
        {
          description: "test agent",
          signal: controller.signal,
        },
      );

      expect(manager.listAgents()).toHaveLength(1);
      expect(manager.listAgents()[0]?.status).toBe("running");

      controller.abort();

      const record = await recordPromise;
      expect(record.status).toBe("stopped");
      expect(record.completedAt).toBeTypeOf("number");
      expect(runAgentMock).toHaveBeenCalledOnce();
    } finally {
      manager.dispose();
    }
  });

  it("stops immediately when the outer tool signal is already aborted", async () => {
    const session = { steer: vi.fn(), abort: vi.fn(), dispose: vi.fn() } as any;
    runAgentMock.mockImplementation((_ctx: any, _type: any, _prompt: any, options: any) => {
      return new Promise((resolve) => {
        const finish = () => resolve({
          responseText: "",
          session,
          aborted: false,
          steered: false,
        });

        if (options.signal?.aborted) {
          finish();
          return;
        }

        options.signal?.addEventListener("abort", finish, { once: true });
      });
    });

    const manager = new AgentManager();
    const controller = new AbortController();
    controller.abort();

    try {
      const record = await manager.spawnAndWait(
        {} as any,
        { cwd: process.cwd() } as any,
        "general-purpose",
        "Test prompt",
        {
          description: "test agent",
          signal: controller.signal,
        },
      );

      expect(record.status).toBe("stopped");
      expect(record.completedAt).toBeTypeOf("number");
      expect(runAgentMock).not.toHaveBeenCalled();
    } finally {
      manager.dispose();
    }
  });

  it("stops a background agent when the outer tool signal aborts", async () => {
    const session = { steer: vi.fn(), abort: vi.fn(), dispose: vi.fn() } as any;
    runAgentMock.mockImplementation((_ctx: any, _type: any, _prompt: any, options: any) => {
      return new Promise((resolve) => {
        const finish = () => resolve({
          responseText: "",
          session,
          aborted: false,
          steered: false,
        });

        if (options.signal?.aborted) {
          finish();
          return;
        }

        options.signal?.addEventListener("abort", finish, { once: true });
      });
    });

    const manager = new AgentManager();
    const controller = new AbortController();

    try {
      const id = manager.spawn(
        {} as any,
        { cwd: process.cwd() } as any,
        "general-purpose",
        "Test prompt",
        {
          description: "background agent",
          signal: controller.signal,
          isBackground: true,
        },
      );

      const record = manager.getRecord(id)!;
      expect(record.status).toBe("running");

      controller.abort();
      await record.promise;

      expect(record.status).toBe("stopped");
      expect(record.completedAt).toBeTypeOf("number");
      expect(runAgentMock).toHaveBeenCalledOnce();
    } finally {
      manager.dispose();
    }
  });

  it("stops a queued background agent when the outer tool signal aborts", () => {
    const manager = new AgentManager(undefined, 0);
    const controller = new AbortController();

    try {
      const id = manager.spawn(
        {} as any,
        { cwd: process.cwd() } as any,
        "general-purpose",
        "Test prompt",
        {
          description: "queued background agent",
          signal: controller.signal,
          isBackground: true,
        },
      );

      const record = manager.getRecord(id)!;
      expect(record.status).toBe("queued");

      controller.abort();

      expect(record.status).toBe("stopped");
      expect(record.completedAt).toBeTypeOf("number");
      expect(runAgentMock).not.toHaveBeenCalled();
    } finally {
      manager.dispose();
    }
  });
});

describe("AgentManager.clearCompleted", () => {
  it("clearCompleted() removes all non-running records", async () => {
    const session = { steer: vi.fn(), abort: vi.fn(), dispose: vi.fn() } as any;
    runAgentMock.mockResolvedValue({ responseText: "", session, aborted: false, steered: false });

    const manager = new AgentManager();
    try {
      const id = manager.spawn({} as any, { cwd: process.cwd() } as any, "general-purpose", "Test", { description: "bg", isBackground: true });
      const record = manager.getRecord(id)!;
      await record.promise;
      expect(record.status).toBe("completed");

      manager.clearCompleted();
      expect(manager.listAgents()).toHaveLength(0);
    } finally {
      manager.dispose();
    }
  });

  it("clearCompleted(true) preserves records where resultConsumed is not true", async () => {
    const session = { steer: vi.fn(), abort: vi.fn(), dispose: vi.fn() } as any;
    runAgentMock.mockResolvedValue({ responseText: "", session, aborted: false, steered: false });

    const manager = new AgentManager();
    try {
      const id = manager.spawn({} as any, { cwd: process.cwd() } as any, "general-purpose", "Test", { description: "bg", isBackground: true });
      const record = manager.getRecord(id)!;
      await record.promise;
      expect(record.status).toBe("completed");
      // resultConsumed is undefined → unconsumed

      manager.clearCompleted(true);
      expect(manager.listAgents()).toHaveLength(1);
      expect(manager.getRecord(id)).toBeDefined();
    } finally {
      manager.dispose();
    }
  });

  it("clearCompleted(true) removes records where resultConsumed === true", async () => {
    const session = { steer: vi.fn(), abort: vi.fn(), dispose: vi.fn() } as any;
    runAgentMock.mockResolvedValue({ responseText: "", session, aborted: false, steered: false });

    const manager = new AgentManager();
    try {
      const id = manager.spawn({} as any, { cwd: process.cwd() } as any, "general-purpose", "Test", { description: "bg", isBackground: true });
      const record = manager.getRecord(id)!;
      await record.promise;
      expect(record.status).toBe("completed");
      record.resultConsumed = true;

      manager.clearCompleted(true);
      expect(manager.getRecord(id)).toBeUndefined();
    } finally {
      manager.dispose();
    }
  });

describe("AgentManager durable resume", () => {
  beforeEach(() => {
    runAgentMock.mockReset();
    resumeAgentMock.mockReset();
  });
  it("keeps the complete typed restoration failure matrix", () => {
    expect(Object.keys(RESTORE_FAILURE_MATRIX)).toHaveLength(12);
    expect(Object.values(RESTORE_FAILURE_MATRIX).every(Boolean)).toBe(true);
  });
  it("preserves persisted state through durable hydration and resumed continuation without public replay", async () => {
    resumeAgentMock.mockResolvedValue("restored answer");
    const onComplete = vi.fn();
    const onStart = vi.fn();
    const manager = new AgentManager(onComplete, undefined, onStart);
    const target = durableTarget();
    target.isBackground = true;
    target.state.resultConsumed = true;
    target.state.notified = true;
    target.state.toolUses = 7;
    target.state.lifetimeUsage = { input: 11, output: 13, cacheWrite: 17 };
    target.state.lifetimeCost = 1.25;
    target.state.compactionCount = 4;
    const session = { dispose: vi.fn(), subscribe: vi.fn(() => () => {}) } as any;
    const restoreSession = vi.fn().mockResolvedValue(session);
    const persistedSnapshots: any[] = [];
    const persist = vi.fn(async (_target, record) => {
      persistedSnapshots.push({
        record: {
          status: record.status, isBackground: record.isBackground, resultConsumed: record.resultConsumed, notified: record.notified,
          toolUses: record.toolUses, lifetimeUsage: { ...record.lifetimeUsage }, lifetimeCost: record.lifetimeCost,
          compactionCount: record.compactionCount, sessionFile: record.sessionFile, sessionDir: record.sessionDir,
          type: record.type, description: record.description, parentSessionId: record.parentSessionId,
        },
        run: record.run && {
          status: record.run.status, isBackground: record.run.isBackground, resultConsumed: record.run.resultConsumed,
          notified: record.run.notified, toolUses: record.run.activity.toolUses, lifetimeUsage: { ...record.run.lifetimeUsage },
          lifetimeCost: record.run.lifetimeCost, compactionCount: record.run.compactionCount, sessionFile: record.run.sessionFile,
          sessionDir: record.run.sessionDir, type: record.run.type, description: record.run.description,
          parentSessionId: record.run.parentSessionId, session: record.run.session, events: record.run.events().map((event: any) => event.kind),
        },
      });
    });
    try {
      const outcome = await manager.resume(target.id, "continue", {
        parentSessionId: "parent-1", expectedType: "GENERAL-PURPOSE", target, restoreSession, persist,
      });
      expect(outcome).toEqual({ status: "restored_session", id: target.id });
      const record = manager.getRecord(target.id)!;
      const persisted = {
        status: target.state.status, isBackground: true, resultConsumed: true, notified: true, toolUses: 7,
        lifetimeUsage: { input: 11, output: 13, cacheWrite: 17 }, lifetimeCost: 1.25, compactionCount: 4,
        sessionFile: target.sessionFile, sessionDir: target.sessionDir, type: target.type, description: target.description,
        parentSessionId: target.parentSessionId,
      };
      expect(persistedSnapshots[0].record).toEqual(persisted);
      expect(persistedSnapshots[0].run).toMatchObject({ ...persisted, session, events: ["hydrated", "restore_started"] });
      expect(record).toMatchObject({ ...persisted, status: "completed", result: "restored answer", resumeSource: "restored" });
      const { toolUses: _toolUses, ...persistedRun } = persisted;
      expect(record.run).toMatchObject({ ...persistedRun, status: "completed", result: "restored answer", resumeSource: "restored" });
      expect(record.run?.activity.toolUses).toBe(7);
      expect(record.promise).toBeInstanceOf(Promise);
      expect(persist).toHaveBeenCalledTimes(2);
      expect(runAgentMock).not.toHaveBeenCalled();
      expect(onStart).not.toHaveBeenCalled();
      expect(onComplete).not.toHaveBeenCalled();
      expect(record.run?.events().map((event) => event.kind)).toEqual(["hydrated", "restore_started", "resumed", "completed"]);
      const restoreEvents = record.run?.events().filter((event) => event.kind !== "completed") ?? [];
      expect(restoreEvents.flatMap((event) => toExternalEffects(event, { isBackground: true }))).toEqual([]);
    } finally { manager.dispose(); }
  });

  it.each([
    ["unknown target", undefined, "parent-1", "general-purpose", "target_unknown"],
    ["scope mismatch", durableTarget(), "wrong-parent", "general-purpose", "scope_mismatch"],
    ["type mismatch", durableTarget(), "parent-1", "reviewer", "scope_mismatch"],
  ])("rejects %s without restore", async (_name, target, parentSessionId, expectedType, reason) => {
    const manager = new AgentManager();
    const restoreSession = vi.fn();
    try {
      const outcome = await manager.resume("stable-agent", "continue", { parentSessionId, expectedType, target, restoreSession });
      expect(outcome).toMatchObject({ status: "failed", reason });
      expect(restoreSession).not.toHaveBeenCalled();
      expect(runAgentMock).not.toHaveBeenCalled();
    } finally { manager.dispose(); }
  });

  it("maps restore callback failure and leaves no hydrated record", async () => {
    const manager = new AgentManager();
    const target = durableTarget();
    try {
      const outcome = await manager.resume(target.id, "continue", {
        parentSessionId: target.parentSessionId, expectedType: target.type, target,
        restoreSession: vi.fn().mockRejectedValue(new Error("open failed")),
      });
      expect(outcome).toEqual({ status: "failed", id: target.id, reason: "runtime_initialization_failed", error: "open failed" });
      expect(manager.getRecord(target.id)).toBeUndefined();
      expect(resumeAgentMock).not.toHaveBeenCalled();
    } finally { manager.dispose(); }
  });

  it("maps restored-generation write failure to persistence_failed", async () => {
    const manager = new AgentManager();
    const target = durableTarget();
    resumeAgentMock.mockResolvedValue("unused");
    try {
      const outcome = await manager.resume(target.id, "continue", {
        parentSessionId: target.parentSessionId,
        expectedType: target.type,
        target,
        restoreSession: vi.fn().mockResolvedValue({ dispose: vi.fn(), subscribe: vi.fn(() => () => {}) }),
        persist: vi.fn().mockRejectedValue(new Error("write failed")),
      });
      expect(outcome).toMatchObject({ status: "failed", id: target.id, reason: "persistence_failed" });
      expect(resumeAgentMock).not.toHaveBeenCalled();
      expect(runAgentMock).not.toHaveBeenCalled();
    } finally { manager.dispose(); }
  });

  it("single-flights continuation as target_busy", async () => {
    let release!: (value: string) => void;
    resumeAgentMock.mockImplementation(() => new Promise<string>((resolve) => { release = resolve; }));
    runAgentMock.mockResolvedValue({ responseText: "first", session: { dispose: vi.fn() } as any, aborted: false, steered: false });
    const manager = new AgentManager();
    try {
      const id = manager.spawn({} as any, { cwd: process.cwd() } as any, "general-purpose", "p", { description: "d" });
      const record = manager.getRecord(id)!;
      await record.promise;
      const request = { parentSessionId: "", expectedType: "general-purpose", restoreSession: vi.fn() };
      const first = manager.resume(id, "one", request);
      await vi.waitFor(() => expect(resumeAgentMock).toHaveBeenCalledOnce());
      await expect(manager.resume(id, "two", request)).resolves.toMatchObject({ status: "failed", reason: "target_busy" });
      release("done");
      await first;
      expect(resumeAgentMock).toHaveBeenCalledOnce();
    } finally { manager.dispose(); }
  });
});
});
