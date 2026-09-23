import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AgentGraph, GraphNode } from "../src/graph/ir.js";
import type { NodeSpawnRequest } from "../src/graph/node-host.js";
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

const researchTask = (source: "local" | "github" | "web", question: string, purpose = "discover") => ({ source, question, purpose });
const planFixture = { tasks: [researchTask("local", "Inspect code"), researchTask("web", "Inspect documentation")] };
const sourceFixture = { claims: [{ claim: "Example claim", excerpt: "Opened excerpt", reference: "https://example.org/source", source: "opened source" }], gaps: [] };
const sufficientFixture = { decision: "sufficient", gaps: [], tasks: [] };
const reportFixture = (status: "succeeded" | "partial") => ({
  markdown: "# Research\nExample claim [1].\n\n[1] Opened source (https://example.org/source)",
  acceptedFindings: [{ claim: "Example claim", citations: ["[1]"], verification: "selected independent check" }],
  verifiedCoverage: ["Example claim"], rejectedClaims: status === "partial" ? ["Unverified claim"] : [],
  gaps: status === "partial" ? ["Disputed claim remains"] : [], failures: status === "partial" ? ["source offline"] : [],
  outcome: status === "partial" ? { status, reason: "Disputed claim and source offline" } : { status },
});
function accepts(request: NodeSpawnRequest, fixture: unknown): boolean { return request.schema?.check(fixture) === true; }

describe("deep-research portfolio", () => {
  it("validates deep research wiring", async () => {
    const graph = savedGraph("deep-research");
    expect(validateGraph(savedGraph("context-gather")).ok).toBe(true);
    expect(graph.version).toBe(2);
    expect(graph.inputSchema).toMatchObject({ required: ["question"], properties: { question: { type: "string", pattern: "\\S" } } });
    expect(agentNode(graph, "plan").outputSchema).toMatchObject({ required: ["tasks"], properties: { tasks: { minItems: 1, maxItems: 6 } } });
    const research = boundedFeedbackNode(graph, "research");
    expect(research).toMatchObject({ maxIterations: 3, maxItemsPerIteration: 6, maxTotalItems: 18 });
    expect(research.work.items).toEqual({ node: "plan", path: "$.tasks" });
    expect(research.work.dispatch).toEqual({ path: "$.source", cases: { local: "chengfeng", github: "wenchang", web: "wenchang" } });
    expect(research.evaluator.input).not.toHaveProperty("feedback");
    expect(research.evaluator.outputSchema).toBeUndefined();
    expect(graph.edges).toEqual([{ from: "plan", to: "research" }, { from: "research", to: "synthesize" }]);
    expect(agentNode(graph, "synthesize").input?.research).toEqual({ node: "research", path: "$" });
    for (const field of ["markdown", "acceptedFindings", "verifiedCoverage", "rejectedClaims", "gaps", "failures"]) expect(graph.outputs?.[field]).toEqual({ node: "synthesize", path: `$.${field}` });
    expect(graph.outputs?.$subagentWorkflowOutcome).toEqual({ node: "synthesize", path: "$.outcome" });
    expect([agentNode(graph, "plan").agent, research.evaluator.agent, agentNode(graph, "synthesize").agent]).toEqual(["wenchang", "wenchang", "wenchang"]);
    expect(Object.values(research.work.dispatch.cases).every(name => ["chengfeng", "wenchang"].includes(name))).toBe(true);
    expect(Object.values(graph.nodes).every(node => node.type !== "expand" && node.type !== "human_gate" && !("validation" in node && node.validation))).toBe(true);
    const calls: string[] = [];
    const result = await runGraph(graph, { question: "Inspect behavior" }, { onCheckpoint: () => {}, host: { spawnAgent: async request => {
      calls.push(request.agentType);
      return { ok: true, output: JSON.stringify(accepts(request, planFixture) ? { tasks: [] } : sourceFixture) };
    } } });
    expect(result.status).toBe("failed");
    expect(calls).toEqual(["wenchang"]);
    expect(result.nodes.research?.status).toBe("skipped");
  });

  it("runs sufficient deep research", async () => {
    const agents: string[] = [];
    const result = await runGraph(savedGraph("deep-research"), { question: "Inspect behavior", context: "Prior evidence disputed" }, {
      onCheckpoint: () => {}, host: { spawnAgent: async request => {
        agents.push(request.agentType);
        if (accepts(request, planFixture)) return { ok: true, output: JSON.stringify(planFixture) };
        if (accepts(request, sufficientFixture)) return { ok: true, output: JSON.stringify(sufficientFixture) };
        if (accepts(request, reportFixture("succeeded"))) return { ok: true, output: JSON.stringify(reportFixture("succeeded")) };
        if (accepts(request, sourceFixture)) return { ok: true, output: JSON.stringify(sourceFixture) };
        throw new Error("Unexpected research schema");
      } },
    });
    expect(result.status, JSON.stringify(result.nodes)).toBe("completed");
    expect(agents.filter(agent => agent === "chengfeng")).toHaveLength(1);
    expect(agents.filter(agent => agent === "wenchang")).toHaveLength(4);
    expect(result.feedback?.research).toMatchObject({ reason: "sufficient", partial: false, counters: { iterations: 1, totalItems: 2 } });
    expect(result.outputs).toMatchObject({ markdown: expect.stringContaining("[1]"), acceptedFindings: [{ claim: "Example claim", citations: ["[1]"], verification: "selected independent check" }], verifiedCoverage: ["Example claim"], gaps: [], failures: [] });
  });

  it("dispatches a distinct source check in round two after continue", async () => {
    const check = researchTask("github", "Open upstream README via alternate fetch", "Verify missing source");
    const followup = { decision: "continue", gaps: [{ id: "readme", description: "Upstream source not opened" }], tasks: [{ gapId: "readme", item: check }] };
    const decisions = [followup, sufficientFixture];
    const agents: string[] = [];
    let work = 0;
    const result = await runGraph(savedGraph("deep-research"), { question: "Inspect behavior" }, {
      onCheckpoint: () => {}, host: { spawnAgent: async request => {
        agents.push(request.agentType);
        if (accepts(request, planFixture)) return { ok: true, output: JSON.stringify(planFixture) };
        if (accepts(request, sufficientFixture)) return { ok: true, output: JSON.stringify(decisions.shift()) };
        if (accepts(request, reportFixture("succeeded"))) return { ok: true, output: JSON.stringify(reportFixture("succeeded")) };
        if (accepts(request, sourceFixture)) return { ok: true, output: JSON.stringify({ ...sourceFixture, claims: sourceFixture.claims.map(claim => ({ ...claim, claim: `${claim.claim} ${++work}` })) }) };
        throw new Error("Unexpected research schema");
      } },
    });
    expect(result.status).toBe("completed");
    expect(decisions).toHaveLength(0);
    expect(agents.filter(agent => agent === "chengfeng")).toHaveLength(1);
    expect(agents.filter(agent => agent === "wenchang")).toHaveLength(6);
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
      onCheckpoint: () => {}, host: { spawnAgent: async request => {
        if (accepts(request, planFixture)) return { ok: true, output: JSON.stringify(planFixture) };
        if (accepts(request, sufficientFixture)) { evaluations++; return { ok: true, output: JSON.stringify({ decision: "sufficient", gaps: [gap], tasks: [] }) }; }
        if (accepts(request, reportFixture("partial"))) return { ok: true, output: JSON.stringify(reportFixture("partial")) };
        if (accepts(request, sourceFixture)) { work++; return { ok: true, output: JSON.stringify(sourceFixture) }; }
        throw new Error("Unexpected research schema");
      } },
    });
    expect(result.status).toBe("completed");
    expect(evaluations).toBe(1);
    expect(work).toBe(2);
    expect(result.feedback?.research).toMatchObject({ reason: "sufficient", partial: true, gaps: [gap], counters: { iterations: 1, totalItems: 2 }, exhaustedBounds: [] });
    expect(result.outputs.$subagentWorkflowOutcome).toMatchObject({ status: "partial" });
  });

  it("preserves partial deep research", async () => {
    let evaluations = 0; let external = 0;
    const followup = () => ({ decision: "continue", gaps: [{ id: `gap-${evaluations}`, description: "Disputed claim" }], tasks: [{ gapId: `gap-${evaluations}`, item: researchTask("web", `Independent source ${evaluations}`, "verify") }] });
    const result = await runGraph(savedGraph("deep-research"), { question: "Inspect behavior" }, {
      onCheckpoint: () => {}, host: { spawnAgent: async request => {
        if (accepts(request, planFixture)) return { ok: true, output: JSON.stringify({ tasks: [researchTask("github", "Inspect issue"), researchTask("local", "Inspect code")] }) };
        if (accepts(request, sufficientFixture)) { evaluations++; return { ok: true, output: JSON.stringify(followup()) }; }
        if (accepts(request, reportFixture("partial"))) return { ok: true, output: JSON.stringify(reportFixture("partial")) };
        if (accepts(request, sourceFixture)) {
          if (request.agentType === "wenchang" && ++external === 1) return { ok: false, error: "source offline" };
          return { ok: true, output: JSON.stringify({ ...sourceFixture, claims: sourceFixture.claims.map(claim => ({ ...claim, claim: `${claim.claim} ${external}` })) }) };
        }
        throw new Error("Unexpected research schema");
      } },
    });
    expect(result.status, JSON.stringify(result.nodes)).toBe("completed");
    expect(evaluations).toBe(3);
    expect(external).toBe(3);
    expect(result.feedback?.research).toMatchObject({ reason: "iteration limit", partial: true, counters: { iterations: 3, totalItems: 4 } });
    expect(result.feedback?.research?.iterations[0]?.results).toEqual(expect.arrayContaining([expect.objectContaining({ status: "failed", error: "source offline" })]));
    expect(result.outputs).toMatchObject({ rejectedClaims: ["Unverified claim"], gaps: ["Disputed claim remains"], failures: ["source offline"] });
    expect(result.outputs.$subagentWorkflowOutcome).toMatchObject({ status: "partial", reason: expect.stringContaining("source offline") });
  });
});
