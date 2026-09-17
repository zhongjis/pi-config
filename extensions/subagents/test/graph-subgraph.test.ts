import { describe, expect, it } from "vitest";
import type { AgentGraph } from "../src/graph/ir.js";
import type { NodeHost } from "../src/graph/node-host.js";
import { runGraph } from "../src/graph/run-graph.js";

/** A child graph whose single node's value becomes the declared `echo` output. */
const childGraph: AgentGraph = {
  nodes: { inner: { type: "agent", agent: "x", prompt: "inner" } },
  edges: [],
  outputs: { echo: { node: "inner", path: "$" } },
};

/** Parent graph: a `graph` node composes the child, feeding a downstream agent + output. */
const parentGraph: AgentGraph = {
  nodes: {
    sub: { type: "graph", graph: "child", input: {} },
    finish: { type: "agent", agent: "x", prompt: "finish", input: { echo: { node: "sub", path: "$.echo" } } },
  },
  edges: [{ from: "sub", to: "finish" }],
  outputs: { result: { node: "sub", path: "$.echo" } },
};

const loadGraph = (name: string): AgentGraph | undefined => (name === "child" ? childGraph : undefined);

describe("runGraph — subgraph (graph) nodes", () => {
  it("composes a child graph; its outputs become the node output and flow downstream", async () => {
    const host: NodeHost = {
      spawnAgent: async request => (request.nodeId === "inner" ? { ok: true, output: "child-out" } : { ok: true, output: "ok" }),
    };
    const result = await runGraph(parentGraph, {}, { host, loadGraph });
    expect(result.status).toBe("completed");
    expect(result.nodes.sub.status).toBe("completed");
    expect(result.nodes.sub.output).toEqual({ echo: "child-out" }); // child outputs became the node output
    expect(result.nodes.finish.status).toBe("completed"); // the downstream node ran on the subgraph
    expect(result.outputs).toEqual({ result: "child-out" }); // and reached a declared graph output
  });

  it("fails the subgraph node when the child run fails", async () => {
    const host: NodeHost = {
      spawnAgent: async request => (request.nodeId === "inner" ? { ok: false, error: "boom" } : { ok: true, output: "ok" }),
    };
    const result = await runGraph(parentGraph, {}, { host, loadGraph });
    expect(result.status).toBe("failed");
    expect(result.nodes.sub.status).toBe("failed");
    expect(result.nodes.sub.error).toContain("failed");
    expect(result.nodes.finish.status).toBe("skipped");
  });

  it("fails the subgraph node when no loader is provided", async () => {
    const host: NodeHost = { spawnAgent: async () => ({ ok: true, output: "ok" }) };
    const result = await runGraph(parentGraph, {}, { host });
    expect(result.status).toBe("failed");
    expect(result.nodes.sub.status).toBe("failed");
    expect(result.nodes.sub.error).toContain("loadGraph");
  });
});
