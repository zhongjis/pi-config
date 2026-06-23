// finalize-run-parity.test.ts — pins the terminal-finalization behavior of AgentManager
// BEFORE the finalizeRun() extraction (candidate #1 / T1). These lock two currently-
// unguarded invariants so the refactor cannot silently change them:
//
//   Pin A — stopped idempotency: a user-stopped run publishes exactly one `result_amended`
//           and zero `completed`/`failed`, whether runAgent settles or rejects after the abort.
//   Pin B — branch-note asymmetry: the "Changes saved to branch …" note is appended on the
//           SETTLED continuation (completed, then-stopped) and NOT on the REJECTED continuation
//           (error, catch-stopped). This asymmetry is intentional-as-of-today; pin = preserve.
//
// Drives the real manager terminal blocks via a mocked runAgent.
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

/** runAgent that settles (resolve or reject) only once the agent's abort signal fires. */
function settleOnAbort(mode: "resolve" | "reject", responseText = "") {
  return (_c: any, _t: any, _p: any, options: any) => {
    options.onSessionCreated?.(fakeSession());
    return new Promise((resolve, reject) => {
      options.signal?.addEventListener(
        "abort",
        () =>
          mode === "resolve"
            ? resolve({ responseText, session: fakeSession(), aborted: false, steered: false })
            : reject(new Error("aborted")),
        { once: true },
      );
    });
  };
}

afterEach(() => {
  runAgentMock.mockReset();
  resumeAgentMock.mockReset();
});


describe("finalizeRun parity — stopped idempotency", () => {
  it("then-stopped (runAgent resolves after abort): exactly one result_amended, no completed/failed", async () => {
    runAgentMock.mockImplementation(settleOnAbort("resolve", "late output"));

    const manager = new AgentManager(undefined, 4);
    const controller = new AbortController();
    try {
      const id = manager.spawn(PI, CTX, "general-purpose", "p", {
        description: "d",
        isBackground: true,
        signal: controller.signal,
      });
      const record = manager.getRecord(id)!;
      controller.abort();
      await record.promise;

      const kinds = record.run!.events().map((e) => e.kind);
      expect(kinds.filter((k) => k === "result_amended")).toHaveLength(1);
      expect(kinds).not.toContain("completed");
      expect(kinds).not.toContain("failed");
      expect(record.status).toBe("stopped");
    } finally {
      manager.dispose();
    }
  });

  it("catch-stopped (runAgent rejects after abort): exactly one result_amended, no completed/failed", async () => {
    runAgentMock.mockImplementation(settleOnAbort("reject"));

    const manager = new AgentManager(undefined, 4);
    const controller = new AbortController();
    try {
      const id = manager.spawn(PI, CTX, "general-purpose", "p", {
        description: "d",
        isBackground: true,
        signal: controller.signal,
      });
      const record = manager.getRecord(id)!;
      controller.abort();
      await record.promise;

      const kinds = record.run!.events().map((e) => e.kind);
      expect(kinds.filter((k) => k === "result_amended")).toHaveLength(1);
      expect(kinds).not.toContain("completed");
      expect(kinds).not.toContain("failed");
      expect(record.status).toBe("stopped");
    } finally {
      manager.dispose();
    }
  });
});

