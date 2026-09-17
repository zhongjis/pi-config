import { describe, expect, it } from "vitest";
import type { AgentGraph, GraphFragment } from "../src/graph/ir.js";
import type { NodeHost } from "../src/graph/node-host.js";
import { namespaceFragment, runGraph } from "../src/graph/run-graph.js";

/** A fragment whose two nodes are linked by an internal edge + input reference. */
const internalFragment: GraphFragment = {
  nodes: {
    a: { type: "agent", agent: "x", prompt: "a" },
    b: { type: "agent", agent: "x", prompt: "b", input: { v: { node: "a", path: "$" } } },
  },
  edges: [{ from: "a", to: "b" }],
  outputs: { out: { node: "b", path: "$" } },
};

/** A graph whose expand node reads its fragment from an upstream agent's output. */
function expandGraph(namespace?: string): AgentGraph {
  const exp: AgentGraph["nodes"]["exp"] =
    namespace === undefined
      ? { type: "expand", source: { node: "gen", path: "$" } }
      : { type: "expand", source: { node: "gen", path: "$" }, namespace };
  return {
    nodes: {
      gen: { type: "agent", agent: "x", prompt: "gen", outputSchema: { type: "object" } },
      exp,
    },
    edges: [{ from: "gen", to: "exp" }],
  };
}

describe("namespaceFragment", () => {
  it("prefixes internal ids and rewrites internal references, leaving external ones alone", () => {
    const withExternal: GraphFragment = {
      nodes: {
        a: { type: "agent", agent: "x", prompt: "a", input: { up: { node: "outside", path: "$" } } },
        b: { type: "agent", agent: "x", prompt: "b", input: { v: { node: "a", path: "$.k" } } },
      },
      edges: [
        { from: "outside", to: "a" },
        { from: "a", to: "b", when: { eq: [{ node: "a", path: "$.ok" }, true] } },
      ],
      outputs: { out: { node: "b", path: "$" } },
    };
    const placed = namespaceFragment(withExternal, "ns");
    expect(Object.keys(placed.nodes).sort()).toEqual(["ns:a", "ns:b"]);
    // Internal input ref rewritten; external ref ("outside") untouched.
    expect((placed.nodes["ns:b"] as { input: Record<string, { node?: string }> }).input.v.node).toBe("ns:a");
    expect((placed.nodes["ns:a"] as { input: Record<string, { node?: string }> }).input.up.node).toBe("outside");
    expect(placed.edges[0]).toMatchObject({ from: "outside", to: "ns:a" });
    expect(placed.edges[1]).toMatchObject({ from: "ns:a", to: "ns:b" });
    expect(placed.edges[1].when).toEqual({ eq: [{ node: "ns:a", path: "$.ok" }, true] });
    expect(placed.outputs?.out).toEqual({ node: "ns:b", path: "$" });
  });

  it("returns the fragment unchanged when no namespace is given", () => {
    expect(namespaceFragment(internalFragment, undefined)).toBe(internalFragment);
  });
});

describe("runGraph — expand nodes", () => {
  it("inserts a fragment from an upstream output and runs the new nodes to completion", async () => {
    const fragment: GraphFragment = { nodes: { w: { type: "agent", agent: "x", prompt: "w" } }, edges: [] };
    const host: NodeHost = {
      spawnAgent: async request => {
        if (request.nodeId === "gen") return { ok: true, output: JSON.stringify(fragment) };
        if (request.nodeId === "w") return { ok: true, output: "worked" };
        return { ok: true, output: "ok" };
      },
    };
    const result = await runGraph(expandGraph(), {}, { host });
    expect(result.status).toBe("completed");
    expect(result.nodes.exp.status).toBe("completed");
    expect(result.nodes.w.status).toBe("completed"); // the inserted node ran
    expect(result.nodes.w.output).toBe("worked");
  });

  it("fails the expand node when the resolved fragment is invalid", async () => {
    const bad = { nodes: { oops: { type: "nope" } }, edges: [] };
    const host: NodeHost = {
      spawnAgent: async request => (request.nodeId === "gen" ? { ok: true, output: JSON.stringify(bad) } : { ok: true, output: "ok" }),
    };
    const result = await runGraph(expandGraph(), {}, { host });
    expect(result.status).toBe("failed");
    expect(result.nodes.exp.status).toBe("failed");
    expect(result.nodes.exp.error).toContain("invalid");
  });

  it("fails the expand node when the source does not resolve to a fragment", async () => {
    // gen has no outputSchema, so its plain-text output reaches the expand source as a string.
    const g: AgentGraph = {
      nodes: {
        gen: { type: "agent", agent: "x", prompt: "gen" },
        exp: { type: "expand", source: { node: "gen", path: "$" } },
      },
      edges: [{ from: "gen", to: "exp" }],
    };
    const host: NodeHost = {
      spawnAgent: async request => (request.nodeId === "gen" ? { ok: true, output: "not-a-fragment" } : { ok: true, output: "ok" }),
    };
    const result = await runGraph(g, {}, { host });
    expect(result.status).toBe("failed");
    expect(result.nodes.exp.error).toContain("GraphFragment");
  });

  it("namespaces inserted ids and resolves their internal edges", async () => {
    const host: NodeHost = {
      spawnAgent: async request => {
        if (request.nodeId === "gen") return { ok: true, output: JSON.stringify(internalFragment) };
        return { ok: true, output: `${request.nodeId}-out` };
      },
    };
    const result = await runGraph(expandGraph("sub"), {}, { host });
    expect(result.status).toBe("completed");
    // Ids are prefixed, and sub:b completing proves its internal edge from sub:a was rewritten.
    expect(result.nodes["sub:a"].status).toBe("completed");
    expect(result.nodes["sub:b"].status).toBe("completed");
  });
});
