import { describe, expect, it, vi } from "vitest";

const runAgentMock = vi.fn();

vi.mock("../../src/agent-runner.js", () => ({
  runAgent: (...args: any[]) => runAgentMock(...args),
  resumeAgent: vi.fn(),
  getAgentConversation: () => "partial transcript",
}));

const { AgentManager } = await import("../../src/agent-manager.js");

describe("regression: result recovery after supervision abort", () => {
  it("does not double-fire abort while recovering a stopped result", async () => {
    const abortSpy = vi.fn();
    const onComplete = vi.fn();

    runAgentMock.mockImplementation((_ctx: any, _type: any, _prompt: any, options: any) => {
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => {
          abortSpy();
          reject(new Error("aborted by supervision"));
        }, { once: true });
      });
    });

    const manager = new AgentManager(onComplete);

    try {
      const id = manager.spawn(
        {} as any,
        { cwd: process.cwd() } as any,
        "general-purpose",
        "Test prompt",
        {
          description: "background agent",
          isBackground: true,
        },
      );

      const record = manager.getRecord(id)!;
      record.error = "Auto-stopped after 301s of inactivity.";

      expect(manager.abort(id)).toBe(true);
      expect(manager.abort(id)).toBe(false);

      await record.promise;

      expect(abortSpy).toHaveBeenCalledOnce();
      expect(onComplete).toHaveBeenCalledOnce();
      expect(record.status).toBe("stopped");
      expect(record.result).toContain("Agent was stopped before producing a final answer.");
      expect(record.result).toContain("Auto-stopped after 301s of inactivity.");
    } finally {
      await manager.dispose();
      runAgentMock.mockReset();
    }
  });
});
