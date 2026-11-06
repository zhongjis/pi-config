import { describe, expect, it, vi } from "vitest";
import { decisionSchema, type FeedbackState, type FeedbackView } from "../src/graph/bounded-feedback.js";
import { validateCheckpointTransition } from "../src/graph/graph-checkpoint-transition.js";
import type { GraphRunSnapshot } from "../src/graph/graph-persist.js";
import { validateGraphRestore } from "../src/graph/graph-restore-validation.js";
import type { AgentGraph, BoundedFeedbackNode, DecisionGateNode } from "../src/graph/ir.js";
import type { DecisionResult, NodeHost, NodeSpawnResult } from "../src/graph/node-host.js";
import { runGraph } from "../src/graph/run-graph.js";
import type { SchedulerState } from "../src/graph/scheduler.js";
import { validateGraph } from "../src/graph/validate.js";
import { deferred, releaseAfterPending } from "./graph-drain.fixture.js";

const itemSchema = { type: "object", properties: { kind: { type: "string" }, query: { type: "string" } }, required: ["kind", "query"], additionalProperties: false };
const judge: DecisionGateNode = { type: "decision_gate", name: "Covered", state: { goal: { path: "$.goal" } }, questions: { covered: { type: "bool", instructions: "Is the goal covered?", criteria: { true: "Covered", false: "Not covered" } } } };
const feedback: BoundedFeedbackNode = {
  type: "bounded_feedback", name: "Research", maxIterations: 3, maxItemsPerIteration: 2, maxTotalItems: 4,
  work: { type: "fanout", items: { path: "$.tasks" }, itemSchema, dispatch: { path: "$.kind", cases: { local: "worker" } }, prompt: `\${item}`, outputSchema: { type: "object" } },
  evaluator: { type: "agent", agent: "tasker", prompt: `\${feedback}`, retry: { maxAttempts: 2 } },
  judge,
};
const input = { goal: "G", tasks: [{ kind: "local", query: "first" }] };
const gap = { id: "g", description: "missing" };
const followup = { gaps: [gap], tasks: [{ gapId: "g", item: { kind: "local", query: "second" } }] };
function graph(node: BoundedFeedbackNode = feedback): AgentGraph { return { nodes: { research: node }, edges: [], outputs: { evidence: { node: "research", path: "$" } } }; }
const verdict = (value: boolean, confidence = 0.9, costUsd?: number): DecisionResult => ({ ok: true, answers: { covered: { value, confidence } }, decidedBy: "classifier", model: "test/classifier", ...(costUsd === undefined ? {} : { costUsd }) });
/** The judge answers from the iteration it was shown (its last item's `r<iteration>`); the tasker writes one follow-up, then none. */
function scripted(options: { verdicts?: (round: number) => boolean; tasks?: (round: number) => unknown; judgeCost?: number; workCost?: number } = {}) {
  const round = (feedback: unknown): number => Number(/^r(\d+)-/.exec((feedback as FeedbackView).items.at(-1)?.id ?? "")?.[1]);
  const decide = vi.fn<NonNullable<NodeHost["decide"]>>(async request => verdict((options.verdicts ?? (n => n > 1))(round(request.state.feedback)), 0.9, options.judgeCost));
  const spawnAgent = vi.fn<NodeHost["spawnAgent"]>(async request => {
    if (request.agentType !== "tasker") return { ok: true, output: JSON.stringify({ evidence: request.nodeId }), ...(options.workCost === undefined ? {} : { costUsd: options.workCost }) };
    // A repair attempt appends the previous failure after the feedback JSON.
    const iteration = round(JSON.parse(request.prompt.split("\n\nPrevious attempt")[0]));
    return { ok: true, output: JSON.stringify((options.tasks ?? (n => n === 1 ? followup : { gaps: [gap], tasks: [] }))(iteration)) };
  });
  return { decide, spawnAgent };
}
function durable() {
  const checkpoints: GraphRunSnapshot[] = [];
  const onCheckpoint = (state: SchedulerState, effective: AgentGraph) => {
    validateGraphRestore(state, effective, input);
    const snapshot: GraphRunSnapshot = JSON.parse(JSON.stringify({ version: 2, runId: state.runtime?.runId ?? "", state, graph: effective, input, waitingGate: "", savedAt: 0 } satisfies GraphRunSnapshot));
    const previous = checkpoints.at(-1);
    if (previous) validateCheckpointTransition(previous, snapshot);
    checkpoints.push(snapshot);
  };
  return { checkpoints, onCheckpoint };
}
const undrained = (state: SchedulerState): boolean => {
  const rows = (state.runtime?.executionLedger ?? []).flatMap(row => "payload" in row ? [row] : []);
  return rows.some(row => row.payload.kind === "admitted" && !rows.some(other => other.executionAttemptId === row.executionAttemptId && other.payload.kind === "drain-ack"));
};
const research = (state: SchedulerState): FeedbackState | undefined => state.runtime?.feedback?.research;
const bindings = (state: SchedulerState | undefined): string[] => state?.runtime?.manifest.map(row => row.binding) ?? [];

describe("bounded feedback judge", () => {
  it("records a sufficient judge verdict without ever materializing an evaluator", async () => {
    const host = scripted({ verdicts: () => true });
    const { checkpoints, onCheckpoint } = durable();
    const result = await runGraph(graph(), input, { host, onCheckpoint });
    expect(result.status).toBe("completed");
    expect(result.feedback?.research).toMatchObject({ reason: "sufficient", partial: false, gaps: [], counters: { iterations: 1, totalItems: 1 } });
    expect(result.feedback?.research.iterations[0]).toMatchObject({ judge: "research:iteration:1:judge", decision: { decision: "sufficient", gaps: [], tasks: [] } });
    expect(result.feedback?.research.iterations[0].evaluator).toBeUndefined();
    expect(host.spawnAgent.mock.calls.map(([request]) => request.agentType)).toEqual(["worker"]);
    expect(checkpoints.flatMap(row => bindings(row.state)).some(binding => binding.endsWith(":evaluator"))).toBe(false);
    // The judge receives its authored state plus the runtime-owned feedback the evaluator would see.
    expect(host.decide).toHaveBeenCalledWith(expect.objectContaining({ state: { goal: "G", feedback: { items: [{ id: "r1-1", item: input.tasks[0], status: "completed", output: { evidence: expect.any(String) } }], gaps: [] } } }), expect.any(AbortSignal));
  });

  it("hands judge and evaluator one flat item list with positional IDs, and returns it in the terminal output", async () => {
    const tasks = [{ kind: "local", query: "first" }, { kind: "local", query: "broken" }];
    const first = { id: "r1-1", item: tasks[0], status: "completed", output: { evidence: "first" } };
    const broken = { id: "r1-2", item: tasks[1], status: "failed", error: "offline" };
    const second = { id: "r2-1", item: followup.tasks[0].item, status: "completed", output: { evidence: "second" } };
    const evaluatorFeedback: unknown[] = [];
    let judged = 0;
    const decide = vi.fn<NonNullable<NodeHost["decide"]>>(async () => verdict(++judged > 1));
    const result = await runGraph(graph(), { goal: "G", tasks }, { onCheckpoint: (state, effective) => validateGraphRestore(state, effective, { goal: "G", tasks }), host: { decide, spawnAgent: async request => {
      if (request.agentType === "tasker") { evaluatorFeedback.push(JSON.parse(request.prompt)); return { ok: true, output: JSON.stringify(followup) }; }
      const { query } = JSON.parse(request.prompt) as { query: string };
      return query === "broken" ? { ok: false, error: "offline" } : { ok: true, output: JSON.stringify({ evidence: query }) };
    } } });
    expect(evaluatorFeedback).toEqual([{ items: [first, broken], gaps: [] }]);
    expect(decide.mock.calls.map(([request]) => request.state.feedback)).toEqual([{ items: [first, broken], gaps: [] }, { items: [first, broken, second], gaps: [gap] }]);
    expect(result.feedback?.research.items).toEqual([first, broken, second]);
    expect(result.outputs.evidence).toMatchObject({ reason: "sufficient", items: [first, broken, second] });
  });

  it("keeps the previous evaluator's open gaps through a sufficient judge verdict for downstream nodes", async () => {
    const outside = { id: "outside-foo", description: "Outside the plan" };
    const open = { id: "p1-x", description: "Part one lacks a source" };
    const definition: AgentGraph = { ...graph(), nodes: { ...graph().nodes, writer: { type: "agent", agent: "writer", prompt: `\${gaps}`, input: { gaps: { node: "research", path: "$.gaps" } } } }, edges: [{ from: "research", to: "writer" }] };
    const host = scripted({ tasks: () => ({ gaps: [outside, open], tasks: [{ gapId: "p1-x", item: { kind: "local", query: "second" } }] }) });
    const writerPrompts: string[] = [];
    const result = await runGraph(definition, input, { onCheckpoint: durable().onCheckpoint, host: { ...host, spawnAgent: async (request, signal) => {
      if (request.agentType !== "writer") return host.spawnAgent(request, signal);
      writerPrompts.push(request.prompt);
      return { ok: true, output: "report" };
    } } });
    expect(result.feedback?.research).toMatchObject({ reason: "sufficient", partial: true, gaps: [outside, open], counters: { iterations: 2 } });
    expect(result.feedback?.research.iterations[1]).toMatchObject({ judge: "research:iteration:2:judge", decision: { decision: "sufficient", gaps: [], tasks: [] } });
    expect(writerPrompts.map(prompt => JSON.parse(prompt))).toEqual([[outside, open]]);
  });

  it("materializes work and items first, then the judge, then the evaluator only after a false verdict", async () => {
    const host = scripted();
    const { checkpoints, onCheckpoint } = durable();
    const result = await runGraph(graph(), input, { host, onCheckpoint });
    expect(result.feedback?.research).toMatchObject({ reason: "sufficient", counters: { iterations: 2, totalItems: 2 }, gaps: [gap] });
    expect(result.feedback?.research.iterations[0]).toMatchObject({ judge: "research:iteration:1:judge", evaluator: "research:iteration:1:evaluator", decision: { decision: "continue", ...followup } });
    const first = checkpoints.find(row => research(row.state)?.active?.iteration === 1);
    expect(research(first?.state ?? { nodes: {}, loopCounts: {} })?.active).toEqual({ iteration: 1, tasks: input.tasks, work: "research:iteration:1:work", workInstanceId: expect.any(String) });
    expect(bindings(first?.state)).toEqual(["research", "research:iteration:1:work", "research:iteration:1:work:item:0"]);
    expect(bindings(checkpoints.at(-1)?.state)).toEqual(["research", "research:iteration:1:work", "research:iteration:1:work:item:0", "research:iteration:1:judge", "research:iteration:1:evaluator",
      "research:iteration:2:work", "research:iteration:2:work:item:0", "research:iteration:2:judge"]);
    const tasker = host.spawnAgent.mock.calls.find(([request]) => request.agentType === "tasker")?.[0];
    expect(tasker?.schema?.check({ gaps: [], tasks: [] })).toBe(true);
    expect(tasker?.schema?.check({ decision: "continue", ...followup })).not.toBe(true);
    expect(checkpoints.at(-1)?.graph.nodes["research:iteration:1:evaluator"]).toMatchObject({ outputSchema: decisionSchema(itemSchema, true) });
  });

  it("stops with no accessible route when the evaluator returns tasks []", async () => {
    const host = scripted({ verdicts: () => false, tasks: () => ({ gaps: [gap], tasks: [] }) });
    const result = await runGraph(graph(), input, { host, onCheckpoint: durable().onCheckpoint });
    expect(result.status).toBe("completed");
    expect(result.feedback?.research).toMatchObject({ reason: "no accessible route", partial: true, gaps: [gap], counters: { iterations: 1 } });
    expect(result.feedback?.research.iterations[0].decision).toEqual({ decision: "continue", gaps: [gap], tasks: [] });
  });

  it("repairs a malformed lazy evaluator on the same instance with durable failure evidence", async () => {
    let calls = 0;
    const host = scripted({ tasks: round => round > 1 ? { gaps: [], tasks: [] } : ++calls === 1 ? { decision: "continue", ...followup } : followup });
    const { checkpoints, onCheckpoint } = durable();
    const result = await runGraph(graph(), input, { host, onCheckpoint });
    expect(result.feedback?.research).toMatchObject({ reason: "sufficient", counters: { iterations: 2 } });
    const taskers = host.spawnAgent.mock.calls.filter(([request]) => request.agentType === "tasker");
    expect(taskers.map(([request]) => request.nodeId)).toEqual([taskers[0][0].nodeId, taskers[0][0].nodeId]);
    expect(checkpoints.some(row => research(row.state)?.retryFailures === 1)).toBe(true);
    expect(research(checkpoints.find(row => research(row.state)?.active?.iteration === 2)?.state ?? { nodes: {}, loopCounts: {} })?.retryFailures).toBe(0);
  });

  it("stops as evaluator failure when the judge fails, without an evaluator", async () => {
    const host = { ...scripted(), decide: async (): Promise<DecisionResult> => ({ ok: false, error: "no model" }) };
    const result = await runGraph(graph(), input, { host, onCheckpoint: durable().onCheckpoint });
    expect(result.status).toBe("completed");
    expect(result.feedback?.research).toMatchObject({ reason: "evaluator failure", partial: true, iterations: [{ judge: "research:iteration:1:judge", evaluatorError: expect.any(String) }] });
    expect(result.nodes["research:iteration:1:evaluator"]).toBeUndefined();
  });

  it("fails a lazy step that concurrent growth left without capacity, and restores that terminal", async () => {
    const definition: AgentGraph = { ...graph(), nodes: { ...graph().nodes, src: { type: "agent", agent: "source", prompt: "fragment", outputSchema: { type: "object" } }, grow: { type: "expand", source: { node: "src", path: "$" } } }, edges: [{ from: "src", to: "grow" }] };
    for (let index = 0; index < 493; index++) definition.nodes[`static${index}`] = { type: "agent", agent: "filler", prompt: "static" };
    const worked = deferred<void>(); const grown = deferred<void>(); const host = scripted();
    let final: { state: SchedulerState; graph: AgentGraph } | undefined;
    const result = await runGraph(definition, input, { onCheckpoint: (state, effective) => { final = { state, graph: effective }; }, onNodeUpdate: (id, run) => { if (id === "grow" && run.status === "completed") grown.resolve(); }, host: { ...host, spawnAgent: async (request, signal) => {
      if (request.agentType === "source") { await worked.promise; return { ok: true, output: JSON.stringify({ nodes: { x1: { type: "agent", agent: "filler", prompt: "x" }, x2: { type: "agent", agent: "filler", prompt: "x" } }, edges: [] }) }; }
      if (request.agentType === "worker") { worked.resolve(); await grown.promise; }
      return request.agentType === "filler" ? { ok: true, output: "ok" } : host.spawnAgent(request, signal);
    } } });
    expect(result.feedback?.research).toMatchObject({ reason: "materialization failure", exhaustedBounds: ["node limit"], counters: { iterations: 1 } });
    expect(result.nodes["research:iteration:1:judge"]).toBeUndefined();
    expect(host.decide).not.toHaveBeenCalled();
    if (!final) throw new Error("missing terminal checkpoint");
    validateGraphRestore(final.state, final.graph, input);
    const spawnAgent = vi.fn();
    await runGraph(final.graph, input, { restore: final.state, onCheckpoint: () => {}, host: { spawnAgent } });
    expect(spawnAgent).not.toHaveBeenCalled();
  });

  it("restores every judged step checkpoint without minting replacement identities", async () => {
    const { checkpoints, onCheckpoint } = durable();
    await runGraph(graph(), input, { host: scripted(), onCheckpoint });
    expect(checkpoints.some(row => research(row.state)?.active?.judge !== undefined && research(row.state)?.active?.evaluator === undefined)).toBe(true);
    expect(checkpoints.some(row => research(row.state)?.active?.evaluator !== undefined)).toBe(true);
    for (const saved of checkpoints) {
      const host = scripted(); const allocated: string[] = [];
      const result = await runGraph(saved.graph, input, { restore: saved.state, reclaimedDeadWriter: true, host: { ...host, reconcileDrain: async () => true, spawnAgent: async (request, signal) => { allocated.push(request.nodeId); return host.spawnAgent(request, signal); } }, onCheckpoint: (state, effective) => {
        validateGraphRestore(state, effective, input);
        for (const row of saved.state.runtime?.manifest ?? []) expect(state.runtime?.manifest).toContainEqual(row);
      } });
      expect(result.status).toBe("completed");
      // A crash mid-execution consumes that single-attempt budget; every other boundary resumes to the same outcome.
      if (!undrained(saved.state)) expect(result.feedback?.research).toMatchObject({ reason: "sufficient", counters: { iterations: 2 } });
      expect(new Set(allocated).size).toBe(allocated.length);
    }
  });

  it("rejects restored judged rows that contradict their judge or skip it", async () => {
    const { checkpoints, onCheckpoint } = durable();
    await runGraph(graph(), input, { host: scripted(), onCheckpoint });
    const final = checkpoints.at(-1);
    if (!final) throw new Error("missing terminal checkpoint");
    const overruled = structuredClone(final); const answer = overruled.state.nodes["research:iteration:2:judge"].output as { answers: { covered: { value: boolean } } };
    answer.answers.covered.value = false;
    expect(() => validateGraphRestore(overruled.state, overruled.graph, input)).toThrow(/Forged evaluator decision/);
    const skipped = structuredClone(final); const skippedRow = research(skipped.state)?.iterations[0];
    if (!skippedRow) throw new Error("missing feedback");
    Reflect.deleteProperty(skippedRow, "judge"); Reflect.deleteProperty(skippedRow, "judgeInstanceId");
    expect(() => validateGraphRestore(skipped.state, skipped.graph, input)).toThrow(/skipped its judge/);
  });

  it("counts judge cost toward spendLimit before materializing the evaluator", async () => {
    const host = scripted({ verdicts: () => false, judgeCost: 0.4, workCost: 0.2 });
    const { checkpoints, onCheckpoint } = durable();
    const result = await runGraph(graph({ ...feedback, spendLimit: 0.5 }), input, { now: () => 1000, host, onCheckpoint });
    expect(result.feedback?.research).toMatchObject({ reason: "deadline/spend limit", partial: true, exhaustedBounds: ["spendLimit"], counters: { iterations: 1 } });
    expect(result.feedback?.research.iterations[0]).toMatchObject({ judge: "research:iteration:1:judge" });
    expect(bindings(checkpoints.at(-1)?.state).some(binding => binding.endsWith(":evaluator"))).toBe(false);
    expect(host.spawnAgent.mock.calls.every(([request]) => request.agentType === "worker")).toBe(true);
    const unavailable = await runGraph(graph({ ...feedback, spendLimit: 5 }), input, { now: () => 1000, host: scripted({ verdicts: () => false, workCost: 0.2 }), onCheckpoint: durable().onCheckpoint });
    expect(unavailable.feedback?.research).toMatchObject({ reason: "deadline/spend limit", exhaustedBounds: ["spend accounting unavailable"] });
  });

  it("keeps spend accounting for a judge restored escalation-only after a lifecycle reload", async () => {
    const definition = graph({ ...feedback, spendLimit: 5 });
    const controller = new AbortController(); const parked = deferred<NodeSpawnResult>(); const entered = deferred<void>();
    let saved: { state: SchedulerState; graph: AgentGraph } | undefined;
    const running = runGraph(definition, input, { signal: controller.signal, now: () => 1000, onCheckpoint: (state, effective) => { validateGraphRestore(state, effective, input); saved = { state, graph: effective }; },
      host: { ...scripted({ workCost: 0.2 }), decide: async () => verdict(true, 0.3, 0.1), awaitEscalation: () => { entered.resolve(); return parked.promise; } } });
    await entered.promise;
    controller.abort("reload");
    await releaseAfterPending(running, () => parked.resolve({ ok: false, skipped: true, error: "Escalation cancelled." }));
    await running;
    if (!saved) throw new Error("missing lifecycle checkpoint");
    const decide = vi.fn<NonNullable<NodeHost["decide"]>>();
    const result = await runGraph(saved.graph, input, { restore: saved.state, now: () => 2000, onCheckpoint: (state, effective) => validateGraphRestore(state, effective, input),
      host: { ...scripted({ workCost: 0.2 }), decide, awaitEscalation: async () => ({ ok: true, output: JSON.stringify({ answers: { covered: true }, decidedBy: "orchestrator" }) }) } });
    expect(decide).not.toHaveBeenCalled();
    expect(result.nodes["research:iteration:1:judge"]).toMatchObject({ status: "completed", attempt: 2, costUsd: 0.1, costAttempts: 1 });
    expect(result.feedback?.research).toMatchObject({ reason: "sufficient", exhaustedBounds: [] });
  });

  it("keeps the no-judge checkpoint shape: evaluator committed with the work, classic schema, no judge rows", async () => {
    const { judge: _judge, ...classic } = feedback;
    const decisions = [{ decision: "continue", ...followup }, { decision: "sufficient", gaps: [], tasks: [] }];
    const { checkpoints, onCheckpoint } = durable();
    const decide = vi.fn<NonNullable<NodeHost["decide"]>>();
    const result = await runGraph(graph(classic), input, { onCheckpoint, host: { decide, spawnAgent: async request => ({ ok: true, output: JSON.stringify(request.agentType === "tasker" ? decisions.shift() : { evidence: request.nodeId }) }) } });
    expect(result.feedback?.research).toMatchObject({ reason: "sufficient", counters: { iterations: 2 } });
    expect(decide).not.toHaveBeenCalled();
    const materialized = checkpoints.find(row => research(row.state)?.active?.iteration === 1);
    expect(Object.keys(research(materialized?.state ?? { nodes: {}, loopCounts: {} })?.active ?? {})).toEqual(["iteration", "tasks", "work", "evaluator", "workInstanceId", "evaluatorInstanceId"]);
    expect(bindings(materialized?.state)).toEqual(["research", "research:iteration:1:work", "research:iteration:1:evaluator", "research:iteration:1:work:item:0"]);
    expect(materialized?.graph.edges).toEqual([{ from: "research:iteration:1:work", to: "research:iteration:1:evaluator" }]);
    expect(materialized?.graph.nodes["research:iteration:1:evaluator"]).toEqual({ type: "agent", agent: "tasker", prompt: `\${feedback}`, retry: { maxAttempts: 2 }, input: { feedback: { path: "$" } }, outputSchema: {
      type: "object", additionalProperties: false, required: ["decision", "gaps", "tasks"], properties: {
        decision: { enum: ["sufficient", "continue"] },
        gaps: { type: "array", items: { type: "object", required: ["id", "description"], additionalProperties: false, properties: { id: { type: "string", minLength: 1 }, description: { type: "string", minLength: 1 } } } },
        tasks: { type: "array", items: { type: "object", required: ["gapId", "item"], additionalProperties: false, properties: { gapId: { type: "string" }, item: itemSchema } } },
      } } });
    expect(JSON.stringify(checkpoints)).not.toContain("judge");
  });
});

describe("judge validation", () => {
  const errors = (node: unknown) => validateGraph({ ...graph(), nodes: { research: node } }).errors;
  it("accepts one bool question and rejects other judge shapes", () => {
    expect(errors(feedback)).toEqual([]);
    expect(errors({ ...feedback, judge: { type: "agent", agent: "a", prompt: "p" } })).toContain("nodes.research.judge: must be a fixed decision_gate template");
    expect(errors({ ...feedback, judge: { ...judge, questions: { ...judge.questions, other: judge.questions.covered } } })).toContain("nodes.research.judge.questions: must declare exactly one bool question");
    expect(errors({ ...feedback, judge: { ...judge, questions: { pick: { type: "choice", instructions: "Pick", criteria: { a: "A", b: "B" } } } } })).toContain("nodes.research.judge.questions: must declare exactly one bool question");
    expect(errors({ ...feedback, judge: { ...judge, state: { feedback: { path: "$.goal" } } } })).toContain("nodes.research: judge.state.feedback is reserved");
    expect(errors({ ...feedback, judge: { ...judge, prompt: "x" } })).toContain("nodes.research.judge.prompt: unknown decision_gate field");
  });
});
