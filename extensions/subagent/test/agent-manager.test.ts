import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { AgentRunTerminalEvent } from "../src/agent-run.js";
import type { AgentLifecycleLease } from "../src/lifecycle/agent-lifecycle-store.js";
import { AgentLifecycleStore, lifecycleSnapshotInput } from "../src/lifecycle/agent-lifecycle-store.js";
import type { AgentRecord, RestoreFailureReason, ResumeTargetV1 } from "../src/types.js";

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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("AgentManager", () => {
  afterEach(() => {
    runAgentMock.mockReset();
    resumeAgentMock.mockReset();
  });

  it("does not keep the process alive with its cleanup timer and still clears it on dispose", async () => {
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    const manager = new AgentManager();
    const timer = (manager as unknown as { cleanupInterval: NodeJS.Timeout }).cleanupInterval;
    const keptProcessAlive = timer.hasRef();

    await manager.dispose();

    expect(keptProcessAlive).toBe(false);
    expect(clearIntervalSpy).toHaveBeenCalledWith(timer);
    clearIntervalSpy.mockRestore();
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
      await manager.dispose();
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
      await manager.dispose();
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
      await manager.dispose();
    }
  });

  it("stops a queued background agent when the outer tool signal aborts", async () => {
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
      await manager.dispose();
    }
  });
  it("publishes one failed terminal event for a resolved runner failure and preserves partial output", async () => {
    const session = { steer: vi.fn(), abort: vi.fn(), dispose: vi.fn() } as any;
    runAgentMock.mockResolvedValue({
      responseText: "PARTIAL OUTPUT",
      session,
      aborted: false,
      steered: false,
      failure: "provider stream failed",
    });
    const manager = new AgentManager();

    try {
      const record = await manager.spawnAndWait(
        {} as any,
        { cwd: process.cwd() } as any,
        "general-purpose",
        "Test prompt",
        { description: "provider failure" },
      );

      expect(record.status).toBe("error");
      expect(record.error).toBe("provider stream failed");
      expect(record.result).toBe("PARTIAL OUTPUT");
      expect(record.run?.events().filter(event => event.kind === "failed")).toHaveLength(1);
      expect(record.run?.events().some(event => event.kind === "completed")).toBe(false);
    } finally {
      await manager.dispose();
    }
  });

  it("keeps hard-abort precedence over a resolved runner failure", async () => {
    const session = { steer: vi.fn(), abort: vi.fn(), dispose: vi.fn() } as any;
    runAgentMock.mockResolvedValue({
      responseText: "PARTIAL OUTPUT",
      session,
      aborted: true,
      steered: true,
      failure: "provider stream failed",
    });
    const manager = new AgentManager();

    try {
      const record = await manager.spawnAndWait(
        {} as any,
        { cwd: process.cwd() } as any,
        "general-purpose",
        "Test prompt",
        { description: "hard abort" },
      );

      expect(record.status).toBe("aborted");
      expect(record.run?.events().filter(event => event.kind === "aborted")).toHaveLength(1);
      expect(record.run?.events().some(event => event.kind === "failed")).toBe(false);
    } finally {
      await manager.dispose();
    }
  });

});

describe("AgentManager.clearCompleted", () => {
  it("retains a completed session until removal, then shuts it down before dispose", async () => {
    const order: string[] = [];
    const emit = vi.fn(async (event: unknown) => {
      order.push("shutdown");
      expect(event).toEqual({ type: "session_shutdown", reason: "quit" });
    });
    const session = {
      steer: vi.fn(),
      abort: vi.fn(),
      extensionRunner: { hasHandlers: vi.fn(() => true), emit },
      dispose: vi.fn(() => order.push("dispose")),
    } as any;
    runAgentMock.mockResolvedValue({ responseText: "done", session, aborted: false, steered: false });

    const manager = new AgentManager();
    try {
      const id = manager.spawn({} as any, { cwd: process.cwd() } as any, "general-purpose", "Test", { description: "bg", isBackground: true });
      const record = manager.getRecord(id)!;
      await record.promise;

      expect(manager.getRecord(id)).toBe(record);
      expect(record.session).toBe(session);
      expect(order).toEqual([]);

      await manager.clearCompleted();

      expect(manager.getRecord(id)).toBeUndefined();
      expect(record.session).toBeUndefined();
      expect(order).toEqual(["shutdown", "dispose"]);
    } finally {
      await manager.dispose();
    }
  });

  it("still disposes a removed session when its shutdown hook rejects", async () => {
    const emit = vi.fn().mockRejectedValue(new Error("shutdown failed"));
    const session = {
      steer: vi.fn(),
      abort: vi.fn(),
      extensionRunner: { hasHandlers: vi.fn(() => true), emit },
      dispose: vi.fn(),
    } as any;
    runAgentMock.mockResolvedValue({ responseText: "done", session, aborted: false, steered: false });

    const manager = new AgentManager();
    try {
      const id = manager.spawn({} as any, { cwd: process.cwd() } as any, "general-purpose", "Test", { description: "bg", isBackground: true });
      await manager.getRecord(id)!.promise;

      await manager.clearCompleted();

      expect(emit).toHaveBeenCalledOnce();
      expect(session.dispose).toHaveBeenCalledOnce();
    } finally {
      await manager.dispose();
    }
  });

  it("does not shut down or dispose a session twice during overlapping teardown", async () => {
    let recordDuringShutdown: any;
    const emit = vi.fn(async () => {
      expect(recordDuringShutdown.session).toBeUndefined();
      await Promise.resolve();
    });
    const session = {
      steer: vi.fn(),
      abort: vi.fn(),
      extensionRunner: { hasHandlers: vi.fn(() => true), emit },
      dispose: vi.fn(),
    } as any;
    runAgentMock.mockResolvedValue({ responseText: "done", session, aborted: false, steered: false });

    const manager = new AgentManager();
    const id = manager.spawn({} as any, { cwd: process.cwd() } as any, "general-purpose", "Test", { description: "bg", isBackground: true });
    recordDuringShutdown = manager.getRecord(id)!;
    await recordDuringShutdown.promise;

    await Promise.all([manager.clearCompleted(), manager.dispose()]);

    expect(emit).toHaveBeenCalledOnce();
    expect(session.dispose).toHaveBeenCalledOnce();
  });

  it("clearCompleted() removes all non-running records", async () => {
    const session = { steer: vi.fn(), abort: vi.fn(), dispose: vi.fn() } as any;
    runAgentMock.mockResolvedValue({ responseText: "", session, aborted: false, steered: false });

    const manager = new AgentManager();
    try {
      const id = manager.spawn({} as any, { cwd: process.cwd() } as any, "general-purpose", "Test", { description: "bg", isBackground: true });
      const record = manager.getRecord(id)!;
      await record.promise;
      expect(record.status).toBe("completed");

      await manager.clearCompleted();
      expect(manager.listAgents()).toHaveLength(0);
    } finally {
      await manager.dispose();
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

      await manager.clearCompleted(true);
      expect(manager.listAgents()).toHaveLength(1);
      expect(manager.getRecord(id)).toBeDefined();
    } finally {
      await manager.dispose();
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

      await manager.clearCompleted(true);
      expect(manager.getRecord(id)).toBeUndefined();
    } finally {
      await manager.dispose();
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
    const snapshot = (record: AgentRecord) => ({
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
        parentSessionId: record.run.parentSessionId, session: record.run.session, events: record.run.events().map((event) => event.kind),
      },
    });
    const beginResume = vi.fn(async (_target: ResumeTargetV1, record: AgentRecord) => { persistedSnapshots.push(snapshot(record)); });
    const commitTerminal = vi.fn(async (record: AgentRecord) => { persistedSnapshots.push(snapshot(record)); });
    try {
      const outcome = await manager.resume(target.id, "continue", {
        parentSessionId: "parent-1", expectedType: "GENERAL-PURPOSE", target, restoreSession, beginResume, commitTerminal,
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
      expect(beginResume).toHaveBeenCalledOnce();
      expect(commitTerminal).toHaveBeenCalledOnce();
      expect(runAgentMock).not.toHaveBeenCalled();
      expect(onStart).not.toHaveBeenCalled();
      expect(onComplete).not.toHaveBeenCalled();
      expect(record.run?.events().map((event) => event.kind)).toEqual(["hydrated", "restore_started", "resumed", "completed"]);
      const restoreEvents = record.run?.events().filter((event) => event.kind !== "completed") ?? [];
      expect(restoreEvents.flatMap((event) => toExternalEffects(event, { isBackground: true }))).toEqual([]);
    } finally { await manager.dispose(); }
  });

  it("orders begin before provider and terminal commit before publication", async () => {
    const order: string[] = [];
    resumeAgentMock.mockImplementation(async () => { order.push("provider"); return "restored answer"; });
    const manager = new AgentManager();
    const target = durableTarget();
    const beginResume = vi.fn(async () => { order.push("begin"); });
    const commitTerminal = vi.fn(async (_record: AgentRecord, candidate: AgentRunTerminalEvent) => {
      order.push(`terminal:${candidate.kind}`);
    });
    try {
      const outcome = await manager.resume(target.id, "continue", {
        parentSessionId: target.parentSessionId,
        expectedType: target.type,
        target,
        restoreSession: vi.fn().mockResolvedValue({ dispose: vi.fn(), subscribe: vi.fn(() => () => {}) }),
        beginResume,
        commitTerminal,
      });

      expect(outcome).toEqual({ status: "restored_session", id: target.id });
      expect(order).toEqual(["begin", "provider", "terminal:completed"]);
      expect(manager.getRecord(target.id)?.run?.events().map((event) => event.kind)).toEqual([
        "hydrated", "restore_started", "resumed", "completed",
      ]);
    } finally { await manager.dispose(); }
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
    } finally { await manager.dispose(); }
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
    } finally { await manager.dispose(); }
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
        beginResume: vi.fn().mockRejectedValue(new Error("write failed")),
      });
      expect(outcome).toMatchObject({ status: "failed", id: target.id, reason: "persistence_failed" });
      expect(resumeAgentMock).not.toHaveBeenCalled();
      expect(runAgentMock).not.toHaveBeenCalled();
    } finally { await manager.dispose(); }
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
    } finally { await manager.dispose(); }
  });

  it("keeps an already-aborted fresh run busy until its stopped settlement clears", async () => {
    const manager = new AgentManager();
    const controller = new AbortController();
    controller.abort();

    try {
      const id = manager.spawn(
        {} as never,
        { cwd: process.cwd() } as never,
        "general-purpose",
        "p",
        { description: "d", signal: controller.signal },
      );

      const request = { parentSessionId: "", expectedType: "general-purpose", restoreSession: vi.fn() };
      await expect(manager.resume(id, "again", request)).resolves.toMatchObject({ status: "failed", reason: "target_busy" });

      await manager.getRecord(id)?.promise;
      await expect(manager.resume(id, "again", request)).resolves.toMatchObject({ status: "failed", reason: "target_unknown" });
      expect(runAgentMock).not.toHaveBeenCalled();
    } finally { await manager.dispose(); }
  });

  it("clears the fresh execution latch after resolve, reject, abort, and teardown", async () => {
    const manager = new AgentManager();
    const request = { parentSessionId: "", expectedType: "general-purpose", restoreSession: vi.fn() };

    try {
      runAgentMock.mockResolvedValueOnce({ responseText: "done", session: { dispose: vi.fn() }, aborted: false, steered: false });
      const resolvedId = manager.spawn({} as never, { cwd: process.cwd() } as never, "general-purpose", "p", { description: "resolve" });
      await manager.getRecord(resolvedId)?.promise;
      resumeAgentMock.mockResolvedValueOnce("again");
      await expect(manager.resume(resolvedId, "again", request)).resolves.toMatchObject({ status: "resumed_live" });

      runAgentMock.mockRejectedValueOnce(new Error("boom"));
      const rejectedId = manager.spawn({} as never, { cwd: process.cwd() } as never, "general-purpose", "p", { description: "reject" });
      await manager.getRecord(rejectedId)?.promise;
      await expect(manager.resume(rejectedId, "again", request)).resolves.toMatchObject({ status: "failed", reason: "target_unknown" });

      const aborted = deferred<{ responseText: string; session: { dispose: () => void }; aborted: boolean; steered: boolean }>();
      runAgentMock.mockReturnValueOnce(aborted.promise);
      const abortId = manager.spawn({} as never, { cwd: process.cwd() } as never, "general-purpose", "p", { description: "abort" });
      manager.abort(abortId);
      await expect(manager.resume(abortId, "again", request)).resolves.toMatchObject({ status: "failed", reason: "target_busy" });
      aborted.resolve({ responseText: "", session: { dispose: vi.fn() }, aborted: false, steered: false });
      await manager.getRecord(abortId)?.promise;
      resumeAgentMock.mockResolvedValueOnce("again");
      await expect(manager.resume(abortId, "again", request)).resolves.toMatchObject({ status: "resumed_live" });

      const tornDown = deferred<{ responseText: string; session: { dispose: () => void }; aborted: boolean; steered: boolean }>();
      runAgentMock.mockReturnValueOnce(tornDown.promise);
      const teardownId = manager.spawn({} as never, { cwd: process.cwd() } as never, "general-purpose", "p", { description: "teardown" });
      await manager.dispose();
      await expect(manager.resume(teardownId, "again", request)).resolves.toMatchObject({ status: "failed", reason: "target_unknown" });
      tornDown.resolve({ responseText: "", session: { dispose: vi.fn() }, aborted: false, steered: false });
    } finally { await manager.dispose(); }
  });
  it("publishes started only after the fresh running baseline succeeds", async () => {
    const baseline = deferred<void>();
    const order: string[] = [];
    const onStart = vi.fn(() => { order.push("started"); });
    runAgentMock.mockImplementation(async (_ctx, _type, _prompt, options) => {
      await options.onBeforePrompt?.();
      order.push("provider");
      return { responseText: "fresh", session: { dispose: vi.fn() }, aborted: false, steered: false };
    });
    const manager = new AgentManager(undefined, undefined, onStart);
    try {
      const id = manager.spawn({} as never, { cwd: process.cwd() } as never, "general-purpose", "p", {
        description: "fresh barrier",
        onBeforePrompt: async (record) => {
          order.push(`baseline:${record.status}`);
          await baseline.promise;
        },
        onBeforeTerminal: async (_record, candidate) => {
          order.push(`terminal:${candidate.kind}`);
        },
      });
      const record = manager.getRecord(id)!;
      await vi.waitFor(() => expect(order).toEqual(["baseline:running"]));
      expect(onStart).not.toHaveBeenCalled();
      expect(runAgentMock).toHaveBeenCalledOnce();
      expect(record.status).toBe("running");
      baseline.resolve();
      await record.promise;
      expect(order).toEqual(["baseline:running", "started", "provider", "terminal:completed"]);
      expect(onStart).toHaveBeenCalledOnce();
      expect(record.status).toBe("completed");
    } finally { await manager.dispose(); }
  });

  it("blocks fresh provider entry and later resume when running baseline append fails", async () => {
    const session = { dispose: vi.fn() };
    let providerCalls = 0;
    runAgentMock.mockImplementation(async (_ctx, _type, _prompt, options) => {
      options.onSessionCreated?.(session);
      await options.onBeforePrompt?.();
      providerCalls++;
      return { responseText: "must not run", session, aborted: false, steered: false };
    });
    const onStart = vi.fn();
    const manager = new AgentManager(undefined, undefined, onStart);
    try {
      const id = manager.spawn({} as never, { cwd: process.cwd() } as never, "general-purpose", "p", {
        description: "fresh begin failure",
        onBeforePrompt: async () => { throw new Error("baseline append failed"); },
        onBeforeTerminal: vi.fn(),
      });
      const record = manager.getRecord(id)!;
      await record.promise;
      expect(providerCalls).toBe(0);
      expect(record).toMatchObject({ status: "error", session: undefined });
      expect(onStart).not.toHaveBeenCalled();
      await expect(manager.resume(id, "again", {
        parentSessionId: "", expectedType: "general-purpose", restoreSession: vi.fn(),
      })).resolves.toMatchObject({ status: "failed", reason: "target_unknown" });
      expect(resumeAgentMock).not.toHaveBeenCalled();
    } finally { await manager.dispose(); }
  });


  it("commits generation+1 running, permits an interleaved checkpoint, then commits terminal next", async () => {
    const target = durableTarget();
    const beginAppend = deferred<void>();
    let appendCount = 0;
    const appendEntry = vi.fn(async () => {
      appendCount++;
      if (appendCount === 1) await beginAppend.promise;
    });
    const store = new AgentLifecycleStore(target.id, { appendEntry } as never, target);
    const provider = deferred<{ ok: true; text: string }>();
    resumeAgentMock.mockReturnValue(provider.promise);
    const manager = new AgentManager();
    const beginResume = vi.fn(async (_target: ResumeTargetV1, record: AgentRecord) => {
      const input = lifecycleSnapshotInput(target);
      const begun = await store.beginResume({
        ...input,
        updatedAt: 3,
        state: { ...input.state, status: "running", resultConsumed: false, notified: false },
      });
      record.lifecycleLease = begun.lease;
    });
    const commitTerminal = vi.fn(async (record: AgentRecord, candidate: AgentRunTerminalEvent) => {
      const current = store.getSnapshot()!;
      await store.commitTerminal(record.lifecycleLease!, {
        ...lifecycleSnapshotInput(current),
        updatedAt: 5,
        state: { ...current.state, status: candidate.kind === "completed" ? candidate.status : "error" },
      });
    });
    try {
      const resumed = manager.resume(target.id, "continue", {
        parentSessionId: target.parentSessionId, expectedType: target.type, target,
        restoreSession: vi.fn().mockResolvedValue({ dispose: vi.fn(), subscribe: vi.fn(() => () => {}) }),
        beginResume, commitTerminal,
      });
      await vi.waitFor(() => expect(appendEntry).toHaveBeenCalledOnce());
      expect(resumeAgentMock).not.toHaveBeenCalled();
      beginAppend.resolve();
      await vi.waitFor(() => expect(resumeAgentMock).toHaveBeenCalledOnce());
      expect(store.getSnapshot()).toMatchObject({ generation: 2, revision: 0, state: { status: "running" } });

      const record = manager.getRecord(target.id)!;
      const running = store.getSnapshot()!;
      await store.checkpoint(record.lifecycleLease!, { ...lifecycleSnapshotInput(running), updatedAt: 4 });
      expect(store.getSnapshot()).toMatchObject({ generation: 2, revision: 1, state: { status: "running" } });

      provider.resolve({ ok: true, text: "done" });
      await expect(resumed).resolves.toEqual({ status: "restored_session", id: target.id });
      expect(store.getSnapshot()).toMatchObject({ generation: 2, revision: 2, state: { status: "completed" } });
      expect(appendEntry).toHaveBeenCalledTimes(3);
    } finally { await manager.dispose(); }
  });


  it.each(["live", "restored"] as const)("blocks %s provider entry when beginResume append fails", async (source) => {
    const manager = new AgentManager();
    const target = durableTarget();
    resumeAgentMock.mockResolvedValue({ ok: true, text: "must not run" });
    try {
      if (source === "live") {
        runAgentMock.mockResolvedValue({ responseText: "old", session: { dispose: vi.fn() }, aborted: false, steered: false });
        const liveId = manager.spawn({} as never, { cwd: process.cwd() } as never, target.type, "first", {
          description: target.description,
          parentSessionId: target.parentSessionId,
        });
        await manager.getRecord(liveId)?.promise;
        target.id = liveId;
      }
      const before = manager.getRecord(target.id);
      const outcome = await manager.resume(target.id, "continue", {
        parentSessionId: target.parentSessionId,
        expectedType: target.type,
        target,
        restoreSession: vi.fn().mockResolvedValue({ dispose: vi.fn(), subscribe: vi.fn(() => () => {}) }),
        beginResume: vi.fn().mockRejectedValue(new Error("begin append failed")),
        commitTerminal: vi.fn(),
      });
      expect(outcome).toMatchObject({ status: "failed", reason: "persistence_failed" });
      expect(resumeAgentMock).not.toHaveBeenCalled();
      if (source === "live") {
        expect(manager.getRecord(target.id)).toBe(before);
        expect(before).toMatchObject({ status: "completed", result: "old" });
      } else {
        expect(manager.getRecord(target.id)).toBeUndefined();
      }
    } finally { await manager.dispose(); }
  });

  it("repairs a failed terminal append before allowing exactly one subsequent prompt", async () => {
    const manager = new AgentManager();
    const target = durableTarget();
    const order: string[] = [];
    let terminalAttempts = 0;
    resumeAgentMock
      .mockImplementationOnce(async () => { order.push("provider:one"); return { ok: true, text: "fresh output" }; })
      .mockImplementationOnce(async () => { order.push("provider:two"); return { ok: true, text: "after repair" }; });
    const beginResume = vi.fn(async () => { order.push("begin"); });
    const authenticatePendingTerminal = vi.fn(async (_record: AgentRecord, candidate: AgentRunTerminalEvent) => {
      order.push(`authenticate:${candidate.kind}`);
    });
    const commitTerminal = vi.fn(async (_record: AgentRecord, candidate: AgentRunTerminalEvent) => {
      terminalAttempts++;
      order.push(`${terminalAttempts === 1 ? "terminal-fail" : terminalAttempts === 2 ? "repair" : "terminal-ok"}:${candidate.kind}`);
      if (terminalAttempts === 1) throw new Error("terminal append failed");
    });
    try {
      const first = await manager.resume(target.id, "continue", {
        parentSessionId: target.parentSessionId, expectedType: target.type, target,
        restoreSession: vi.fn().mockResolvedValue({ dispose: vi.fn(), subscribe: vi.fn(() => () => {}) }),
        beginResume, commitTerminal,
      });
      expect(first).toMatchObject({ status: "failed", reason: "persistence_failed", error: expect.stringContaining("Execution completed but checkpoint did not") });
      const record = manager.getRecord(target.id)!;
      expect(record).toMatchObject({ status: "error", result: "fresh output" });
      expect(record.run?.events().some((event) => event.kind === "completed")).toBe(false);
      await expect(manager.waitForAll()).resolves.toBeUndefined();
      expect(order).toEqual(["begin", "provider:one", "terminal-fail:completed"]);

      const second = await manager.resume(target.id, "again", {
        parentSessionId: target.parentSessionId, expectedType: target.type, target,
        restoreSession: vi.fn(), beginResume, authenticatePendingTerminal, commitTerminal,
      });
      expect(second).toEqual({ status: "resumed_live", id: target.id });
      expect(resumeAgentMock).toHaveBeenCalledTimes(2);
      expect(authenticatePendingTerminal).toHaveBeenCalledOnce();
      expect(order).toEqual([
        "begin", "provider:one", "terminal-fail:completed",
        "authenticate:completed", "repair:completed", "begin", "provider:two", "terminal-ok:completed",
      ]);
      expect(record).toMatchObject({ status: "completed", result: "after repair" });
    } finally { await manager.dispose(); }
  });

  it("rejects pending-terminal repair before commit and provider re-entry when suffix authentication fails", async () => {
    const manager = new AgentManager();
    const target = durableTarget();
    const beginResume = vi.fn();
    const commitTerminal = vi.fn().mockRejectedValueOnce(new Error("terminal append failed"));
    const authenticatePendingTerminal = vi.fn().mockRejectedValue(new Error("tampered suffix"));
    resumeAgentMock.mockResolvedValue({ ok: true, text: "fresh output" });
    try {
      const first = await manager.resume(target.id, "continue", {
        parentSessionId: target.parentSessionId, expectedType: target.type, target,
        restoreSession: vi.fn().mockResolvedValue({ dispose: vi.fn(), subscribe: vi.fn(() => () => {}) }),
        beginResume, commitTerminal,
      });
      expect(first).toMatchObject({ status: "failed", reason: "persistence_failed" });

      const second = await manager.resume(target.id, "again", {
        parentSessionId: target.parentSessionId, expectedType: target.type, target,
        restoreSession: vi.fn(), beginResume, authenticatePendingTerminal, commitTerminal,
      });

      expect(second).toMatchObject({
        status: "failed", reason: "persistence_failed", error: expect.stringContaining("tampered suffix"),
      });
      expect(authenticatePendingTerminal).toHaveBeenCalledOnce();
      expect(commitTerminal).toHaveBeenCalledOnce();
      expect(beginResume).toHaveBeenCalledOnce();
      expect(resumeAgentMock).toHaveBeenCalledOnce();
    } finally { await manager.dispose(); }
  });

  it("forwards only successful child compactions with the lease captured by the session callback", async () => {
    let subscriber: ((event: AgentSessionEvent) => void) | undefined;
    const session = {
      subscribe: vi.fn((listener: (event: AgentSessionEvent) => void) => { subscriber = listener; return () => {}; }),
      dispose: vi.fn(),
    };
    const provider = deferred<{ responseText: string; session: typeof session; aborted: boolean; steered: boolean }>();
    const lease = Object.freeze({ agentId: "agent-a", generation: 0 }) satisfies AgentLifecycleLease;
    const compacted = vi.fn();
    runAgentMock.mockImplementation(async (
      _ctx: unknown,
      _type: unknown,
      _prompt: unknown,
      options: {
        onSessionCreated?: (created: typeof session) => void;
        onBeforePrompt?: () => Promise<void>;
      },
    ) => {
      options.onSessionCreated?.(session);
      await options.onBeforePrompt?.();
      return provider.promise;
    });
    const manager = new AgentManager(undefined, 4, undefined, compacted);
    try {
      const id = manager.spawn({} as never, { cwd: process.cwd() } as never, "general-purpose", "prompt", {
        description: "compaction lease",
        onBeforePrompt: async (record) => { record.lifecycleLease = lease; },
      });
      await vi.waitFor(() => expect(subscriber).toBeDefined());
      const record = manager.getRecord(id)!;

      subscriber?.({
        type: "compaction_end", aborted: true, willRetry: false,
        result: { summary: "", firstKeptEntryId: "leaf-1", tokensBefore: 100 }, reason: "manual",
      });
      subscriber?.({
        type: "compaction_end", reason: "manual", result: undefined, aborted: false, willRetry: false,
      });
      subscriber?.({
        type: "compaction_end", aborted: false, willRetry: false,
        result: { summary: "", firstKeptEntryId: "leaf-2", tokensBefore: 200 }, reason: "threshold",
      });

      expect(compacted).toHaveBeenCalledOnce();
      expect(compacted).toHaveBeenCalledWith(record, {
        reason: "threshold", tokensBefore: 200, lease,
      });
      expect(record.compactionCount).toBe(0);
      provider.resolve({ responseText: "done", session, aborted: false, steered: false });
      await record.promise;
    } finally {
      await manager.dispose();
    }
  });

});
});
