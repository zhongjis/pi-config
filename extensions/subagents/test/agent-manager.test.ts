import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import type { AgentRecord } from "../src/types.js";

vi.mock("../src/agent-runner.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/agent-runner.js")>(),
  runAgent: vi.fn(),
  resumeAgent: vi.fn(),
}));

import { createAgentResultBuilder } from "../src/agent-result.js";
import { resumeAgent, runAgent } from "../src/agent-runner.js";
import { createResultTools } from "../src/result-tools.js";
import { startBackgroundSupervision } from "../src/supervision-loop.js";

const mockPi = {} as any;
const mockCtx = { cwd: "/tmp" } as any;

const mockSession = () => ({ dispose: vi.fn() } as any);

const resolvedRun = () =>
  vi.mocked(runAgent).mockResolvedValue({
    responseText: "done",
    session: mockSession(),
    aborted: false,
    steered: false,
  });

describe("AgentManager — Bug 1 race condition (resultConsumed vs onComplete)", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it("reproduces bug: onComplete fires with resultConsumed=false when set after await", async () => {
    let seenConsumed: boolean | undefined;
    manager = new AgentManager((r) => {
      seenConsumed = r.resultConsumed;
    });
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    const record = manager.getRecord(id)!;

    // Simulate the buggy get_agent_result: await THEN mark consumed
    await record.promise;
    record.resultConsumed = true; // too late — onComplete already fired

    // onComplete saw resultConsumed as falsy (undefined) — would queue a notification (the bug)
    expect(seenConsumed).toBeFalsy();
  });

  it("fix: onComplete sees resultConsumed=true when pre-marked before await", async () => {
    let seenConsumed: boolean | undefined;
    manager = new AgentManager((r) => {
      seenConsumed = r.resultConsumed;
    });
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    const record = manager.getRecord(id)!;

    // The fix: pre-mark BEFORE awaiting
    record.resultConsumed = true;
    await record.promise;

    expect(seenConsumed).toBe(true);
  });

  it("normal case: onComplete fires with resultConsumed falsy when no explicit polling", async () => {
    let completedRecord: AgentRecord | undefined;
    manager = new AgentManager((r) => {
      completedRecord = r;
    });
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;

    expect(completedRecord).toBeDefined();
    expect(completedRecord!.resultConsumed).toBeFalsy();
  });

  it("onComplete IS called for foreground agents (lifecycle symmetry)", async () => {
    let completedRecord: AgentRecord | undefined;
    manager = new AgentManager((r) => {
      completedRecord = r;
    });
    resolvedRun();

    const { record } = await manager.spawnAndWait(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
    });

    expect(completedRecord).toBeDefined();
    expect(completedRecord!.status).toBe("completed");
    // resultConsumed is set by spawnAndWait so onComplete skips notifications
    expect(completedRecord!.resultConsumed).toBe(true);
    expect(record).toBe(completedRecord);
  });
});

describe("AgentManager — execution activity", () => {
  it("resets execution activity and supervision while retaining lifetime counters and session", async () => {
    vi.useFakeTimers();
    const manager = new AgentManager();
    const session = { ...mockSession(), steer: vi.fn().mockResolvedValue(undefined) };
    const observed = vi.fn();
    const onTextDelta = vi.fn();
    let freshProgressAt: number | undefined;
    manager.setActivityListener(observed);
    vi.mocked(runAgent).mockImplementationOnce(async (_ctx, _type, _prompt, options) => {
      options.onSessionCreated?.(session);
      vi.advanceTimersByTime(1);
      options.onProgress?.();
      freshProgressAt = manager.getRecord(options.agentId ?? "")?.activity?.lastProgressAt;
      options.onTextDelta?.("old", "old");
      options.onToolActivity?.({ type: "end", toolName: "read" });
      options.onTurnEnd?.(2);
      options.onAssistantUsage?.({ input: 10, output: 20, cacheWrite: 3, cacheRead: 4, cost: 1 });
      return { responseText: "old", session, aborted: false, steered: false };
    });
    const { record } = await manager.spawnAndWait(mockPi, mockCtx, "general-purpose", "first", { description: "worker", onTextDelta });
    const oldActivity = record.activity;
    const oldExecutionId = record.executionId;
    if (!oldActivity) throw new Error("No fresh activity");
    oldActivity.activeTools.set("stale", "bash");
    record.lastSupervisionSteerAt = Date.now();
    record.lastSupervisionAbortAt = Date.now();
    const lifetimeUsage = record.lifetimeUsage;
    let release: (() => void) | undefined;
    const drain = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(resumeAgent).mockImplementationOnce(async () => { await drain; return { text: "new" }; });
    const pending = manager.resume(record.id, "continue");
    const callbacks = vi.mocked(resumeAgent).mock.lastCall?.[2];
    const activity = record.activity;
    if (!callbacks || !activity || !release) throw new Error("Resume did not start");
    try {
      expect(freshProgressAt).toBe(Date.now());
      expect(activity).not.toBe(oldActivity);
      expect(record.executionId).not.toBe(oldExecutionId);
      expect(record.resultConsumed).toBe(false);
      expect(activity.activeTools.size).toBe(0);
      expect(activity.responseText).toBe("");
      expect(record.lastSupervisionSteerAt).toBeUndefined();
      expect(record.lastSupervisionAbortAt).toBeUndefined();
      expect(activity.session).toBe(session);
      expect(activity.lifetimeUsage).toBe(lifetimeUsage);
      expect(activity.toolUses).toBe(1);
      expect(activity.turnCount).toBe(2);
      expect(onTextDelta).toHaveBeenCalledExactlyOnceWith("old", "old");
      expect(observed).toHaveBeenCalledTimes(2);
      const freshCallbacks = vi.mocked(runAgent).mock.lastCall?.[3];
      vi.advanceTimersByTime(1);
      freshCallbacks?.onProgress?.();
      expect(activity.lastProgressAt).toBe(record.startedAt);
      for (const event of [
        () => callbacks.onProgress?.(),
        () => callbacks.onTextDelta?.("new", "new"),
        () => callbacks.onToolActivity?.({ type: "start", toolName: "bash" }),
        () => callbacks.onToolActivity?.({ type: "start", toolName: "bash" }),
        () => callbacks.onTurnEnd?.(1),
        () => callbacks.onAssistantUsage?.({ input: 1, output: 2, cacheWrite: 0, cacheRead: 0, cost: 0.5 }),
      ]) {
        vi.advanceTimersByTime(1);
        event();
        expect(activity.lastProgressAt).toBe(Date.now());
      }
      expect(activity.responseText).toBe("new");
      expect(activity.activeTools.size).toBe(2);
      callbacks.onToolActivity?.({ type: "end", toolName: "bash" });
      expect(activity.activeTools.size).toBe(1);
      const stop = startBackgroundSupervision(mockPi, { getRunning: () => [{ ...record, isBackground: true }], steer: manager.steer.bind(manager), abort: manager.abort.bind(manager) }, new Map());
      await vi.advanceTimersByTimeAsync(6 * 60_000);
      stop();
      expect(record.status).toBe("running");
      expect(session.steer).not.toHaveBeenCalled();
      callbacks.onToolActivity?.({ type: "end", toolName: "bash" });
      expect(activity.activeTools.size).toBe(0);
      expect(record.toolUses).toBe(3);
      expect(record.turnCount).toBe(3);
      expect(record.lifetimeUsage).toMatchObject({ input: 11, output: 22, cacheWrite: 3, cacheRead: 4 });
      expect(record.lifetimeCost).toBe(1.5);
      expect(manager.getLifetimeCost()).toBe(1.5);
    } finally {
      release();
      await pending;
      await manager.dispose();
      vi.useRealTimers();
    }
  });

  it.each(["usage", "stream"] as const)("does not treat a %s-progressing resume as idle after five minutes", async (progress) => {
    vi.useFakeTimers();
    const manager = new AgentManager();
    const session = { ...mockSession(), steer: vi.fn().mockResolvedValue(undefined) };
    vi.mocked(runAgent).mockResolvedValueOnce({ responseText: "prior", session, aborted: false, steered: false });
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "first", { description: "worker", isBackground: true });
    const record = manager.getRecord(id);
    if (!record) throw new Error("Missing record");
    await record.promise;
    let release: (() => void) | undefined;
    const drain = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(resumeAgent).mockImplementationOnce(async () => { await drain; return { text: "resumed" }; });
    const pending = manager.resume(id, "continue", undefined, undefined, { isBackground: true });
    const callbacks = vi.mocked(resumeAgent).mock.lastCall?.[2];
    if (!callbacks || !release) throw new Error("Resume did not start");
    const stop = startBackgroundSupervision(mockPi, manager, new Map());
    try {
      for (let minute = 0; minute < 7; minute++) {
        if (progress === "stream") callbacks.onProgress?.();
        else callbacks.onAssistantUsage?.({ input: 1, output: 1, cacheWrite: 0, cacheRead: 0, cost: 0 });
        await vi.advanceTimersByTimeAsync(60_000);
      }
      expect(record.status).toBe("running");
      expect(session.steer).not.toHaveBeenCalled();
    } finally {
      stop();
      release();
      await pending;
      await manager.dispose();
      vi.useRealTimers();
    }
  });
});

describe("AgentManager — interruption provenance", () => {
  it.each(["user", "caller", "lifecycle", "supervisor-idle", "supervisor-ceiling", "unknown"] as const)("preserves %s through drain and clears it on resume", async (cause) => {
    const manager = new AgentManager();
    let release: (() => void) | undefined;
    const drain = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(runAgent).mockImplementationOnce(async () => { await drain; return { responseText: "checkpoint", session: mockSession(), aborted: true, interruptionCause: "unknown", steered: false }; });
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "go", { description: "worker", isBackground: true });
    const record = manager.getRecord(id);
    if (!record) throw new Error("Missing record");
    if (cause === "unknown") manager.abort(id);
    else manager.abort(id, cause);
    release?.();
    await record.promise;
    expect(record).toMatchObject({ status: "stopped", interruptionCause: cause, result: "checkpoint" });
    vi.mocked(resumeAgent).mockResolvedValueOnce({ text: "done" });
    await manager.resume(id, "continue");
    expect(record.interruptionCause).toBeUndefined();
    expect(record.status).toBe("completed");
    await manager.dispose();
  });

  it.each(["unknown"] as const)("does not complete a resumed SDK %s interruption", async (cause) => {
    const manager = new AgentManager();
    resolvedRun();
    const { id, record } = await manager.spawnAndWait(mockPi, mockCtx, "general-purpose", "go", { description: "worker" });
    vi.mocked(resumeAgent).mockResolvedValueOnce({ text: "checkpoint", interruptionCause: cause });
    await manager.resume(id, "continue");
    expect(record).toMatchObject({ status: "aborted", interruptionCause: cause, result: "checkpoint" });
    await manager.dispose();
  });
});

describe("AgentManager — background resume admission", () => {
  it.each([false, true])("settles cancellation without starting SDK resume (already aborted: %s)", async (alreadyAborted) => {
    const manager = new AgentManager(undefined, 1);
    resolvedRun();
    const { id, record } = await manager.spawnAndWait(mockPi, mockCtx, "general-purpose", "first", { description: "first" });
    const session = record.session;
    const activity = record.activity;
    let release: (() => void) | undefined;
    const drain = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(runAgent).mockImplementationOnce(async () => { await drain; return { responseText: "busy", session: mockSession(), aborted: false, steered: false }; });
    manager.spawn(mockPi, mockCtx, "general-purpose", "busy", { description: "busy", isBackground: true });
    vi.mocked(resumeAgent).mockClear();
    const controller = new AbortController();
    if (alreadyAborted) controller.abort();
    try {
      await manager.resume(id, "again", controller.signal, mockCtx, { isBackground: true });
      if (!alreadyAborted) controller.abort();
      await record.promise;
      expect(record.status).toBe("stopped");
      expect(record.activity).toBe(activity);
      expect(record.session).toBe(session);
      expect(resumeAgent).not.toHaveBeenCalled();
    } finally { release?.(); await manager.waitForAll(); await manager.dispose(); }
  });

  it("keeps resume capacity and same-session exclusion until physical drain, independent of foreground and graph", async () => {
    const manager = new AgentManager(undefined, 1);
    manager.setMaxConcurrentForeground(1);
    resolvedRun();
    const { id, record } = await manager.spawnAndWait(mockPi, mockCtx, "general-purpose", "first", { description: "first" });
    let releaseForeground: (() => void) | undefined;
    let releaseResume: (() => void) | undefined;
    const foregroundDrain = new Promise<void>(resolve => { releaseForeground = resolve; });
    const resumeDrain = new Promise<void>(resolve => { releaseResume = resolve; });
    vi.mocked(runAgent).mockImplementationOnce(async () => { await foregroundDrain; return { responseText: "foreground", session: mockSession(), aborted: false, steered: false }; });
    const foreground = manager.spawnAndWait(mockPi, mockCtx, "general-purpose", "busy", { description: "busy" });
    vi.mocked(resumeAgent).mockImplementationOnce(async () => { await resumeDrain; return { text: "partial" }; });
    try {
      await manager.resume(id, "again", undefined, mockCtx, { isBackground: true });
      expect(record.status).toBe("running");
      const queued = manager.spawn(mockPi, mockCtx, "general-purpose", "queued", { description: "queued", isBackground: true });
      expect(manager.getRecord(queued)?.status).toBe("queued");
      const graph = manager.spawn(mockPi, mockCtx, "general-purpose", "graph", { description: "graph", graphRunId: "graph", isBackground: true });
      await manager.getRecord(graph)?.promise;
      expect(manager.getRecord(graph)?.status).toBe("completed");
      manager.abort(id);
      expect(manager.getRecord(queued)?.status).toBe("queued");
      await expect(manager.resume(id, "overlap")).rejects.toThrow("already running");
      releaseResume?.();
      await record.promise;
      await manager.getRecord(queued)?.promise;
      expect(manager.getRecord(queued)?.status).toBe("completed");
      vi.mocked(resumeAgent).mockResolvedValueOnce({ text: "inline" });
      await manager.resume(id, "inline");
      expect(record.isBackground).toBe(false);
      expect(record.resultConsumed).toBe(true);
    } finally { releaseForeground?.(); releaseResume?.(); await foreground; await manager.dispose(); }
  });
  it("queues resume behind the background pool without resetting activity before start", async () => {
    const complete = vi.fn();
    const manager = new AgentManager(complete, 1);
    resolvedRun();
    const { id, record } = await manager.spawnAndWait(mockPi, mockCtx, "general-purpose", "first", { description: "first" });
    const prior = { activity: record.activity, startedAt: record.startedAt, executionId: record.executionId };
    record.lastSupervisionSteerAt = 123;
    let release: (() => void) | undefined;
    const drain = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(runAgent).mockImplementationOnce(async () => { await drain; return { responseText: "busy", session: mockSession(), aborted: false, steered: false }; });
    manager.spawn(mockPi, mockCtx, "general-purpose", "busy", { description: "busy", isBackground: true });
    vi.mocked(resumeAgent).mockClear().mockResolvedValueOnce({ text: "resumed" });
    const admission = manager.resume(id, "again", undefined, mockCtx, { isBackground: true });
    try {
      expect(record.status).toBe("queued");
      expect(record.executionId).not.toBe(prior.executionId);
      expect(record.activity).toBe(prior.activity);
      expect(record.startedAt).toBe(prior.startedAt);
      expect(record.lastSupervisionSteerAt).toBe(123);
      expect(resumeAgent).not.toHaveBeenCalled();
    } finally { release?.(); await admission; await manager.waitForAll(); }
    expect(record.activity).not.toBe(prior.activity);
    expect(record.lastSupervisionSteerAt).toBeUndefined();
    expect(record.resultConsumed).toBe(false);
    expect(complete.mock.calls.filter(([value]) => value.id === id)).toHaveLength(2);
    await manager.dispose();
  });
});

describe("AgentManager — execution-correlated retrieval", () => {
  it("waiting retrieval includes partial output after a stopped execution physically drains", async () => {
    const manager = new AgentManager();
    let release: (() => void) | undefined;
    const drain = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(runAgent).mockImplementationOnce(async () => { await drain; return { responseText: "drained checkpoint", session: mockSession(), aborted: false, steered: false }; });
    const controller = new AbortController();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "go", { description: "worker", isBackground: true, signal: controller.signal });
    controller.abort();
    const details = createAgentResultBuilder(() => false);
    const tools = createResultTools(mockPi, manager, { cancelNudge: vi.fn(), details: record => details({ displayName: "worker", description: "worker", subagentType: "general-purpose" }, record) }, { retrieve: vi.fn() });
    let settled = false;
    const result = tools.getAgentResult.execute("get", { run_id: id, wait: true }, undefined, undefined, mockCtx).then(value => { settled = true; return value; });
    try {
      await new Promise(resolve => setImmediate(resolve));
      expect(settled).toBe(false);
    } finally { release?.(); await result; await manager.dispose(); }
    const value = await result;
    expect(value.content).toEqual([{ type: "text", text: expect.stringContaining("drained checkpoint") }]);
    expect(value.details).toMatchObject({ interruptionCause: "caller", status: "stopped" });
  });
  it("does not consume a newer execution when resume wins a completed wait", async () => {
    const manager = new AgentManager();
    let release: (() => void) | undefined;
    const drain = new Promise<void>(resolve => { release = resolve; });
    const session = mockSession();
    vi.mocked(runAgent).mockImplementationOnce(async () => {
      await drain;
      return { responseText: "old", session, aborted: false, steered: false };
    });
    vi.mocked(resumeAgent).mockResolvedValueOnce({ text: "new" });
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "go", { description: "worker", isBackground: true });
    const record = manager.getRecord(id);
    if (!record?.promise || !release) throw new Error("Run did not start");
    const next = record.promise.then(() => manager.resume(id, "again", undefined, undefined, { isBackground: true }));
    const cancelNudge = vi.fn();
    const buildDetails = createAgentResultBuilder(() => false);
    const tools = createResultTools(mockPi, manager, {
      cancelNudge,
      details: value => buildDetails({ displayName: "worker", description: "worker", subagentType: "general-purpose" }, value),
    }, { retrieve: vi.fn() });
    const pending = tools.getAgentResult.execute("get", { run_id: id, wait: true }, undefined, undefined, mockCtx);
    release();
    const result = await pending;
    await next;
    expect(result.content).toEqual([{ type: "text", text: expect.stringContaining("started another execution") }]);
    expect(record.resultConsumed).toBe(false);
    expect(cancelNudge).not.toHaveBeenCalled();
    await tools.getAgentResult.execute("get-new", { run_id: id }, undefined, undefined, mockCtx);
    expect(cancelNudge).toHaveBeenCalledExactlyOnceWith(id, record.executionId);
    await manager.dispose();
  });
});

describe("AgentManager — physical settlement", () => {
  describe.each(["fresh", "error", "resume"])("%s finalization", (kind) => {
    it.each([new Error("transcript flush failed"), "transcript flush failed"])("retains cleanup failure before completion and releases ownership (%s)", async (failure) => {
      const onComplete = vi.fn((record: AgentRecord) => ({ ...record, diagnostics: record.diagnostics?.slice() }));
      const manager = new AgentManager(onComplete, 1);
      resolvedRun();
      let release: (() => void) | undefined;
      const drain = new Promise<void>(resolve => { release = resolve; });
      let id: string;
      if (kind === "resume") {
        ({ id } = await manager.spawnAndWait(mockPi, mockCtx, "general-purpose", "first", { description: "first" }));
        vi.mocked(resumeAgent).mockImplementationOnce(async () => { await drain; return { text: "finished successfully" }; });
        await manager.resume(id, "continue", undefined, mockCtx, { isBackground: true });
      } else {
        vi.mocked(runAgent).mockImplementationOnce(async () => {
          await drain;
          if (kind === "error") throw new Error("provider failed");
          return { responseText: "finished successfully", session: mockSession(), aborted: false, steered: false };
        });
        id = manager.spawn(mockPi, mockCtx, "general-purpose", "first", { description: "first", isBackground: true });
      }
      const record = manager.getRecord(id);
      if (!record) throw new Error("Missing record");
      onComplete.mockClear();
      const cleanup = vi.fn(() => { throw failure; });
      record.outputCleanup = cleanup;
      try {
        const queued = manager.spawn(mockPi, mockCtx, "general-purpose", "next", { description: "next", isBackground: true });
        expect(manager.getRecord(queued)?.status).toBe("queued");
        expect(manager.hasPendingExecution(id)).toBe(true);
        release?.();
        await expect(record.promise).resolves.toBe(kind === "error" ? "" : "finished successfully");
        await manager.getRecord(queued)?.promise;
        expect(record).toMatchObject({ status: kind === "error" ? "error" : "completed" });
        expect(record.result).toBe(kind === "error" ? undefined : "finished successfully");
        expect(record.error).toBe(kind === "error" ? "provider failed" : undefined);
        expect(cleanup).toHaveBeenCalledOnce();
        expect(record.outputCleanup).toBeUndefined();
        expect(manager.hasPendingExecution(id)).toBe(false);
        expect(manager.getRecord(queued)?.status).toBe("completed");
        expect(manager.hasRunning()).toBe(false);
        expect(record.diagnostics).toContain("Output cleanup failed: transcript flush failed");
        expect(onComplete).toHaveBeenCalledWith(record);
        const snapshot = onComplete.mock.results[0]?.value;
        expect(snapshot).toMatchObject({
          status: record.status, outputCleanup: undefined,
          diagnostics: ["Output cleanup failed: transcript flush failed"],
        });
        expect(snapshot?.error).toBe(record.error);
        expect(snapshot?.result).toBe(record.result);
      } finally { release?.(); await manager.waitForAll(); await manager.dispose(); }
    });
  });

  it("finalizes queued cancellation cleanup before notification without releasing an active run", async () => {
    const onComplete = vi.fn((record: AgentRecord) => ({ ...record, diagnostics: record.diagnostics?.slice() }));
    const manager = new AgentManager(onComplete, 1);
    let release: (() => void) | undefined;
    const drain = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(runAgent).mockImplementationOnce(async () => {
      await drain;
      return { responseText: "done", session: mockSession(), aborted: false, steered: false };
    });
    const active = manager.spawn(mockPi, mockCtx, "general-purpose", "first", { description: "first", isBackground: true });
    const queued = manager.spawn(mockPi, mockCtx, "general-purpose", "next", { description: "next", isBackground: true });
    const record = manager.getRecord(queued);
    if (!record) throw new Error("Missing record");
    const cleanup = vi.fn(() => { throw new Error("queued flush failed"); });
    record.outputCleanup = cleanup;
    try {
      expect(record.status).toBe("queued");
      manager.abort(queued, "caller");
      await expect(record.promise).resolves.toBe("");
      expect(cleanup).toHaveBeenCalledOnce();
      expect(record.outputCleanup).toBeUndefined();
      expect(manager.hasPendingExecution(queued)).toBe(false);
      expect(manager.hasPendingExecution(active)).toBe(true);
      expect(onComplete.mock.results[0]?.value).toMatchObject({ status: "stopped", interruptionCause: "caller", diagnostics: ["Output cleanup failed: queued flush failed"], outputCleanup: undefined });
    } finally { release?.(); await manager.waitForAll(); await manager.dispose(); }
  });

  it.each([false, true])("hasRunning retains stopped execution until physical release (resume: %s)", async (resume) => {
    const manager = new AgentManager();
    let release: (() => void) | undefined;
    const drain = new Promise<void>(resolve => { release = resolve; });
    resolvedRun();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "go", { description: "worker", isBackground: true });
    await manager.getRecord(id)?.promise;
    expect(manager.hasRunning()).toBe(false);
    let pendingId = id;
    try {
      if (resume) {
        vi.mocked(resumeAgent).mockImplementationOnce(async () => { await drain; return { text: "checkpoint" }; });
        await manager.resume(id, "continue", undefined, mockCtx, { isBackground: true });
      } else {
        vi.mocked(runAgent).mockImplementationOnce(async () => { await drain; return { responseText: "checkpoint", session: mockSession(), aborted: false, steered: false }; });
        pendingId = manager.spawn(mockPi, mockCtx, "general-purpose", "next", { description: "worker", isBackground: true });
      }
      expect(manager.hasRunning()).toBe(true);
      expect(manager.abort(pendingId)).toBe(true);
      expect(manager.getRecord(pendingId)?.status).toBe("stopped");
      expect(manager.hasRunning()).toBe(true);
      release?.();
      await manager.getRecord(pendingId)?.promise;
      expect(manager.hasRunning()).toBe(false);
    } finally { release?.(); await manager.waitForAll(); await manager.dispose(); }
  });

  it.each(["waitForAll", "dispose"] as const)("%s waits for stopped physical execution before disposal", async (action) => {
    const manager = new AgentManager();
    const session = mockSession();
    let release: (() => void) | undefined;
    const drain = new Promise<void>(resolve => { release = resolve; });
    if (!release) throw new Error("Missing drain resolver");
    vi.mocked(runAgent).mockImplementationOnce(async (_ctx, _type, _prompt, options) => {
      options.onSessionCreated?.(session);
      await drain;
      return { responseText: "partial", session, aborted: false, steered: false };
    });
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "go", { description: "go" });
    manager.abort(id);
    let settled = false;
    const pending = manager[action]().then(() => { settled = true; });
    try {
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(session.dispose).not.toHaveBeenCalled();
    } finally {
      release();
      await pending;
      await manager.dispose();
    }
    expect(session.dispose).toHaveBeenCalledOnce();
  });

  it("retains stopped ownership, waiters and capacity until the runner drains", async () => {
    const manager = new AgentManager();
    manager.setMaxConcurrentForeground(1);
    const session = mockSession();
    let release: (() => void) | undefined;
    const drain = new Promise<void>(resolve => { release = resolve; });
    if (!release) throw new Error("Missing drain resolver");
    vi.mocked(runAgent).mockImplementationOnce(async (_ctx, _type, _prompt, options) => {
      options.onSessionCreated?.(session);
      await drain;
      return { responseText: "PARTIAL", session, aborted: false, steered: false, failure: "prompt failed" };
    }).mockResolvedValue({ responseText: "next", session: mockSession(), aborted: false, steered: false });
    let id = "";
    const first = manager.spawnAndWait(mockPi, mockCtx, "general-purpose", "first", { description: "first" }, value => { id = value; });
    manager.abort(id);
    const second = manager.spawnAndWait(mockPi, mockCtx, "general-purpose", "second", { description: "second" });
    let allSettled = false;
    const all = manager.waitForAll().then(() => { allSettled = true; });
    try {
      manager.clearCompleted();
      expect(manager.getRecord(id)).toBeDefined();
      expect(session.dispose).not.toHaveBeenCalled();
      await expect(manager.resume(id, "overlap")).rejects.toThrow("already running");
      await Promise.resolve();
      expect(allSettled).toBe(false);
      expect(manager.listAgents().filter(record => record.status === "queued")).toHaveLength(1);
    } finally {
      release();
      await Promise.all([first, second, all]);
      await manager.dispose();
    }
    expect((await first).record).toMatchObject({ status: "stopped", result: "PARTIAL", error: "prompt failed" });
  });
});

describe("AgentManager — concurrent foreground calls", () => {
  let manager: AgentManager;

  afterEach(() => manager?.dispose());

  it("starts two spawnAndWait calls before either foreground run resolves", async () => {
    manager = new AgentManager();
    type MockRunResult = {
      responseText: string;
      session: ReturnType<typeof mockSession>;
      aborted: boolean;
      steered: boolean;
    };
    let resolveFirst: ((result: MockRunResult) => void) | undefined;
    let resolveSecond: ((result: MockRunResult) => void) | undefined;
    const started: string[] = [];

    vi.mocked(runAgent).mockImplementation((_ctx, _type, prompt) =>
      new Promise((resolve) => {
        started.push(prompt);
        if (prompt === "first") resolveFirst = resolve;
        else resolveSecond = resolve;
      }),
    );

    // Manager-level proof only: same-assistant-message host dispatch belongs to pi.
    const first = manager.spawnAndWait(mockPi, mockCtx, "general-purpose", "first", { description: "first" });
    const second = manager.spawnAndWait(mockPi, mockCtx, "general-purpose", "second", { description: "second" });
    let firstSettled = false;
    let secondSettled = false;
    void first.then(() => { firstSettled = true; });
    void second.then(() => { secondSettled = true; });

    await Promise.resolve();
    expect(started).toEqual(["first", "second"]);
    expect(firstSettled).toBe(false);
    expect(secondSettled).toBe(false);

    if (!resolveFirst || !resolveSecond) throw new Error("Both foreground runs must start");
    resolveFirst({ responseText: "first done", session: mockSession(), aborted: false, steered: false });
    await first;
    expect(firstSettled).toBe(true);
    expect(secondSettled).toBe(false);

    resolveSecond({ responseText: "second done", session: mockSession(), aborted: false, steered: false });
    await second;
    expect(secondSettled).toBe(true);
  });
});

describe("AgentManager — spawnAndWait onSpawned + foreground output file wiring (#105)", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  it("fields set on the record in onSpawned are visible when onSessionCreated fires", async () => {
    // The load-bearing ordering guarantee: onSpawned fires synchronously inside
    // spawn(), before runAgent's async onSessionCreated fires. index.ts relies on
    // this to set record.outputFile so streamToOutputFile can pick it up.
    manager = new AgentManager();
    let capturedId: string | undefined;
    let outputFileSeenAtSessionCreated: string | undefined;

    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts: any) => {
      const session = mockSession();
      // Yield one microtask to mirror real behavior: in production, onSessionCreated
      // fires async (after network/session setup). onSpawned fires synchronously
      // inside spawn() before runAgent's promise even starts. This await lets the
      // remainder of startAgent (record.promise = …, onSpawned?.()) finish first.
      await Promise.resolve();
      opts.onSessionCreated?.(session);
      outputFileSeenAtSessionCreated = capturedId
        ? manager.getRecord(capturedId)?.outputFile
        : undefined;
      return { responseText: "done", session, aborted: false, steered: false };
    });

    await manager.spawnAndWait(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
    }, (fgId) => {
      capturedId = fgId;
      manager.getRecord(fgId)!.outputFile = "/fake/agent.jsonl";
    });

    expect(outputFileSeenAtSessionCreated).toBe("/fake/agent.jsonl");
  });

  it("onSpawned id matches the id returned by spawnAndWait", async () => {
    manager = new AgentManager();
    let spawnedId: string | undefined;
    resolvedRun();

    const { id } = await manager.spawnAndWait(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
    }, (fgId) => { spawnedId = fgId; });

    expect(spawnedId).toBe(id);
  });

  it("onComplete fires on the error path with resultConsumed=true", async () => {
    // The .then path is covered by the lifecycle-symmetry test above; this guards
    // the .catch path which lacks try/catch around onComplete (a known asymmetry).
    let completedRecord: AgentRecord | undefined;
    manager = new AgentManager((r) => { completedRecord = r; });
    vi.mocked(runAgent).mockRejectedValue(new Error("agent failed"));

    const { record } = await manager.spawnAndWait(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
    });

    expect(completedRecord).toBeDefined();
    expect(completedRecord!.status).toBe("error");
    expect(completedRecord!.resultConsumed).toBe(true);
    expect(record).toBe(completedRecord);
  });
});

describe("AgentManager — completion callbacks", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it("does not let onComplete errors turn a completed agent into a failed run", async () => {
    manager = new AgentManager(() => {
      throw new Error("stale extension context");
    });
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await expect(manager.getRecord(id)!.promise).resolves.toBe("done");

    expect(manager.getRecord(id)!.status).toBe("completed");
  });
});

describe("AgentManager — cleanup timer", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
    vi.useRealTimers();
  });

  it("does not keep the process alive on its own", () => {
    manager = new AgentManager();

    expect((manager as any).cleanupInterval.hasRef()).toBe(false);
  });

  it("retains terminal foreground and background sessions for 15 minutes, then disposes them", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const foregroundSession = mockSession();
    const backgroundSession = mockSession();
    vi.mocked(runAgent)
      .mockResolvedValueOnce({
        responseText: "foreground done",
        session: foregroundSession,
        aborted: false,
        steered: false,
      })
      .mockResolvedValueOnce({
        responseText: "background done",
        session: backgroundSession,
        aborted: false,
        steered: false,
      });
    manager = new AgentManager();

    const foreground = await manager.spawnAndWait(
      mockPi,
      mockCtx,
      "general-purpose",
      "foreground",
      { description: "foreground" },
    );
    const backgroundId = manager.spawn(
      mockPi,
      mockCtx,
      "general-purpose",
      "background",
      { description: "background", isBackground: true },
    );
    await manager.getRecord(backgroundId)!.promise;

    expect(foreground.record.resultConsumed).toBe(true);
    expect(manager.getRecord(backgroundId)!.resultConsumed).toBeFalsy();

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(manager.getRecord(foreground.id)).toBeDefined();
    expect(manager.getRecord(backgroundId)).toBeDefined();

    await vi.advanceTimersByTimeAsync(6 * 60_000);
    expect(manager.getRecord(foreground.id)).toBeUndefined();
    expect(manager.getRecord(backgroundId)).toBeUndefined();
    expect(foregroundSession.dispose).toHaveBeenCalledOnce();
    expect(backgroundSession.dispose).toHaveBeenCalledOnce();
  });
});

describe("AgentManager — Bug 3 clearCompleted", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it("clearCompleted removes completed records", async () => {
    manager = new AgentManager();
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;

    expect(manager.listAgents()).toHaveLength(1);
    manager.clearCompleted();
    expect(manager.listAgents()).toHaveLength(0);
  });

  it("clearCompleted does not remove running or queued agents", async () => {
    // Use maxConcurrent=0 to keep agents queued, then spawn one running via foreground
    manager = new AgentManager(undefined, 1);

    // Mock runAgent to never resolve (keeps agent "running")
    vi.mocked(runAgent).mockImplementation(
      () => new Promise(() => {}), // hangs forever
    );

    const id1 = manager.spawn(mockPi, mockCtx, "general-purpose", "test1", {
      description: "running agent",
      isBackground: true,
    });
    // Second agent should be queued (limit=1)
    const id2 = manager.spawn(mockPi, mockCtx, "general-purpose", "test2", {
      description: "queued agent",
      isBackground: true,
    });

    expect(manager.getRecord(id1)!.status).toBe("running");
    expect(manager.getRecord(id2)!.status).toBe("queued");

    manager.clearCompleted();

    // Both should still be present
    expect(manager.getRecord(id1)).toBeDefined();
    expect(manager.getRecord(id2)).toBeDefined();

    // Abort to allow cleanup
    manager.abort(id1);
    manager.abort(id2);
  });

  it("clearCompleted calls dispose on sessions of removed records", async () => {
    manager = new AgentManager();
    const disposeSpy = vi.fn();
    const sess = { dispose: disposeSpy };
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "done",
      session: sess as any,
      aborted: false,
      steered: false,
    });

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;

    manager.clearCompleted();

    expect(disposeSpy).toHaveBeenCalledOnce();
  });

  it("emits child session_shutdown once and disposes after handlers on manager dispose", async () => {
    manager = new AgentManager();
    const order: string[] = [];
    const emit = vi.fn(async (event: { type: string; reason: string }) => { order.push(`${event.type}:${event.reason}`); });
    const sess = { dispose: vi.fn(() => order.push("dispose")), extensionRunner: { hasHandlers: () => true, emit } };
    vi.mocked(runAgent).mockResolvedValue({ responseText: "done", session: sess as any, aborted: false, steered: false });

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", { description: "test", isBackground: true });
    await manager.getRecord(id)!.promise;
    await manager.dispose();
    manager.clearCompleted();

    expect(emit).toHaveBeenCalledOnce();
    expect(order).toEqual(["session_shutdown:quit", "dispose"]);
  });

  it("clearCompleted removes error and stopped records", async () => {
    manager = new AgentManager();
    vi.mocked(runAgent).mockRejectedValue(new Error("boom"));

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;
    expect(manager.getRecord(id)!.status).toBe("error");

    manager.clearCompleted();
    expect(manager.getRecord(id)).toBeUndefined();
  });

  it("clearCompleted(true) preserves completed records with resultConsumed=false", async () => {
    manager = new AgentManager();
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;
    expect(manager.getRecord(id)!.status).toBe("completed");
    expect(manager.getRecord(id)!.resultConsumed).toBeFalsy();

    manager.clearCompleted(true);
    expect(manager.getRecord(id)).toBeDefined();
  });

  it("clearCompleted(true) removes completed records with resultConsumed=true", async () => {
    manager = new AgentManager();
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    const record = manager.getRecord(id)!;
    await record.promise;
    record.resultConsumed = true;

    manager.clearCompleted(true);
    expect(manager.getRecord(id)).toBeUndefined();
  });

  it("clearCompleted(true) still removes running=false queued=false records when resultConsumed=false for error status", async () => {
    manager = new AgentManager();
    vi.mocked(runAgent).mockRejectedValue(new Error("boom"));

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;
    expect(manager.getRecord(id)!.status).toBe("error");
    expect(manager.getRecord(id)!.resultConsumed).toBeFalsy();

    // Error records with unread results are also preserved — the LLM should
    // be able to read the error message via get_agent_result before the
    // record is evicted.
    manager.clearCompleted(true);
    expect(manager.getRecord(id)).toBeDefined();
  });
});

// Eager init removes the optional/required asymmetry that previously required
// `??=` defaults at the callback sites and `?? 0` / `?? 1` at the read sites.
describe("AgentManager — lifetime usage + compaction count are eagerly initialized", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it("spawn initializes lifetimeUsage to zeros and compactionCount to 0", () => {
    manager = new AgentManager();
    // Don't resolve the run — we just want to inspect the record at spawn time.
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    const record = manager.getRecord(id)!;

    expect(record.lifetimeUsage).toEqual({ input: 0, output: 0, cacheWrite: 0 });
    expect(record.compactionCount).toBe(0);

    manager.abort(id);
  });

  it("onAssistantUsage from runAgent accumulates into record.lifetimeUsage", async () => {
    manager = new AgentManager();

    // Capture the options passed to runAgent so we can drive callbacks
    let captured: any;
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts: any) => {
      captured = opts;
      // Two assistant messages with usage
      opts.onAssistantUsage?.({ input: 100, output: 50, cacheWrite: 10 });
      opts.onAssistantUsage?.({ input: 200, output: 80, cacheWrite: 20 });
      return { responseText: "done", session: mockSession(), aborted: false, steered: false };
    });

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;

    expect(captured).toBeDefined();
    expect(manager.getRecord(id)!.lifetimeUsage).toEqual({
      input: 300, output: 130, cacheWrite: 30,
    });
  });

  it("onCompaction from runAgent increments record.compactionCount", async () => {
    manager = new AgentManager();
    const compactSeen: any[] = [];

    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts: any) => {
      // Compaction fires while the agent is still running — the record passed to
      // onCompact should reflect the just-incremented count.
      opts.onCompaction?.({ reason: "threshold", tokensBefore: 12345 });
      opts.onCompaction?.({ reason: "manual", tokensBefore: 22222 });
      return { responseText: "done", session: mockSession(), aborted: false, steered: false };
    });

    manager = new AgentManager(undefined, undefined, undefined, (record, info) => {
      compactSeen.push({ count: record.compactionCount, reason: info.reason });
    });

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;

    expect(compactSeen).toEqual([
      { count: 1, reason: "threshold" },
      { count: 2, reason: "manual" },
    ]);
    expect(manager.getRecord(id)!.compactionCount).toBe(2);
  });

  it("resume() also accumulates usage and increments compactions on the same record", async () => {
    manager = new AgentManager();

    // First, spawn with a session that resume can latch onto
    const session = { ...mockSession() };
    vi.mocked(runAgent).mockResolvedValue({
      responseText: "first",
      session: session as any,
      aborted: false,
      steered: false,
    });

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;

    // Pre-resume: lifetimeUsage from spawn was zero (mock didn't call onAssistantUsage)
    expect(manager.getRecord(id)!.lifetimeUsage).toEqual({ input: 0, output: 0, cacheWrite: 0 });
    expect(manager.getRecord(id)!.compactionCount).toBe(0);

    // Now resume — drive callbacks via the mocked resumeAgent
    const { resumeAgent: resumeMock } = await import("../src/agent-runner.js");
    manager.getRecord(id)!.turnCount = 4;
    let turnsAfterUsage: number | undefined;
    vi.mocked(resumeMock).mockImplementation(async (_session, _prompt, opts) => {
      opts?.onAssistantUsage?.({ input: 70, output: 30, cacheWrite: 5, cost: 0 });
      turnsAfterUsage = manager.getRecord(id)!.turnCount;
      opts?.onTurnEnd?.(1);
      opts?.onCompaction?.({ reason: "overflow", tokensBefore: 999 });
      return { text: "second" };
    });

    await manager.resume(id, "more");

    expect(turnsAfterUsage).toBe(4);
    expect(manager.getRecord(id)!.turnCount).toBe(5);
    expect(manager.getRecord(id)!.lifetimeUsage).toEqual({ input: 70, output: 30, cacheWrite: 5 });
    expect(manager.getRecord(id)!.compactionCount).toBe(1);
  });
});

describe("AgentManager — SpawnOptions.cwd passthrough (#96)", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  it("passes cwd to runAgent as the working dir, parent cwd as configCwd", async () => {
    resolvedRun();
    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      cwd: "/", // absolute and always exists
    });
    await manager.getRecord(id)!.promise;

    expect(runAgent).toHaveBeenCalledWith(
      mockCtx, "general-purpose", "test",
      expect.objectContaining({ cwd: "/", configCwd: "/tmp" }),
    );
  });

  it("without cwd, configCwd stays unset — existing behavior untouched", async () => {
    // mockClear + lastCall: toHaveBeenCalledWith would scan the file's whole
    // accumulated call history, where earlier no-cwd spawns already match.
    vi.mocked(runAgent).mockClear();
    resolvedRun();
    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
    });
    await manager.getRecord(id)!.promise;

    const opts = vi.mocked(runAgent).mock.lastCall![3];
    expect(opts.cwd).toBeUndefined();
    expect(opts.configCwd).toBeUndefined();
  });

  it("cwd: null (RPC 'unset') behaves exactly like omitting cwd", async () => {
    vi.mocked(runAgent).mockClear();
    resolvedRun();
    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      cwd: null as any,
    });
    await manager.getRecord(id)!.promise;

    const opts = vi.mocked(runAgent).mock.lastCall![3];
    expect(opts.cwd).toBeUndefined();
    expect(opts.configCwd).toBeUndefined();
  });

  it("relative cwd throws immediately; no orphan record", () => {
    vi.mocked(runAgent).mockClear();
    manager = new AgentManager();
    expect(() => manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      cwd: "relative/path",
    })).toThrow(/absolute path/);
    expect(manager.listAgents()).toEqual([]);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("nonexistent cwd throws immediately; no orphan record", () => {
    vi.mocked(runAgent).mockClear();
    manager = new AgentManager();
    expect(() => manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      cwd: "/nonexistent-pi-subagents-test-dir",
    })).toThrow(/does not exist/);
    expect(manager.listAgents()).toEqual([]);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("cwd pointing at a regular file throws a curated 'not a directory' error", () => {
    vi.mocked(runAgent).mockClear();
    manager = new AgentManager();
    expect(() => manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      cwd: fileURLToPath(import.meta.url), // this test file: absolute, exists, not a directory
    })).toThrow(/not a directory/);
    expect(manager.listAgents()).toEqual([]);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("non-string cwd (RPC junk) throws the curated error, not a TypeError from path internals", () => {
    vi.mocked(runAgent).mockClear();
    manager = new AgentManager();
    expect(() => manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      cwd: 123 as any,
    })).toThrow(/must be an absolute path/);
    expect(manager.listAgents()).toEqual([]);
  });
});

describe("AgentManager — abort() state machine", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  it("returns false for an unknown id (no record, no side-effects)", () => {
    manager = new AgentManager();
    expect(manager.abort("does-not-exist")).toBe(false);
  });

  it("removes a queued agent from the queue and marks it stopped", () => {
    // Concurrency=1: the second background spawn queues behind the first
    manager = new AgentManager(undefined, 1);
    resolvedRun();

    manager.spawn(mockPi, mockCtx, "X", "blocker", { description: "block", isBackground: true });
    const queuedId = manager.spawn(mockPi, mockCtx, "Y", "queued", {
      description: "q",
      isBackground: true,
    });
    const queuedRecord = manager.getRecord(queuedId)!;
    expect(queuedRecord.status).toBe("queued");

    expect(manager.abort(queuedId)).toBe(true);
    expect(queuedRecord.status).toBe("stopped");
    expect(queuedRecord.completedAt).toBeGreaterThan(0);
    // Aborting again is a no-op — status is no longer "queued" or "running"
    expect(manager.abort(queuedId)).toBe(false);
  });

  it("aborts a running agent by firing its AbortController and setting status='stopped'", () => {
    manager = new AgentManager();
    let receivedSignal: AbortSignal | undefined;
    vi.mocked(runAgent).mockImplementation((_ctx, _type, _prompt, opts) => {
      receivedSignal = (opts as { signal?: AbortSignal })?.signal;
      return Promise.resolve({ responseText: "done", session: mockSession(), aborted: false, steered: false });
    });

    const id = manager.spawn(mockPi, mockCtx, "X", "p", {
      description: "r",
      isBackground: true,
    });
    const record = manager.getRecord(id)!;
    expect(record.status).toBe("running");
    expect(receivedSignal?.aborted).toBe(false);

    expect(manager.abort(id)).toBe(true);
    expect(record.status).toBe("stopped");
    expect(record.completedAt).toBeGreaterThan(0);
    expect(receivedSignal?.aborted).toBe(true);
  });

  it("returns false (and does not change status) for an already-completed agent", async () => {
    manager = new AgentManager();
    resolvedRun();
    const id = manager.spawn(mockPi, mockCtx, "X", "p", {
      description: "x",
      isBackground: false,
    });
    await manager.getRecord(id)?.promise;
    expect(manager.getRecord(id)?.status).toBe("completed");

    expect(manager.abort(id)).toBe(false);
    expect(manager.getRecord(id)?.status).toBe("completed");
  });

  it("a user abort survives the agent settling — stays 'stopped', never 'completed'", async () => {
    // Guards the `if (record.status !== "stopped")` check in the completion
    // handler: after a user abort, runAgent's promise still settles (here with
    // aborted:false, as a non-cooperative mock would), and must NOT flip the
    // user-stopped status back to "completed" — otherwise the parent agent
    // would read the partial output as a finished result.
    manager = new AgentManager();
    let resolveRun!: (v: unknown) => void;
    vi.mocked(runAgent).mockImplementation(() => new Promise((res) => { resolveRun = res as (v: unknown) => void; }));

    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "r", isBackground: true });
    const record = manager.getRecord(id)!;
    expect(record.status).toBe("running");

    expect(manager.abort(id)).toBe(true);
    expect(record.status).toBe("stopped");

    // The agent loop ends and the promise settles "normally".
    resolveRun({ responseText: "partial output", session: mockSession(), aborted: false, steered: false });
    await record.promise;

    expect(record.status).toBe("stopped");        // not overwritten to "completed"
    expect(record.result).toBe("partial output"); // partial result still captured
  });
});

// Regression for #44: ESC during a foreground Agent call must propagate to
// the child. Pi delivers parent abort via AbortSignal; the manager wires the
// signal's "abort" event to this.abort(id).
describe("AgentManager — steer()", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  it("returns false for an unknown id", () => {
    manager = new AgentManager();
    expect(manager.steer("nope", "hi")).toBe(false);
  });

  it("delivers to a live session via session.steer()", () => {
    manager = new AgentManager();
    const steer = vi.fn(() => Promise.resolve());
    let captured: ((s: any) => void) | undefined;
    vi.mocked(runAgent).mockImplementation((_ctx, _type, _prompt, opts) => {
      captured = (opts as any)?.onSessionCreated;
      return Promise.resolve({ responseText: "done", session: mockSession(), aborted: false, steered: false });
    });
    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "r", isBackground: true });
    // Simulate the session becoming ready.
    captured?.({ steer, dispose: vi.fn() });

    expect(manager.steer(id, "go left")).toBe(true);
    expect(steer).toHaveBeenCalledWith("go left");
  });

  it("queues onto pendingSteers when the session isn't ready yet", () => {
    manager = new AgentManager();
    resolvedRun();
    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "r", isBackground: true });
    const record = manager.getRecord(id)!;
    record.session = undefined; // not ready

    expect(manager.steer(id, "first")).toBe(true);
    expect(manager.steer(id, "second")).toBe(true);
    expect(record.pendingSteers).toEqual(["first", "second"]);
  });

  it("refuses to steer an agent that is no longer running", async () => {
    manager = new AgentManager();
    resolvedRun();
    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "x", isBackground: false });
    await manager.getRecord(id)?.promise;
    expect(manager.getRecord(id)?.status).toBe("completed");
    expect(manager.steer(id, "too late")).toBe(false);
  });
});

describe("AgentManager — parent abort signal forwarding (#44)", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  it("aborts the child when the parent signal aborts", () => {
    manager = new AgentManager();
    resolvedRun();

    const parent = new AbortController();
    const id = manager.spawn(mockPi, mockCtx, "X", "p", {
      description: "x",
      isBackground: false,
      signal: parent.signal,
    });
    const record = manager.getRecord(id)!;
    expect(record.status).toBe("running");

    parent.abort();
    expect(record.status).toBe("stopped");
    expect(record.completedAt).toBeGreaterThan(0);
  });
});

describe("AgentManager — listAgents() ordering", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  it("returns records sorted by startedAt descending (most recent first)", () => {
    manager = new AgentManager();
    resolvedRun();

    const a = manager.spawn(mockPi, mockCtx, "X", "1", { description: "a" });
    const b = manager.spawn(mockPi, mockCtx, "X", "2", { description: "b" });
    const c = manager.spawn(mockPi, mockCtx, "X", "3", { description: "c" });

    // Force deterministic startedAt — Date.now() can collide on fast runs
    manager.getRecord(a)!.startedAt = 100;
    manager.getRecord(b)!.startedAt = 200;
    manager.getRecord(c)!.startedAt = 300;

    expect(manager.listAgents().map((r) => r.id)).toEqual([c, b, a]);
  });
});

describe("AgentManager — abortAll", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  it("stops both queued and running agents and returns the total count", async () => {
    manager = new AgentManager(undefined, 1);
    resolvedRun();

    const running = manager.spawn(mockPi, mockCtx, "X", "r", {
      description: "r",
      isBackground: true,
    });
    const queued = manager.spawn(mockPi, mockCtx, "Y", "q", {
      description: "q",
      isBackground: true,
    });
    expect(manager.getRecord(running)?.status).toBe("running");
    expect(manager.getRecord(queued)?.status).toBe("queued");

    expect(manager.abortAll()).toBe(2);
    expect(manager.getRecord(running)?.status).toBe("stopped");
    expect(manager.getRecord(queued)?.status).toBe("stopped");
    expect(manager.hasPendingExecution(queued)).toBe(false);
    expect(manager.hasPendingExecution(running)).toBe(true);
    expect(manager.hasRunning()).toBe(true);
    await manager.waitForAll();
    expect(manager.hasPendingExecution(running)).toBe(false);
    expect(manager.hasRunning()).toBe(false);
  });

  it("returns 0 when there are no running or queued agents", () => {
    manager = new AgentManager();
    expect(manager.abortAll()).toBe(0);
  });
});

describe("AgentManager — hasRunning", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  it("is true while a background agent is running, false after it completes", async () => {
    manager = new AgentManager();
    resolvedRun();

    expect(manager.hasRunning()).toBe(false);
    const id = manager.spawn(mockPi, mockCtx, "X", "p", {
      description: "x",
      isBackground: true,
    });
    expect(manager.hasRunning()).toBe(true);

    await manager.getRecord(id)?.promise;
    expect(manager.hasRunning()).toBe(false);
  });

  it("is true when an agent is queued behind the concurrency limit", () => {
    manager = new AgentManager(undefined, 1);
    resolvedRun();

    manager.spawn(mockPi, mockCtx, "X", "r", { description: "r", isBackground: true });
    manager.spawn(mockPi, mockCtx, "Y", "q", { description: "q", isBackground: true });
    expect(manager.hasRunning()).toBe(true);
  });
});

describe("AgentManager — runAgent rejection leaves the record visible with error status", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  it("sets status='error', captures the error message, and stamps completedAt", async () => {
    manager = new AgentManager();
    vi.mocked(runAgent).mockRejectedValue(new Error("boom"));

    const id = manager.spawn(mockPi, mockCtx, "X", "p", {
      description: "x",
      isBackground: false,
    });
    const record = manager.getRecord(id)!;
    await record.promise;

    expect(record.status).toBe("error");
    expect(record.error).toBe("boom");
    expect(record.completedAt).toBeGreaterThan(0);
  });
});

// #144 — a run that RESOLVES with a failed final turn (pi never rejects on
// retry exhaustion) must map to status "error", not "completed".
describe("AgentManager — resolved runs with a failed final turn map to error (#144)", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  const failedRun = (failure: string, responseText = "") =>
    vi.mocked(runAgent).mockResolvedValue({
      responseText,
      session: mockSession(),
      aborted: false,
      steered: false,
      failure,
    } as any);

  it("sets status='error' and captures the provider message", async () => {
    manager = new AgentManager();
    failedRun("retries exhausted: 529 overloaded");

    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "x", isBackground: true });
    const record = manager.getRecord(id)!;
    await record.promise;

    expect(record.status).toBe("error");
    expect(record.error).toBe("retries exhausted: 529 overloaded");
    expect(record.completedAt).toBeGreaterThan(0);
  });

  it("keeps earlier-turn text available as result context, but never as a clean completion", async () => {
    manager = new AgentManager();
    failedRun("provider died", "partial progress from an earlier turn");

    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "x", isBackground: true });
    const record = manager.getRecord(id)!;
    await record.promise;

    expect(record.status).toBe("error");
    expect(record.result).toBe("partial progress from an earlier turn");
  });

  it("onComplete sees the error status (routes to subagents:failed in the host)", async () => {
    let completed: AgentRecord | undefined;
    manager = new AgentManager((r) => { completed = r; });
    failedRun("boom");

    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "x", isBackground: true });
    await manager.getRecord(id)!.promise;

    expect(completed?.status).toBe("error");
  });

  it.each(["stopped", "unknown", "turn-limit"] as const)("retains failure independently of %s outcome", async (cause) => {
    const onComplete = vi.fn((record: AgentRecord) => ({ ...record }));
    manager = new AgentManager(onComplete);
    let resolveRun: ((v: Awaited<ReturnType<typeof runAgent>>) => void) | undefined;
    const session = mockSession();
    vi.mocked(runAgent).mockImplementation(() => new Promise((r) => { resolveRun = r; }));

    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "x", isBackground: true });
    const record = manager.getRecord(id)!;
    if (cause === "stopped") manager.abort(id, "caller");
    resolveRun!({ responseText: "partial", session, aborted: cause !== "stopped", steered: false, failure: "late error", interruptionCause: cause === "stopped" ? undefined : cause });
    await record.promise;

    expect(record.status).toBe(cause === "stopped" ? "stopped" : "aborted");
    expect(record.interruptionCause).toBe(cause === "stopped" ? "caller" : cause);
    expect(record.result).toBe("partial");
    expect(record.error).toBe("late error");
    expect(onComplete.mock.results[0]?.value).toMatchObject({ status: record.status, interruptionCause: record.interruptionCause, error: "late error", result: "partial" });
    expect(manager.hasPendingExecution(id)).toBe(false);
  });

  it("resume(): a failed final turn on the resumed prompt maps to error too", async () => {
    manager = new AgentManager();
    resolvedRun();
    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "x", isBackground: true });
    const record = manager.getRecord(id)!;
    await record.promise;
    expect(record.status).toBe("completed");

    const { resumeAgent: resumeMock } = await import("../src/agent-runner.js");
    // resumeAgent bounds its fallback to this invocation, so a failed empty
    // resume yields text "" — never the prior turn's answer (#144 root-fix).
    vi.mocked(resumeMock).mockResolvedValue({
      text: "",
      failure: "retries exhausted on resume",
    });

    await manager.resume(id, "more");

    expect(record.status).toBe("error");
    expect(record.error).toBe("retries exhausted on resume");
    expect(record.result).toBe(""); // no stale prior answer
  });

  it("resume(): partial text produced before the failure is kept as result", async () => {
    manager = new AgentManager();
    resolvedRun();
    const id = manager.spawn(mockPi, mockCtx, "X", "p", { description: "x", isBackground: true });
    const record = manager.getRecord(id)!;
    await record.promise;

    const { resumeAgent: resumeMock } = await import("../src/agent-runner.js");
    vi.mocked(resumeMock).mockResolvedValue({
      text: "new partial progress",
      failure: "provider died mid-turn",
    });

    await manager.resume(id, "more");

    expect(record.status).toBe("error");
    expect(record.result).toBe("new partial progress"); // salvageable, this-run text
  });
});

describe("AgentManager — injected delegation policy checker", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it("fails closed: a denying checker prevents spawn and throws its reason", () => {
    manager = new AgentManager();
    resolvedRun();
    vi.mocked(runAgent).mockClear();
    manager.setPolicyChecker(() => "delegation_policy_denied: blocked");

    expect(() =>
      manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
        description: "test",
        isBackground: true,
      }),
    ).toThrow(/delegation_policy_denied: blocked/);
    // No orphaned record left behind on a denied spawn.
    expect(manager.listAgents()).toHaveLength(0);
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("permits spawn when the checker returns undefined (no false denial)", async () => {
    manager = new AgentManager();
    resolvedRun();
    manager.setPolicyChecker(() => undefined);

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;

    expect(runAgent).toHaveBeenCalled();
    expect(manager.getRecord(id)!.status).toBe("completed");
  });

  it("receives the spawn ctx and type so the checker can resolve session policy", () => {
    manager = new AgentManager();
    resolvedRun();
    const seen: Array<{ ctx: unknown; type: string }> = [];
    manager.setPolicyChecker((ctx, type) => {
      seen.push({ ctx, type });
      return undefined;
    });

    manager.spawn(mockPi, mockCtx, "Explore", "test", {
      description: "test",
      isBackground: true,
    });

    expect(seen).toEqual([{ ctx: mockCtx, type: "Explore" }]);
  });
});

describe("AgentManager — lifetime cost tracking", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  it("(happy) two agents emitting cost:0.1 and cost:0.2 → getLifetimeCost() ≈ 0.3", async () => {
    manager = new AgentManager();
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts: any) => {
      opts.onAssistantUsage?.({ input: 100, output: 50, cacheWrite: 10, cost: 0.1 });
      return { responseText: "done", session: mockSession(), aborted: false, steered: false };
    });
    const id1 = manager.spawn(mockPi, mockCtx, "general-purpose", "test1", { description: "a", isBackground: true });
    await manager.getRecord(id1)!.promise;

    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts: any) => {
      opts.onAssistantUsage?.({ input: 100, output: 50, cacheWrite: 10, cost: 0.2 });
      return { responseText: "done", session: mockSession(), aborted: false, steered: false };
    });
    const id2 = manager.spawn(mockPi, mockCtx, "general-purpose", "test2", { description: "b", isBackground: true });
    await manager.getRecord(id2)!.promise;

    expect(manager.getLifetimeCost()).toBeCloseTo(0.3);
  });

  it("(edge) usage delta with no/undefined cost → no NaN; total unchanged (finite)", async () => {
    manager = new AgentManager();
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts: any) => {
      opts.onAssistantUsage?.({ input: 100, output: 50, cacheWrite: 10 } as any);
      return { responseText: "done", session: mockSession(), aborted: false, steered: false };
    });
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", { description: "x", isBackground: true });
    await manager.getRecord(id)!.promise;

    expect(manager.getLifetimeCost()).toBe(0);
    expect(Number.isFinite(manager.getLifetimeCost())).toBe(true);
  });

  it("record.lifetimeCost accumulates per-record cost across messages", async () => {
    manager = new AgentManager();
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts: any) => {
      opts.onAssistantUsage?.({ input: 100, output: 50, cacheWrite: 10, cost: 0.05 });
      opts.onAssistantUsage?.({ input: 100, output: 50, cacheWrite: 10, cost: 0.05 });
      return { responseText: "done", session: mockSession(), aborted: false, steered: false };
    });
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", { description: "x", isBackground: true });
    await manager.getRecord(id)!.promise;

    expect(manager.getRecord(id)!.lifetimeCost).toBeCloseTo(0.1);
  });
});

describe("AgentManager.getRunning()", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  it("returns only records whose status === 'running'", async () => {
    manager = new AgentManager();
    // A never-resolving run keeps the background agent in 'running'.
    vi.mocked(runAgent).mockImplementation(
      () => new Promise(() => {}) as Promise<any>,
    );

    const runningId = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "running",
      isBackground: true,
    });

    // Seed non-running records directly so status filtering is exercised.
    const completed = manager.getRecord(runningId)!;
    const fake: AgentRecord[] = [
      { ...completed, id: "c1", status: "completed" },
      { ...completed, id: "q1", status: "queued" },
      { ...completed, id: "e1", status: "error" },
    ];
    for (const r of fake) (manager as any).agents.set(r.id, r);

    const running = manager.getRunning();
    expect(running.map((r) => r.id)).toEqual([runningId]);
    expect(running.every((r) => r.status === "running")).toBe(true);
  });
});

it("forwards selected fast metadata unchanged from Agent/RPC options into the runner", async () => {
  resolvedRun();
  const manager = new AgentManager();
  const selectedModel = { model: undefined, fast: false };
  try {
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", { description: "test", selectedModel });
    await manager.getRecord(id)!.promise;
    expect(vi.mocked(runAgent).mock.lastCall?.[3].selectedModel).toBe(selectedModel);
  } finally { manager.dispose(); }
});

describe("AgentManager — independent foreground pool", () => {
  let manager: AgentManager;
  const finishes = new Map<string, () => void>();
  const starts: string[] = [];
  const ids = new Map<string, string>();

  const foreground = (name: string, signal?: AbortSignal) =>
    manager.spawnAndWait(mockPi, mockCtx, "general-purpose", name, { description: name, signal },
      id => { ids.set(name, id); });
  const record = (name: string) => {
    const id = ids.get(name);
    const found = id ? manager.getRecord(id) : undefined;
    if (!found) throw new Error(`Missing record: ${name}`);
    return found;
  };
  const prepare = () => {
    finishes.clear(); starts.length = 0; ids.clear();
    manager = new AgentManager(undefined, 1);
    vi.mocked(runAgent).mockImplementation((_ctx, _type, prompt, options) => {
      starts.push(prompt);
      return new Promise(resolve => {
        const finish = () => resolve({ responseText: prompt, session: mockSession(), aborted: false, steered: false });
        finishes.set(prompt, finish);
        options.signal?.addEventListener("abort", finish, { once: true });
      });
    });
  };
  afterEach(() => { manager?.dispose(); });

  it("limits foreground FIFO independently of a saturated background pool", async () => {
    prepare(); manager.setMaxConcurrentForeground(1);
    manager.spawn(mockPi, mockCtx, "general-purpose", "bg", { description: "bg", isBackground: true });
    manager.spawn(mockPi, mockCtx, "general-purpose", "bg2", { description: "bg2", isBackground: true });
    const a = foreground("a"), b = foreground("b"), c = foreground("c");
    expect(starts).toEqual(["bg", "a"]);
    expect(record("b").status).toBe("queued");
    let completed = false; void b.then(() => { completed = true; });
    await Promise.resolve(); expect(completed).toBe(false);
    finishes.get("a")?.(); await a;
    expect(starts).toEqual(["bg", "a", "b"]);
    finishes.get("b")?.(); await b;
    expect(starts).toEqual(["bg", "a", "b", "c"]);
    finishes.get("c")?.(); await c;
  });

  it("preserves immediate unlimited overlap and per-spawn callbacks", async () => {
    prepare();
    expect(manager.getMaxConcurrentForeground()).toBe(0);
    const callback = vi.fn();
    const a = manager.spawnAndWait(mockPi, mockCtx, "general-purpose", "a", { description: "a" }, callback);
    const b = foreground("b");
    manager.spawn(mockPi, mockCtx, "general-purpose", "detached", { description: "detached" });
    expect(starts).toEqual(["a", "b", "detached"]);
    expect(callback).toHaveBeenCalledTimes(1);
    finishes.get("a")?.(); finishes.get("b")?.(); await Promise.all([a, b]);
  });

  it.each(["signal", "stop", "abortAll", "dispose"] as const)("releases queued waiters on %s without starting them", async action => {
    prepare(); manager.setMaxConcurrentForeground(1);
    const signal = new AbortController();
    const a = foreground("a"), b = foreground("b", signal.signal);
    switch (action) {
      case "signal": signal.abort(); break;
      case "stop": manager.abort(record("b").id); break;
      case "abortAll": expect(manager.abortAll()).toBe(2); break;
      case "dispose": manager.dispose(); break;
    }
    expect((await b).record.status).toBe("stopped");
    expect(starts).toEqual(["a"]);
    finishes.get("a")?.(); await a;
  });

  it("does not start a foreground call with an already aborted parent", async () => {
    prepare(); const signal = new AbortController(); signal.abort();
    expect((await foreground("a", signal.signal)).record.status).toBe("stopped");
    expect(starts).toEqual([]);
  });

  it("honors cancellation during synchronous registration before queueing", async () => {
    prepare(); manager.setMaxConcurrentForeground(1);
    const a = foreground("a"); const signal = new AbortController();
    const b = manager.spawnAndWait(mockPi, mockCtx, "general-purpose", "b",
      { description: "b", signal: signal.signal }, () => signal.abort());
    expect((await b).record.status).toBe("stopped");
    finishes.get("a")?.(); await a;
    expect(starts).toEqual(["a"]);
  });

  it("holds a cancelled running slot until the runner settles", async () => {
    prepare(); manager.setMaxConcurrentForeground(1);
    const a = foreground("a"), b = foreground("b");
    manager.abort(record("a").id);
    expect(starts).toEqual(["a"]);
    await a; expect(starts).toEqual(["a", "b"]);
    finishes.get("b")?.(); await b;
  });

  it("drains after a queued startup failure without losing a slot", async () => {
    prepare(); manager.setMaxConcurrentForeground(1);
    const a = foreground("a"), b = foreground("b"), c = foreground("c");
    vi.mocked(runAgent).mockImplementationOnce(() => { throw new Error("startup failed"); });
    finishes.get("a")?.(); await a;
    expect((await b).record.error).toBe("startup failed");
    expect(starts).toEqual(["a", "c"]);
    finishes.get("c")?.(); await c;
  });

  it("preserves a successful result when completion notification throws", async () => {
    prepare(); manager.dispose();
    const notify = vi.fn(() => { throw new Error("notification failed"); });
    manager = new AgentManager(notify);
    const pending = foreground("a");
    finishes.get("a")?.();
    const { record: completed } = await pending;
    await Promise.resolve(); // Observe any detached completion handler too.
    expect(completed.status).toBe("completed");
    expect(completed.result).toBe("a");
    expect(completed.error).toBeUndefined();
    expect(completed.diagnostics).toEqual(["Completion callback failed: notification failed"]);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("drains queued startup failures when completion notifications throw", async () => {
    prepare(); manager.dispose();
    const notify = vi.fn(() => { throw new Error("notification failed"); });
    manager = new AgentManager(notify); manager.setMaxConcurrentForeground(1);
    const a = foreground("a"), b = foreground("b"), c = foreground("c"), d = foreground("d");
    vi.mocked(runAgent).mockImplementationOnce(() => { throw new Error("startup failed"); });
    expect(() => manager.setMaxConcurrentForeground(2)).not.toThrow();
    const { record: failed } = await b;
    expect(failed.status).toBe("error");
    expect(failed.error).toBe("startup failed");
    expect(failed.diagnostics).toEqual(["Completion callback failed: notification failed"]);
    expect(starts).toEqual(["a", "c"]);
    finishes.get("c")?.(); await c;
    expect(starts).toEqual(["a", "c", "d"]);
    finishes.get("a")?.(); finishes.get("d")?.(); await Promise.all([a, d]);
    expect(notify).toHaveBeenCalledTimes(4);
    expect(manager.hasRunning()).toBe(false);
  });

  it("clearing the limit drains queued calls immediately", async () => {
    prepare(); manager.setMaxConcurrentForeground(1);
    const a = foreground("a"), b = foreground("b"), c = foreground("c");
    manager.setMaxConcurrentForeground(0);
    expect(starts).toEqual(["a", "b", "c"]);
    finishes.forEach(finish => { finish(); }); await Promise.all([a, b, c]);
  });

  it("direct spawn and resume bypass a saturated foreground pool", async () => {
    prepare(); manager.setMaxConcurrentForeground(1);
    const a = foreground("a"), b = foreground("b");
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "direct", { description: "direct", isBackground: false });
    expect(starts).toEqual(["a", "direct"]);
    finishes.get("direct")?.(); await manager.getRecord(id)?.promise;
    const { resumeAgent } = await import("../src/agent-runner.js");
    vi.mocked(resumeAgent).mockResolvedValue({ text: "resumed" });
    expect((await manager.resume(id, "resume"))?.result).toBe("resumed");
    finishes.get("a")?.(); await a; finishes.get("b")?.(); await b;
  });

  it("reports fresh and resumed usage once alongside live costs", async () => {
    prepare(); const listener = vi.fn(); manager.setUsageListener(listener);
    const delta = { input: 10, output: 20, cacheWrite: 5, cacheRead: 100, cost: 0.25 };
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, options) => {
      options.onAssistantUsage?.(delta);
      return { responseText: "done", session: mockSession(), aborted: false, steered: false };
    });
    const { id, record: completed } = await foreground("a");
    const { resumeAgent } = await import("../src/agent-runner.js");
    vi.mocked(resumeAgent).mockImplementation(async (_session, _prompt, options) => {
      options?.onAssistantUsage?.(delta); return { text: "resumed" };
    });
    await manager.resume(id, "resume");
    expect(listener.mock.calls).toEqual([[delta], [delta]]);
    expect(manager.getLifetimeCost()).toBe(0.5);
    expect(completed.lifetimeCost).toBe(0.5);
    expect(completed.lifetimeUsage).toEqual({ input: 20, output: 40, cacheWrite: 10, cacheRead: 200, cost: 0.5 });
    manager.setUsageListener(undefined);
    await manager.resume(id, "again");
    expect(listener).toHaveBeenCalledTimes(2);
    expect(manager.getLifetimeCost()).toBe(0.75);
  });
});

describe("graph run pool ownership", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());

  it("does not consume foreground/background slots or notifications, but retains usage and internal visibility", async () => {
    const completed = vi.fn();
    const started = vi.fn();
    const usage = vi.fn();
    manager = new AgentManager(completed, 1, started);
    manager.setMaxConcurrentForeground(1);
    manager.setUsageListener(usage);
    let finishGraphRun: (() => void) | undefined;
    vi.mocked(runAgent).mockImplementationOnce(async (_ctx, _type, _prompt, options) => {
      options.onAssistantUsage?.({ input: 2, output: 3, cacheWrite: 0, cacheRead: 7, cost: 0.25 });
      await new Promise<void>(resolve => { finishGraphRun = resolve; });
      return { responseText: "graph run", session: mockSession(), aborted: false, steered: false };
    }).mockResolvedValue({ responseText: "ordinary", session: mockSession(), aborted: false, steered: false });
    const pending = manager.spawnAndWait(mockPi, mockCtx, "general-purpose", "graph run", {
      description: "graph run", graphRunId: "wf-1",
    });
    const graphRun = manager.listAgents()[0];
    expect(graphRun.graphRunId).toBe("wf-1");
    expect(manager.getRunning()).toEqual([]);
    const ordinary = await manager.spawnAndWait(mockPi, mockCtx, "general-purpose", "ordinary", { description: "ordinary" });
    expect(ordinary.record.status).toBe("completed");
    expect(started).toHaveBeenCalledTimes(1);
    expect(completed).toHaveBeenCalledTimes(1);
    expect(manager.getLifetimeCost()).toBe(0.25);
    expect(graphRun.lifetimeUsage.cacheRead).toBe(7);
    expect(usage).toHaveBeenCalledTimes(1);
    finishGraphRun?.();
    await pending;
    expect(completed).toHaveBeenCalledTimes(1);
    expect(manager.listAgents()).toContain(graphRun);
  });

  it("tracks resumed graph run promises, rejects concurrent resumes, and aborts via manager", async () => {
    const { resumeAgent } = await import("../src/agent-runner.js");
    manager = new AgentManager();
    resolvedRun();
    const { record } = await manager.spawnAndWait(mockPi, mockCtx, "general-purpose", "first", { description: "child", graphRunId: "wf" });
    vi.mocked(resumeAgent).mockImplementationOnce(async (_session, _prompt, options) => {
      await new Promise<void>(resolve => options?.signal?.addEventListener("abort", () => resolve(), { once: true }));
      return { text: "cancelled" };
    });
    const resumed = manager.resume(record.id, "next");
    await expect(manager.resume(record.id, "overlap")).rejects.toThrow("already running");
    expect(manager.abort(record.id)).toBe(true);
    await manager.waitForAll();
    expect((await resumed)?.status).toBe("stopped");
    expect(await record.promise).toBe("cancelled");
  });
});

describe("AgentManager session listener", () => {
  let manager: AgentManager;
  afterEach(() => manager?.dispose());
  function persisted(sessionFile: string, persistedSession = true) {
    return {
      dispose: vi.fn(),
      sessionManager: {
        isPersisted: () => persistedSession,
        getSessionFile: () => sessionFile,
      },
    };
  }
  it("fires with sessionFile for a persisted session and leaves it absent for in-memory", async () => {
    manager = new AgentManager();
    const listener = vi.fn();
    manager.setSessionListener(listener);
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, prompt, opts) => {
      const session = prompt === "memory" ? persisted("/tmp/ignored.jsonl", false) : persisted("/tmp/child.jsonl");
      opts?.onSessionCreated?.(session as never);
      return { responseText: "done", session, aborted: false, steered: false };
    });
    const persistedId = manager.spawn(mockPi, mockCtx, "general-purpose", "persisted", { description: "persisted", isBackground: true });
    const memoryId = manager.spawn(mockPi, mockCtx, "general-purpose", "memory", { description: "memory", isBackground: true });
    await manager.getRecord(persistedId)!.promise;
    await manager.getRecord(memoryId)!.promise;
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener.mock.calls[0][0].sessionFile).toBe("/tmp/child.jsonl");
    expect(manager.getRecord(persistedId)!.sessionFile).toBe("/tmp/child.jsonl");
    expect(listener.mock.calls[1][0].sessionFile).toBeUndefined();
    expect(manager.getRecord(memoryId)!.sessionFile).toBeUndefined();
  });
  it("does not call the listener for graph-owned children", async () => {
    manager = new AgentManager();
    const listener = vi.fn();
    manager.setSessionListener(listener);
    vi.mocked(runAgent).mockImplementation(async (_ctx, _type, _prompt, opts) => {
      const session = persisted("/tmp/graph-child.jsonl");
      opts?.onSessionCreated?.(session as never);
      return { responseText: "done", session, aborted: false, steered: false };
    });
    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "graph", { description: "graph", graphRunId: "run-1" });
    await manager.getRecord(id)!.promise;
    expect(listener).not.toHaveBeenCalled();
  });
});
