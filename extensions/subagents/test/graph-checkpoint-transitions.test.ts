import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { type GraphRunSnapshot, graphRunsDir, readGraphSnapshots, writeGraphSnapshot } from "../src/graph/graph-persist.js";
import type { AgentGraph } from "../src/graph/ir.js";
import { runGraph } from "../src/graph/run-graph.js";

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
const graph: AgentGraph = {
  version: 2, nodes: {
    spare: { type: "agent", agent: "spare", prompt: "spare" },
    feedback: { type: "bounded_feedback", maxIterations: 2, maxItemsPerIteration: 2, maxTotalItems: 4,
      work: { type: "fanout", items: { path: "$.tasks" }, itemSchema: { type: "object" }, dispatch: { path: "$.kind", cases: { a: "worker" } }, prompt: `\${item}`, outputSchema: { type: "object" } },
      evaluator: { type: "agent", agent: "judge", prompt: `\${feedback}` },
    },
  }, edges: [],
};
async function frames(budgets: { deadline?: number; spendLimit?: number } = {}): Promise<GraphRunSnapshot[]> {
  const result: GraphRunSnapshot[] = []; let evaluations = 0; let evidence = 0;
  const input = { tasks: [{ kind: "a", goal: "first" }] }; const runId = "agr_feedback1";
  const feedback = graph.nodes.feedback;
  if (feedback.type !== "bounded_feedback") throw new Error("missing feedback fixture");
  const definition = { ...graph, nodes: { ...graph.nodes, feedback: { ...feedback, ...budgets } } };
  await runGraph(definition, input, { runId, now: () => 1000, onCheckpoint: (state, graph) => result.push(structuredClone({ version: 2, runId, state, graph, input, waitingGate: "", savedAt: 0 })), host: {
    spawnAgent: async request => ({ ok: true, costUsd: 0.2, output: JSON.stringify(request.agentType === "judge" ? (++evaluations === 1 ? { decision: "continue", gaps: [{ id: "gap", description: "more" }], tasks: [{ gapId: "gap", item: { kind: "a", goal: "second" } }] } : { decision: "sufficient", gaps: [], tasks: [] }) : { evidence: ++evidence }) }),
  } });
  return result;
}

it("round-trips every feedback checkpoint through transition validation and restores completed evidence without dispatch", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "graph-transition-")); directories.push(cwd);
  const checkpoints = await frames();
  for (const snapshot of checkpoints) writeGraphSnapshot(cwd, snapshot);
  const [saved] = readGraphSnapshots(cwd);
  expect(saved?.state.runtime?.feedback?.feedback.terminal?.reason).toBe("sufficient");
  const spawnAgent = vi.fn();
  await runGraph(saved.graph, saved.input, { runId: saved.runId, restore: saved.state, host: { spawnAgent }, onCheckpoint: (state, graph) => writeGraphSnapshot(cwd, { ...saved, state, graph }) });
  expect(spawnAgent).not.toHaveBeenCalled();
});

it.each(["completed evidence", "admitted node"])("rejects correct-revision replacement of %s and keeps prior bytes", async mutation => {
  const cwd = mkdtempSync(join(tmpdir(), "graph-transition-")); directories.push(cwd);
  const checkpoints = await frames(); for (const snapshot of checkpoints) writeGraphSnapshot(cwd, snapshot);
  const [saved] = readGraphSnapshots(cwd);
  const path = join(graphRunsDir(cwd), `${saved.runId}.json`); const prior = readFileSync(path, "utf8");
  const altered = structuredClone(saved);
  if (!altered.state.runtime) throw new Error("missing runtime");
  altered.state.runtime.revision += 1;
  if (mutation === "admitted node") {
    delete altered.graph.nodes.spare; delete altered.state.nodes.spare;
    altered.state.runtime.manifest.splice(altered.state.runtime.manifest.findIndex(row => row.binding === "spare"), 1);
  } else {
    const rewrite = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        if (key === "evidence" && typeof child === "number") Reflect.set(value, key, child + 100);
        else rewrite(child);
      }
    };
    rewrite(altered.state);
  }
  expect(() => writeGraphSnapshot(cwd, altered)).toThrow(/rewrites|execution ledger/);
  expect(readFileSync(path, "utf8")).toBe(prior);
});

it("retains nested invocation history and unique recursive ordinals across a v1 loop", async () => {
  const { restoredNestedRows } = await import("../src/graph/graph-nested-checkpoint.js");
  const cwd = mkdtempSync(join(tmpdir(), "graph-transition-")); directories.push(cwd);
  const parent: AgentGraph = { nodes: { start: { type: "agent", agent: "start", prompt: "start" }, sub: { type: "graph", graph: "child" }, check: { type: "agent", agent: "check", prompt: "check" } }, edges: [{ from: "start", to: "sub" }, { from: "sub", to: "check", when: { eq: [{ node: "sub", path: "$.done" }, false] } }, { from: "check", to: "sub", loop: { maxIterations: 2 } }] };
  const child: AgentGraph = { version: 2, nodes: { worker: { type: "agent", agent: "worker", prompt: "child", outputSchema: { type: "object" } } }, edges: [], outputs: { done: { node: "worker", path: "$.done" } } };
  const runId = "agr_nestedloop"; let checks = 0;
  const result = await runGraph(parent, {}, { runId, loadGraph: () => child, onCheckpoint: (state, graph) => writeGraphSnapshot(cwd, { version: 2, runId, state, graph, input: {}, waitingGate: "", savedAt: 0 }), host: { spawnAgent: async request => ({ ok: true, output: request.agentType === "worker" ? JSON.stringify({ done: ++checks === 2 }) : "continue" }) } });
  expect(result.status).toBe("completed");
  const [saved] = readGraphSnapshots(cwd); const nested = saved.state.runtime?.nested?.sub;
  if (!nested) throw new Error("missing nested checkpoint");
  const rows = restoredNestedRows(nested, "sub");
  expect(rows.map(row => row.ordinal)).toEqual([3, 4]);
  expect(new Set(rows.map(row => row.id)).size).toBe(2);
  expect(saved.state.runtime?.nextOrdinal).toBe(5);
  const spawnAgent = vi.fn();
  await runGraph(saved.graph, saved.input, { runId, restore: saved.state, loadGraph: () => child, host: { spawnAgent }, onCheckpoint: (state, graph) => writeGraphSnapshot(cwd, { ...saved, state, graph }) });
  expect(spawnAgent).not.toHaveBeenCalled();
});

it("persists budget termination and real costs through every on-disk revision", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "graph-budget-")); directories.push(cwd);
  for (const snapshot of await frames({ spendLimit: 0.4, deadline: 1000 })) writeGraphSnapshot(cwd, snapshot);
  const [saved] = readGraphSnapshots(cwd);
  expect(saved.state.runtime?.startedAt).toBe(1000);
  expect(saved.state.runtime?.feedback?.feedback.terminal).toMatchObject({ reason: "deadline/spend limit", exhaustedBounds: ["spendLimit"], counters: { iterations: 1 } });
  expect(saved.state.nodes["feedback:iteration:1:evaluator"].costUsd).toBe(0.2);
  const spawnAgent = vi.fn();
  await runGraph(saved.graph, saved.input, { restore: saved.state, now: () => 5000, host: { spawnAgent }, onCheckpoint: (state, graph) => writeGraphSnapshot(cwd, { ...saved, state, graph }) });
  expect(spawnAgent).not.toHaveBeenCalled();
});
it.each(["start", "cost rollback", "cost removal", "cost rewrite", "cost invalid", "budget clock"])("rejects forged %s before replacement or dispatch", async mutation => {
  const cwd = mkdtempSync(join(tmpdir(), "graph-budget-")); directories.push(cwd);
  const checkpoints = await frames({ spendLimit: 10, deadline: 1000 });
  const end = checkpoints.findIndex(row => row.state.nodes["feedback:iteration:1:evaluator"]?.costUsd === 0.2 && row.state.nodes["feedback:iteration:1:evaluator"]?.status === "completed");
  expect(end).toBeGreaterThan(0);
  for (const snapshot of checkpoints.slice(0, end + 1)) writeGraphSnapshot(cwd, snapshot);
  const [saved] = readGraphSnapshots(cwd); const altered = structuredClone(saved);
  if (!altered.state.runtime?.feedback) throw new Error("missing runtime");
  altered.state.runtime.revision += 1;
  const evaluator = altered.state.nodes["feedback:iteration:1:evaluator"];
  if (mutation === "start") Reflect.set(altered.state.runtime, "startedAt", 999);
  if (mutation === "cost rollback") evaluator.costUsd = 0.1;
  if (mutation === "cost removal") delete evaluator.costUsd;
  if (mutation === "cost rewrite") evaluator.costUsd = 0.3;
  if (mutation === "cost invalid") evaluator.costUsd = -1;
  if (mutation === "budget clock") altered.state.runtime.feedback.feedback.budgetCheckedAt = 999;
  const path = join(graphRunsDir(cwd), `${saved.runId}.json`); const prior = readFileSync(path, "utf8");
  expect(() => writeGraphSnapshot(cwd, altered)).toThrow();
  expect(readFileSync(path, "utf8")).toBe(prior);
});

it("keeps unbudgeted v1 loops resumable when later child executions cost less", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "graph-v1-cost-")); directories.push(cwd);
  const legacy: AgentGraph = { nodes: {
    start: { type: "agent", agent: "start", prompt: "start" },
    review: { type: "agent", agent: "review", prompt: "review", outputSchema: { type: "object" } },
    fix: { type: "agent", agent: "fix", prompt: "fix" },
  }, edges: [{ from: "start", to: "review" }, { from: "review", to: "fix", when: { eq: [{ node: "review", path: "$.approved" }, false] } }, { from: "fix", to: "review", loop: { maxIterations: 2 } }] };
  let reviews = 0; const runId = "agr_v1cost";
  const result = await runGraph(legacy, {}, { runId, onCheckpoint: (state, graph) => writeGraphSnapshot(cwd, { version: 2, runId, state, graph, input: {}, waitingGate: "", savedAt: 0 }), host: { spawnAgent: async request => {
    if (request.agentType !== "review") return { ok: true, costUsd: 0, output: "ok" };
    reviews += 1; return { ok: true, costUsd: reviews === 1 ? 0.5 : 0.2, output: JSON.stringify({ approved: reviews === 2 }) };
  } } });
  expect(result.status).toBe("completed");
  expect(readGraphSnapshots(cwd)[0].state.nodes.review.costUsd).toBeCloseTo(0.7);
});

it.each([1, 2] as const)("retains envelope v%s while upgrading and enforcing immutable execution prefixes", async version => {
  const { upgradeLegacyExecution } = await import("../src/graph/graph-execution.js");
  const cwd = mkdtempSync(join(tmpdir(), "graph-execution-")); directories.push(cwd);
  const saved = (await frames())[0];
  if (!saved?.state.runtime) throw new Error("missing runtime");
  saved.version = version;
  Reflect.deleteProperty(saved.state.runtime, "executionProtocolVersion");
  Reflect.deleteProperty(saved.state.runtime, "executionLedger");
  writeGraphSnapshot(cwd, saved);
  const upgraded = { ...saved, state: upgradeLegacyExecution(saved.state) };
  const upgradedRuntime = upgraded.state.runtime;
  if (!upgradedRuntime) throw new Error("missing upgraded runtime");
  upgradedRuntime.revision++;
  writeGraphSnapshot(cwd, upgraded);
  expect(readGraphSnapshots(cwd)[0].version).toBe(version);
  const path = join(graphRunsDir(cwd), `${saved.runId}.json`); const bytes = readFileSync(path, "utf8");
  for (const change of ["remove", "partial", "downgrade", "rewrite", "truncate"] as const) {
    const next = structuredClone(upgraded); const runtime = next.state.runtime;
    if (!runtime) throw new Error("missing cloned runtime");
    runtime.revision++;
    if (change === "remove") { Reflect.deleteProperty(runtime, "executionProtocolVersion"); Reflect.deleteProperty(runtime, "executionLedger"); }
    if (change === "partial") Reflect.deleteProperty(runtime, "executionLedger");
    if (change === "downgrade") Reflect.set(runtime, "executionProtocolVersion", 0);
    if (change === "rewrite") {
      const ledger = runtime.executionLedger;
      const [entry] = ledger ?? [];
      if (!entry) throw new Error("missing execution ledger entry");
      Reflect.set(entry, "costUsd", 1);
    }
    if (change === "truncate") Reflect.set(runtime, "executionLedger", []);
    expect(() => writeGraphSnapshot(cwd, next)).toThrow();
    expect(readFileSync(path, "utf8")).toBe(bytes);
  }
});
