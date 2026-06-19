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
// Drives the real manager terminal blocks via a mocked runAgent + mocked worktree.
import { afterEach, describe, expect, it, vi } from "vitest";

const runAgentMock = vi.fn();
const resumeAgentMock = vi.fn();
const createWorktreeMock = vi.fn();
const cleanupWorktreeMock = vi.fn();
const pruneWorktreesMock = vi.fn();

vi.mock("../../src/agent-runner.js", () => ({
  runAgent: (...args: any[]) => runAgentMock(...args),
  resumeAgent: (...args: any[]) => resumeAgentMock(...args),
  getAgentConversation: () => "",
}));

vi.mock("../../src/worktree.js", () => ({
  createWorktree: (...args: any[]) => createWorktreeMock(...args),
  cleanupWorktree: (...args: any[]) => cleanupWorktreeMock(...args),
  pruneWorktrees: (...args: any[]) => pruneWorktreesMock(...args),
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
const BRANCH_NOTE = "Changes saved to branch";

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
  createWorktreeMock.mockReset();
  cleanupWorktreeMock.mockReset();
  pruneWorktreesMock.mockReset();
});

// ─── Pin A: stopped idempotency (no worktree) ──────────────────────────────────

describe("finalizeRun parity — stopped idempotency", () => {
  it("then-stopped (runAgent resolves after abort): exactly one result_amended, no completed/failed", async () => {
    createWorktreeMock.mockReturnValue(undefined);
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
    createWorktreeMock.mockReturnValue(undefined);
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

// ─── Pin B: branch-note asymmetry (with worktree) ──────────────────────────────

describe("finalizeRun parity — branch-note asymmetry", () => {
  function withWorktree() {
    createWorktreeMock.mockReturnValue({ path: "/tmp/wt", branch: "pi-agent-x" });
    cleanupWorktreeMock.mockReturnValue({ hasChanges: true, branch: "pi-agent-x", path: "/tmp/wt" });
  }

  it("completed (settled): appends the branch note", async () => {
    withWorktree();
    runAgentMock.mockResolvedValue({ responseText: "done", session: fakeSession(), aborted: false, steered: false });

    const manager = new AgentManager(undefined, 4);
    try {
      const id = manager.spawn(PI, CTX, "general-purpose", "p", {
        description: "d",
        isBackground: true,
        isolation: "worktree",
      });
      const record = manager.getRecord(id)!;
      await record.promise;
      expect(record.status).toBe("completed");
      expect(record.result ?? "").toContain(BRANCH_NOTE);
    } finally {
      manager.dispose();
    }
  });

  it("error (rejected): does NOT append the branch note", async () => {
    withWorktree();
    runAgentMock.mockRejectedValue(new Error("kaboom"));

    const manager = new AgentManager(undefined, 4);
    try {
      const id = manager.spawn(PI, CTX, "general-purpose", "p", {
        description: "d",
        isBackground: true,
        isolation: "worktree",
      });
      const record = manager.getRecord(id)!;
      await record.promise;
      expect(record.status).toBe("error");
      expect(record.result ?? "").not.toContain(BRANCH_NOTE);
    } finally {
      manager.dispose();
    }
  });

  it("then-stopped (settled after abort): appends the branch note", async () => {
    withWorktree();
    runAgentMock.mockImplementation(settleOnAbort("resolve", "late output"));

    const manager = new AgentManager(undefined, 4);
    const controller = new AbortController();
    try {
      const id = manager.spawn(PI, CTX, "general-purpose", "p", {
        description: "d",
        isBackground: true,
        isolation: "worktree",
        signal: controller.signal,
      });
      const record = manager.getRecord(id)!;
      controller.abort();
      await record.promise;
      expect(record.status).toBe("stopped");
      expect(record.result ?? "").toContain(BRANCH_NOTE);
    } finally {
      manager.dispose();
    }
  });

  it("catch-stopped (rejected after abort): does NOT append the branch note", async () => {
    withWorktree();
    runAgentMock.mockImplementation(settleOnAbort("reject"));

    const manager = new AgentManager(undefined, 4);
    const controller = new AbortController();
    try {
      const id = manager.spawn(PI, CTX, "general-purpose", "p", {
        description: "d",
        isBackground: true,
        isolation: "worktree",
        signal: controller.signal,
      });
      const record = manager.getRecord(id)!;
      controller.abort();
      await record.promise;
      expect(record.status).toBe("stopped");
      expect(record.result ?? "").not.toContain(BRANCH_NOTE);
    } finally {
      manager.dispose();
    }
  });
});
