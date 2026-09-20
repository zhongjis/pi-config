import { describe, expect, it } from "vitest";
import type { AgentGraph } from "../src/graph/ir.js";
import { MAX_NODES, validateFragment, validateGraph } from "../src/graph/validate.js";

/** A well-formed review -> fix loop: agent + condition + bounded loop + gate + human gate + outputs. */
function reviewLoopGraph(): AgentGraph {
  return {
    id: "shared/review-loop",
    name: "review loop",
    version: 1,
    inputSchema: { type: "object", properties: { task: { type: "string" } }, required: ["task"] },
    nodes: {
      implement: {
        type: "agent",
        agent: "jintong",
        prompt: "Implement the task",
        input: { task: { path: "$.task" } },
        outputSchema: { type: "object", properties: { diff: { type: "string" } }, required: ["diff"] },
        validation: { gate: "npm test" },
        retry: { maxAttempts: 2 },
        resources: ["workspace:main"],
      },
      review: {
        type: "agent",
        agent: "yanluo",
        prompt: "Review the diff",
        input: { diff: { node: "implement", path: "$.diff" } },
        outputSchema: {
          type: "object",
          properties: { approved: { type: "boolean" }, issues: { type: "array", items: { type: "string" } } },
          required: ["approved", "issues"],
          additionalProperties: false,
        },
      },
      fix: { type: "agent", agent: "jintong", prompt: "Fix the issues" },
      approve: { type: "human_gate", prompt: "Approve?", outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] } },
    },
    edges: [
      { from: "implement", to: "review" },
      { from: "review", to: "approve", when: { eq: [{ node: "review", path: "$.approved" }, true] } },
      { from: "review", to: "fix", when: { eq: [{ node: "review", path: "$.approved" }, false] } },
      { from: "fix", to: "review", loop: { maxIterations: 3 } },
    ],
    outputs: { approved: { node: "review", path: "$.approved" } },
  };
}

describe("validateGraph — accepts well-formed graphs", () => {
  it("accepts a minimal single-agent graph", () => {
    const result = validateGraph({ nodes: { a: { type: "agent", agent: "jintong", prompt: "do it" } }, edges: [] });
    expect(result).toEqual({ ok: true, errors: [] });
  });

  it("accepts a review->fix loop with conditions, gate, loop, human gate, and outputs", () => {
    const result = validateGraph(reviewLoopGraph());
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("accepts all boolean/numeric/logical condition operators", () => {
    const graph: AgentGraph = {
      nodes: {
        a: { type: "agent", agent: "x", prompt: "p", outputSchema: { type: "object", properties: { n: { type: "number" }, s: { type: "string" } } } },
        b: { type: "agent", agent: "x", prompt: "p" },
      },
      edges: [
        {
          from: "a",
          to: "b",
          when: {
            and: [
              { gt: [{ node: "a", path: "$.n" }, 1] },
              { or: [{ exists: { node: "a", path: "$.s" } }, { not: { eq: [{ node: "a", path: "$.s" }, ""] } }] },
            ],
          },
        },
      ],
    };
    expect(validateGraph(graph).ok).toBe(true);
  });

  it("accepts an agent prompt whose placeholder is wired in input", () => {
    const graph: AgentGraph = {
      nodes: { a: { type: "agent", agent: "x", prompt: `Fix \${task}`, input: { task: { path: "$.task" } } } },
      edges: [],
    };
    expect(validateGraph(graph)).toEqual({ ok: true, errors: [] });
  });
});

  it("accepts an optional description but rejects a non-string value", () => {
    const graph = {
      description: "Gather repository context before implementation.",
      nodes: { a: { type: "agent", agent: "x", prompt: "p" } },
      edges: [],
    };
    expect(validateGraph(graph)).toEqual({ ok: true, errors: [] });
    expect(validateGraph({ ...graph, description: 1 }).errors).toContain("description: must be a string when present");
  });

describe("validateGraph — rejects malformed graphs", () => {
  const bad = (graph: unknown): string[] => validateGraph(graph).errors;

  it("rejects a non-object graph", () => {
    expect(validateGraph(null).ok).toBe(false);
    expect(validateGraph([]).ok).toBe(false);
  });

  it("rejects missing/empty nodes", () => {
    expect(bad({ edges: [] })).toContain("nodes: must be an object of { id: GraphNode }");
    expect(bad({ nodes: {}, edges: [] })).toContain("nodes: must declare at least one node");
  });

  it("rejects an unknown node type", () => {
    const errors = bad({ nodes: { a: { type: "action", action: "sh" } }, edges: [] });
    expect(errors.some(e => e.includes("nodes.a.type") && e.includes("agent | human_gate | graph | expand"))).toBe(true);
  });

  it("rejects an agent prompt whose placeholder is not wired in input", () => {
    const errors = bad({
      nodes: { a: { type: "agent", agent: "x", prompt: `Fix \${task} for \${owner}`, input: { task: { path: "$.task" } } } },
      edges: [],
    });
    expect(errors).toContain(`nodes.a.prompt: references \${owner} but node.input has no "owner" mapping`);
    expect(errors.some(e => e.includes(`\${task}`))).toBe(false);
  });

  it("rejects a human_gate prompt placeholder that is not wired in input", () => {
    const errors = bad({
      nodes: {
        g: {
          type: "human_gate",
          prompt: `Approve \${plan}?`,
          outputSchema: { type: "object", properties: { approved: { type: "boolean" } }, required: ["approved"] },
        },
      },
      edges: [],
    });
    expect(errors).toContain(`nodes.g.prompt: references \${plan} but node.input has no "plan" mapping`);
  });

  it("rejects an agent node missing agent/prompt", () => {
    const errors = bad({ nodes: { a: { type: "agent" } }, edges: [] });
    expect(errors).toContain("nodes.a.agent: must be a non-empty agent selector");
    expect(errors).toContain("nodes.a.prompt: must be a non-empty prompt");
  });

  it("requires outputSchema on a human_gate", () => {
    const errors = bad({ nodes: { g: { type: "human_gate", prompt: "ok?" } }, edges: [] });
    expect(errors).toContain("nodes.g.outputSchema: is required for a human_gate node");
  });

  it("rejects edges referencing unknown nodes", () => {
    const errors = bad({ nodes: { a: { type: "agent", agent: "x", prompt: "p" } }, edges: [{ from: "a", to: "ghost" }] });
    expect(errors).toContain('edges[0].to: references unknown node "ghost"');
  });

  it("rejects a ValueRef to an unknown node", () => {
    const errors = bad({
      nodes: { a: { type: "agent", agent: "x", prompt: "p", input: { v: { node: "ghost", path: "$.x" } } } },
      edges: [],
    });
    expect(errors).toContain('nodes.a.input.v.node: references unknown node "ghost"');
  });

  it("rejects a ValueRef with a non-$ path", () => {
    const errors = bad({
      nodes: { a: { type: "agent", agent: "x", prompt: "p", input: { v: { path: "approved" } } } },
      edges: [],
    });
    expect(errors).toContain('nodes.a.input.v.path: must be a JSONPath string starting with "$"');
  });

  it("rejects malformed conditions", () => {
    const twoOps = bad({
      nodes: { a: { type: "agent", agent: "x", prompt: "p" }, b: { type: "agent", agent: "x", prompt: "p" } },
      edges: [{ from: "a", to: "b", when: { eq: [{ path: "$.x" }, 1], ne: [{ path: "$.y" }, 2] } }],
    });
    expect(twoOps.some(e => e.includes("must have exactly one operator"))).toBe(true);

    const numeric = bad({
      nodes: { a: { type: "agent", agent: "x", prompt: "p" }, b: { type: "agent", agent: "x", prompt: "p" } },
      edges: [{ from: "a", to: "b", when: { gt: [{ path: "$.x" }, "not-a-number"] } }],
    });
    expect(numeric).toContain("edges[0].when.gt[1]: must be a number");

    const unknownOp = bad({
      nodes: { a: { type: "agent", agent: "x", prompt: "p" }, b: { type: "agent", agent: "x", prompt: "p" } },
      edges: [{ from: "a", to: "b", when: { between: [1, 2] } }],
    });
    expect(unknownOp.some(e => e.includes('unknown operator "between"'))).toBe(true);
  });

  it("rejects a bad loop bound", () => {
    const errors = bad({
      nodes: { a: { type: "agent", agent: "x", prompt: "p" }, b: { type: "agent", agent: "x", prompt: "p" } },
      edges: [{ from: "a", to: "b", loop: { maxIterations: 0 } }],
    });
    expect(errors).toContain("edges[0].loop.maxIterations: must be a positive integer");
  });

  it("rejects an invalid node outputSchema", () => {
    const errors = bad({ nodes: { a: { type: "agent", agent: "x", prompt: "p", outputSchema: { type: "nonsense" } } }, edges: [] });
    expect(errors.some(e => e.startsWith("nodes.a.outputSchema:"))).toBe(true);
  });

  it("rejects too many nodes", () => {
    const nodes: Record<string, unknown> = {};
    for (let i = 0; i <= MAX_NODES; i++) nodes[`n${i}`] = { type: "agent", agent: "x", prompt: "p" };
    expect(bad({ nodes, edges: [] }).some(e => e.includes(`exceeds the limit of ${MAX_NODES}`))).toBe(true);
  });
});

describe("validateFragment — expansion against existing ids", () => {
  it("accepts a fragment whose edges reference existing run-graph nodes", () => {
    const result = validateFragment(
      { nodes: { t1: { type: "agent", agent: "x", prompt: "p" } }, edges: [{ from: "root", to: "t1" }] },
      ["root"],
    );
    expect(result).toEqual({ ok: true, errors: [] });
  });

  it("rejects a fragment id that collides with an existing node", () => {
    const result = validateFragment({ nodes: { root: { type: "agent", agent: "x", prompt: "p" } }, edges: [] }, ["root"]);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("nodes.root: collides with an id already in the run graph");
  });

  it("rejects a non-object fragment", () => {
    expect(validateFragment(42, []).ok).toBe(false);
  });
});

describe("fanout validation", () => {
  const node = {
    type: "fanout", items: { path: "$.tasks" }, itemSchema: { type: "object" },
    dispatch: { path: "$.source", cases: { project: "local" } },
    prompt: `\${item} \${context}`, input: { context: { path: "$.context" } },
    phase: { index: 0, title: "Round 1/2" },
  };
  it("accepts typed items and reserved item interpolation", () => {
    expect(validateGraph({ nodes: { work: node }, edges: [] })).toEqual({ ok: true, errors: [] });
  });
  it.each([
    ["items", { path: "tasks" }, "items.path"],
    ["items", { node: "unknown", path: "$" }, "items.node"],
    ["itemSchema", { type: "array" }, "itemSchema"],
    ["outputSchema", { type: "string" }, "outputSchema"],
    ["dispatch", { path: "source", cases: { project: "x" } }, "dispatch.path"],
    ["dispatch", { path: "$.source[", cases: { project: "x" } }, "dispatch.path"],
    ["dispatch", { path: "$.source", cases: {} }, "dispatch.cases"],
    ["dispatch", { path: "$.source", cases: { project: " " } }, "dispatch.cases.project"],
    ["prompt", `\${unknown}`, "prompt"],
    ["input", { item: { path: "$" } }, "input.item"],
    ["phase", { index: -1, title: "x" }, "phase.index"],
    ["phase", { index: 0.5, title: "x" }, "phase.index"],
    ["phase", { index: 0, title: " " }, "phase.title"],
  ])("locates malformed %s", (key, value, location) => {
    const result = validateGraph({ nodes: { work: { ...node, [key]: value } }, edges: [] });
    expect(result.ok).toBe(false);
    expect(result.errors.some(error => error.startsWith(`nodes.work.${location}:`))).toBe(true);
  });
  it("rejects a loop targeting a fanout", () => {
    const result = validateGraph({ nodes: { work: node }, edges: [{ from: "work", to: "work", loop: { maxIterations: 2 } }] });
    expect(result.errors.join("; ")).toContain('edges[0].to: loop target "work" can reach barrier "work"');
  });

  it("rejects transitive fanout loop barriers while preserving unrelated loops", () => {
    const ordinary = { type: "agent" as const, agent: "worker", prompt: "fixture" };
    const transitive = validateGraph({
      nodes: { review: ordinary, work: node },
      edges: [{ from: "review", to: "work" }, { from: "work", to: "review", loop: { maxIterations: 2 } }],
    });
    expect(transitive.ok).toBe(false);
    expect(transitive.errors.join("; ")).toContain("edges[1].to: loop target");
    const direct = validateGraph({ nodes: { review: ordinary, work: node }, edges: [{ from: "review", to: "work", loop: { maxIterations: 2 } }] });
    expect(direct.errors.join("; ")).toContain("edges[0].to: loop target");
    const safe = validateGraph({
      nodes: { review: ordinary, fix: ordinary, unrelated: node },
      edges: [{ from: "review", to: "fix" }, { from: "fix", to: "review", loop: { maxIterations: 2 } }],
    });
    expect(safe).toEqual({ ok: true, errors: [] });
  });

  it("rejects transitive and direct bounded-feedback loop barriers", () => {
    const ordinary = { type: "agent" as const, agent: "worker", prompt: "fixture" };
    const barrier = {
      type: "bounded_feedback" as const,
      work: { ...node, outputSchema: { type: "object" } },
      evaluator: ordinary,
      maxIterations: 2,
      maxItemsPerIteration: 2,
      maxTotalItems: 4,
    };
    const transitive = validateGraph({
      version: 2,
      nodes: { review: ordinary, barrier },
      edges: [{ from: "review", to: "barrier" }, { from: "barrier", to: "review", loop: { maxIterations: 2 } }],
    });
    expect(transitive.ok).toBe(false);
    expect(transitive.errors.join("; ")).toContain("edges[1].to: loop target");
    const direct = validateGraph({
      version: 2,
      nodes: { review: ordinary, barrier },
      edges: [{ from: "review", to: "barrier", loop: { maxIterations: 2 } }],
    });
    expect(direct.errors.join("; ")).toContain("edges[0].to: loop target");
  });
  it("counts existing nodes toward the expansion ceiling", () => {
    const result = validateFragment({ nodes: { work: node }, edges: [] }, Array.from({ length: 500 }, (_, i) => `n${i}`));
    expect(result.errors).toContain("nodes: 501 nodes exceeds the limit of 500");
  });
});

describe("graph versions", () => {
  it("accepts v1 defaults and v2, rejects unknown versions", () => {
    const base = { nodes: { a: { type: "agent", agent: "x", prompt: "x" } }, edges: [] };
    for (const version of [undefined, 1, 2]) expect(validateGraph({ ...base, version }).ok).toBe(true);
    for (const version of [0, 3, -1, 1.5, "2", null]) expect(validateGraph({ ...base, version }).ok).toBe(false);
  });
});

it("checks guarded cyclic paths and prototype-name IDs without traversing loop edges", () => {
  const agent = { type: "agent", agent: "worker", prompt: "fixture" };
  const fanout = { type: "fanout", items: { path: "$" }, itemSchema: { type: "object" }, dispatch: { path: "$.kind", cases: { x: "worker" } }, prompt: "${item}" };
  const nodes = Object.fromEntries([["__proto__", agent], ["constructor", agent], ["barrier", fanout]]);
  const edges = [
    { from: "__proto__", to: "constructor" },
    { from: "constructor", to: "__proto__" },
    { from: "constructor", to: "barrier", when: { exists: { path: "$.enabled" } } },
    { from: "barrier", to: "__proto__", loop: { maxIterations: 2 } },
  ];
  expect(validateGraph({ nodes, edges }).errors).toEqual(['edges[3].to: loop target "__proto__" can reach barrier "barrier" (fanout or bounded_feedback); barrier reactivation is unsupported']);
  const safe = { nodes, edges: [{ from: "barrier", to: "__proto__", loop: { maxIterations: 2 } }] };
  expect(validateGraph(safe).ok).toBe(true);
});

it("does not accept literal placeholders as authored agents or arbitrary expansion fragments", () => {
  const nodes = { child: { type: "agent", agent: "worker", prompt: "${context}" } };
  expect(validateGraph({ nodes, edges: [] }).ok).toBe(false);
  expect(validateFragment({ nodes, edges: [] }, []).ok).toBe(false);
});
