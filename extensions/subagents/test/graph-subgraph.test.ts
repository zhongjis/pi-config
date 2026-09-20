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

function savedChain(depth: number): { root: AgentGraph; loadGraph: (name: string) => AgentGraph | undefined } {
  const saved = new Map<string, AgentGraph>();
  saved.set(`saved-${depth}`, { nodes: { leaf: { type: "agent", agent: `worker-${depth}`, prompt: "leaf" } }, edges: [] });
  for (let level = depth - 1; level >= 0; level--) {
    saved.set(`saved-${level}`, { nodes: { child: { type: "graph", graph: `saved-${level + 1}`, input: {} } }, edges: [] });
  }
  const root = saved.get("saved-0");
  if (!root) throw new Error("Missing saved-chain root");
  return { root, loadGraph: name => saved.get(name) };
}

it.each([32, 33])("enforces the shared graph depth limit at %i", async depth => {
  const chain = savedChain(depth);
  const created: string[] = [];
  const selectors: string[] = [];
  const run = runGraph(chain.root, {}, {
    loadGraph: chain.loadGraph,
    host: { spawnAgent: async request => { selectors.push(request.agentType); return { ok: true, output: "leaf" }; } },
    onNodeAdded: id => created.push(id),
  });
  if (depth > 32) { await expect(run).rejects.toThrow(/depth 32/); expect(selectors).toEqual([]); return; }
  const result = await run;
  expect(result.status).toBe("completed");
  expect(selectors).toEqual([`worker-${depth}`]);
  expect(created.some(id => id.endsWith("/leaf"))).toBe(true);
}, 20_000);
