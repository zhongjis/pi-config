import { describe, expect, it, vi } from "vitest";
import { checkGraphDelegation } from "../src/graph/delegation-preflight.js";
import { validateGraphRestore } from "../src/graph/graph-restore-validation.js";
import type { AgentGraph, ClassifierQuestion, DecisionGateNode } from "../src/graph/ir.js";
import type { DecisionResult, EscalationRequest, NodeHost, NodeSpawnResult } from "../src/graph/node-host.js";
import { runGraph } from "../src/graph/run-graph.js";
import type { SchedulerState } from "../src/graph/scheduler.js";
import { deferred } from "./graph-drain.fixture.js";

const questions = { ship: { type: "bool", instructions: "Ship it?", criteria: { true: "Ready", false: "Not ready" } } } satisfies Record<string, ClassifierQuestion>;
function graph(gate: Partial<DecisionGateNode> = {}): AgentGraph {
  return { nodes: {
    plan: { type: "agent", agent: "planner", prompt: "Plan", outputSchema: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] } },
    gate: { type: "decision_gate", state: { plan: { node: "plan", path: "$.summary" } }, questions, ...gate },
    done: { type: "agent", agent: "worker", prompt: "Finish" },
  }, edges: [{ from: "plan", to: "gate" }, { from: "gate", to: "done", when: { eq: [{ node: "gate", path: "$.answers.ship.value" }, true] } }],
  outputs: { decision: { node: "gate", path: "$" } } };
}
const spawnAgent: NodeHost["spawnAgent"] = async request => ({ ok: true, output: request.agentType === "planner" ? '{"summary":"P"}' : "done" });
const answer = (value: boolean, confidence: number, extra: { costUsd?: number } = {}): DecisionResult =>
  ({ ok: true, answers: { ship: { value, confidence } }, decidedBy: "classifier", model: "test/classifier", ...extra });
const respond = (ship: boolean, decidedBy = "human"): NodeSpawnResult => ({ ok: true, output: JSON.stringify({ answers: { ship }, decidedBy }) });
const check = (definition: AgentGraph) => (state: SchedulerState) => validateGraphRestore(state, definition);
const escalated = (state: SchedulerState | undefined) => state?.runtime?.executionLedger?.some(row => "payload" in row && row.payload.kind === "dispatched" && row.payload.target === "escalation") === true;
function required<T>(value: T | undefined): T { if (value === undefined) throw new Error("Missing test value"); return value; }
async function run(host: Omit<NodeHost, "spawnAgent">, definition = graph(), extra: Partial<Parameters<typeof runGraph>[2]> = {}) {
  return runGraph(definition, {}, { host: { spawnAgent, ...host }, onCheckpoint: check(definition), ...extra });
}

describe("decide", () => {
  it("passes the resolved state and questions to the decider", async () => {
    const decide = vi.fn<NonNullable<NodeHost["decide"]>>(async () => answer(true, 0.9));
    await run({ decide });
    expect(decide).toHaveBeenCalledWith(expect.objectContaining({ state: { plan: "P" }, questions }), expect.any(AbortSignal));
  });

  it("exposes a confident answer without escalating", async () => {
    const awaitEscalation = vi.fn<NonNullable<NodeHost["awaitEscalation"]>>();
    const result = await run({ decide: async () => answer(true, 0.9), awaitEscalation });
    expect([result.outputs.decision, awaitEscalation.mock.calls.length]).toEqual([{ answers: { ship: { value: true, confidence: 0.9 } }, decidedBy: "classifier" }, 0]);
  });

  it.each([[true, "completed"], [false, "skipped"]])("routes the guarded branch on answer %s", async (value, status) => {
    const result = await run({ decide: async () => answer(value, 0.9) });
    expect(result.nodes.done.status).toBe(status);
  });

  it("never consults agent delegation policy", async () => {
    const authorizeAgent = vi.fn<(agent: string) => string | undefined>(() => undefined);
    await run({ decide: async () => answer(true, 0.9) }, graph(), { authorizeAgent });
    expect(new Set(authorizeAgent.mock.calls.map(([agent]) => agent))).toEqual(new Set(["planner", "worker"]));
  });

  it("records the decider's cost once", async () => {
    const result = await run({ decide: async () => answer(true, 0.9, { costUsd: 0.03 }) });
    expect([result.nodes.gate.costUsd, result.nodes.gate.costAttempts]).toEqual([0.03, 1]);
  });

  it("marks an unreported decider cost unavailable", async () => {
    const result = await run({ decide: async () => answer(true, 0.9) });
    expect([result.nodes.gate.costUsd, result.nodes.gate.costUnavailable]).toEqual([undefined, true]);
  });

  it.each([
    { label: "default 0.8", gate: {}, options: {}, confidence: 0.79, escalates: true },
    { label: "run option", gate: {}, options: { decisionGateMinConfidence: 0.95 }, confidence: 0.9, escalates: true },
    { label: "node over run option", gate: { minConfidence: 0.5 }, options: { decisionGateMinConfidence: 0.95 }, confidence: 0.6, escalates: false },
    { label: "node threshold", gate: { minConfidence: 0.95 }, options: {}, confidence: 0.9, escalates: true },
  ])("applies the $label threshold", async ({ gate, options, confidence, escalates }) => {
    const awaitEscalation = vi.fn<NonNullable<NodeHost["awaitEscalation"]>>(async () => respond(true));
    await run({ decide: async () => answer(true, confidence), awaitEscalation }, graph(gate), options);
    expect(awaitEscalation.mock.calls.length).toBe(escalates ? 1 : 0);
  });

  it("names the decider only after a successful decision", async () => {
    const sources: (string | undefined)[] = [];
    await run({ decide: async () => answer(true, 0.9) }, graph(), { onNodeUpdate: (id, node) => { if (id === "gate") sources.push(node.decisionSource); } });
    expect([sources.slice(0, -1).every(source => source === undefined), sources.at(-1)]).toEqual([true, "classifier"]);
  });

  it("skips the gate without escalating when the decider reports it was dismissed", async () => {
    const awaitEscalation = vi.fn<NonNullable<NodeHost["awaitEscalation"]>>();
    const result = await run({ decide: async () => ({ ok: false, skipped: true, error: "dismissed" }), awaitEscalation });
    expect([result.nodes.gate.status, awaitEscalation.mock.calls.length]).toEqual(["skipped", 0]);
  });
});

describe("escalation", () => {
  it("publishes only after its escalation dispatch checkpoint", async () => {
    let latest: SchedulerState | undefined; let committed: unknown;
    await run({ decide: async () => answer(true, 0.3), awaitEscalation: async () => { committed = latest?.runtime?.executionLedger?.at(-1); return respond(true); } },
      graph(), { onCheckpoint: state => { check(graph())(state); latest = state; } });
    expect(committed).toMatchObject({ payload: { kind: "dispatched", target: "escalation", reason: expect.any(String) } });
  });

  it("carries the questions, resolved state and response schema", async () => {
    let request: EscalationRequest | undefined;
    await run({ decide: async () => answer(true, 0.3), awaitEscalation: async received => { request = received; return respond(true); } });
    const { questions: asked, state, schema } = required(request);
    expect([asked, state, schema.check({ answers: { ship: false }, decidedBy: "human" }), schema.check({ answers: { ship: "no" }, decidedBy: "human" }) === true]).toEqual([questions, { plan: "P" }, true, false]);
  });

  it("exposes a resolved escalation with confidence 1 and the responder", async () => {
    const result = await run({ decide: async () => answer(true, 0.3), awaitEscalation: async () => respond(false, "orchestrator") });
    expect(result.outputs.decision).toEqual({ answers: { ship: { value: false, confidence: 1 } }, decidedBy: "orchestrator" });
  });

  it("names the responder as the decision source", async () => {
    const sources: (string | undefined)[] = [];
    await run({ decide: async () => answer(true, 0.3), awaitEscalation: async () => respond(false) }, graph(), { onNodeUpdate: (id, node) => { if (id === "gate") sources.push(node.decisionSource); } });
    expect([sources.slice(0, -1).every(source => source === undefined), sources.at(-1)]).toEqual([true, "human"]);
  });

  it("keeps the decider's cost once across escalation", async () => {
    const result = await run({ decide: async () => answer(true, 0.3, { costUsd: 0.5 }), awaitEscalation: async () => respond(true) });
    expect([result.nodes.gate.costUsd, result.nodes.gate.costAttempts]).toEqual([0.5, 1]);
  });

  it("escalates an exhausted chain with its error", async () => {
    const awaitEscalation = vi.fn<NonNullable<NodeHost["awaitEscalation"]>>(async () => respond(true));
    await run({ decide: async () => ({ ok: false, error: "every entry failed" }), awaitEscalation });
    expect(awaitEscalation).toHaveBeenCalledWith(expect.objectContaining({ reason: expect.stringContaining("every entry failed") }), expect.any(AbortSignal));
  });

  it("escalates a throwing decider with its error", async () => {
    const awaitEscalation = vi.fn<NonNullable<NodeHost["awaitEscalation"]>>(async () => respond(true));
    await run({ decide: async () => { throw new Error("decider crashed"); }, awaitEscalation });
    expect(awaitEscalation).toHaveBeenCalledWith(expect.objectContaining({ reason: expect.stringContaining("decider crashed") }), expect.any(AbortSignal));
  });

  it("escalates when the host cannot run decision models", async () => {
    const result = await run({ awaitEscalation: async () => respond(true) });
    expect(result.outputs.decision).toEqual({ answers: { ship: { value: true, confidence: 1 } }, decidedBy: "human" });
  });

  it("fails the gate when the host cannot escalate", async () => {
    const result = await run({ decide: async () => answer(true, 0.3) });
    expect(result.nodes.gate).toMatchObject({ status: "failed", error: expect.stringContaining("escalate") });
  });

  it("fails a response that does not answer the questions", async () => {
    const result = await run({ decide: async () => answer(true, 0.3), awaitEscalation: async () => ({ ok: true, output: '{"answers":{"ship":"yes"},"decidedBy":"human"}' }) });
    expect(result.nodes.gate.status).toBe("failed");
  });

  it("skips the gate when the escalation is dismissed", async () => {
    const result = await run({ decide: async () => answer(true, 0.3), awaitEscalation: async () => ({ ok: false, skipped: true, error: "dismissed" }) });
    expect([result.nodes.gate.status, result.nodes.done.status]).toEqual(["skipped", "skipped"]);
  });
});

describe("cancellation", () => {
  it("retains a parked decider until it settles and never escalates", async () => {
    const controller = new AbortController(); const parked = deferred<DecisionResult>(); const awaitEscalation = vi.fn<NonNullable<NodeHost["awaitEscalation"]>>();
    let entered = false; let settled = false;
    const running = run({ decide: () => { entered = true; return parked.promise; }, awaitEscalation }, graph(), { signal: controller.signal });
    void running.then(() => { settled = true; });
    await vi.waitFor(() => expect(entered).toBe(true));
    controller.abort();
    await new Promise(resolve => setTimeout(resolve, 10));
    try { expect(settled).toBe(false); }
    finally { parked.resolve(answer(true, 0.3)); }
    const result = await running;
    expect([result.status, awaitEscalation.mock.calls.length]).toEqual(["aborted", 0]);
  });

  it("retains a parked escalation until its handoff settles", async () => {
    const controller = new AbortController(); const parked = deferred<NodeSpawnResult>();
    let entered = false; let settled = false;
    const running = run({ decide: async () => answer(true, 0.3), awaitEscalation: () => { entered = true; return parked.promise; } }, graph(), { signal: controller.signal });
    void running.then(() => { settled = true; });
    await vi.waitFor(() => expect(entered).toBe(true));
    controller.abort();
    await new Promise(resolve => setTimeout(resolve, 10));
    try { expect(settled).toBe(false); }
    finally { parked.resolve({ ok: false, skipped: true, error: "Escalation cancelled." }); }
    expect((await running).status).toBe("aborted");
  });

  it("suppresses the handoff when cancellation follows the escalation checkpoint", async () => {
    const definition = graph(); const controller = new AbortController(); const awaitEscalation = vi.fn<NonNullable<NodeHost["awaitEscalation"]>>();
    await run({ decide: async () => answer(true, 0.3), awaitEscalation }, definition, { signal: controller.signal, onCheckpoint: state => {
      check(definition)(state);
      if (escalated(state)) controller.abort("reload");
    } });
    expect(awaitEscalation).not.toHaveBeenCalled();
  });
});

describe("restore", () => {
  /** Runs until a lifecycle reload interrupts a parked escalation; returns the undrained and drained checkpoints. */
  async function interruptedEscalation() {
    const definition = graph(); const controller = new AbortController(); const parked = deferred<NodeSpawnResult>();
    let entered: EscalationRequest | undefined; let saved: SchedulerState | undefined;
    const running = run({ decide: async () => answer(true, 0.3), awaitEscalation: request => { entered = request; return parked.promise; } }, definition,
      { signal: controller.signal, onCheckpoint: state => { check(definition)(state); saved = state; } });
    await vi.waitFor(() => expect(entered).toBeDefined());
    controller.abort("reload");
    await new Promise(resolve => setTimeout(resolve, 10));
    const undrained = structuredClone(required(saved));
    parked.resolve({ ok: false, skipped: true, error: "Escalation cancelled." });
    await running;
    return { reason: required(entered).reason, checkpoints: { undrained, drained: required(saved) } };
  }

  it.each(["undrained", "drained"] as const)("resumes an %s escalation without deciding again", async kind => {
    const { checkpoints } = await interruptedEscalation();
    const decide = vi.fn<NonNullable<NodeHost["decide"]>>();
    await run({ decide, reconcileDrain: async () => true, awaitEscalation: async () => respond(false) }, graph(), { restore: checkpoints[kind], reclaimedDeadWriter: true });
    expect(decide).not.toHaveBeenCalled();
  });

  it.each(["undrained", "drained"] as const)("re-publishes an %s escalation with its original reason", async kind => {
    const { reason, checkpoints } = await interruptedEscalation();
    const awaitEscalation = vi.fn<NonNullable<NodeHost["awaitEscalation"]>>(async () => respond(false));
    await run({ reconcileDrain: async () => true, awaitEscalation }, graph(), { restore: checkpoints[kind], reclaimedDeadWriter: true });
    expect(awaitEscalation.mock.calls.map(([request]) => request.reason)).toEqual([reason]);
  });

  it("resumes an interrupted escalation to the responder's decision", async () => {
    const { checkpoints } = await interruptedEscalation();
    const result = await run({ awaitEscalation: async () => respond(false) }, graph(), { restore: checkpoints.drained });
    expect(result.outputs.decision).toEqual({ answers: { ship: { value: false, confidence: 1 } }, decidedBy: "human" });
  });

  it("never escalates a restored completed gate again", async () => {
    let saved: SchedulerState | undefined;
    await run({ decide: async () => answer(true, 0.3), awaitEscalation: async () => respond(false) }, graph(), { onCheckpoint: state => { check(graph())(state); saved = state; } });
    const awaitEscalation = vi.fn<NonNullable<NodeHost["awaitEscalation"]>>();
    await run({ awaitEscalation }, graph(), { restore: required(saved) });
    expect(awaitEscalation).not.toHaveBeenCalled();
  });

  it("keeps decision provenance from a restored completed output", async () => {
    let saved: SchedulerState | undefined; let restored: string | undefined;
    await run({ decide: async () => answer(true, 0.3), awaitEscalation: async () => respond(false) }, graph(), { onCheckpoint: state => { check(graph())(state); saved = state; } });
    await run({}, graph(), { restore: required(saved), onNodeUpdate: (id, node) => { if (id === "gate") restored = node.decisionSource; } });
    expect(restored).toBe("human");
  });

  it("rejects an escalation invented without a model decision", async () => {
    let saved: SchedulerState | undefined;
    await run({ decide: async () => answer(true, 0.9) }, graph(), { onCheckpoint: state => { saved = state; } });
    const state = structuredClone(required(saved)); const runtime = required(state.runtime);
    state.runtime = { ...runtime, executionLedger: required(runtime.executionLedger).map(row => "payload" in row && row.payload.kind === "dispatched" && row.payload.target === "agent" && row.instanceId === runtime.manifest.find(entry => entry.binding === "gate")?.instanceId
      ? { ...row, payload: { kind: "dispatched", target: "escalation", reason: "Forged" } } : row) };
    expect(() => validateGraphRestore(state, graph())).toThrow();
  });

  it("claims no decision source while an escalation waits", async () => {
    const parked = deferred<NodeSpawnResult>(); const sources: (string | undefined)[] = []; let waiting: (string | undefined)[] = [];
    const running = run({ decide: async () => answer(true, 0.3), awaitEscalation: () => { waiting = [...sources]; return parked.promise; } }, graph(),
      { onNodeUpdate: (id, node) => { if (id === "gate") sources.push(node.decisionSource); } });
    await vi.waitFor(() => expect(waiting.length).toBeGreaterThan(0));
    parked.resolve(respond(true));
    await running;
    expect(waiting.every(source => source === undefined)).toBe(true);
  });

  it.each(["dismissed", "failed", "cancelled"] as const)("claims no decision source after a %s escalation or its restore", async outcome => {
    const definition = graph(); const controller = new AbortController(); const parked = deferred<NodeSpawnResult>();
    const sources: (string | undefined)[] = []; let entered = false; let saved: SchedulerState | undefined;
    const observe = (id: string, node: { decisionSource?: string }) => { if (id === "gate") sources.push(node.decisionSource); };
    const running = run({ decide: async () => answer(true, 0.3), awaitEscalation: () => { entered = true; return parked.promise; } }, definition,
      { signal: controller.signal, onNodeUpdate: observe, onCheckpoint: state => { check(definition)(state); saved = state; } });
    await vi.waitFor(() => expect(entered).toBe(true));
    if (outcome === "cancelled") controller.abort();
    parked.resolve(outcome === "failed" ? { ok: true, output: "{}" } : { ok: false, skipped: true });
    await running;
    await run({}, definition, { restore: required(saved), onNodeUpdate: observe });
    expect(sources.every(source => source === undefined)).toBe(true);
  });
});

it("adds no delegation selectors to preflight", () => {
  const result = checkGraphDelegation({ nodes: { gate: { type: "decision_gate", state: {}, questions } }, edges: [] }, () => "denied");
  expect(result.ok).toBe(true);
});
