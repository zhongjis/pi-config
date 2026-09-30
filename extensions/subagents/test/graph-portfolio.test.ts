import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AgentGraph } from "../src/graph/ir.js";
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

function portfolioNames(directory = join(REPO_ROOT, "agent-graphs"), prefix: string[] = []): string[] {
  const names: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      names.push(...portfolioNames(join(directory, entry.name), [...prefix, entry.name]));
      continue;
    }
    const match = /^(.*)\.graph\.(json|yaml)$/.exec(entry.name);
    if (match?.[1]) names.push([...prefix, match[1]].join("/"));
  }
  return names;
}

const PORTFOLIO = portfolioNames().sort();

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

describe("agent-graph reusable portfolio", () => {
  it("discovers saved graphs", () => {
    expect(PORTFOLIO.length).toBeGreaterThan(0);
  });

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
    const claims = [PROJECT_EVIDENCE.claims[0], { ...PROJECT_EVIDENCE.claims[0], claim: "A second distinct claim with the same id." }];
    const { result } = await runCase({ research: { ...PROJECT_EVIDENCE, claims } });
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

  it("accepts prefixed claims and distinct task ids", async () => {
    const { result } = await runCase();
    expect(result.status).toBe("completed");
    expect(result.nodes["research:iteration:1:work:item:0"]?.status).toBe("completed");
  });

  it("rejects a worker claimId outside its task prefix", async () => {
    const { result, calls } = await runCase({ research: { ...PROJECT_EVIDENCE, claims: PROJECT_EVIDENCE.claims.map(claim => ({ ...claim, claimId: "t2-c1" })) } });
    const worker = result.nodes["research:iteration:1:work:item:0"];
    expect(worker?.status).toBe("failed");
    expect(worker?.error).toContain("context-gather-v1:");
    expect(worker?.error).toContain("t2-c1");
    expect(calls.filter(agent => agent === "chengfeng")).toHaveLength(1);
  });

  it("rejects a worker claim criterionId outside its task", async () => {
    const { result, calls } = await runCase({ research: { ...PROJECT_EVIDENCE, claims: PROJECT_EVIDENCE.claims.map(claim => ({ ...claim, criterionIds: ["other"] })) } });
    const worker = result.nodes["research:iteration:1:work:item:0"];
    expect(worker?.status).toBe("failed");
    expect(worker?.error).toContain("context-gather-v1:");
    expect(worker?.error).toContain("other");
    expect(calls.filter(agent => agent === "chengfeng")).toHaveLength(1);
  });

  it("rejects duplicate plan taskIds", async () => {
    const { result, calls } = await runCase({ plan: { tasks: [INITIAL_TASK, { ...INITIAL_TASK, question: "Inspect a second configuration path.", purpose: "Keep the duplicate id distinct in the schema." }] } });
    expect(result.nodes.plan.status).toBe("failed");
    expect(result.nodes.plan.error).toContain("context-gather-v1:");
    expect(result.nodes.plan.error).toContain("Duplicate taskId: t1");
    expect(calls).toEqual(["xuannv", "xuannv"]);
  });

  it("rejects an evaluator gap taskId that reuses a plan taskId", async () => {
    const { result, calls } = await runCase({ evaluation: { decision: "continue", gaps: [{ id: "runtime", description: "Runtime coverage lacks direct evidence." }], tasks: [{ gapId: "runtime", item: { ...GAP_TASK, taskId: "t1" } }] } });
    expect(calls.filter(agent => agent === "direnjie")).toHaveLength(2);
    expect(calls.filter(agent => agent === "chengfeng")).toHaveLength(1);
    expect(result.feedback?.research?.reason).toBe("evaluator failure");
    expect(result.nodes["research:iteration:1:evaluator"]?.error).toContain("context-gather-v1:");
    expect(result.nodes["research:iteration:1:evaluator"]?.error).toContain("Duplicate taskId: t1");
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
  for (const kind of ["continuation", "synthesis", "work"]) {
    const state = structuredClone(saved.state);
    if (kind === "continuation") {
      const evaluator = state.runtime?.feedback?.research.iterations[0]?.evaluator;
      if (!evaluator) throw new Error("Missing evaluator");
      state.nodes[evaluator].output = { ...followup, tasks: [{ gapId: "runtime", item: { ...GAP_TASK, criterionIds: ["outside"] } }] };
    } else if (kind === "work") {
      const forged = { ...PROJECT_EVIDENCE, claims: PROJECT_EVIDENCE.claims.map(claim => ({ ...claim, claimId: "t2-c1" })) };
      const feedback = state.runtime?.feedback?.research;
      if (!feedback?.terminal) throw new Error("Missing feedback");
      state.nodes["research:iteration:1:work:item:0"].output = forged;
      const fanout = state.nodes["research:iteration:1:work"].output as { results: { output?: unknown }[] };
      fanout.results[0].output = forged;
      const forgedResults = <T extends { results: readonly { output?: unknown }[] }>(row: T): T => ({ ...row, results: row.results.map((result, index) => index === 0 ? { ...result, output: forged } : result) });
      feedback.iterations[0] = forgedResults(feedback.iterations[0]);
      feedback.terminal = { ...feedback.terminal, iterations: feedback.terminal.iterations.map((row, index) => index === 0 ? forgedResults(row) : row) };
      const research = state.nodes.research.output as { iterations: { results: { output?: unknown }[] }[] };
      research.iterations[0].results[0].output = forged;
      state.nodes.synthesize.output = { ...COMPLETE_SYNTHESIS, evidence: forged.claims, verifiedCoverage: COMPLETE_SYNTHESIS.verifiedCoverage.map(row => ({ ...row, claimIds: ["t2-c1"] })) };
    } else {
      state.nodes.synthesize.output = { ...COMPLETE_SYNTHESIS, evidence: PROJECT_EVIDENCE.claims.map(claim => ({ ...claim, confidence: "inferred" })) };
    }
    await expect(runGraph(saved.graph, INPUT, { restore: state, onCheckpoint: () => { writes++; }, host: { spawnAgent: async () => { dispatches++; return { ok: false }; } } })).rejects.toThrow(/semantic output/);
  }
  expect(dispatches).toBe(0);
  expect(writes).toBe(0);
});
