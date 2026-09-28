import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AgentGraph, GraphNode } from "../src/graph/ir.js";
import { compileJsonSchema } from "../src/graph/json-schema.js";
import { isGraphRunOutcome } from "../src/graph/outcome.js";
import { runGraph } from "../src/graph/run-graph.js";
import { validateGraphRestore } from "../src/graph/graph-restore-validation.js";
import type { SchedulerState } from "../src/graph/scheduler.js";
import { resolveSavedGraph } from "../src/graph/saved-graph.js";
import { validateGraph } from "../src/graph/validate.js";

/**
 * The shipped reusable agent-graph portfolio in the committed `agent-graphs/` directory
 * must always resolve and validate. These saved graphs are Pi's known-good starting
 * points, so a shape regression in one of them should fail here rather than at a live
 * tool call. `cwd` is the repo root, mirroring how the runtime resolves
 * `agent-graphs/<name>.graph.json` in production.
 */
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

const PORTFOLIO = [
  "context-gather",
  "deep-research",
] as const;

const TASK_FIELDS = {
  source: { type: "string", enum: ["project", "platform", "upstream", "work-records", "practice"] },
  question: { type: "string", minLength: 1 },
  purpose: { type: "string", minLength: 1 },
  criterionIds: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", minLength: 1 } },
};

function taskSchema(taskIdPattern: string) {
  return {
    type: "object",
    properties: { ...TASK_FIELDS, taskId: { type: "string", pattern: taskIdPattern } },
    required: ["source", "question", "purpose", "criterionIds", "taskId"],
    additionalProperties: false,
  };
}

const PLAN_TASK_SCHEMA = taskSchema("^t[1-6]$");
const ITEM_TASK_SCHEMA = taskSchema("^[tg][1-6]$");

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

const WORKER_CLAIM_SCHEMA = {
  ...CLAIM_SCHEMA,
  properties: {
    ...CLAIM_SCHEMA.properties,
    claimId: { type: "string", minLength: 1, pattern: "^[tg][1-6]-c[1-4]$" },
  },
};

function schemaCheck(schema: unknown, value: unknown): true | string {
  const compiled = compileJsonSchema(schema);
  if (!compiled.ok) throw new Error(compiled.message);
  return compiled.compiled.check(value);
}

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
};

const INITIAL_TASK = {
  taskId: "t1",
  source: "project",
  question: "Inspect the repository configuration and runtime entry point.",
  purpose: "Establish the requested configuration and runtime coverage.",
  criterionIds: ["configuration", "runtime"],
};

const GAP_TASK = {
  taskId: "g1",
  source: "project",
  question: "Inspect the runtime path for the missing coverage criterion.",
  purpose: "Close the isolated runtime coverage gap.",
  criterionIds: ["runtime"],
};

const PROJECT_EVIDENCE = {
  claims: [{
    claimId: "t1-c1",
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
  claims: [{
    claimId: "g1-c1",
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
    { id: "configuration", status: "supported", claimIds: ["t1-c1"] },
    { id: "runtime", status: "supported", claimIds: ["t1-c1"] },
  ],
  unknowns: [],
  evidence: PROJECT_EVIDENCE.claims,
  conflicts: [],
  outcome: { status: "succeeded" },
};

const PARTIAL_SYNTHESIS = {
  answer: "Configuration is supported; runtime coverage remains unknown.",
  verifiedCoverage: [
    { id: "configuration", status: "supported", claimIds: ["t1-c1"] },
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
      required: ["request", "requiredCoverage"],
      additionalProperties: false,
      properties: {
        request: { type: "string", minLength: 1, pattern: "\\S" },
        requiredCoverage: { type: "array", minItems: 1, maxItems: 12 },
      },
    });
    expect(graph.inputSchema).not.toHaveProperty("properties.budget");
    expect(Object.keys(graph.nodes)).toEqual(["plan", "research", "synthesize"]);
    expect(graph.edges).toEqual([{ from: "plan", to: "research" }, { from: "research", to: "synthesize" }]);

    const plan = agentNode(graph, "plan");
    expect(plan).toMatchObject({
      agent: "xuannv",
      input: {
        request: { path: "$.request" },
        requiredCoverage: { path: "$.requiredCoverage" },
      },
      retry: { maxAttempts: 2 },
      outputSchema: {
        type: "object",
        properties: { tasks: { type: "array", minItems: 1, maxItems: 6, items: PLAN_TASK_SCHEMA } },
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
      itemSchema: ITEM_TASK_SCHEMA,
      outputSchema: {
        type: "object",
        properties: {
          claims: { type: "array", maxItems: 4, items: WORKER_CLAIM_SCHEMA },
          unknowns: { type: "array", maxItems: 6 },
          conflicts: { type: "array", maxItems: 4 },
        },
        required: ["claims", "unknowns", "conflicts"],
        additionalProperties: false,
      },
    });
    expect(research.work.outputSchema).not.toHaveProperty("properties.source");
    expect(research.work.outputSchema?.required).not.toContain("source");
    expect(research.evaluator).toMatchObject({
      agent: "direnjie",
      input: {
        request: { path: "$.request" },
        requiredCoverage: { path: "$.requiredCoverage" },
        plan: { node: "plan", path: "$" },
      },
      retry: { maxAttempts: 2 },
    });
    expect(research.evaluator.input).not.toHaveProperty("feedback");
    expect(placeholders(research.evaluator.prompt)).toContain("feedback");
    for (const node of [plan, research.work, research.evaluator]) {
      expect(node.input).not.toHaveProperty("budget");
      expect(placeholders(node.prompt)).not.toContain("budget");
    }
    expect(plan.prompt).toContain("Number tasks taskId t1, t2, ... in order.");
    expect(research.work.prompt).toContain("claimId MUST be <item taskId>-c<n>, n=1..4.");
    expect(research.work.prompt).not.toContain("JSON source MUST match task source");
    expect(research.work.prompt).toContain("only task criterionIds");
    expect(research.work.prompt).toContain("one opened source per provenance");
    expect(research.work.prompt).toContain("NEVER combine");
    expect(research.evaluator.prompt).toContain("Gap tasks use taskId g1, g2, ... in order.");
    expect(research.evaluator.prompt).not.toContain("source mismatches");
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
    expect(isGraphRunOutcome(result.outputs.$agentGraphOutcome), JSON.stringify(result.nodes.synthesize)).toBe(true);
    expect(result.outputs.$agentGraphOutcome).toEqual({ status: "succeeded" });
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
    const partialPlan = INITIAL_TASK;
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
    expect(synthesize.prompt).toContain("omit reason");
    expect(synthesize.prompt).toContain("reason MUST name missing coverage");
    expect(synthesize).toMatchObject({
      agent: "jintong",
      input: {
        request: { path: "$.request" },
        requiredCoverage: { path: "$.requiredCoverage" },
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
    expect(synthesize.input).not.toHaveProperty("budget");
    expect(placeholders(synthesize.prompt)).not.toContain("budget");
  });

  it("rejects a succeeded reason and a partial outcome without one", () => {
    const schema = agentNode(savedGraph("context-gather"), "synthesize").outputSchema;
    expect(schemaCheck(schema, { ...COMPLETE_SYNTHESIS, outcome: { status: "succeeded", reason: "All requested coverage is directly supported." } })).not.toBe(true);
    expect(schemaCheck(schema, { ...PARTIAL_SYNTHESIS, outcome: { status: "partial" } })).not.toBe(true);
    expect(schemaCheck(schema, COMPLETE_SYNTHESIS)).toBe(true);
    expect(schemaCheck(schema, PARTIAL_SYNTHESIS)).toBe(true);
  });
});

describe("context-gather semantic policy", () => {
  async function runCase(overrides: { plan?: unknown; research?: unknown; synthesis?: unknown; evaluation?: unknown } = {}) {
    const calls: string[] = [];
    const checkpoints: { state: SchedulerState; graph: AgentGraph }[] = [];
    const result = await runGraph(savedGraph("context-gather"), INPUT, {
      onCheckpoint: (state, graph) => {
        validateGraphRestore(state, graph, INPUT);
        checkpoints.push(structuredClone({ state, graph }));
      },
      host: { spawnAgent: async request => {
        calls.push(request.agentType);
        const outputs: Record<string, unknown> = {
          xuannv: overrides.plan ?? { tasks: [INITIAL_TASK] },
          chengfeng: overrides.research ?? PROJECT_EVIDENCE,
          direnjie: overrides.evaluation ?? SUFFICIENT,
          jintong: overrides.synthesis ?? COMPLETE_SYNTHESIS,
        };
        return { ok: true, output: JSON.stringify(outputs[request.agentType]) };
      } },
    });
    return { result, calls, checkpoints };
  }

  it("validates only the recognized explicit policy, independently of display name", () => {
    const graph = savedGraph("context-gather");
    expect(graph.semanticPolicy).toBe("context-gather-v1");
    expect(validateGraph({ ...graph, name: "renamed" }).ok).toBe(true);
    expect(validateGraph({ ...graph, semanticPolicy: "context-gather-v2" }).ok).toBe(false);
  });

  it("rejects duplicate requested IDs before dispatch", async () => {
    let calls = 0;
    await expect(runGraph(savedGraph("context-gather"), { ...INPUT, requiredCoverage: [
      { id: "configuration", criterion: "First" }, { id: "configuration", criterion: "Different" },
    ] }, { onCheckpoint: () => {}, host: { spawnAgent: async () => { calls++; return { ok: false }; } } })).rejects.toThrow(/coverage/i);
    expect(calls).toBe(0);
  });

  it.each([[["configuration", "other"]], [["configuration"]]])("rejects invalid plan coverage %j with retries", async criterionIds => {
    const { result, calls } = await runCase({ plan: { tasks: [{ ...INITIAL_TASK, criterionIds }] } });
    expect(result.nodes.plan.status).toBe("failed");
    expect(calls).toEqual(["xuannv", "xuannv"]);
  });

  it("rejects out-of-scope continuation before dispatching another task", async () => {
    const { result, calls } = await runCase({ evaluation: { decision: "continue", gaps: [{ id: "gap", description: "Missing" }], tasks: [{ gapId: "gap", item: { ...GAP_TASK, criterionIds: ["other"] } }] } });
    expect(calls.filter(agent => agent === "direnjie")).toHaveLength(2);
    expect(calls.filter(agent => agent === "chengfeng")).toHaveLength(1);
    expect(result.feedback?.research?.reason).toBe("evaluator failure");
  });

  it.each([
    ["invented claim", { evidence: PROJECT_EVIDENCE.claims.map(claim => ({ ...claim, claimId: "invented" })) }],
    ["changed text", { evidence: PROJECT_EVIDENCE.claims.map(claim => ({ ...claim, claim: "New text" })) }],
    ["changed criteria", { evidence: PROJECT_EVIDENCE.claims.map(claim => ({ ...claim, criterionIds: ["configuration"] })) }],
    ["changed provenance", { evidence: PROJECT_EVIDENCE.claims.map(claim => ({ ...claim, provenance: claim.provenance.map(source => ({ ...source, excerpt: "New excerpt" })) })) }],
    ["nonexistent reference", { verifiedCoverage: COMPLETE_SYNTHESIS.verifiedCoverage.map(row => ({ ...row, claimIds: ["absent"] })) }],
    ["incomplete succeeded coverage", { verifiedCoverage: COMPLETE_SYNTHESIS.verifiedCoverage.slice(0, 1) }],
    ["unrequested coverage", { verifiedCoverage: COMPLETE_SYNTHESIS.verifiedCoverage.map((row, index) => ({ ...row, id: `other-${index}` })) }],
    ["duplicate coverage", { verifiedCoverage: COMPLETE_SYNTHESIS.verifiedCoverage.map(row => ({ ...row, id: "configuration", reason: row.id })) }],
  ])("rejects %s through synthesis retries", async (_label, override) => {
    const { result, calls } = await runCase({ synthesis: { ...COMPLETE_SYNTHESIS, ...override } });
    expect(result.nodes.synthesize.status).toBe("failed");
    expect(calls.filter(agent => agent === "jintong")).toHaveLength(2);
  });

  it.each(["promotion", "inferred support"])("rejects %s", async kind => {
    const claims = PROJECT_EVIDENCE.claims.map(claim => ({ ...claim, confidence: "inferred" }));
    const { result } = await runCase({ research: { ...PROJECT_EVIDENCE, claims }, synthesis: { ...COMPLETE_SYNTHESIS, evidence: kind === "promotion" ? PROJECT_EVIDENCE.claims : claims } });
    expect(result.nodes.synthesize.status).toBe("failed");
  });

  it("requires claim references to match their coverage criterion", async () => {
    const claims = PROJECT_EVIDENCE.claims.map(claim => ({ ...claim, criterionIds: ["configuration"] }));
    const { result } = await runCase({ research: { ...PROJECT_EVIDENCE, claims }, synthesis: { ...COMPLETE_SYNTHESIS, evidence: claims } });
    expect(result.nodes.synthesize.status).toBe("failed");
  });

  it("rejects ambiguous raw claim IDs across results", async () => {
    const { result } = await runCase({ plan: { tasks: [INITIAL_TASK, { ...GAP_TASK, taskId: "t2" }] } });
    expect(result.nodes.synthesize.status).toBe("failed");
    expect(result.nodes.synthesize.error).toContain("Ambiguous research claimId: t1-c1");
  });

  it("does not turn inferred graph-example into new direct claims", async () => {
    const claims = PROJECT_EVIDENCE.claims.map(claim => ({ ...claim, claimId: "t1-c2", confidence: "inferred" }));
    const evidence = ["t1-c3", "t1-c4"].flatMap(claimId => PROJECT_EVIDENCE.claims.map(claim => ({ ...claim, claimId })));
    const { result } = await runCase({ research: { ...PROJECT_EVIDENCE, claims }, synthesis: { ...COMPLETE_SYNTHESIS, evidence, verifiedCoverage: COMPLETE_SYNTHESIS.verifiedCoverage.map((row, index) => ({ ...row, claimIds: [evidence[index].claimId] })) } });
    expect(result.feedback?.research?.iterations[0]?.results.every(row => row.status === "completed")).toBe(true);
    expect(result.nodes.synthesize.status).toBe("failed");
    expect(result.nodes.synthesize.error).toContain("Evidence must copy a unique completed research claim exactly");
  });
});

it("restores policy checkpoints and rejects forged continuation and final evidence before dispatch", async () => {
  const checkpoints: { state: SchedulerState; graph: AgentGraph }[] = [];
  let work = 0; let evaluations = 0;
  const followup = { decision: "continue", gaps: [{ id: "runtime", description: "Missing" }], tasks: [{ gapId: "runtime", item: GAP_TASK }] };
  await runGraph(savedGraph("context-gather"), INPUT, {
    onCheckpoint: (state, graph) => { validateGraphRestore(state, graph, INPUT); checkpoints.push(structuredClone({ state, graph })); },
    host: { spawnAgent: async request => {
      const outputs: Record<string, unknown> = {
        xuannv: { tasks: [INITIAL_TASK] },
        chengfeng: work === 0 ? PROJECT_EVIDENCE : GAP_EVIDENCE,
        direnjie: evaluations === 0 ? followup : SUFFICIENT,
        jintong: COMPLETE_SYNTHESIS,
      };
      if (request.agentType === "chengfeng") work++;
      if (request.agentType === "direnjie") evaluations++;
      return { ok: true, output: JSON.stringify(outputs[request.agentType]) };
    } },
  });
  const saved = checkpoints.at(-1);
  if (!saved) throw new Error("Missing terminal checkpoint");
  let dispatches = 0; let writes = 0;
  const restored = await runGraph(saved.graph, INPUT, { restore: saved.state, onCheckpoint: () => {}, host: { spawnAgent: async () => { dispatches++; return { ok: false }; } } });
  expect(restored.outputs.evidence).toEqual(PROJECT_EVIDENCE.claims);
  expect(dispatches).toBe(0);
  for (const kind of ["continuation", "synthesis"]) {
    const state = structuredClone(saved.state);
    if (kind === "continuation") {
      const evaluator = state.runtime?.feedback?.research.iterations[0]?.evaluator;
      if (!evaluator) throw new Error("Missing evaluator");
      state.nodes[evaluator].output = { ...followup, tasks: [{ gapId: "runtime", item: { ...GAP_TASK, criterionIds: ["outside"] } }] };
    } else {
      state.nodes.synthesize.output = { ...COMPLETE_SYNTHESIS, evidence: PROJECT_EVIDENCE.claims.map(claim => ({ ...claim, confidence: "inferred" })) };
    }
    await expect(runGraph(saved.graph, INPUT, { restore: state, onCheckpoint: () => { writes++; }, host: { spawnAgent: async () => { dispatches++; return { ok: false }; } } })).rejects.toThrow(/semantic output/);
  }
  expect(dispatches).toBe(0);
  expect(writes).toBe(0);
});
