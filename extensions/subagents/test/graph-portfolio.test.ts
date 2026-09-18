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
