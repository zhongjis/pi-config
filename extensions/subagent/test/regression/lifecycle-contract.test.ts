// Phase 0 characterization net — locks AgentManager lifecycle contracts the C/D refactor
// will move onto the event bus: queue drain (audit gap #5), pendingSteers flush (gap #7),
// and onStart(all)/onComplete(background-only) gating (the external-emission gating, #2).
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

describe("AgentManager lifecycle contracts (Phase 0 characterization)", () => {
  afterEach(() => {
    runAgentMock.mockReset();
    resumeAgentMock.mockReset();
  });

  it("queues background agents over the concurrency limit and drains on completion", async () => {
    const resolvers: Array<() => void> = [];
    runAgentMock.mockImplementation((_ctx: any, _type: any, _prompt: any, options: any) => {
      options.onSessionCreated?.(fakeSession());
      return new Promise((resolve) => {
        resolvers.push(() => resolve({ responseText: "done", session: fakeSession(), aborted: false, steered: false }));
      });
    });

    const onStart = vi.fn();
    const onComplete = vi.fn();
    const manager = new AgentManager(onComplete, 1, onStart); // maxConcurrent = 1
    try {
      const id1 = manager.spawn(PI, CTX, "general-purpose", "p1", { description: "a", isBackground: true });
      const id2 = manager.spawn(PI, CTX, "general-purpose", "p2", { description: "b", isBackground: true });

      // Over the limit: first runs, second is queued.
      expect(manager.getRecord(id1)?.status).toBe("running");
      expect(manager.getRecord(id2)?.status).toBe("queued");
      expect(onStart).toHaveBeenCalledTimes(1);

      // Completing the first drains the queue and starts the second.
      resolvers[0]();
      await vi.waitFor(() => expect(manager.getRecord(id2)?.status).toBe("running"));
      expect(onStart).toHaveBeenCalledTimes(2);
      expect(onComplete).toHaveBeenCalledTimes(1);
      expect(onComplete.mock.calls[0][0].id).toBe(id1);

      resolvers[1]();
      await vi.waitFor(() => expect(onComplete).toHaveBeenCalledTimes(2));
    } finally {
      manager.dispose();
    }
  });

  it("flushes steers queued before the session was ready, then clears pendingSteers", () => {
    let captured: any;
    runAgentMock.mockImplementation((_ctx: any, _type: any, _prompt: any, options: any) => {
      captured = options; // capture the manager's wrapped options; do NOT signal session yet
      return new Promise(() => {}); // never settles for this test
    });

    const manager = new AgentManager(undefined, 4);
    try {
      const id = manager.spawn(PI, CTX, "general-purpose", "p", { description: "x", isBackground: true });
      const record = manager.getRecord(id)!;
      // Steer arrives before the session exists → queued by the tool layer.
      record.pendingSteers = ["first", "second"];

      const session = fakeSession();
      captured.onSessionCreated(session); // session becomes ready → flush

      expect(session.steer).toHaveBeenCalledTimes(2);
      expect(session.steer).toHaveBeenNthCalledWith(1, "first");
      expect(session.steer).toHaveBeenNthCalledWith(2, "second");
      expect(record.pendingSteers).toBeUndefined();
    } finally {
      manager.dispose();
    }
  });

  it("onStart fires for every run; onComplete fires for background runs only", async () => {
    runAgentMock.mockImplementation((_ctx: any, _type: any, _prompt: any, options: any) => {
      options.onSessionCreated?.(fakeSession());
      return Promise.resolve({ responseText: "ok", session: fakeSession(), aborted: false, steered: false });
    });

    const onStart = vi.fn();
    const onComplete = vi.fn();
    const manager = new AgentManager(onComplete, 4, onStart);
    try {
      // Foreground run.
      const fg = await manager.spawnAndWait(PI, CTX, "general-purpose", "p", { description: "fg" });
      expect(fg.status).toBe("completed");

      // Background run.
      const id = manager.spawn(PI, CTX, "general-purpose", "p", { description: "bg", isBackground: true });
      await manager.getRecord(id)!.promise;
      await vi.waitFor(() => expect(onComplete).toHaveBeenCalled());

      expect(onStart).toHaveBeenCalledTimes(2); // foreground + background
      expect(onComplete).toHaveBeenCalledTimes(1); // background only
      expect(onComplete.mock.calls[0][0].isBackground).toBe(true);
    } finally {
      manager.dispose();
    }
  });
});
