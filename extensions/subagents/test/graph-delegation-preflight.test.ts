import { describe, expect, it } from "vitest";
import { checkGraphDelegation } from "../src/graph/delegation-preflight.js";
import type { AgentGraph } from "../src/graph/ir.js";

describe("checkGraphDelegation", () => {
  it("allows a graph when denyReason permits every agent", () => {
    const graph: AgentGraph = {
      nodes: {
        implement: { type: "agent", agent: "jintong", prompt: "do" },
        review: { type: "agent", agent: "taishang", prompt: "review" },
      },
      edges: [{ from: "implement", to: "review" }],
    };
    expect(checkGraphDelegation(graph, () => undefined)).toEqual({ ok: true });
  });

  it("denies a graph with an agent the active mode cannot delegate to", () => {
    const graph: AgentGraph = {
      nodes: { review: { type: "agent", agent: "yanluo", prompt: "review" } },
      edges: [],
    };
    const deny = (type: string): string | undefined =>
      type === "yanluo"
        ? `delegation_policy_denied: Agent "kuafu" cannot delegate to "yanluo". Allowed targets: taishang, direnjie.`
        : undefined;
    const result = checkGraphDelegation(graph, deny);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected denial");
    expect(result.error).toContain("yanluo");
    expect(result.error).toContain("review");
    expect(result.error).toContain("Allowed targets: taishang, direnjie");
    expect(result.error).toContain("delegation_policy_denied");
  });

  it("aggregates multiple nodes on one denied agent and calls denyReason once", () => {
    const graph: AgentGraph = {
      nodes: {
        first: { type: "agent", agent: "yanluo", prompt: "a" },
        second: { type: "agent", agent: "yanluo", prompt: "b" },
      },
      edges: [],
    };
    let calls = 0;
    const result = checkGraphDelegation(graph, type => {
      if (type !== "yanluo") return undefined;
      calls++;
      return "policy blocks this delegation target";
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected denial");
    expect(calls).toBe(1);
    expect(result.error).toContain("first");
    expect(result.error).toContain("second");
    // The denied agent is listed once, on a single aggregated bullet.
    expect(result.error.match(/yanluo/g)?.length).toBe(1);
  });

  it("recurses into a subgraph node and names a denied agent inside it", () => {
    const parent: AgentGraph = {
      nodes: { sub: { type: "graph", graph: "child" } },
      edges: [],
    };
    const child: AgentGraph = {
      nodes: { inner: { type: "agent", agent: "yanluo", prompt: "x" } },
      edges: [],
    };
    const load = (name: string): AgentGraph | undefined => (name === "child" ? child : undefined);
    const deny = (type: string): string | undefined => (type === "yanluo" ? `denied: ${type}` : undefined);
    const result = checkGraphDelegation(parent, deny, load);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected denial");
    expect(result.error).toContain("yanluo");
    expect(result.error).toContain("inner");
  });

  it("does not infinite-loop when a subgraph references its own name", () => {
    const parent: AgentGraph = {
      nodes: {
        self: { type: "graph", graph: "loop" },
        ok: { type: "agent", agent: "jintong", prompt: "ok" },
      },
      edges: [],
    };
    const loopGraph: AgentGraph = {
      nodes: { again: { type: "graph", graph: "loop" } },
      edges: [],
    };
    const load = (name: string): AgentGraph | undefined => (name === "loop" ? loopGraph : undefined);
    expect(checkGraphDelegation(parent, () => undefined, load)).toEqual({ ok: true });
  });

  it("skips a subgraph node when no loader is provided", () => {
    const parent: AgentGraph = {
      nodes: { sub: { type: "graph", graph: "child" } },
      edges: [],
    };
    // Without a loader the subgraph is unresolvable statically — runtime handles it.
    expect(checkGraphDelegation(parent, () => "denied everything")).toEqual({ ok: true });
  });

  it("ignores expand and human_gate nodes (no false positives)", () => {
    const graph: AgentGraph = {
      nodes: {
        work: { type: "agent", agent: "jintong", prompt: "w" },
        gate: { type: "human_gate", prompt: "approve?", outputSchema: { type: "object" } },
        grow: { type: "expand", source: { path: "$.fragment" } },
      },
      edges: [],
    };
    expect(checkGraphDelegation(graph, () => undefined)).toEqual({ ok: true });
  });
});
