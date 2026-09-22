import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AgentGraph, GraphNode } from "../src/graph/ir.js";
import { runGraph } from "../src/graph/run-graph.js";
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
  "context-gather",
] as const;

const INITIAL_TASK_SCHEMA = {
  type: "object",
  properties: {
    source: { type: "string", enum: ["project", "platform", "upstream", "work-records", "practice"] },
    question: { type: "string" },
    reason: { type: "string" },
  },
  required: ["source", "question"],
} as const;

const EVIDENCE_SCHEMA = {
  type: "object",
  properties: {
    source: { type: "string", enum: ["project", "platform", "upstream", "work-records", "practice"] },
    evidence: {
      type: "array",
      items: {
        type: "object",
        properties: {
          claim: { type: "string" },
          provenance: {
            type: "array",
            items: {
              type: "object",
              properties: { reference: { type: "string" }, detail: { type: "string" } },
              required: ["reference", "detail"],
            },
          },
        },
        required: ["claim", "provenance"],
      },
    },
    relevantFiles: { type: "array", items: { type: "string" } },
    constraints: { type: "array", items: { type: "string" } },
    unknowns: { type: "array", items: { type: "string" } },
    conflicts: { type: "array", items: { type: "string" } },
  },
  required: ["source", "evidence", "relevantFiles", "constraints", "unknowns", "conflicts"],
} as const;


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
  const resolved = resolveSavedGraph("context-gather", REPO_ROOT);
  expect(resolved.ok, resolved.ok ? "" : resolved.message).toBe(true);
  if (!resolved.ok) return;
  const description = (resolved.graph as { description?: unknown }).description;
  expect(typeof description).toBe("string");
  if (typeof description !== "string") return;
  expect(description.trim()).not.toBe("");
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

function agentNode(graph: AgentGraph, id: string): Extract<GraphNode, { type: "agent" }> {
  const node = graph.nodes[id];
  expect(node?.type, id).toBe("agent");
  if (node?.type !== "agent") throw new Error(`Expected ${id} to be an agent`);
  return node;
}

function boundedFeedbackNode(graph: AgentGraph, id: string): Extract<GraphNode, { type: "bounded_feedback" }> {
  const node = graph.nodes[id];
  expect(node?.type, id).toBe("bounded_feedback");
  if (node?.type !== "bounded_feedback") throw new Error(`Expected ${id} to be bounded feedback`);
  return node;
}

describe("adaptive context-gather contract", () => {
  it("uses one bounded-feedback research region with exact bounds", () => {
    const graph = savedGraph("context-gather");
    requiresInput(graph, "request");
    requiresInput(graph, "tasks");
    expect(graph.version).toBe(2);
    expect(Object.keys(graph.nodes)).toEqual(["research", "synthesize"]);
    expect(Object.values(graph.nodes).filter(node => node.type === "bounded_feedback")).toHaveLength(1);
    expect(Object.values(graph.nodes).some(node => node.type === "fanout" || node.type === "expand")).toBe(false);
    expect(graph.edges).toEqual([{ from: "research", to: "synthesize" }]);

    const research = boundedFeedbackNode(graph, "research");
    expect(research.name).toBe("Research");
    expect(research.maxIterations).toBe(2);
    expect(research.maxItemsPerIteration).toBe(200);
    expect(research.maxTotalItems).toBe(400);
    expect(research.work).toMatchObject({
      type: "fanout",
      name: "Gather evidence",
      items: { path: "$.tasks" },
      itemSchema: INITIAL_TASK_SCHEMA,
      dispatch: {
        path: "$.source",
        cases: {
          project: "chengfeng",
          platform: "wenchang",
          upstream: "wenchang",
          "work-records": "wenchang",
          practice: "wenchang",
        },
      },
      input: { request: { path: "$.request" } },
      outputSchema: EVIDENCE_SCHEMA,
    });
  });

  it("uses the reserved accumulated feedback evaluator contract", () => {
    const research = boundedFeedbackNode(savedGraph("context-gather"), "research");
    expect(research.evaluator).toMatchObject({
      type: "agent",
      name: "Evaluate evidence",
      agent: "direnjie",
      input: { request: { path: "$.request" }, tasks: { path: "$.tasks" } },
      retry: { maxAttempts: 2 },
    });
    expect(research.evaluator.input).not.toHaveProperty("feedback");
    expect(research.evaluator.outputSchema).toBeUndefined();
    for (const placeholder of [`\${request}`, `\${tasks}`, `\${feedback}`]) expect(research.evaluator.prompt).toContain(placeholder);
    expect(research.evaluator.prompt).toContain("gapId");
    expect(research.evaluator.prompt.toLowerCase()).toContain("do not add practice research by default");
  });

  it("runs sufficient and one-continuation evidence fixtures without materializing future work", async () => {
    const sufficient = { decision: "sufficient", gaps: [], tasks: [] };
    const continueOnce = {
      decision: "continue",
      gaps: [{ id: "platform-gap", description: "Platform behavior is unverified" }],
      tasks: [{ gapId: "platform-gap", item: { source: "platform", question: "Verify the platform behavior", reason: "Close platform-gap" } }],
    };
    const gatheredContext = {
      summary: "Evidence gathered.", relevantFiles: [], constraints: [], unknowns: [],
      evidence: [{ claim: "Observed evidence", provenance: [{ reference: "fixture", detail: "stub" }] }], conflicts: [],
    };
    for (const [fixture, expectedAgents] of [
      [[sufficient], ["chengfeng", "direnjie", "jintong"]],
      [[continueOnce, sufficient], ["chengfeng", "direnjie", "wenchang", "direnjie", "jintong"]],
    ] as const) {
      const decisions = [...fixture];
      const agents: string[] = [];
      let bindings: string[] = [];
      const result = await runGraph(savedGraph("context-gather"), {
        request: "Gather context",
        tasks: [{ source: "project", question: "Find the implementation" }],
      }, {
        onCheckpoint: (_state, effective) => { bindings = Object.keys(effective.nodes); },
        host: { spawnAgent: async request => {
          agents.push(request.agentType);
          if (request.agentType === "direnjie") return { ok: true, output: JSON.stringify(decisions.shift()) };
          if (request.agentType === "jintong") return { ok: true, output: JSON.stringify(gatheredContext) };
          return { ok: true, output: JSON.stringify({ source: "project", evidence: [], relevantFiles: [], constraints: [], unknowns: [], conflicts: [] }) };
        } },
      });
      expect(result.status).toBe("completed");
      expect(result.outputs).toEqual(gatheredContext);
      expect(agents).toEqual(expectedAgents);
      if (expectedAgents.length === 3) expect(bindings.some(id => id.includes(":iteration:2:"))).toBe(false);
      else expect(bindings.filter(id => id.includes(":iteration:2:")).length).toBe(3);
    }
  });

  it("preserves GatheredContext outputs and synthesis input", () => {
    const graph = savedGraph("context-gather");
    expect(graph.outputs).toEqual({
      summary: { node: "synthesize", path: "$.summary" },
      relevantFiles: { node: "synthesize", path: "$.relevantFiles" },
      constraints: { node: "synthesize", path: "$.constraints" },
      unknowns: { node: "synthesize", path: "$.unknowns" },
      evidence: { node: "synthesize", path: "$.evidence" },
      conflicts: { node: "synthesize", path: "$.conflicts" },
      $subagentWorkflowOutcome: { node: "synthesize", path: "$.outcome" },
    });
    const synthesize = agentNode(graph, "synthesize");
    expect(synthesize.agent).toBe("jintong");
    expect(synthesize.name).toBe("Synthesize context");
    expect(synthesize.input).toEqual({
      request: { path: "$.request" },
      tasks: { path: "$.tasks" },
      research: { node: "research", path: "$" },
    });
    expect(synthesize.outputSchema).toMatchObject({
      type: "object",
      properties: { evidence: EVIDENCE_SCHEMA.properties.evidence },
      required: ["summary", "relevantFiles", "constraints", "unknowns", "evidence", "conflicts"],
    });
  });
});

