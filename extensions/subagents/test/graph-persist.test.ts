import { describe, expect, it } from "vitest";
import type { AgentGraph } from "../src/graph/ir.js";
import type { NodeHost } from "../src/graph/node-host.js";
import { runGraph } from "../src/graph/run-graph.js";
import type { SchedulerState } from "../src/graph/scheduler.js";
import { ProjectionDriver as Scheduler } from "./graph-projection.fixture.js";

const agent = () => ({ type: "agent" as const, agent: "x", prompt: "p" });

const gateGraph: AgentGraph = {
  nodes: {
    a: agent(),
    gate: {
      type: "human_gate",
      prompt: "approve?",
      outputSchema: { type: "object", properties: { approved: { type: "boolean" } }, required: ["approved"] },
    },
    done: agent(),
  },
  edges: [
    { from: "a", to: "gate" },
    { from: "gate", to: "done", when: { eq: [{ node: "gate", path: "$.approved" }, true] } },
  ],
  outputs: { decision: { node: "gate", path: "$.approved" } },
};

describe("Scheduler snapshot/hydrate", () => {
  it("round-trips completed node state", () => {
    const graph: AgentGraph = { nodes: { a: agent(), b: agent() }, edges: [{ from: "a", to: "b" }] };
    const s = new Scheduler(graph, {});
    s.markRunning("a");
    s.settle("a", { ok: true, output: { x: 1 } });
    const state = s.snapshotState();
    expect(state.nodes.a.status).toBe("completed");
    expect(state.nodes.a.output).toEqual({ x: 1 });

    const restored = new Scheduler(graph, {});
    restored.hydrate(state);
    expect(restored.nodes.get("a")?.status).toBe("completed");
    expect(restored.nodes.get("a")?.output).toEqual({ x: 1 });
  });

  it("hydrates a mid-flight (running) node back to pending", () => {
    const graph: AgentGraph = { nodes: { a: agent() }, edges: [] };
    const s = new Scheduler(graph, {});
    s.markRunning("a");
    const restored = new Scheduler(graph, {});
    restored.hydrate(s.snapshotState());
    expect(restored.nodes.get("a")?.status).toBe("pending");
  });
});

describe("runGraph durable resume", () => {
  it("fires onGateWaiting with the current run state when a gate awaits", async () => {
    const captured: { id: string; state: SchedulerState }[] = [];
    const host: NodeHost = {
      spawnAgent: async () => ({ ok: true, output: "a-out" }),
      awaitHumanGate: async () => ({ ok: true, output: '{"approved":true}' }),
    };
    await runGraph(gateGraph, {}, { host, onGateWaiting: (id, state) => captured.push({ id, state }) });
    expect(captured).toHaveLength(1);
    expect(captured[0].id).toBe("gate");
    expect(captured[0].state.nodes.a.status).toBe("completed");
    expect(captured[0].state.nodes.gate.status).toBe("running");
  });
});
