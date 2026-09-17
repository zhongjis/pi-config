import { describe, expect, it } from "vitest";
import type { AgentGraph } from "../src/graph/ir.js";
import type { NodeHost, NodeSpawnResult } from "../src/graph/node-host.js";
import { runGraph } from "../src/graph/run-graph.js";

/** A host that scripts each spawn by node id + attempt. */
function host(script: (nodeId: string, attempt: number) => NodeSpawnResult): NodeHost {
  return { spawnAgent: async request => script(request.nodeId, request.attempt) };
}
const okText = (output: string): NodeSpawnResult => ({ ok: true, output });

const reviewGraph: AgentGraph = {
  nodes: {
    implement: { type: "agent", agent: "x", prompt: "implement" },
    review: {
      type: "agent",
      agent: "x",
      prompt: "review",
      outputSchema: { type: "object", properties: { approved: { type: "boolean" } }, required: ["approved"] },
    },
    fix: { type: "agent", agent: "x", prompt: "fix" },
    done: { type: "agent", agent: "x", prompt: "done" },
  },
  edges: [
    { from: "implement", to: "review" },
    { from: "review", to: "done", when: { eq: [{ node: "review", path: "$.approved" }, true] } },
    { from: "review", to: "fix", when: { eq: [{ node: "review", path: "$.approved" }, false] } },
    { from: "fix", to: "review", loop: { maxIterations: 3 } },
  ],
  outputs: { approved: { node: "review", path: "$.approved" } },
};

describe("runGraph — end to end via XState actors", () => {
  it("runs a linear graph and resolves outputs", async () => {
    const graph: AgentGraph = {
      nodes: { a: { type: "agent", agent: "x", prompt: "a" }, b: { type: "agent", agent: "x", prompt: "b" } },
      edges: [{ from: "a", to: "b" }],
      outputs: { r: { node: "b", path: "$" } },
    };
    const result = await runGraph(graph, {}, { host: host(() => okText("out")) });
    expect(result.status).toBe("completed");
    expect(result.nodes.a.status).toBe("completed");
    expect(result.nodes.b.status).toBe("completed");
    expect(result.outputs).toEqual({ r: "out" });
  });

  it("drives a review->fix loop to approval through real actors", async () => {
    const result = await runGraph(reviewGraph, {}, {
      host: host((id, attempt) => (id === "review" ? okText(JSON.stringify({ approved: attempt >= 3 })) : okText("ok"))),
    });
    expect(result.status).toBe("completed");
    expect(result.nodes.review.attempt).toBe(3);
    expect(result.nodes.fix.attempt).toBe(2);
    expect(result.nodes.done.status).toBe("completed");
    expect(result.outputs).toEqual({ approved: true });
  });

  it("fails a node whose structured output violates its schema", async () => {
    const result = await runGraph(reviewGraph, {}, {
      host: host((id) => (id === "review" ? okText('{"approved":"yes"}') : okText("ok"))),
    });
    expect(result.status).toBe("failed");
    expect(result.nodes.review.status).toBe("failed");
    expect(result.nodes.done.status).toBe("skipped");
  });

  it("returns aborted when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runGraph(reviewGraph, {}, { host: host(() => okText("ok")), signal: controller.signal });
    expect(result.status).toBe("aborted");
  });

  it("fails a node type that is not implemented yet", async () => {
    const graph: AgentGraph = {
      nodes: { g: { type: "human_gate", prompt: "approve?", outputSchema: { type: "object" } } },
      edges: [],
    };
    const result = await runGraph(graph, {}, { host: host(() => okText("x")) });
    expect(result.status).toBe("failed");
    expect(result.nodes.g.error).toContain("not supported yet");
  });

  it("reports node updates as the run progresses", async () => {
    const seen: string[] = [];
    await runGraph(reviewGraph, {}, {
      host: host((id, attempt) => (id === "review" ? okText(JSON.stringify({ approved: attempt >= 1 })) : okText("ok"))),
      onNodeUpdate: (id, run) => seen.push(`${id}:${run.status}`),
    });
    expect(seen).toContain("implement:running");
    expect(seen).toContain("done:completed");
  });
});
