import { describe, expect, it, vi } from "vitest";
import { createBackgroundStop } from "../src/background-stop.js";
import { createGraphRunTask } from "../src/graph/task.js";
import type { AgentRecord } from "../src/types.js";

function agent(id: string, extra: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id, type: "fixture", description: id, status: "running", toolUses: 0, startedAt: 0,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 }, compactionCount: 0, ...extra,
  };
}

function setup(agents: AgentRecord[], graphStatus: "running" | "completed" = "running") {
  const graph = createGraphRunTask({ id: "agr_1", script: "" });
  graph.status = graphStatus;
  const abortAgent = vi.fn();
  const stop = createBackgroundStop({ listAgents: () => agents, abortAgent, graphRuns: () => [graph] });
  return { stop, graph, abortAgent, ui: { notify: vi.fn() } };
}

describe("an aborted orchestrator run stops background work", () => {
  it("stops top-level background agents and running graph runs as a user stop, once", () => {
    const t = setup([
      agent("bg"),
      agent("queued", { status: "queued" }),
      agent("done", { status: "completed" }),
      agent("graph-owned", { graphRunId: "agr_1" }),
      agent("nested", { parentAgentId: "bg" }),
    ]);
    t.stop.stop(t.ui);
    expect(t.abortAgent.mock.calls.map(call => call[0])).toEqual(["bg", "queued"]);
    expect(t.graph.abortController.signal.reason).toBe("user");
    expect(t.ui.notify).toHaveBeenCalledTimes(1);
    expect(t.ui.notify).toHaveBeenLastCalledWith("Stopped 2 background agents and 1 agent graph run.", "info");
  });

  it("does nothing when no background work runs", () => {
    const t = setup([agent("done", { status: "completed" })], "completed");
    t.stop.stop(t.ui);
    expect(t.abortAgent).not.toHaveBeenCalled();
    expect(t.ui.notify).not.toHaveBeenCalled();
  });

  it("still stops without a UI to notify", () => {
    const t = setup([agent("bg")], "completed");
    t.stop.stop();
    expect(t.abortAgent).toHaveBeenCalledWith("bg");
  });
});
