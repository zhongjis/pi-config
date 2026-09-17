import { describe, expect, it } from "vitest";
import type { AgentGraph } from "../src/graph/ir.js";
import type { NodeHost, NodeSpawnResult } from "../src/graph/node-host.js";
import { runGraph } from "../src/graph/run-graph.js";

const gateGraph: AgentGraph = {
  nodes: {
    gate: {
      type: "human_gate",
      prompt: "Approve the plan?",
      outputSchema: { type: "object", properties: { approved: { type: "boolean" } }, required: ["approved"] },
    },
    done: { type: "agent", agent: "x", prompt: "finish" },
  },
  edges: [{ from: "gate", to: "done", when: { eq: [{ node: "gate", path: "$.approved" }, true] } }],
  outputs: { decision: { node: "gate", path: "$.approved" } },
};

/** Host with a scripted human-gate resolver and a trivial agent spawn. */
function host(gate: (() => Promise<NodeSpawnResult>) | undefined): NodeHost {
  const base: NodeHost = { spawnAgent: async () => ({ ok: true, output: "done" }) };
  if (gate === undefined) return base;
  return { ...base, awaitHumanGate: async () => gate() };
}

describe("human_gate node", () => {
  it("completes and routes the approved branch", async () => {
    const result = await runGraph(gateGraph, {}, {
      host: host(async () => ({ ok: true, output: '{"approved":true}' })),
    });
    expect(result.status).toBe("completed");
    expect(result.nodes.gate.status).toBe("completed");
    expect(result.nodes.done.status).toBe("completed");
    expect(result.outputs).toEqual({ decision: true });
  });

  it("records a rejection and skips the approved branch", async () => {
    const result = await runGraph(gateGraph, {}, {
      host: host(async () => ({ ok: true, output: '{"approved":false}' })),
    });
    expect(result.status).toBe("completed");
    expect(result.nodes.gate.status).toBe("completed");
    expect(result.nodes.done.status).toBe("skipped");
    expect(result.outputs).toEqual({ decision: false });
  });

  it("fails loudly when the host cannot await human input", async () => {
    const result = await runGraph(gateGraph, {}, { host: host(undefined) });
    expect(result.status).toBe("failed");
    expect(result.nodes.gate.status).toBe("failed");
    expect(result.nodes.gate.error).toContain("await human input");
  });

  it("fails a gate whose response violates the schema", async () => {
    const result = await runGraph(gateGraph, {}, {
      host: host(async () => ({ ok: true, output: '{"approved":"yes"}' })),
    });
    expect(result.status).toBe("failed");
    expect(result.nodes.gate.status).toBe("failed");
  });

  it("treats a dismissed gate as skipped", async () => {
    const result = await runGraph(gateGraph, {}, {
      host: host(async () => ({ ok: false, skipped: true, error: "dismissed" })),
    });
    expect(result.nodes.gate.status).toBe("skipped");
    expect(result.nodes.done.status).toBe("skipped");
  });
});
