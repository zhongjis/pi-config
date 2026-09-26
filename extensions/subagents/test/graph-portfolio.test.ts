import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AgentGraph, GraphNode } from "../src/graph/ir.js";
import { runGraph } from "../src/graph/run-graph.js";
import { resolveSavedGraph } from "../src/graph/saved-graph.js";
import { validateGraph } from "../src/graph/validate.js";

/**
 * The shipped reusable agent-graph portfolio (docs/specs/agent-graph-reusable-workflows.md)
 * must always resolve and validate. These saved graphs are Pi's known-good
 * starting points, so a shape regression in one of them should fail here rather
 * than at a live tool call. `cwd` is the repo root, mirroring how the runtime
 * resolves `agent-graphs/<name>.graph.json` in production.
 */
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

const PORTFOLIO = [
  "context-gather",
  "deep-research",
] as const;

const TASK_SCHEMA = {
  type: "object",
  properties: {
    source: { type: "string", enum: ["project", "platform", "upstream", "work-records", "practice"] },
    question: { type: "string", minLength: 1 },
    purpose: { type: "string", minLength: 1 },
    criterionIds: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", minLength: 1 } },
  },
  required: ["source", "question", "purpose", "criterionIds"],
  additionalProperties: false,
};

const CLAIM_SCHEMA = {
  type: "object",
  properties: {
    claimId: { type: "string", minLength: 1 },
    claim: { type: "string", minLength: 1 },
    criterionIds: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", minLength: 1 } },
    confidence: { type: "string", enum: ["direct", "inferred"] },
    provenance: {
      type: "array",
      minItems: 1,
      maxItems: 4,
      items: {
        type: "object",
        properties: {
          reference: { type: "string", minLength: 1 },
          locator: { type: "string", minLength: 1 },
          excerpt: { type: "string", minLength: 1 },
          detail: { type: "string", minLength: 1 },
        },
        required: ["reference", "locator", "excerpt", "detail"],
        additionalProperties: false,
      },
    },
  },
  required: ["claimId", "claim", "criterionIds", "confidence", "provenance"],
  additionalProperties: false,
};

function isAgentGraph(value: unknown): value is AgentGraph {
  return validateGraph(value).ok;
}

function savedGraph(name: string): AgentGraph {
  const resolved = resolveSavedGraph(name, REPO_ROOT);
  expect(resolved.ok, resolved.ok ? "" : resolved.message).toBe(true);
  if (!resolved.ok) throw new Error(resolved.message);
  if (!isAgentGraph(resolved.graph)) throw new Error(`Saved graph ${name} did not validate`);
  return resolved.graph;
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

function placeholders(prompt: string): string[] {
  return [...prompt.matchAll(/\$\{([A-Za-z_$][\w$]*)\}/g)].map(([, name]) => name);
}

const INPUT = {
  request: "Verify the current repository configuration and runtime behavior.",
  requiredCoverage: [
    { id: "configuration", criterion: "Current configuration is directly evidenced." },
    { id: "runtime", criterion: "Runtime behavior is directly evidenced." },
  ],
  budget: { maxTasks: 2, maxGapTasks: 1, maxAnswerWords: 300 },
};

const INITIAL_TASK = {
  source: "project",
  question: "Inspect the repository configuration and runtime entry point.",
  purpose: "Establish the requested configuration and runtime coverage.",
  criterionIds: ["configuration", "runtime"],
};

const GAP_TASK = {
  source: "project",
  question: "Inspect the runtime path for the missing coverage criterion.",
  purpose: "Close the isolated runtime coverage gap.",
  criterionIds: ["runtime"],
};

const PROJECT_EVIDENCE = {
  source: "project",
  claims: [{
    claimId: "project-runtime-entry",
    claim: "The repository runtime entry point declares the configured behavior.",
    criterionIds: ["configuration", "runtime"],
    confidence: "direct",
    provenance: [{
      reference: "extensions/subagents/src/index.ts",
      locator: "activate",
      excerpt: "export function activate",
      detail: "The activation entry point is present in the repository source.",
    }],
  }],
  unknowns: [],
  conflicts: [],
};

const GAP_EVIDENCE = {
  source: "project",
  claims: [{
    claimId: "project-runtime-gap",
    claim: "The targeted runtime path provides the missing direct evidence.",
    criterionIds: ["runtime"],
    confidence: "direct",
    provenance: [{
      reference: "extensions/subagents/src/graph/run-graph.ts",
      locator: "runGraph",
      excerpt: "export async function runGraph",
      detail: "The graph execution entry point is directly defined by this source.",
    }],
  }],
  unknowns: [],
  conflicts: [],
};

const SUFFICIENT = { decision: "sufficient", gaps: [], tasks: [] };

const COMPLETE_SYNTHESIS = {
  answer: "The configuration and runtime behavior are directly evidenced.",
  verifiedCoverage: [
    { id: "configuration", status: "supported", claimIds: ["project-runtime-entry"] },
    { id: "runtime", status: "supported", claimIds: ["project-runtime-entry"] },
  ],
  unknowns: [],
  evidence: PROJECT_EVIDENCE.claims,
  conflicts: [],
  outcome: { status: "succeeded", reason: "All requested coverage is directly supported." },
};

const PARTIAL_SYNTHESIS = {
  answer: "Configuration is supported; runtime coverage remains unknown.",
  verifiedCoverage: [
    { id: "configuration", status: "supported", claimIds: ["project-runtime-entry"] },
    { id: "runtime", status: "missing", claimIds: [], reason: "No direct runtime evidence was found." },
  ],
  unknowns: ["No direct runtime evidence was found."],
  evidence: PROJECT_EVIDENCE.claims.map(claim => ({ ...claim, criterionIds: ["configuration"] })),
  conflicts: [],
  outcome: { status: "partial", reason: "Missing runtime coverage." },
};

describe("agent-graph reusable portfolio", () => {
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
  const description = savedGraph("context-gather").description;
  expect(typeof description).toBe("string");
  if (typeof description !== "string") throw new Error("Context-gather graph needs a description");
  expect(description.trim()).not.toBe("");
});

describe("adaptive context-gather contract", () => {
  it("plans criterion-linked research with the bounded feedback contract", () => {
    const graph = savedGraph("context-gather");
    expect(graph.version).toBe(2);
    expect(graph.inputSchema).toMatchObject({
      type: "object",
      required: ["request", "requiredCoverage", "budget"],
      additionalProperties: false,
      properties: {
        request: { type: "string", minLength: 1, pattern: "\\S" },
        requiredCoverage: { type: "array", minItems: 1, maxItems: 12 },
        budget: { type: "object", required: ["maxTasks", "maxGapTasks", "maxAnswerWords"] },
      },
    });
    expect(Object.keys(graph.nodes)).toEqual(["plan", "research", "synthesize"]);
    expect(graph.edges).toEqual([{ from: "plan", to: "research" }, { from: "research", to: "synthesize" }]);

    const plan = agentNode(graph, "plan");
    expect(plan).toMatchObject({
      agent: "xuannv",
      input: {
        request: { path: "$.request" },
        requiredCoverage: { path: "$.requiredCoverage" },
        budget: { path: "$.budget" },
      },
      retry: { maxAttempts: 2 },
      outputSchema: {
        type: "object",
        properties: { tasks: { type: "array", minItems: 1, maxItems: 6, items: TASK_SCHEMA } },
        required: ["tasks"],
        additionalProperties: false,
      },
    });

    const research = boundedFeedbackNode(graph, "research");
    expect(research).toMatchObject({ maxIterations: 2, maxItemsPerIteration: 6, maxTotalItems: 9 });
    expect(research.work.items).toEqual({ node: "plan", path: "$.tasks" });
    expect(research.work.dispatch).toEqual({
      path: "$.source",
      cases: { project: "chengfeng", platform: "wenchang", upstream: "wenchang", "work-records": "wenchang", practice: "wenchang" },
    });
    expect(research.work).toMatchObject({
      input: { request: { path: "$.request" }, requiredCoverage: { path: "$.requiredCoverage" } },
      itemSchema: TASK_SCHEMA,
      outputSchema: {
        type: "object",
        properties: {
          source: { type: "string", enum: ["project", "platform", "upstream", "work-records", "practice"] },
          claims: { type: "array", maxItems: 4, items: CLAIM_SCHEMA },
          unknowns: { type: "array", maxItems: 6 },
          conflicts: { type: "array", maxItems: 4 },
        },
        required: ["source", "claims", "unknowns", "conflicts"],
        additionalProperties: false,
      },
    });
    expect(research.evaluator).toMatchObject({
      agent: "direnjie",
      input: {
        request: { path: "$.request" },
        requiredCoverage: { path: "$.requiredCoverage" },
        budget: { path: "$.budget" },
        plan: { node: "plan", path: "$" },
      },
      retry: { maxAttempts: 2 },
    });
    expect(research.evaluator.input).not.toHaveProperty("feedback");
    expect(placeholders(research.evaluator.prompt)).toContain("feedback");
    expect(research.work.prompt).toContain("one opened source per provenance");
    expect(research.work.prompt).toContain("NEVER combine");
    expect(research.evaluator.prompt).toContain("locator and excerpt");
  });

  it("runs a sufficient first round without materializing iteration two", async () => {
    const agents: string[] = [];
    let bindings: string[] = [];
    const result = await runGraph(savedGraph("context-gather"), INPUT, {
      onCheckpoint: (_state, effective) => { bindings = Object.keys(effective.nodes); },
      host: { spawnAgent: async request => {
        agents.push(request.agentType);
        if (request.agentType === "xuannv") return { ok: true, output: JSON.stringify({ tasks: [INITIAL_TASK] }) };
        if (request.agentType === "chengfeng") return { ok: true, output: JSON.stringify(PROJECT_EVIDENCE) };
        if (request.agentType === "direnjie") return { ok: true, output: JSON.stringify(SUFFICIENT) };
        if (request.agentType === "jintong") return { ok: true, output: JSON.stringify(COMPLETE_SYNTHESIS) };
        throw new Error(`Unexpected agent ${request.agentType}`);
      } },
    });
    expect(result.status).toBe("completed");
    expect(agents).toEqual(["xuannv", "chengfeng", "direnjie", "jintong"]);
    expect(bindings.some(id => id.includes(":iteration:2:"))).toBe(false);
  });

  it("runs one project gap task in iteration two", async () => {
    const followup = {
      decision: "continue",
      gaps: [{ id: "runtime", description: "Runtime coverage lacks direct evidence." }],
      tasks: [{ gapId: "runtime", item: GAP_TASK }],
    };
    const decisions = [followup, SUFFICIENT];
    const evidence = [PROJECT_EVIDENCE, GAP_EVIDENCE];
    const agents: string[] = [];
    let bindings: string[] = [];
    const result = await runGraph(savedGraph("context-gather"), INPUT, {
      onCheckpoint: (_state, effective) => { bindings = Object.keys(effective.nodes); },
      host: { spawnAgent: async request => {
        agents.push(request.agentType);
        if (request.agentType === "xuannv") return { ok: true, output: JSON.stringify({ tasks: [INITIAL_TASK] }) };
        if (request.agentType === "chengfeng") {
          const output = evidence.shift();
          if (!output) throw new Error("Unexpected research round");
          return { ok: true, output: JSON.stringify(output) };
        }
        if (request.agentType === "direnjie") {
          const output = decisions.shift();
          if (!output) throw new Error("Unexpected evaluation round");
          return { ok: true, output: JSON.stringify(output) };
        }
        if (request.agentType === "jintong") return { ok: true, output: JSON.stringify(COMPLETE_SYNTHESIS) };
        throw new Error(`Unexpected agent ${request.agentType}`);
      } },
    });
    expect(result.status).toBe("completed");
    expect(agents).toEqual(["xuannv", "chengfeng", "direnjie", "chengfeng", "direnjie", "jintong"]);
    expect(bindings.some(id => id.includes(":iteration:2:"))).toBe(true);
  });

  it("returns partial coverage without exposing the outcome envelope as payload", async () => {
    const partialPlan = { ...INITIAL_TASK, criterionIds: ["configuration"] };
    const partialEvidence = {
      ...PROJECT_EVIDENCE,
      claims: PROJECT_EVIDENCE.claims.map(claim => ({ ...claim, criterionIds: ["configuration"] })),
      unknowns: ["No direct runtime evidence was found."],
    };
    const agents: string[] = [];
    const result = await runGraph(savedGraph("context-gather"), INPUT, {
      onCheckpoint: () => {},
      host: { spawnAgent: async request => {
        agents.push(request.agentType);
        if (request.agentType === "xuannv") return { ok: true, output: JSON.stringify({ tasks: [partialPlan] }) };
        if (request.agentType === "chengfeng") return { ok: true, output: JSON.stringify(partialEvidence) };
        if (request.agentType === "direnjie") return {
          ok: true,
          output: JSON.stringify({
            decision: "sufficient",
            gaps: [{ id: "runtime", description: "No direct runtime evidence was found." }],
            tasks: [],
          }),
        };
        if (request.agentType === "jintong") return { ok: true, output: JSON.stringify(PARTIAL_SYNTHESIS) };
        throw new Error(`Unexpected agent ${request.agentType}`);
      } },
    });
    const { $agentGraphOutcome: outcome, ...returnedOutputs } = result.outputs;
    expect(result.status).toBe("completed");
    expect(agents).toEqual(["xuannv", "chengfeng", "direnjie", "jintong"]);
    expect(outcome).toEqual({ status: "partial", reason: "Missing runtime coverage." });
    expect(returnedOutputs).toEqual({
      answer: PARTIAL_SYNTHESIS.answer,
      verifiedCoverage: PARTIAL_SYNTHESIS.verifiedCoverage,
      unknowns: PARTIAL_SYNTHESIS.unknowns,
      evidence: PARTIAL_SYNTHESIS.evidence,
      conflicts: PARTIAL_SYNTHESIS.conflicts,
    });
    expect(returnedOutputs).not.toHaveProperty("$agentGraphOutcome");
  });

  it("maps the final synthesis payload and inputs", () => {
    const graph = savedGraph("context-gather");
    expect(graph.outputs).toEqual({
      answer: { node: "synthesize", path: "$.answer" },
      verifiedCoverage: { node: "synthesize", path: "$.verifiedCoverage" },
      unknowns: { node: "synthesize", path: "$.unknowns" },
      evidence: { node: "synthesize", path: "$.evidence" },
      conflicts: { node: "synthesize", path: "$.conflicts" },
      $agentGraphOutcome: { node: "synthesize", path: "$.outcome" },
    });
    const synthesize = agentNode(graph, "synthesize");
    expect(synthesize.prompt).toContain("one source per provenance");
    expect(synthesize.prompt).toContain("NEVER combine");
    expect(synthesize).toMatchObject({
      agent: "jintong",
      input: {
        request: { path: "$.request" },
        requiredCoverage: { path: "$.requiredCoverage" },
        budget: { path: "$.budget" },
        plan: { node: "plan", path: "$" },
        research: { node: "research", path: "$" },
      },
      outputSchema: {
        type: "object",
        properties: {
          verifiedCoverage: { type: "array", minItems: 1, maxItems: 12 },
          unknowns: { type: "array", maxItems: 12 },
          evidence: { type: "array", maxItems: 18, items: CLAIM_SCHEMA },
          conflicts: { type: "array", maxItems: 8 },
        },
      },
    });
  });
});
