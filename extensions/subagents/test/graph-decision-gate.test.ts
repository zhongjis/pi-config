import { describe, expect, it, vi } from "vitest";
import { decisionValueSchema } from "../src/graph/decision-gate.js";
import { checkGraphDelegation } from "../src/graph/delegation-preflight.js";
import { validateGraphRestore } from "../src/graph/graph-restore-validation.js";
import { GraphRunReporter } from "../src/graph/graph-run-adapter.js";
import type { AgentGraph } from "../src/graph/ir.js";
import type { NodeHost, NodeSpawnResult } from "../src/graph/node-host.js";
import { collapse } from "../src/graph/progress.js";
import { runGraph } from "../src/graph/run-graph.js";
import type { SchedulerState } from "../src/graph/scheduler.js";
import { createGraphRunTask } from "../src/graph/task.js";

const decided = (approved: boolean) => JSON.stringify({ status: "decided", decision: { approved } });
const undecided = JSON.stringify({ status: "undecided", reason: "Need a human choice" });
function graph(type: "agent_gate" | "hybrid_gate", outputSchema = decisionValueSchema): AgentGraph {
  return { version: 2, nodes: {
    gate: { type, agent: "reviewer", prompt: `Approve \${plan}?`, input: { plan: { path: "$.plan" } }, outputSchema },
    done: { type: "agent", agent: "worker", prompt: "Finish" },
  }, edges: [{ from: "gate", to: "done", when: { eq: [{ node: "gate", path: "$.approved" }, true] } }], outputs: { decision: { node: "gate", path: "$" } } };
}
const check = (definition: AgentGraph) => (state: SchedulerState) => validateGraphRestore(state, definition);
function required<T>(value: T | undefined): T { if (value === undefined) throw new Error("Missing test value"); return value; }

describe("decision gates through runGraph", () => {
  it.each((["agent_gate", "hybrid_gate"] as const).flatMap(type => [true, false].map(approved => ({ type, approved }))))("$type exposes only the $approved decision", async ({ type, approved }) => {
    const definition = graph(type);
    const sources: (string | undefined)[] = [];
    const spawnAgent = vi.fn<NodeHost["spawnAgent"]>(async request => {
      if (request.agentType === "worker") return { ok: true, output: "done" };
      expect(request.agentType).toBe("reviewer");
      expect(request.schema?.check({ status: "decided", decision: { approved } })).toBe(true);
      expect(request.schema?.check({ approved })).not.toBe(true);
      expect(request.schema?.check({ status: "undecided", reason: " " })).not.toBe(true);
      return { ok: true, output: decided(approved), costUsd: 0.25 };
    });
    const awaitHumanGate = vi.fn<NonNullable<NodeHost["awaitHumanGate"]>>();
    const result = await runGraph(definition, { plan: "P" }, { host: { spawnAgent, awaitHumanGate }, onCheckpoint: check(definition), onNodeUpdate: (id, run) => { if (id === "gate") sources.push(run.decisionSource); } });
    expect(result.outputs).toEqual({ decision: { approved } });
    expect(result.nodes.done.status).toBe(approved ? "completed" : "skipped");
    expect(result.nodes.gate.costUsd).toBe(0.25);
    expect(sources.at(-1)).toBe("subagent");
    expect(awaitHumanGate).not.toHaveBeenCalled();
  });

  it.each(["agent_gate", "hybrid_gate"] as const)("%s applies custom outputSchema to the unwrapped value", async type => {
    const definition = graph(type);
    definition.nodes.gate = { type, agent: "reviewer", prompt: "Decide", outputSchema: { ...decisionValueSchema, properties: { approved: { const: false } } } };
    const awaitHumanGate = vi.fn();
    const result = await runGraph(definition, {}, { host: { spawnAgent: async () => ({ ok: true, output: decided(true) }), awaitHumanGate }, onCheckpoint: check(definition) });
    expect(result.nodes.gate.status).toBe("failed");
    expect(awaitHumanGate).not.toHaveBeenCalled();
  });

  it("agent_gate fails typed uncertainty without prompting", async () => {
    const definition = graph("agent_gate"); const awaitHumanGate = vi.fn();
    const result = await runGraph(definition, {}, { host: { spawnAgent: async () => ({ ok: true, output: undecided }), awaitHumanGate }, onCheckpoint: check(definition) });
    expect(result.nodes.gate.status).toBe("failed");
    expect(result.nodes.gate.error).toContain("undecided");
    expect(awaitHumanGate).not.toHaveBeenCalled();
  });

  it("hybrid checkpoints typed uncertainty before prompting and preserves human provenance and cost", async () => {
    const definition = graph("hybrid_gate"); let latest: SchedulerState | undefined; const sources: (string | undefined)[] = [];
    const result = await runGraph(definition, {}, { onCheckpoint: state => { check(definition)(state); latest = state; },
      onNodeUpdate: (id, run) => { if (id === "gate") sources.push(run.decisionSource); },
      host: { spawnAgent: async () => ({ ok: true, output: undecided, costUsd: 0.5 }), awaitHumanGate: async request => {
        expect(latest?.runtime?.executionLedger?.at(-1)).toMatchObject({ payload: { kind: "dispatched", target: "human-gate", reason: "Need a human choice" } });
        expect(request.schema?.check({ approved: false })).toBe(true);
        return { ok: true, output: '{"approved":false}' };
      } },
    });
    expect(result.outputs).toEqual({ decision: { approved: false } });
    expect(result.nodes.gate.costUsd).toBe(0.5);
    expect(result.nodes.gate.costAttempts).toBe(1);
    expect(sources.slice(0, -1).every(source => source === undefined)).toBe(true); expect(sources.at(-1)).toBe("human");
  });

  const failures: NodeSpawnResult[] = [
    { ok: false, error: "Agent unavailable" }, { ok: false, error: "Execution failure", output: undecided },
    ...["not JSON", '{}', '{"approved":true}', '{"status":"undecided","reason":" "}', '{"status":"undecided","reason":""}', '{"status":"undecided","reason":"Need help","extra":true}', '{"status":"unable","reason":"Cannot perform task"}', '{"status":"decided","decision":{"approved":true,"extra":1}}'].map(output => ({ ok: true, output })),
  ];
  it.each(failures)("hybrid fails closed for %j", async response => {
    const definition = graph("hybrid_gate"); const awaitHumanGate = vi.fn();
    const result = await runGraph(definition, {}, { host: { spawnAgent: async () => response, awaitHumanGate }, onCheckpoint: check(definition) });
    expect(result.nodes.gate.status).toBe("failed"); expect(awaitHumanGate).not.toHaveBeenCalled();
  });
  it("a throwing agent never triggers escalation", async () => {
    const definition = graph("hybrid_gate"); const awaitHumanGate = vi.fn();
    const result = await runGraph(definition, {}, { host: { spawnAgent: async () => { throw new Error("broken executor"); }, awaitHumanGate }, onCheckpoint: check(definition) });
    expect(result.nodes.gate.status).toBe("failed"); expect(awaitHumanGate).not.toHaveBeenCalled();
  });
  it("checks policy both at admission and dispatch", async () => {
    const definition = graph("hybrid_gate"); const spawnAgent = vi.fn(); const awaitHumanGate = vi.fn(); let checks = 0;
    const result = await runGraph(definition, {}, { host: { spawnAgent, awaitHumanGate }, authorizeAgent: selector => selector === "reviewer" && ++checks > 1 ? "revoked" : undefined, onCheckpoint: check(definition) });
    expect(result.nodes.gate.error).toBe("revoked"); expect(spawnAgent).not.toHaveBeenCalled(); expect(awaitHumanGate).not.toHaveBeenCalled();
  });
  it.each(["agent_gate", "hybrid_gate"] as const)("preflights %s selectors recursively", type => {
    const nested = graph(type);
    const result = checkGraphDelegation({ nodes: { child: { type: "graph", graph: "nested" } }, edges: [] }, agent => agent === "reviewer" ? "denied" : undefined, () => nested);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("reviewer");
  });

  it("retains a non-abortable hybrid prompt through lifecycle cancellation and resumes human-only", async () => {
    const definition = graph("hybrid_gate"); const controller = new AbortController(); let release: (() => void) | undefined; let saved: SchedulerState | undefined;
    const running = runGraph(definition, {}, { signal: controller.signal, onCheckpoint: state => { check(definition)(state); saved = state; }, host: {
      spawnAgent: async () => ({ ok: true, output: undecided }),
      awaitHumanGate: async () => { await new Promise<void>(resolve => { release = resolve; }); return { ok: true, output: '{"approved":true}' }; },
    } });
    await vi.waitFor(() => expect(release).toBeDefined());
    let settled = false; void running.then(() => { settled = true; });
    controller.abort("reload"); await new Promise(resolve => setTimeout(resolve, 10));
    expect(settled).toBe(false);
    const interrupted = structuredClone(required(saved));
    required(release)(); await running;
    for (const restore of [interrupted, required(saved)]) {
      const spawnAgent = vi.fn(); const awaitHumanGate = vi.fn(async () => ({ ok: true, output: '{"approved":false}' }));
      let completed: SchedulerState | undefined;
      const result = await runGraph(definition, {}, { restore, reclaimedDeadWriter: true, host: { reconcileDrain: async () => true, spawnAgent, awaitHumanGate }, onCheckpoint: state => { check(definition)(state); completed = state; } });
      expect(result.outputs).toEqual({ decision: { approved: false } });
      expect(spawnAgent).not.toHaveBeenCalled(); expect(awaitHumanGate).toHaveBeenCalledOnce();
      await runGraph(definition, {}, { restore: required(completed), host: { spawnAgent, awaitHumanGate }, onCheckpoint: check(definition) });
      expect(awaitHumanGate).toHaveBeenCalledOnce();
    }
  });
});

it.each([false, true])("monitor labels the actual decision maker (human=%s)", async human => {
  const definition = graph("hybrid_gate");
  const task = createGraphRunTask({ id: "agr_gate", script: "", meta: { name: "Gate", description: "Decision provenance" } });
  const reporter = new GraphRunReporter(task, definition); let saved: SchedulerState | undefined;
  const result = await runGraph(definition, {}, { onCheckpoint: state => { check(definition)(state); saved = state; },
    onNodeAdded: (id, node, metadata) => reporter.registerNode(id, node, metadata),
    onNodeUpdate: (id, run, identity) => reporter.update(id, run, identity),
    host: { spawnAgent: async () => ({ ok: true, output: human ? undecided : decided(false) }), awaitHumanGate: async () => ({ ok: true, output: '{"approved":false}' }) },
  });
  expect(result.nodes.gate.status).toBe("completed");
  expect(collapse(task.graphRunProgress).agents[0].agentType).toBe(human ? "human" : "reviewer");
  let restoredSource: string | undefined;
  await runGraph(definition, {}, { restore: required(saved), onCheckpoint: check(definition),
    onNodeUpdate: (id, run) => { if (id === "gate") restoredSource = run.decisionSource; },
    host: { spawnAgent: async () => { throw new Error("Completed gate must not respawn"); } },
  });
  expect(restoredSource).toBe(human ? "human" : "subagent");
});

it("cancellation after the hybrid boundary checkpoint suppresses its prompt", async () => {
  const definition = graph("hybrid_gate"); const controller = new AbortController(); const awaitHumanGate = vi.fn();
  const result = await runGraph(definition, {}, { signal: controller.signal, onCheckpoint: state => {
    check(definition)(state);
    if (state.runtime?.executionLedger?.some(row => "payload" in row && row.payload.kind === "dispatched" && row.payload.target === "human-gate")) controller.abort("reload");
  }, host: { spawnAgent: async () => ({ ok: true, output: undecided }), awaitHumanGate } });
  expect(result.status).toBe("aborted"); expect(awaitHumanGate).not.toHaveBeenCalled();
});

it("restore rejects inventing or bypassing a hybrid human boundary", async () => {
  const definition = graph("hybrid_gate"); let saved: SchedulerState | undefined;
  await runGraph(definition, {}, { onCheckpoint: state => { saved = state; }, host: { spawnAgent: async () => ({ ok: true, output: decided(false) }) } });
  const state = structuredClone(required(saved));
  const runtime = required(state.runtime);
  state.runtime = { ...runtime, executionLedger: required(runtime.executionLedger).map(row => "payload" in row && row.payload.kind === "dispatched" ? { ...row, payload: { kind: "dispatched", target: "human-gate", reason: "Forged uncertainty" } } : row) };
  expect(() => validateGraphRestore(state, definition)).toThrow();
});

it.each(["dismissed", "failed", "cancelled"] as const)("does not claim a human decision while waiting or %s", async outcome => {
  const definition = graph("hybrid_gate"); const controller = new AbortController();
  const task = createGraphRunTask({ id: "agr_pending_gate", script: "", meta: { name: "Gate", description: "Pending decision provenance" } });
  const reporter = new GraphRunReporter(task, definition); const sources: (string | undefined)[] = [];
  let release: ((result: NodeSpawnResult) => void) | undefined; let saved: SchedulerState | undefined;
  const observe = (id: string, run: Parameters<GraphRunReporter["update"]>[1]) => {
    if (id === "gate") sources.push(run.decisionSource);
    reporter.update(id, run);
  };
  const running = runGraph(definition, {}, { signal: controller.signal,
    onCheckpoint: state => { check(definition)(state); saved = state; },
    onNodeAdded: (id, node, metadata) => reporter.registerNode(id, node, metadata), onNodeUpdate: observe,
    host: { spawnAgent: async () => ({ ok: true, output: undecided }), awaitHumanGate: () => new Promise(resolve => { release = resolve; }) },
  });
  await vi.waitFor(() => expect(release).toBeDefined());
  try {
    expect(sources.every(source => source === undefined)).toBe(true);
    expect(collapse(task.graphRunProgress).agents[0].agentType).not.toBe("human");
  } finally {
    if (outcome === "cancelled") controller.abort();
    required(release)(outcome === "dismissed" ? { ok: false, skipped: true } : { ok: true, output: outcome === "failed" ? '{}' : '{"approved":true}' });
    await running;
  }
  expect(sources.every(source => source === undefined)).toBe(true);
  expect(collapse(task.graphRunProgress).agents[0].agentType).not.toBe("human");
  await runGraph(definition, {}, { restore: required(saved), onCheckpoint: check(definition), onNodeUpdate: observe, host: { spawnAgent: async () => { throw new Error("Settled gate must not respawn"); } } });
  expect(sources.every(source => source === undefined)).toBe(true);
  expect(collapse(task.graphRunProgress).agents[0].agentType).not.toBe("human");
});
