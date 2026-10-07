import { describe, expect, it } from "vitest";
import { checkDeepResearchOutput, evaluatorFeedback, type LedgerRound, researchLedger, validateDeepResearchRestore } from "../src/graph/deep-research-policy.js";
import { validateGraphRestore } from "../src/graph/graph-restore-validation.js";
import type { AgentGraph, FanoutResult, JsonValue } from "../src/graph/ir.js";
import { runGraph } from "../src/graph/run-graph.js";
import type { SchedulerState } from "../src/graph/scheduler.js";
import { validateGraph } from "../src/graph/validate.js";

type Results = FanoutResult["results"];
const claim = (reference: string, excerpt: string, sourceKind?: "primary" | "secondary") => ({ claim: `fact ${excerpt}`, excerpt, reference, source: "undated", ...(sourceKind ? { sourceKind } : {}) });
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

  it("copies sourceKind when primary or secondary, and leaves it absent (still counting as covering) otherwise", () => {
    const ledger = researchLedger(SEED, [{ iteration: 1, results: [done(task("q1", ["p1"]), { claims: [claim("https://a.example/x", "alpha", "secondary"), claim("https://a.example/y", "beta")], gaps: [] }) ] }]);
    expect(ledger.claims[1].sourceKind).toBe("secondary");
    expect(ledger.claims[2].sourceKind).toBeUndefined();
  });
});

describe("deep-research-v1 checks", () => {
  const evaluation = (value: unknown) => checkDeepResearchOutput({ graph: graphStub, stage: "evaluation", planning: PLANNING, iterations: [{ iteration: 1, results: ROUND1 }] }, value);
  it("rejects an early sufficient decision unless each part has a claim or a <partId>- gap", () => {
    expect(evaluation({ decision: "sufficient", gaps: [], tasks: [] })).toMatch(/^deep-research-v1: decision 'sufficient' leaves plan parts with no primary ledger claim and no reported gap: p2\./);
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

  it("treats a URL inside an annotated or joined claim reference as opened, while a URL in no reference is still rejected", () => {
    const annotatedRound: Results = [
      done(task("q1", ["p1"]), {
        claims: [
          claim("https://arxiv.org/html/2607.00038, section 3", "alpha"),
          claim("https://a2a-protocol.org/latest/specification/ \u2014 Introduction", "beta"),
        ],
        gaps: [],
      }),
      done(task("q2", ["p2"]), { claims: [claim("github://owner/repo/README.md and https://api.github.com/repos/owner/repo/commits?per_page=100", "gamma")], gaps: [] }, 1),
    ];
    const annotatedResearch = { reason: "sufficient", partial: false, gaps: [], counters: { iterations: 1, totalItems: 2 }, iterations: [{ iteration: 1, results: annotatedRound }] };
    const annotatedWriter = (markdown: string) => checkDeepResearchOutput({ graph: graphStub, stage: "synthesize", planning: PLANNING, research: annotatedResearch }, {
      markdown, outcome: { status: "succeeded" },
      acceptedFindings: [{ claim: "alpha", claimIds: ["r1-1-1"], verification: "single-source" }],
      verifiedCoverage: [{ id: "p1", status: "supported", claimIds: ["r1-1-1"] }, { id: "p2", status: "supported", claimIds: ["r1-2-1"] }],
    });
    expect(annotatedWriter(
      "Alpha [r1-1-1] per https://arxiv.org/html/2607.00038, beta [r1-1-2] per https://a2a-protocol.org/latest/specification/, gamma [r1-2-1] per https://api.github.com/repos/owner/repo/commits?per_page=100",
    )).toBe(true);
    expect(annotatedWriter("Alpha [r1-1-1] per https://unopened.example/page.")).toMatch(/markdown cites URLs no ledger claim references: https:\/\/unopened\.example\/page/);
  });

  it("keeps the whole normalized reference in visited alongside its URL", () => {
    const ledger = researchLedger(undefined, [{ iteration: 1, results: [done(task("q1", ["p1"]), { claims: [claim("https://arxiv.org/html/2607.00038, section 3", "alpha")], gaps: [] })] }]);
    expect(ledger.visited).toEqual(["https://arxiv.org/html/2607.00038,%20section%203", "https://arxiv.org/html/2607.00038"]);
  });

  const ROUND1_WITH_SECONDARY: Results = [
    done(task("q1", ["p1"]), { claims: [claim("https://a.example/x", "alpha"), claim("https://a.example/z", "zeta", "secondary")], gaps: ["paywalled"] }),
    ROUND1[1],
  ];
  const secondaryResearch = { reason: "sufficient", partial: false, gaps: [], counters: { iterations: 1, totalItems: 2 }, iterations: [{ iteration: 1, results: ROUND1_WITH_SECONDARY }] };
  const secondaryWriter = (claimIds: string[]) => checkDeepResearchOutput({ graph: graphStub, stage: "synthesize", planning: PLANNING, research: secondaryResearch }, {
    markdown: "Zeta [r1-1-2] per https://a.example/z.", outcome: { status: "partial", reason: "p2" },
    acceptedFindings: [{ claim: "zeta", claimIds: ["r1-1-2"], verification: "single-source" }],
    verifiedCoverage: [{ id: "p1", status: "supported", claimIds }, { id: "p2", status: "missing", claimIds: [], reason: "timeout" }],
  });
  it("rejects supported coverage backed only by secondary claims, and accepts it once a primary claim is included", () => {
    expect(secondaryWriter(["r1-1-2"])).toMatch(/supported coverage needs at least one primary claim: p1/);
    expect(secondaryWriter(["r1-1-1", "r1-1-2"])).toBe(true);
  });

  it("rejects sufficient when a part has only secondary claims and no gap, and accepts it with a <partId>- gap", () => {
    const secondaryOnlyRound: Results = [done(task("q2", ["p2"]), { claims: [claim("https://b.example/y", "beta", "secondary")], gaps: [] })];
    const secondaryEvaluation = (value: unknown) => checkDeepResearchOutput({ graph: graphStub, stage: "evaluation", planning: PLANNING, iterations: [{ iteration: 1, results: [...ROUND1, ...secondaryOnlyRound] }] }, value);
    expect(secondaryEvaluation({ decision: "sufficient", gaps: [], tasks: [] })).toMatch(/plan parts with no primary ledger claim and no reported gap: p2\./);
    expect(secondaryEvaluation({ decision: "sufficient", gaps: [{ id: "p2-secondary-only", description: "only secondary sources" }], tasks: [] })).toBe(true);
  });

  it("rejects a continue task for a gap already tried the attempt limit, accepts one prior try, and evaluatorFeedback reports exhaustedGaps", () => {
    const priorDecision = (iteration: number): LedgerRound => ({ iteration, results: [], decision: { decision: "continue", gaps: [], tasks: [{ gapId: "p2-none", item: task("q2", ["p2"]) }] } });
    const continueWith = (iterations: LedgerRound[]) => checkDeepResearchOutput({ graph: graphStub, stage: "evaluation", planning: PLANNING, iterations }, { decision: "continue", gaps: [], tasks: [{ gapId: "p2-none", item: task("q2", ["p2"]) }] });
    expect(continueWith([priorDecision(1), { iteration: 2, results: [] }])).toBe(true);
    expect(continueWith([priorDecision(1), priorDecision(2), { iteration: 3, results: [] }])).toMatch(/^deep-research-v1: gap p2-none already had 2 tasks with no closing claim \(limit 2\)/);

    const feedback = evaluatorFeedback(PLANNING, [priorDecision(1), priorDecision(2), { iteration: 3, results: [] }], []);
    expect(feedback.exhaustedGaps).toEqual([{ id: "p2-none", attempts: 2 }]);
  });

  it("restore rechecks a multi-round state whose last decision targets a gap tried once without counting its own tasks", () => {
    const iter1 = { iteration: 1, results: [] as Results, work: "work1", evaluator: "eval1", workInstanceId: "work1" as never, evaluatorInstanceId: "eval1" as never, tasks: [],
      decision: { decision: "continue" as const, gaps: [], tasks: [{ gapId: "g1", item: task("q", ["p2"]) }] } };
    const iter2 = { iteration: 2, results: [] as Results, work: "work2", evaluator: "eval2", workInstanceId: "work2" as never, evaluatorInstanceId: "eval2" as never, tasks: [],
      decision: { decision: "continue" as const, gaps: [], tasks: [{ gapId: "g1", item: task("q", ["p2"]) }, { gapId: "g1", item: task("q", ["p2"]) }] } };
    const state: SchedulerState = {
      nodes: {
        planning: { status: "completed", attempt: 1, output: PLANNING },
        eval1: { status: "completed", attempt: 1, output: iter1.decision },
        eval2: { status: "completed", attempt: 1, output: iter2.decision },
      },
      loopCounts: {},
      runtime: { feedback: { research: { iterations: [iter1, iter2], gaps: [] } } } as unknown as SchedulerState["runtime"],
    };
    expect(() => validateDeepResearchRestore(graphStub, state)).not.toThrow();
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
