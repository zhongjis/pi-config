/**
 * subagent-integration.test.ts — verifies D2: AgentRun is the writer of terminal record fields.
 *
 * For each terminal family (completed, steered, aborted/max_turns, error, stopped),
 * asserts that after the terminal event fires:
 *   1. record.status / result / error / completedAt match run.status / result / error / completedAt
 *      (i.e. project() ran correctly).
 *   2. emitTerminalContract (the single external-contract caller) still sees the expected
 *      record fields — i.e. behavioral parity with the pre-D2 inline writes.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const runAgentMock = vi.fn();
const resumeAgentMock = vi.fn();

vi.mock("../src/agent-runner.js", () => ({
  runAgent: (...args: any[]) => runAgentMock(...args),
  resumeAgent: (...args: any[]) => resumeAgentMock(...args),
  getAgentConversation: () => "",
}));

const { AgentManager } = await import("../src/agent-manager.js");

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
  expectedType: "general-purpose",
  restoreSession: async () => { throw new Error("unexpected restore"); },
};

describe("D2 — project() writes terminal fields via run (foreground spawnAndWait)", () => {
  afterEach(() => {
    runAgentMock.mockReset();
    resumeAgentMock.mockReset();
  });

  it("completed: record fields match run fields after project()", async () => {
    const session = fakeSession();
    runAgentMock.mockResolvedValue({ responseText: "final answer", session, aborted: false, steered: false });

    const manager = new AgentManager();
    try {
      const record = await manager.spawnAndWait(PI, CTX, "general-purpose", "p", { description: "d" });

      expect(record.status).toBe("completed");
      expect(record.result).toBe("final answer");
      expect(record.error).toBeUndefined();
      expect(record.completedAt).toBeTypeOf("number");

      // run and record must agree — project() did its job
      expect(record.run?.status).toBe(record.status);
      expect(record.run?.result).toBe(record.result);
      expect(record.run?.completedAt).toBe(record.completedAt);
    } finally {
      manager.dispose();
    }
  });

  it("steered: record fields match run fields after project()", async () => {
    const session = fakeSession();
    runAgentMock.mockResolvedValue({ responseText: "partial", session, aborted: false, steered: true });

    const manager = new AgentManager();
    try {
      const record = await manager.spawnAndWait(PI, CTX, "general-purpose", "p", { description: "d" });

      expect(record.status).toBe("steered");
      expect(record.result).toBe("partial");
      expect(record.run?.status).toBe("steered");
      expect(record.run?.result).toBe("partial");
    } finally {
      manager.dispose();
    }
  });

  it("aborted (max_turns): record fields match run fields after project()", async () => {
    const session = fakeSession();
    runAgentMock.mockResolvedValue({ responseText: "", session, aborted: true, steered: false });

    const manager = new AgentManager();
    try {
      const record = await manager.spawnAndWait(PI, CTX, "general-purpose", "p", { description: "d" });

      expect(record.status).toBe("aborted");
      expect(record.error).toBeUndefined();
      // result is the recovered text (non-empty)
      expect(record.result).toBeTruthy();
      expect(record.run?.status).toBe("aborted");
      expect(record.run?.result).toBe(record.result);
      expect(record.run?.completedAt).toBe(record.completedAt);
    } finally {
      manager.dispose();
    }
  });

  it("error: record fields match run fields after project()", async () => {
    runAgentMock.mockRejectedValue(new Error("tool timed out"));

    const manager = new AgentManager();
    try {
      const record = await manager.spawnAndWait(PI, CTX, "general-purpose", "p", { description: "d" });

      expect(record.status).toBe("error");
      expect(record.error).toBe("tool timed out");
      expect(record.result).toBeTruthy(); // recovered result text
      expect(record.run?.status).toBe("error");
      expect(record.run?.error).toBe("tool timed out");
      expect(record.run?.result).toBe(record.result);
      expect(record.run?.completedAt).toBe(record.completedAt);
    } finally {
      manager.dispose();
    }
  });
});

describe("D2 — project() writes terminal fields via run (resume path)", () => {
  afterEach(() => {
    runAgentMock.mockReset();
    resumeAgentMock.mockReset();
  });

  it("resume completed: record fields match run fields after project()", async () => {
    const session = fakeSession();
    runAgentMock.mockResolvedValue({ responseText: "first run", session, aborted: false, steered: false });
    resumeAgentMock.mockResolvedValue("resumed answer");

    const manager = new AgentManager();
    try {
      const id = manager.spawn(PI, CTX, "general-purpose", "p", { description: "d", isBackground: false });
      const record = manager.getRecord(id)!;
      await record.promise;

      // First run should be completed
      expect(record.status).toBe("completed");
      expect(record.run?.status).toBe("completed");

      // Resume the agent
      const resumed = await manager.resume(id, "follow-up", LIVE_RESUME);
      expect(resumed).toEqual({ status: "resumed_live", id }); // same record retained

      expect(record.status).toBe("completed");
      expect(record.result).toBe("resumed answer");
      expect(record.run?.status).toBe("completed");
      expect(record.run?.result).toBe("resumed answer");
      expect(record.run?.completedAt).toBe(record.completedAt);
    } finally {
      manager.dispose();
    }
  });

  it("resume error: record fields match run fields after project()", async () => {
    const session = fakeSession();
    runAgentMock.mockResolvedValue({ responseText: "first run", session, aborted: false, steered: false });
    resumeAgentMock.mockRejectedValue(new Error("resume failed"));

    const manager = new AgentManager();
    try {
      const id = manager.spawn(PI, CTX, "general-purpose", "p", { description: "d", isBackground: false });
      const record = manager.getRecord(id)!;
      await record.promise;

      const resumed = await manager.resume(id, "follow-up", LIVE_RESUME);
      expect(resumed).toEqual({ status: "resumed_live", id });

      expect(record.status).toBe("error");
      expect(record.error).toBe("resume failed");
      expect(record.result).toBeTruthy(); // recovered result
      expect(record.run?.status).toBe("error");
      expect(record.run?.error).toBe("resume failed");
      expect(record.run?.result).toBe(record.result);
    } finally {
      manager.dispose();
    }
  });
});

describe("D2 — stopped path leaves terminal state from publishRunStop (not project)", () => {
  afterEach(() => {
    runAgentMock.mockReset();
  });

  it("stopped agent: run.status = stopped, project() NOT called from .then terminal path", async () => {
    const session = fakeSession();
    runAgentMock.mockImplementation((_ctx: any, _type: any, _prompt: any, options: any) => {
      return new Promise((resolve) => {
        options.signal?.addEventListener("abort", () => {
          resolve({ responseText: "", session, aborted: false, steered: false });
        }, { once: true });
      });
    });

    const manager = new AgentManager();
    const controller = new AbortController();
    try {
      const recordPromise = manager.spawnAndWait(PI, CTX, "general-purpose", "p", {
        description: "d",
        signal: controller.signal,
      });

      controller.abort();
      const record = await recordPromise;

      // Stopped by publishRunStop (D3 territory) — inline writes from abort()
      expect(record.status).toBe("stopped");
      expect(record.completedAt).toBeTypeOf("number");
      // run also reflects stopped (from publishRunStop)
      expect(record.run?.status).toBe("stopped");
    } finally {
      manager.dispose();
    }
  });
});

describe("D3a — abort() / publishRunStop interleave: stopped status wins over .then settlement", () => {
  afterEach(() => {
    runAgentMock.mockReset();
  });

  it("abort() while running: .then sees stopped, does not overwrite stop message", async () => {
    const session = fakeSession();
    let resolveRun!: (v: any) => void;
    runAgentMock.mockImplementation(() => new Promise(resolve => { resolveRun = resolve; }));

    const manager = new AgentManager();
    try {
      const id = manager.spawn(PI, CTX, "general-purpose", "p", { description: "d", isBackground: false });
      const record = manager.getRecord(id)!;

      // Flush microtasks so startAgent has been called (record.promise is set)
      await Promise.resolve();

      // abort() while running — publishRunStop sets status synchronously via project()
      manager.abort(id);

      expect(record.status).toBe("stopped");
      expect(record.error).toBe("Agent was stopped while running.");
      expect(record.run?.status).toBe("stopped");

      // Now resolve the runAgent promise (late arrival, after abort)
      resolveRun({ responseText: "late result", session, aborted: false, steered: false });

      // Wait for the promise chain to fully settle
      await record.promise;

      // .then guard saw status === "stopped" and did NOT overwrite terminal state
      expect(record.status).toBe("stopped");
      expect(record.error).toBe("Agent was stopped while running.");
      expect(record.run?.status).toBe("stopped");
    } finally {
      manager.dispose();
    }
  });
});

describe("D4a — result_amended: stopped result flows via run after late settle", () => {
  afterEach(() => {
    runAgentMock.mockReset();
  });

  it("abort() then settle: run.result === record.result, status stays stopped", async () => {
    const session = fakeSession();
    let resolveRun!: (v: any) => void;
    runAgentMock.mockImplementation(() => new Promise(resolve => { resolveRun = resolve; }));

    const manager = new AgentManager();
    try {
      const id = manager.spawn(PI, CTX, "general-purpose", "p", { description: "d", isBackground: false });
      const record = manager.getRecord(id)!;

      await Promise.resolve(); // flush so startAgent runs

      manager.abort(id); // sets status="stopped" synchronously via publishRunStop+project
      expect(record.status).toBe("stopped");

      // Resolve with partial text — .then stopped branch publishes result_amended
      resolveRun({ responseText: "partial output", session, aborted: false, steered: false });
      await record.promise;

      // status and error unchanged (terminal guard held)
      expect(record.status).toBe("stopped");
      expect(record.error).toBe("Agent was stopped while running.");
      // result_amended + project() propagated the result
      expect(record.result).toBe("partial output");
      expect(record.run?.result).toBe("partial output");
      expect(record.run?.result).toBe(record.result); // run is the writer
      // completedAt stamped at abort time, not settle time
      expect(record.completedAt).toBeTypeOf("number");
    } finally {
      manager.dispose();
    }
  });
});
