import { describe, expect, it } from "vitest";
import { checkDeepResearchOutput, researchLedger, validateDeepResearchRestore } from "../src/graph/deep-research-policy.js";
import { validateGraphRestore } from "../src/graph/graph-restore-validation.js";
import type { AgentGraph, FanoutResult, JsonValue } from "../src/graph/ir.js";
import { runGraph } from "../src/graph/run-graph.js";
import type { SchedulerState } from "../src/graph/scheduler.js";
import { validateGraph } from "../src/graph/validate.js";

type Results = FanoutResult["results"];
const claim = (reference: string, excerpt: string) => ({ claim: `fact ${excerpt}`, excerpt, reference, source: "undated" });
const done = (item: JsonValue, output: unknown, index = 0) => ({ nodeId: `n${index}`, index, item, status: "completed" as const, attempt: 1, output });
const task = (question: string, partIds: string[]) => ({ source: "web", question, purpose: "check", partIds });
const SEED = { results: [done({ source: "web", question: "seed", purpose: "leads" }, { claims: [claim("https://seed.example/a/", "seed")], gaps: [] })] };
const PLANNING = { parts: [{ id: "p1", question: "one" }, { id: "p2", question: "two" }], tasks: [task("q1", ["p1"])], seed: SEED, approved: true };
const ROUND1: Results = [
  done(task("q1", ["p1"]), { claims: [claim("https://a.example/x", "alpha"), claim("https://a.example/x#frag", " Alpha ")], gaps: ["paywalled"] }),
  { nodeId: "n1", index: 1, item: task("q2", ["p2"]), status: "failed", attempt: 1, error: "timeout" },
];
const graphStub = { semanticPolicy: "deep-research-v1" } as AgentGraph;

describe("deep-research-v1 ledger", () => {
  it("assigns stable 1-based IDs, keeps the first duplicate, and records visited, gaps and failures", () => {
    const ledger = researchLedger(SEED, [{ iteration: 1, results: ROUND1 }]);
    expect(ledger.claims.map(row => [row.id, row.partIds])).toEqual([["r0-1-1", []], ["r1-1-1", ["p1"]]]);
    expect(ledger.claims[1].duplicateIds).toEqual(["r1-1-2"]);
    expect(ledger.visited).toEqual(["https://seed.example/a", "https://a.example/x"]);
    expect(ledger.gaps).toEqual([{ id: "r1-1", partIds: ["p1"], gap: "paywalled" }]);
    expect(ledger.failures).toEqual([{ id: "r1-2", item: task("q2", ["p2"]), status: "failed", error: "timeout" }]);
    expect(researchLedger(SEED, [{ iteration: 1, results: ROUND1 }])).toEqual(ledger);
  });

  it("merges the parts of a duplicate into the first claim, so a seed claim re-found by a task counts for its part", () => {
    const ledger = researchLedger(SEED, [{ iteration: 1, results: [done(task("q1", ["p1"]), { claims: [claim("https://seed.example/a", "seed")], gaps: [] })] }]);
    expect(ledger.claims).toEqual([expect.objectContaining({ id: "r0-1-1", partIds: ["p1"], duplicateIds: ["r1-1-1"] })]);
  });
});

describe("deep-research-v1 checks", () => {
  const evaluation = (value: unknown) => checkDeepResearchOutput({ graph: graphStub, stage: "evaluation", planning: PLANNING, iterations: [{ iteration: 1, results: ROUND1 }] }, value);
  it("rejects an early sufficient decision unless each part has a claim or a <partId>- gap", () => {
    expect(evaluation({ decision: "sufficient", gaps: [], tasks: [] })).toMatch(/^deep-research-v1: decision 'sufficient' leaves plan parts with no ledger claim and no reported gap: p2\./);
    expect(evaluation({ decision: "sufficient", gaps: [{ id: "p2-timeout", description: "unreachable" }], tasks: [] })).toBe(true);
    expect(evaluation({ decision: "continue", gaps: [], tasks: [] })).toBe(true);
  });

  const research = { reason: "sufficient", partial: false, gaps: [], counters: { iterations: 1, totalItems: 2 }, iterations: [{ iteration: 1, results: ROUND1 }] };
  const writer = (patch: Record<string, unknown>) => checkDeepResearchOutput({ graph: graphStub, stage: "synthesize", planning: PLANNING, research }, {
    markdown: "Alpha [r1-1-1] per https://a.example/x.", outcome: { status: "partial", reason: "p2" },
    acceptedFindings: [{ claim: "alpha", claimIds: ["r1-1-1"], verification: "single-source" }],
    verifiedCoverage: [{ id: "p1", status: "supported", claimIds: ["r1-1-1"] }, { id: "p2", status: "missing", claimIds: [], reason: "timeout" }],
    ...patch,
  });
  it("accepts ledger citations and rejects forged IDs, URLs and coverage", () => {
    expect(writer({})).toBe(true);
    expect(writer({ markdown: "See [r9-9-9]." })).toMatch(/unknown ledger claim IDs: r9-9-9/);
    expect(writer({ markdown: "See https://unopened.example/page." })).toMatch(/markdown cites URLs no ledger claim references: https:\/\/unopened.example\/page/);
    expect(writer({ verifiedCoverage: [{ id: "p1", status: "supported", claimIds: ["r1-1-1"] }] })).toMatch(/verifiedCoverage must list each plan part exactly once \(p1, p2\); missing or repeated: p2/);
    expect(writer({ verifiedCoverage: [{ id: "p1", status: "supported", claimIds: [] }, { id: "p2", status: "missing", claimIds: [] }] })).toMatch(/supported coverage requires at least one claimId: p1/);
  });
});

describe("deep-research-v1 graph", () => {
  const planningGraph: AgentGraph = {
    nodes: { plan: { type: "agent", agent: "planner", prompt: "plan", outputSchema: { type: "object" } } }, edges: [],
    outputs: { parts: { node: "plan", path: "$.parts" }, tasks: { node: "plan", path: "$.tasks" }, seed: { node: "plan", path: "$.seed" }, approved: { node: "plan", path: "$.approved" } },
  };
  const itemSchema = { type: "object", properties: { source: { type: "string" }, question: { type: "string" }, purpose: { type: "string" }, partIds: { type: "array", items: { type: "string" } } }, required: ["source", "question", "purpose", "partIds"] };
  const graph: AgentGraph = {
    semanticPolicy: "deep-research-v1",
    nodes: {
      planning: { type: "graph", graph: "plan-child" },
      research: {
        type: "bounded_feedback", maxIterations: 3, maxItemsPerIteration: 4, maxTotalItems: 8,
        work: { type: "fanout", items: { node: "planning", path: "$.tasks" }, itemSchema, dispatch: { path: "$.source", cases: { web: "worker" } }, prompt: `Work \${item}`, outputSchema: { type: "object" } },
        evaluator: { type: "agent", agent: "judge", prompt: `Judge \${feedback}` },
      },
      synthesize: { type: "agent", agent: "writer", prompt: `Write \${research}`, input: { research: { node: "research", path: "$" } }, outputSchema: { type: "object" } },
    },
    edges: [{ from: "planning", to: "research" }, { from: "research", to: "synthesize" }],
  };

  it("requires planning/research/synthesize with the stated types", () => {
    expect(validateGraph(graph).ok).toBe(true);
    const { planning: _planning, ...nodes } = graph.nodes;
    expect(validateGraph({ ...graph, nodes, edges: [{ from: "research", to: "synthesize" }] }).errors).toContain("semanticPolicy: deep-research-v1 requires planning (graph), research (bounded_feedback) and synthesize (agent) nodes");
  });

  it("feeds the ledger to evaluator and writer, lists visited references in later rounds, and rechecks on restore", async () => {
    const prompts: Record<string, string[]> = {};
    const checkpoints: { state: SchedulerState; graph: AgentGraph }[] = [];
    let judged = 0;
    const result = await runGraph(graph, {}, {
      loadGraph: () => planningGraph,
      onCheckpoint: (state, current) => { validateGraphRestore(state, current, {}); checkpoints.push(structuredClone({ state, graph: current })); },
      host: { spawnAgent: async request => {
        prompts[request.agentType] = [...(prompts[request.agentType] ?? []), request.prompt];
        const outputs: Record<string, unknown> = {
          planner: { ...PLANNING, seed: SEED },
          worker: request.prompt.includes("q1")
            ? { claims: [claim("https://a.example/x", "alpha")], gaps: [] }
            : { claims: [claim("https://b.example/y", "beta")], gaps: [] },
          judge: request.agentType === "judge" && judged++ === 0 ? { decision: "continue", gaps: [{ id: "p2-none", description: "no p2 evidence" }], tasks: [{ gapId: "p2-none", item: task("q2", ["p2"]) }] } : { decision: "sufficient", gaps: [], tasks: [] },
          writer: {
            markdown: "Alpha [r1-1-1], beta [r2-1-1] https://b.example/y", outcome: { status: "succeeded" },
            acceptedFindings: [{ claim: "alpha", claimIds: ["r1-1-1"], verification: "single-source" }],
            verifiedCoverage: [{ id: "p1", status: "supported", claimIds: ["r1-1-1"] }, { id: "p2", status: "supported", claimIds: ["r2-1-1"] }],
          },
        };
        return { ok: true, output: JSON.stringify(outputs[request.agentType]) };
      } },
    });
    expect(result.status).toBe("completed");
    expect(prompts.judge[0]).toContain("\"id\":\"r0-1-1\"");
    expect(prompts.judge[1]).toContain("\"id\":\"r2-1-1\"");
    expect(prompts.judge[0]).not.toContain("\"iterations\"");
    expect(prompts.writer[0]).toContain("\"id\":\"r2-1-1\"");
    expect(prompts.writer[0]).toContain("\"terminal\":{\"reason\":\"sufficient\"");
    expect(prompts.worker[0]).not.toContain("Already opened references");
    expect(prompts.worker[1]).toContain("Already opened references (do not reopen unless verifying a specific claim): [\"https://seed.example/a\",\"https://a.example/x\"]");

    const last = structuredClone(checkpoints.at(-1));
    if (!last) throw new Error("Missing checkpoint");
    const { state } = last;
    const synthesize = state.nodes.synthesize.output as { markdown: string };
    synthesize.markdown += " [r9-9-9]";
    expect(() => validateDeepResearchRestore(last.graph, state)).toThrow(/Invalid restored semantic output: deep-research-v1: unknown ledger claim IDs: r9-9-9/);
    expect(() => validateGraphRestore(state, last.graph, {})).toThrow(/deep-research-v1/);
  });
});
