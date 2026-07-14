// Phase 1 parity net — proves the dormant AgentRun stays in lockstep with AgentRecord
// across the full lifecycle, before Phase 2 makes the run authoritative. Nothing reads
// from record.run in production yet; these tests assert the shadow is correct.
import { afterEach, describe, expect, it, vi } from "vitest";

const runAgentMock = vi.fn();
const resumeAgentMock = vi.fn();

vi.mock("../../src/agent-runner.js", () => ({
  runAgent: (...args: any[]) => runAgentMock(...args),
  resumeAgent: (...args: any[]) => resumeAgentMock(...args),
  getAgentConversation: () => "",
}));

const { AgentManager } = await import("../../src/agent-manager.js");

function fakeSession() {
  return {
    steer: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn(),
    dispose: vi.fn(),
    getSessionStats: () => ({ tokens: { input: 0, output: 0, total: 0 } }),
  } as any;
}

const PI = {} as any;
const CTX = { cwd: process.cwd() } as any;
const LIVE_RESUME = {
  parentSessionId: "",
  expectedType: "GENERAL-PURPOSE",
  restoreSession: async () => { throw new Error("unexpected restore"); },
};

describe("AgentRun ⇄ AgentRecord parity (Phase 1 dormant shadow)", () => {
  afterEach(() => {
    runAgentMock.mockReset();
    resumeAgentMock.mockReset();
  });

  it("tracks a completed background run (status, toolUses, session, result)", async () => {
    runAgentMock.mockImplementation((_c: any, _t: any, _p: any, options: any) => {
      options.onSessionCreated?.(fakeSession());
      options.onToolActivity?.({ type: "start", toolName: "read" });
      options.onToolActivity?.({ type: "end", toolName: "read" });
      options.onTurnEnd?.(2);
      return Promise.resolve({ responseText: "the answer", session: fakeSession(), aborted: false, steered: false });
    });

    const manager = new AgentManager(undefined, 4);
    try {
      const id = manager.spawn(PI, CTX, "general-purpose", "p", { description: "d", isBackground: true });
      const record = manager.getRecord(id)!;
      await record.promise;
      await vi.waitFor(() => expect(record.run?.status).toBe("completed"));

      expect(record.run?.status).toBe(record.status);
      expect(record.run?.activity.toolUses).toBe(record.toolUses);
      expect(record.run?.result).toBe(record.result);
      expect(record.run?.activity.turnCount).toBe(2);
      expect(record.run?.session).toBeDefined();
      expect(record.run?.isBackground).toBe(true);
    } finally {
      await manager.dispose();
    }
  });

  it("tracks a soft-steered finish as status 'steered' (a completed outcome)", async () => {
    runAgentMock.mockImplementation(() =>
      Promise.resolve({ responseText: "wrapped", session: fakeSession(), aborted: false, steered: true }),
    );
    const manager = new AgentManager(undefined, 4);
    try {
      const id = manager.spawn(PI, CTX, "general-purpose", "p", { description: "d", isBackground: true });
      const record = manager.getRecord(id)!;
      await record.promise;
      await vi.waitFor(() => expect(record.run?.status).toBe("steered"));
      expect(record.status).toBe("steered");
      expect(record.run?.result).toBe(record.result);
    } finally {
      await manager.dispose();
    }
  });

  it("tracks an errored run", async () => {
    runAgentMock.mockImplementation(() => Promise.reject(new Error("kaboom")));
    const manager = new AgentManager(undefined, 4);
    try {
      const id = manager.spawn(PI, CTX, "general-purpose", "p", { description: "d", isBackground: true });
      const record = manager.getRecord(id)!;
      await record.promise;
      await vi.waitFor(() => expect(record.run?.status).toBe("error"));
      expect(record.status).toBe("error");
      expect(record.run?.error).toBe(record.error);
    } finally {
      await manager.dispose();
    }
  });

  it("tracks an external stop (foreground signal abort) as status 'stopped'", async () => {
    runAgentMock.mockImplementation((_c: any, _t: any, _p: any, options: any) => {
      options.onSessionCreated?.(fakeSession());
      return new Promise((resolve) => {
        options.signal?.addEventListener(
          "abort",
          () => resolve({ responseText: "", session: fakeSession(), aborted: false, steered: false }),
          { once: true },
        );
      });
    });
    const manager = new AgentManager(undefined, 4);
    const controller = new AbortController();
    try {
      const p = manager.spawnAndWait(PI, CTX, "general-purpose", "p", { description: "d", signal: controller.signal });
      controller.abort();
      const record = await p;
      expect(record.status).toBe("stopped");
      expect(record.run?.status).toBe("stopped");
    } finally {
      await manager.dispose();
    }
  });

  it("tracks resume: terminal → reopened → completed again", async () => {
    runAgentMock.mockImplementation((_c: any, _t: any, _p: any, options: any) => {
      options.onSessionCreated?.(fakeSession());
      return Promise.resolve({ responseText: "first", session: fakeSession(), aborted: false, steered: false });
    });
    resumeAgentMock.mockResolvedValue("second");

    const manager = new AgentManager(undefined, 4);
    try {
      const id = manager.spawn(PI, CTX, "general-purpose", "p", { description: "d", isBackground: true });
      const record = manager.getRecord(id)!;
      await record.promise;
      await vi.waitFor(() => expect(record.run?.status).toBe("completed"));

      await manager.resume(id, "again", LIVE_RESUME);
      expect(record.status).toBe("completed");
      expect(record.run?.status).toBe("completed");
      expect(record.run?.result).toBe(record.result);
      expect(record.run?.result).toBe("second");
    } finally {
      await manager.dispose();
    }
  });

  it("tracks queue lifecycle: queued → running → completed", async () => {
    const resolvers: Array<() => void> = [];
    runAgentMock.mockImplementation((_c: any, _t: any, _p: any, options: any) => {
      options.onSessionCreated?.(fakeSession());
      return new Promise((resolve) => {
        resolvers.push(() => resolve({ responseText: "ok", session: fakeSession(), aborted: false, steered: false }));
      });
    });
    const manager = new AgentManager(undefined, 1); // force queueing
    try {
      const id1 = manager.spawn(PI, CTX, "general-purpose", "p1", { description: "a", isBackground: true });
      const id2 = manager.spawn(PI, CTX, "general-purpose", "p2", { description: "b", isBackground: true });
      const r1 = manager.getRecord(id1)!;
      const r2 = manager.getRecord(id2)!;

      expect(r1.run?.status).toBe("running");
      expect(r2.run?.status).toBe("queued");
      expect(r2.status).toBe("queued");

      resolvers[0]();
      await vi.waitFor(() => expect(r2.run?.status).toBe("running"));
      expect(r1.run?.status).toBe("completed");

      resolvers[1]();
      await vi.waitFor(() => expect(r2.run?.status).toBe("completed"));
    } finally {
      await manager.dispose();
    }
  });
});
