import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AgentGraph, GraphNode } from "../src/graph/ir.js";
import { compileJsonSchema } from "../src/graph/json-schema.js";
import type { NodeSpawnRequest, NodeSpawnResult } from "../src/graph/node-host.js";
import { isGraphRunOutcome } from "../src/graph/outcome.js";
import { runGraph } from "../src/graph/run-graph.js";
import { resolveSavedGraph } from "../src/graph/saved-graph.js";
import { validateGraph } from "../src/graph/validate.js";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
function savedGraph(name: string): AgentGraph {
  const resolved = resolveSavedGraph(name, REPO_ROOT);
  expect(resolved.ok, resolved.ok ? "" : resolved.message).toBe(true);
  if (!resolved.ok) throw new Error(resolved.message);
  return resolved.graph as AgentGraph;
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

const researchTask = (source: "local" | "github" | "web", question: string, purpose = "discover", partIds: string[] = ["p1"]) => ({ source, question, purpose, partIds });
const planFixture = { parts: [{ id: "p1", question: "What behavior is implemented?" }], tasks: [researchTask("local", "Inspect code"), researchTask("web", "Inspect documentation")] };
const sourceFixture = { claims: [{ claim: "Example claim", excerpt: "Opened excerpt", reference: "https://example.org/source", source: "opened source" }], gaps: [] };
const sufficientFixture = { decision: "sufficient", gaps: [], tasks: [] };
const reportFixture = (status: "succeeded" | "partial") => ({
  markdown: "# Research\nExample claim [r0-1-1].\n\n[r0-1-1] Opened source (https://example.org/source)",
  acceptedFindings: [{ claim: "Example claim", claimIds: ["r0-1-1"], verification: "independently-checked" }],
  verifiedCoverage: status === "partial"
    ? [{ id: "p1", status: "partial", claimIds: ["r0-1-1"], reason: "Disputed claim and source offline" }]
    : [{ id: "p1", status: "supported", claimIds: ["r0-1-1"] }],
  rejectedClaims: status === "partial" ? ["Unverified claim"] : [],
  gaps: status === "partial" ? ["Disputed claim remains"] : [], failures: status === "partial" ? ["source offline"] : [],
  outcome: status === "partial" ? { status, reason: "Disputed claim and source offline" } : { status },
});
function accepts(request: NodeSpawnRequest, fixture: unknown): boolean { return request.schema?.check(fixture) === true; }
const seedFixture = { items: [{ source: "web", question: "Broad topic scan", purpose: "Map the topic" }] };
const gateDecision = (approved: boolean) => ({ status: "decided", decision: { approved } });
const loadGraph = (name: string) => savedGraph(name);
/** Reports a cost for every child so the research budget (spendLimit) stays accountable. */
function priced(spawn: (request: NodeSpawnRequest) => Promise<NodeSpawnResult>) {
  return { spawnAgent: async (request: NodeSpawnRequest) => ({ costUsd: 0.001, ...(await spawn(request)) }) };
}
/** Answers the planning subgraph: seed queries, seed searches, plan, and the scope agent_gate. */
function planningReply(request: NodeSpawnRequest, plan: unknown = planFixture, gate: unknown = gateDecision(true)) {
  if (request.prompt.includes("Broad seed query")) return { ok: true, output: JSON.stringify(sourceFixture) };
  if (accepts(request, seedFixture)) return { ok: true, output: JSON.stringify(seedFixture) };
  if (accepts(request, planFixture)) return { ok: true, output: JSON.stringify(plan) };
  if (accepts(request, gateDecision(true))) return { ok: true, output: JSON.stringify(gate) };
  return undefined;
}
function schemaCheck(schema: unknown): (value: unknown) => true | string {
  const compiled = compileJsonSchema(schema);
  expect(compiled.ok, compiled.ok ? "" : compiled.message).toBe(true);
  if (!compiled.ok) throw new Error(compiled.message);
  return value => compiled.compiled.check(value);
}
const typedFinding = (verification: "independently-checked" | "single-source" | "disputed" = "independently-checked") => ({ claim: "Example claim", claimIds: ["r0-1-1"], verification });
const typedReport = (coverage: unknown, outcome: unknown, findings: unknown = [typedFinding()]) => ({
  markdown: "# Research\nExample claim [r0-1-1].\n\n[r0-1-1] Opened source (https://example.org/source)",
  acceptedFindings: findings, verifiedCoverage: coverage, rejectedClaims: [], gaps: [], failures: [], outcome,
});
const supportedPart = { id: "p1", status: "supported", claimIds: ["r0-1-1"] };
const partialPart = { id: "p1", status: "partial", claimIds: ["r0-1-1"], reason: "Unresolved part" };
const validSucceeded = typedReport([supportedPart], { status: "succeeded" });
const validPartial = typedReport([partialPart], { status: "partial", reason: "p1 unresolved" });
const validFailed = typedReport([{ id: "p1", status: "missing", claimIds: [], reason: "No reliable findings" }], { status: "failed", reason: "No reliable findings" }, []);

describe("deep-research portfolio", () => {
  it("validates deep research wiring", async () => {
    const graph = savedGraph("deep-research");
    const planning = savedGraph("deep-research/plan");
    expect(validateGraph(savedGraph("context-gather")).ok).toBe(true);
    expect(validateGraph(planning).ok).toBe(true);
    expect(graph.inputSchema).toMatchObject({ required: ["question"], properties: { question: { type: "string", pattern: "\\S" } } });
    expect(graph.nodes.planning).toMatchObject({ type: "graph", graph: "deep-research/plan" });
    expect(agentNode(planning, "plan").outputSchema).toMatchObject({ required: ["parts", "tasks"], properties: { tasks: { minItems: 1, maxItems: 6 } } });
    expect(agentNode(planning, "plan").input?.seed).toEqual({ node: "seedSearch", path: "$" });
    expect(planning.nodes.seedSearch).toMatchObject({ type: "fanout", items: { node: "seedQueries", path: "$.items" } });
    expect(planning.nodes.scope).toMatchObject({ type: "agent_gate", agent: "panguan" });
    expect(planning.edges).toContainEqual({ from: "scope", to: "plan", when: { eq: [{ node: "scope", path: "$.approved" }, false] }, loop: { maxIterations: 1 } });
    expect(planning.outputs).toEqual({ parts: { node: "plan", path: "$.parts" }, tasks: { node: "plan", path: "$.tasks" }, seed: { node: "seedSearch", path: "$" }, approved: { node: "scope", path: "$.approved" } });
    const research = boundedFeedbackNode(graph, "research");
    expect(research).toMatchObject({ maxIterations: 3, maxItemsPerIteration: 30, maxTotalItems: 30, spendLimit: 2, deadline: 900000 });
    expect(research.work.items).toEqual({ node: "planning", path: "$.tasks" });
    expect(research.work.dispatch).toEqual({ path: "$.source", cases: { local: "chengfeng", github: "wenchang", web: "wenchang" } });
    expect(research.evaluator.input).not.toHaveProperty("feedback");
    expect(research.evaluator.outputSchema).toBeUndefined();
    expect(graph.edges).toEqual([{ from: "planning", to: "research" }, { from: "research", to: "synthesize" }]);
    expect(agentNode(graph, "synthesize").input).toMatchObject({ research: { node: "research", path: "$" }, scopeApproved: { node: "planning", path: "$.approved" } });
    for (const field of ["markdown", "acceptedFindings", "verifiedCoverage", "rejectedClaims", "gaps", "failures"]) expect(graph.outputs?.[field]).toEqual({ node: "synthesize", path: `$.${field}` });
    expect(graph.outputs?.$agentGraphOutcome).toEqual({ node: "synthesize", path: "$.outcome" });
    expect([agentNode(planning, "seedQueries").agent, agentNode(planning, "plan").agent, research.evaluator.agent, agentNode(graph, "synthesize").agent]).toEqual(["wenchang", "wenchang", "panguan", "simaqian"]);
    expect(Object.values(research.work.dispatch.cases).every(name => ["chengfeng", "wenchang"].includes(name))).toBe(true);
    for (const saved of [graph, planning]) expect(Object.values(saved.nodes).every(node => node.type !== "expand" && node.type !== "human_gate" && node.type !== "hybrid_gate" && !("validation" in node && node.validation))).toBe(true);
    const calls: string[] = [];
    const result = await runGraph(graph, { question: "Inspect behavior" }, { onCheckpoint: () => {}, loadGraph, host: priced(async request => {
      calls.push(request.agentType);
      return { ok: true, output: JSON.stringify(sourceFixture) };
    }) });
    expect(result.status).toBe("failed");
    expect(calls).toEqual(["wenchang"]);
    expect(result.nodes.research?.status).toBe("skipped");
  });

  it("re-plans once when the scope gate rejects, then researches", async () => {
    const gates = [gateDecision(false), gateDecision(true)];
    const agents: string[] = [];
    const result = await runGraph(savedGraph("deep-research"), { question: "Inspect behavior" }, {
      onCheckpoint: () => {}, loadGraph, host: priced(async request => {
        agents.push(request.agentType);
        if (accepts(request, gateDecision(true))) return { ok: true, output: JSON.stringify(gates.shift()) };
        const planned = planningReply(request); if (planned) return planned;
        if (accepts(request, sufficientFixture)) return { ok: true, output: JSON.stringify(sufficientFixture) };
        if (accepts(request, reportFixture("succeeded"))) return { ok: true, output: JSON.stringify(reportFixture("succeeded")) };
        if (accepts(request, sourceFixture)) return { ok: true, output: JSON.stringify(sourceFixture) };
        throw new Error("Unexpected research schema");
      }),
    });
    expect(result.status, JSON.stringify(result.nodes)).toBe("completed");
    expect(gates).toHaveLength(0);
    expect(agents.filter(agent => agent === "panguan")).toHaveLength(3);
    expect(result.feedback?.research).toMatchObject({ reason: "sufficient", counters: { iterations: 1, totalItems: 2 } });
  });

  it("proceeds with an unapproved plan after one re-plan and tells the writer", async () => {
    let plans = 0; let writerPrompt = "";
    const result = await runGraph(savedGraph("deep-research"), { question: "Inspect behavior" }, {
      onCheckpoint: () => {}, loadGraph, host: priced(async request => {
        if (accepts(request, planFixture)) plans++;
        const planned = planningReply(request, planFixture, gateDecision(false)); if (planned) return planned;
        if (accepts(request, sufficientFixture)) return { ok: true, output: JSON.stringify(sufficientFixture) };
        if (accepts(request, reportFixture("succeeded"))) { writerPrompt = request.prompt; return { ok: true, output: JSON.stringify(reportFixture("succeeded")) }; }
        if (accepts(request, sourceFixture)) return { ok: true, output: JSON.stringify(sourceFixture) };
        throw new Error("Unexpected research schema");
      }),
    });
    expect(result.status, JSON.stringify(result.nodes)).toBe("completed");
    expect(plans).toBe(2);
    expect(writerPrompt).toContain("approved the plan: false");
  });

  it("fails before research when the scope gate is undecided", async () => {
    const result = await runGraph(savedGraph("deep-research"), { question: "Inspect behavior" }, {
      onCheckpoint: () => {}, loadGraph, host: priced(async request => {
        const planned = planningReply(request, planFixture, { status: "undecided", reason: "Cannot tell" }); if (planned) return planned;
        throw new Error("Research must not start");
      }),
    });
    expect(result.status).toBe("failed");
    expect(result.nodes.planning?.status).toBe("failed");
    expect(result.nodes.research?.status).toBe("skipped");
  });

  it("runs sufficient deep research", async () => {
    const agents: string[] = []; const prompts: Record<string, string> = {};
    const result = await runGraph(savedGraph("deep-research"), { question: "Inspect behavior", context: "Prior evidence disputed" }, {
      onCheckpoint: () => {}, loadGraph, host: priced(async request => {
        agents.push(request.agentType);
        const planned = planningReply(request); if (planned) return planned;
        if (accepts(request, sufficientFixture)) { prompts.evaluator = request.prompt; return { ok: true, output: JSON.stringify(sufficientFixture) }; }
        if (accepts(request, reportFixture("succeeded"))) { prompts.writer = request.prompt; return { ok: true, output: JSON.stringify(reportFixture("succeeded")) }; }
        if (accepts(request, sourceFixture)) return { ok: true, output: JSON.stringify(sourceFixture) };
        throw new Error("Unexpected research schema");
      }),
    });
    expect(result.status, JSON.stringify(result.nodes)).toBe("completed");
    expect(prompts.evaluator).toContain('"id":"r0-1-1","partIds":["p1"]');
    expect(prompts.writer).toContain('"id":"r0-1-1"');
    expect(prompts.writer).toContain('"terminal":{"reason":"sufficient"');
    expect(agents.filter(agent => agent === "chengfeng")).toHaveLength(1);
    expect(agents.filter(agent => agent === "wenchang")).toHaveLength(4);
    expect(agents.filter(agent => agent === "panguan")).toHaveLength(2);
    expect(agents.filter(agent => agent === "simaqian")).toHaveLength(1);
    expect(result.feedback?.research).toMatchObject({ reason: "sufficient", partial: false, counters: { iterations: 1, totalItems: 2 } });
    expect(result.outputs).toMatchObject({ markdown: expect.stringContaining("[r0-1-1]"), acceptedFindings: [{ claim: "Example claim", claimIds: ["r0-1-1"], verification: "independently-checked" }], verifiedCoverage: [{ id: "p1", status: "supported", claimIds: ["r0-1-1"] }], gaps: [], failures: [] });
    expect(result.outputs.parts).toEqual(planFixture.parts);
    expect(isGraphRunOutcome(result.outputs.$agentGraphOutcome)).toBe(true);
    expect(result.outputs.$agentGraphOutcome).toEqual({ status: "succeeded" });
  });

  it("dispatches a distinct source check in round two after continue", async () => {
    const check = researchTask("github", "Open upstream README via alternate fetch", "Verify missing source");
    const followup = { decision: "continue", gaps: [{ id: "readme", description: "Upstream source not opened" }], tasks: [{ gapId: "readme", item: check }] };
    const decisions = [followup, sufficientFixture];
    const agents: string[] = [];
    let work = 0;
    const result = await runGraph(savedGraph("deep-research"), { question: "Inspect behavior" }, {
      onCheckpoint: () => {}, loadGraph, host: priced(async request => {
        agents.push(request.agentType);
        const planned = planningReply(request); if (planned) return planned;
        if (accepts(request, sufficientFixture)) return { ok: true, output: JSON.stringify(decisions.shift()) };
        if (accepts(request, reportFixture("succeeded"))) return { ok: true, output: JSON.stringify(reportFixture("succeeded")) };
        if (accepts(request, sourceFixture)) return { ok: true, output: JSON.stringify({ ...sourceFixture, claims: sourceFixture.claims.map(claim => ({ ...claim, claim: `${claim.claim} ${++work}` })) }) };
        throw new Error("Unexpected research schema");
      }),
    });
    expect(result.status).toBe("completed");
    expect(decisions).toHaveLength(0);
    expect(agents.filter(agent => agent === "chengfeng")).toHaveLength(1);
    expect(agents.filter(agent => agent === "wenchang")).toHaveLength(5);
    expect(agents.filter(agent => agent === "panguan")).toHaveLength(3);
    expect(work).toBe(3);
    expect(result.feedback?.research).toMatchObject({ reason: "sufficient", partial: false, counters: { iterations: 2, totalItems: 3 }, exhaustedBounds: [] });
    expect(result.feedback?.research?.iterations.map(round => round.tasks)).toEqual([planFixture.tasks, [check]]);
    expect(result.feedback?.research?.iterations[1]?.results).toEqual([expect.objectContaining({ status: "completed" })]);
  });

  it("terminates partial on sufficient with an unresolved gap", async () => {
    const gap = { id: "offline", description: "Source inaccessible; no useful accessible check remains" };
    let evaluations = 0;
    let work = 0;
    const result = await runGraph(savedGraph("deep-research"), { question: "Inspect behavior" }, {
      onCheckpoint: () => {}, loadGraph, host: priced(async request => {
        const planned = planningReply(request); if (planned) return planned;
        if (accepts(request, sufficientFixture)) { evaluations++; return { ok: true, output: JSON.stringify({ decision: "sufficient", gaps: [gap], tasks: [] }) }; }
        if (accepts(request, reportFixture("partial"))) return { ok: true, output: JSON.stringify(reportFixture("partial")) };
        if (accepts(request, sourceFixture)) { work++; return { ok: true, output: JSON.stringify(sourceFixture) }; }
        throw new Error("Unexpected research schema");
      }),
    });
    expect(result.status).toBe("completed");
    expect(evaluations).toBe(1);
    expect(work).toBe(2);
    expect(result.feedback?.research).toMatchObject({ reason: "sufficient", partial: true, gaps: [gap], counters: { iterations: 1, totalItems: 2 }, exhaustedBounds: [] });
    expect(result.outputs.$agentGraphOutcome).toMatchObject({ status: "partial" });
  });

  it("preserves partial deep research", async () => {
    let evaluations = 0; let external = 0;
    const followup = () => ({ decision: "continue", gaps: [{ id: `gap-${evaluations}`, description: "Disputed claim" }], tasks: [{ gapId: `gap-${evaluations}`, item: researchTask("web", `Independent source ${evaluations}`, "verify") }] });
    const result = await runGraph(savedGraph("deep-research"), { question: "Inspect behavior" }, {
      onCheckpoint: () => {}, loadGraph, host: priced(async request => {
        const planned = planningReply(request, { parts: planFixture.parts, tasks: [researchTask("github", "Inspect issue"), researchTask("local", "Inspect code")] }); if (planned) return planned;
        if (accepts(request, sufficientFixture)) { evaluations++; return { ok: true, output: JSON.stringify(followup()) }; }
        if (accepts(request, reportFixture("partial"))) return { ok: true, output: JSON.stringify(reportFixture("partial")) };
        if (accepts(request, sourceFixture)) {
          if (request.agentType === "wenchang" && ++external === 1) return { ok: false, error: "source offline" };
          return { ok: true, output: JSON.stringify({ ...sourceFixture, claims: sourceFixture.claims.map(claim => ({ ...claim, claim: `${claim.claim} ${external}` })) }) };
        }
        throw new Error("Unexpected research schema");
      }),
    });
    expect(result.status, JSON.stringify(result.nodes)).toBe("completed");
    expect(evaluations).toBe(3);
    expect(external).toBe(3);
    expect(result.feedback?.research).toMatchObject({ reason: "iteration limit", partial: true, counters: { iterations: 3, totalItems: 4 } });
    expect(result.feedback?.research?.iterations[0]?.results).toEqual(expect.arrayContaining([expect.objectContaining({ status: "failed", error: "source offline" })]));
    expect(result.outputs).toMatchObject({ rejectedClaims: ["Unverified claim"], gaps: ["Disputed claim remains"], failures: ["source offline"] });
    expect(result.outputs.$agentGraphOutcome).toMatchObject({ status: "partial", reason: expect.stringContaining("source offline") });
  });

  it("requires plan parts, task partIds, and parts output", () => {
    const graph = savedGraph("deep-research");
    const plan = agentNode(savedGraph("deep-research/plan"), "plan").outputSchema;
    expect(plan).toMatchObject({
      required: ["parts", "tasks"],
      properties: {
        parts: { type: "array", minItems: 1, maxItems: 6, uniqueItems: true, items: { additionalProperties: false, required: ["id", "question"], properties: { id: { type: "string", pattern: "^p[1-6]$" }, question: { type: "string", minLength: 1 } } } },
        tasks: { items: { required: ["source", "question", "purpose", "partIds"], properties: { partIds: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", pattern: "^p[1-6]$" } } } } },
      },
    });
    expect(boundedFeedbackNode(graph, "research").work.itemSchema).toMatchObject({
      required: ["source", "question", "purpose", "partIds"],
      properties: { partIds: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", pattern: "^p[1-6]$" } } },
    });
    expect(graph.outputs?.parts).toEqual({ node: "planning", path: "$.parts" });
  });

  it.each([
    ["succeeded-with-reason", validSucceeded, { ...validSucceeded, outcome: { status: "succeeded", reason: "extra" } }],
    ["partial-without-reason", validPartial, { ...validPartial, outcome: { status: "partial" } }],
    ["succeeded with a non-supported part", validSucceeded, typedReport([partialPart], { status: "succeeded" })],
    ["succeeded with a disputed finding", validSucceeded, typedReport([supportedPart], { status: "succeeded" }, [typedFinding("disputed")])],
  ])("rejects %s", (_label, valid, invalid) => {
    const check = schemaCheck(agentNode(savedGraph("deep-research"), "synthesize").outputSchema);
    expect([check(valid), check(invalid)]).toEqual([true, expect.any(String)]);
  });

  it("accepts typed coverage fixtures", () => {
    const check = schemaCheck(agentNode(savedGraph("deep-research"), "synthesize").outputSchema);
    expect(check(validSucceeded)).toBe(true);
    expect(check(validPartial)).toBe(true);
    expect(check(validFailed)).toBe(true);
  });
});
