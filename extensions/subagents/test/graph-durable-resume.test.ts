import { describe, expect, it, vi } from "vitest";
import { readGraphSnapshots } from "../src/graph/graph-persist.js";
import { deferred, releaseAfterPending } from "./graph-drain.fixture.js";
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
  it("resumes a drained human gate under a new graph attempt on restart", async () => {
    // Session 1 parks at the gate until shutdown requests cancellation.
    const s1 = boot({ workflowsEnabled: true });
    await s1.lifecycle("session_start");
    const human = deferred<string>();
    s1.ui.select.mockReturnValue(human.promise);
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
      expect(s1.ui.select).toHaveBeenCalled();
      expect(readGraphSnapshots(s1.ctx.cwd).some(s => s.runId === runId)).toBe(true);
    });

    // Simulate shutdown: the parked run aborts, but its snapshot is kept.
    const shutdown = s1.lifecycle("session_shutdown");
    await releaseAfterPending(shutdown, () => human.resolve("Approve"));
    await shutdown;
    expect(readGraphSnapshots(s1.ctx.cwd).some(s => s.runId === runId)).toBe(true);

    // Restart admits a new graph attempt, without repairing the cancelled execution.
    const s2 = boot({ workflowsEnabled: true });
    s2.ui.select.mockResolvedValue("Approve");
    await s2.lifecycle("session_start"); // resumeDurableGraphRuns re-launches the run

    const message = await s2.notification(runId);
    expect(message.content).toContain("Execution: completed");
    expect(s2.ui.select).toHaveBeenCalledTimes(1);
    // A settled run clears its snapshot.
    expect(readGraphSnapshots(s2.ctx.cwd).some(s => s.runId === runId)).toBe(false);
  });
});

it("persists effective fanout topology through the workflow runtime and resumes it once", async () => {
  const s1 = boot({ workflowsEnabled: true });
  await s1.lifecycle("session_start");
  const human = deferred<string>();
  s1.ui.select.mockReturnValue(human.promise);
  const graph = {
    nodes: {
      research: {
        type: "fanout", items: { path: "$.tasks" }, itemSchema: { type: "object" },
        dispatch: { path: "$.source", cases: { project: "fixture" } }, prompt: `\${item}`,
      },
      gate: gateGraph.nodes.gate,
    },
    edges: [],
  };
  const result = await required(s1.tools.get("agent_graph")).execute(
    "call", { graph, input: { tasks: [{ source: "project" }] } }, undefined, undefined, s1.ctx,
  );
  const runId = required(result.details?.taskId);
  await vi.waitFor(() => expect(readGraphSnapshots(s1.ctx.cwd).some(s => s.runId === runId)).toBe(true));
  const saved = required(readGraphSnapshots(s1.ctx.cwd).find(s => s.runId === runId));
  expect(saved.graph.nodes["research:item:0"]).toMatchObject({ type: "agent", agent: "fixture" });
  expect(saved.state.collections?.research).toEqual([{ nodeId: "research:item:0", item: { source: "project" } }]);
  const shutdown = s1.lifecycle("session_shutdown");
  await releaseAfterPending(shutdown, () => human.resolve("Approve"));
  await shutdown;
  const s2 = boot({ workflowsEnabled: true });
  s2.ui.select.mockResolvedValue("Approve");
  await s2.lifecycle("session_start");
  const message = await s2.notification(runId);
  expect(message.content).toContain("Execution: completed");
  expect(readGraphSnapshots(s2.ctx.cwd).some(s => s.runId === runId)).toBe(false);
});
