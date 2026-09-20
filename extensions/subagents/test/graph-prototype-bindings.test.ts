import { expect, it } from "vitest";
import type { AgentGraph } from "../src/graph/ir.js";
import { runGraph } from "../src/graph/run-graph.js";

it("returns a serializable terminal feedback result for a __proto__ binding", async () => {
  const graph: AgentGraph = {
    version: 2,
    nodes: { ["__proto__"]: {
      type: "bounded_feedback", maxIterations: 1, maxItemsPerIteration: 1, maxTotalItems: 1,
      work: {
        type: "fanout", items: { path: "$.items" },
        itemSchema: { type: "object", properties: { kind: { const: "work" } }, required: ["kind"], additionalProperties: false },
        dispatch: { path: "$.kind", cases: { work: "worker" } }, prompt: "fixture", outputSchema: { type: "object" },
      },
      evaluator: { type: "agent", agent: "judge", prompt: "fixture" },
    } },
    edges: [], outputs: { evidence: { node: "__proto__", path: "$" } },
  };
  const result = await runGraph(graph, { items: [{ kind: "work" }] }, {
    onCheckpoint: () => {},
    host: { spawnAgent: async request => ({ ok: true, output: JSON.stringify(request.agentType === "judge" ? { decision: "sufficient", gaps: [], tasks: [] } : { evidence: 1 }) }) },
  });
  expect(result.status).toBe("completed");
  expect(result.outputs.evidence).toMatchObject({ reason: "sufficient", partial: false });
  expect(Object.keys(result.feedback ?? {})).toEqual(["__proto__"]);
  expect(JSON.parse(JSON.stringify(result.feedback))).toEqual({ ["__proto__"]: result.outputs.evidence });
});

it("propagates a subgraph __proto__ input as an own value while omitting missing inputs", async () => {
  const child: AgentGraph = {
    nodes: { inner: { type: "agent", agent: "worker", prompt: "fixture" } }, edges: [],
    outputs: { forwarded: { path: "$.__proto__" }, ordinary: { path: "$.ordinary" }, missing: { path: "$.missing" } },
  };
  const parent: AgentGraph = {
    nodes: { sub: { type: "graph", graph: "child", input: { ["__proto__"]: { path: "$.payload" }, ordinary: { path: "$.ordinary" }, missing: { path: "$.absent" } } } },
    edges: [], outputs: { child: { node: "sub", path: "$" } },
  };
  const payload = { value: 42 };
  const result = await runGraph(parent, { payload, ordinary: 7 }, {
    loadGraph: name => name === "child" ? child : undefined,
    host: { spawnAgent: async () => ({ ok: true, output: "ok" }) },
  });
  expect(result.status).toBe("completed");
  expect(result.outputs.child).toEqual({ forwarded: payload, ordinary: 7 });
});
