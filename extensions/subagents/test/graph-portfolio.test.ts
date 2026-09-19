import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AgentGraph, GraphNode } from "../src/graph/ir.js";
import { resolveSavedGraph } from "../src/graph/saved-graph.js";
import { validateGraph } from "../src/graph/validate.js";

/**
 * The shipped reusable-workflow portfolio (docs/specs/agent-graph-reusable-workflows.md)
 * must always resolve and validate. These saved graphs are Pi's known-good
 * starting points, so a shape regression in one of them should fail here rather
 * than at a live tool call. `cwd` is the repo root, mirroring how the runtime
 * resolves `agent-graphs/<name>.graph.json` in production.
 */
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

const PORTFOLIO = [
  "shared/context-gather",
  "shared/review-loop",
  "shared/work-verify",
  "fuxi/ulw-plan",
  "houtu/execute-plan",
  "kuafu/ulw",
] as const;

describe("agent-graph reusable-workflow portfolio", () => {
  for (const name of PORTFOLIO) {
    it(`resolves and validates ${name}`, () => {
      const resolved = resolveSavedGraph(name, REPO_ROOT);
      expect(resolved.ok, resolved.ok ? "" : resolved.message).toBe(true);
      if (!resolved.ok) return;
      const verdict = validateGraph(resolved.graph);
      expect(verdict.ok, verdict.errors.join("\n")).toBe(true);
    });
  }
});

it("describes the context-gather graph", () => {
  const resolved = resolveSavedGraph("shared/context-gather", REPO_ROOT);
  expect(resolved.ok, resolved.ok ? "" : resolved.message).toBe(true);
  if (!resolved.ok) return;
  const description = (resolved.graph as { description?: unknown }).description;
  expect(typeof description).toBe("string");
  if (typeof description !== "string") return;
  expect(description.trim()).not.toBe("");
});

/**
 * The two review-bearing shared graphs were reconciled off `yanluo` (which the
 * kuafu mode may not delegate to) and onto permitted targets. Guard the property
 * that keeps them runnable under that mode: no denied agent, all within the set.
 */
describe("reconciled shared graphs stay within permitted delegation targets", () => {
  const ALLOWED = new Set(["jintong", "taishang", "direnjie", "cangjie"]);
  for (const name of ["shared/work-verify", "shared/review-loop"] as const) {
    it(`${name} has no denied agent and stays within the allowed set`, () => {
      const resolved = resolveSavedGraph(name, REPO_ROOT);
      expect(resolved.ok, resolved.ok ? "" : resolved.message).toBe(true);
      if (!resolved.ok) return;
      const verdict = validateGraph(resolved.graph);
      expect(verdict.ok, verdict.errors.join("\n")).toBe(true);
      const graph = resolved.graph as AgentGraph;
      const agents = Object.values(graph.nodes)
        .filter((node): node is Extract<GraphNode, { type: "agent" }> => node.type === "agent")
        .map(node => node.agent);
      expect(agents).not.toContain("yanluo");
      for (const agent of agents) expect(ALLOWED.has(agent), `unexpected agent ${agent}`).toBe(true);
    });
  }
});

function savedGraph(name: string): AgentGraph {
  const resolved = resolveSavedGraph(name, REPO_ROOT);
  expect(resolved.ok, resolved.ok ? "" : resolved.message).toBe(true);
  if (!resolved.ok) throw new Error(resolved.message);
  return resolved.graph as AgentGraph;
}

function requiresInput(graph: AgentGraph, field: string): void {
  const schema = graph.inputSchema as { properties?: Record<string, unknown>; required?: unknown } | undefined;
  expect(schema?.properties).toHaveProperty(field);
  expect(schema?.required).toContain(field);
}

function hasBooleanGuard(graph: AgentGraph, from: string, to: string, path: string): boolean {
  return graph.edges.some(edge => {
    if (edge.from !== from || edge.to !== to || edge.when === undefined || !("eq" in edge.when)) return false;
    const [ref, value] = edge.when.eq;
    return ref.node === from && ref.path === path && value === true;
  });
}

describe("adaptive context-gather contract", () => {
  const sources = {
    project: { first: "project-round-one", second: "project-round-two", agent: "chengfeng", firstFlag: "$.hasProject", secondFlag: "$.needsProject" },
    platform: { first: "platform-round-one", second: "platform-round-two", agent: "wenchang", firstFlag: "$.hasPlatform", secondFlag: "$.needsPlatform" },
    upstream: { first: "upstream-round-one", second: "upstream-round-two", agent: "wenchang", firstFlag: "$.hasUpstream", secondFlag: "$.needsUpstream" },
    "work-records": { first: "work-records-round-one", second: "work-records-round-two", agent: "wenchang", firstFlag: "$.hasWorkRecords", secondFlag: "$.needsWorkRecords" },
    practice: { first: "practice-round-one", second: "practice-round-two", agent: "wenchang", firstFlag: "$.hasPractice", secondFlag: "$.needsPractice" },
  } as const;

  it("routes five on-demand lanes through at most two conditional rounds", () => {
    const graph = savedGraph("shared/context-gather");
    requiresInput(graph, "request");
    requiresInput(graph, "tasks");
    expect(graph.nodes["route-round-one"]?.type).toBe("agent");
    expect(graph.nodes["evaluate-round-one"]?.type).toBe("agent");
    expect(graph.nodes.synthesize?.type).toBe("agent");
    expect(Object.values(graph.nodes).some(node => node.type === "expand")).toBe(false);

    for (const [source, lane] of Object.entries(sources)) {
      const first = graph.nodes[lane.first];
      const second = graph.nodes[lane.second];
      expect(first?.type, `${source} round one`).toBe("agent");
      expect(second?.type, `${source} round two`).toBe("agent");
      if (first?.type === "agent") expect(first.agent).toBe(lane.agent);
      if (second?.type === "agent") expect(second.agent).toBe(lane.agent);
      expect(hasBooleanGuard(graph, "route-round-one", lane.first, lane.firstFlag)).toBe(true);
      expect(hasBooleanGuard(graph, "evaluate-round-one", lane.second, lane.secondFlag)).toBe(true);
    }
    expect(graph.edges).toContainEqual({ from: "route-round-one", to: "evaluate-round-one" });
    expect(graph.edges).toContainEqual({ from: "evaluate-round-one", to: "synthesize" });
  });

  it("preserves GatheredContext outputs and adds evidence provenance and conflicts", () => {
    const graph = savedGraph("shared/context-gather");
    for (const output of ["summary", "relevantFiles", "constraints", "unknowns", "evidence", "conflicts"]) {
      expect(graph.outputs).toHaveProperty(output);
    }
    const synthesize = graph.nodes.synthesize;
    expect(synthesize?.type).toBe("agent");
    if (synthesize?.type === "agent") {
      const properties = synthesize.outputSchema?.properties as Record<string, unknown> | undefined;
      const evidence = properties?.evidence as { items?: { properties?: Record<string, unknown>; required?: unknown } } | undefined;
      expect(evidence?.items?.properties).toHaveProperty("claim");
      expect(evidence?.items?.properties).toHaveProperty("provenance");
      expect(evidence?.items?.required).toEqual(["claim", "provenance"]);
    }
    for (const lane of Object.values(sources)) {
      for (const nodeId of [lane.first, lane.second]) {
        const node = graph.nodes[nodeId];
        expect(node?.type).toBe("agent");
        if (node?.type !== "agent") continue;
        const properties = node.outputSchema?.properties as Record<string, unknown> | undefined;
        for (const field of ["evidence", "relevantFiles", "constraints", "unknowns", "conflicts"]) {
          expect(properties).toHaveProperty(field);
        }
        const evidence = properties?.evidence as { items?: { properties?: Record<string, unknown> } } | undefined;
        expect(evidence?.items?.properties).toHaveProperty("claim");
        expect(evidence?.items?.properties).toHaveProperty("provenance");
      }
    }
  });
});

describe("context-gather callers", () => {
  for (const name of ["fuxi/ulw-plan", "kuafu/ulw"] as const) {
    it(`${name} requires and forwards caller-planned context tasks`, () => {
      const graph = savedGraph(name);
      requiresInput(graph, "request");
      requiresInput(graph, "tasks");
      const context = graph.nodes.context;
      expect(context?.type).toBe("graph");
      if (context?.type !== "graph") return;
      expect(context.graph).toBe("shared/context-gather");
      expect(context.input?.request).toEqual({ path: "$.request" });
      expect(context.input?.tasks).toEqual({ path: "$.tasks" });
    });
  }
});
