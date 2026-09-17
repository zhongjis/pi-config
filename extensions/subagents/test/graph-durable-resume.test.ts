import { describe, expect, it, vi } from "vitest";
import { readGraphSnapshots } from "../src/graph/graph-persist.js";
import { boot, required } from "./workflow-registration.fixture.js";

const gateGraph = {
  name: "gated",
  nodes: {
    a: { type: "agent", agent: "fixture", prompt: "step a" },
    gate: {
      type: "human_gate",
      prompt: "approve?",
      outputSchema: { type: "object", properties: { approved: { type: "boolean" } }, required: ["approved"] },
    },
    done: { type: "agent", agent: "fixture", prompt: "finish" },
  },
  edges: [
    { from: "a", to: "gate" },
    { from: "gate", to: "done", when: { eq: [{ node: "gate", path: "$.approved" }, true] } },
  ],
};

describe("agent_graph durable human_gate resume", () => {
  it("persists a gate-paused run and resumes it after a simulated restart", async () => {
    // --- Session 1: the gate parks (ui.select never resolves) -----------------
    const s1 = boot({ workflowsEnabled: true });
    await s1.lifecycle("session_start");
    s1.ui.select.mockReturnValue(new Promise(() => {})); // never resolves → parked at the gate
    const result = await required(s1.tools.get("agent_graph")).execute(
      "call",
      { graph: gateGraph, input: {} },
      undefined,
      undefined,
      s1.ctx,
    );
    const runId = required(result.details?.taskId);

    // The run reaches the gate and writes a durable snapshot.
    await vi.waitFor(() => {
      expect(readGraphSnapshots(s1.ctx.cwd).some(s => s.runId === runId)).toBe(true);
    });

    // Simulate shutdown: the parked run aborts, but its snapshot is kept.
    await s1.lifecycle("session_shutdown");
    expect(readGraphSnapshots(s1.ctx.cwd).some(s => s.runId === runId)).toBe(true);

    // --- Session 2 (same cwd = restart): approve the gate ---------------------
    const s2 = boot({ workflowsEnabled: true });
    s2.ui.select.mockResolvedValue("Approve");
    await s2.lifecycle("session_start"); // resumeDurableGraphRuns re-launches the run

    const message = await s2.notification(runId);
    expect(message.content).toContain("Execution: completed");
    // A settled run clears its snapshot.
    expect(readGraphSnapshots(s2.ctx.cwd).some(s => s.runId === runId)).toBe(false);
  });
});
