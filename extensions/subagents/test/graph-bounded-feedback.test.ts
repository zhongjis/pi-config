import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { checkGraphDelegation } from "../src/graph/delegation-preflight.js";
import { validateCheckpointTransition } from "../src/graph/graph-checkpoint-transition.js";
import type { GraphRunSnapshot } from "../src/graph/graph-persist.js";
import { validateGraphRestore } from "../src/graph/graph-restore-validation.js";
import type { AgentGraph, BoundedFeedbackNode } from "../src/graph/ir.js";
import { type GraphControl, runGraph } from "../src/graph/run-graph.js";
import type { SchedulerState } from "../src/graph/scheduler.js";
import { validateGraph } from "../src/graph/validate.js";
import { deferred, releaseAfterPending } from "./graph-drain.fixture.js";

const feedback: BoundedFeedbackNode = {
  type: "bounded_feedback", name: "Research", maxIterations: 2, maxItemsPerIteration: 2, maxTotalItems: 4,
  work: { type: "fanout", items: { path: "$.tasks" }, itemSchema: { type: "object", properties: { kind: { type: "string" }, query: { type: "string" } }, required: ["kind", "query"], additionalProperties: false }, dispatch: { path: "$.kind", cases: { local: "worker" } }, prompt: `\${item}`, outputSchema: { type: "object" } },
  evaluator: { type: "agent", agent: "judge", prompt: `\${feedback}`, retry: { maxAttempts: 2 } },
};
const initial = { kind: "local", query: "first" };
const more = { decision: "continue", gaps: [{ id: "g", description: "missing" }], tasks: [{ gapId: "g", item: { kind: "local", query: "second" } }] };
const enough = { decision: "sufficient", gaps: [], tasks: [] };
function graph(node = feedback): AgentGraph { return { version: 2, nodes: { research: node }, edges: [], outputs: { evidence: { node: "research", path: "$" } } }; }
async function execute(decisions: unknown[], node = feedback) {
  const requests: { nodeId: string; agentType: string; attempt: number }[] = [];
  const checkpoints: { state: SchedulerState; graph: AgentGraph }[] = [];
  let work = 0;
  const result = await runGraph(graph(node), { tasks: [initial] }, {
    onCheckpoint: (state, effective) => checkpoints.push({ state, graph: effective }),
    host: { spawnAgent: async request => {
      requests.push(request);
      return { ok: true, output: JSON.stringify(request.agentType === "judge" ? decisions.shift() : { evidence: ++work }) };
    } },
  });
  return { result, requests, checkpoints };
}

describe("bounded feedback", () => {
  it("validates versions, templates, bounds and references; preflights both templates", () => {
    expect(validateGraph(graph()).ok).toBe(true);
    for (const version of [undefined, 1, 3]) expect(validateGraph({ ...graph(), version }).ok).toBe(false);
    for (const field of ["maxIterations", "maxItemsPerIteration", "maxTotalItems"]) {
      for (const value of [undefined, 0, -1, 1.5]) expect(validateGraph(graph({ ...feedback, [field]: value })).ok).toBe(false);
    }
    expect(validateGraph(graph({ ...feedback, work: { ...feedback.work, items: { node: "missing", path: "$" } } })).ok).toBe(false);
    const seen: string[] = [];
    checkGraphDelegation(graph(), agent => { seen.push(agent); return "denied"; });
    expect(seen.sort()).toEqual(["judge", "worker"]);
  });
  it("sufficient creates one iteration; continue appends exactly one fresh successor", async () => {
    for (const decisions of [[enough], [more, enough]]) {
      const count = decisions.length;
      const { result, requests, checkpoints } = await execute([...decisions]);
      expect(result.status).toBe("completed");
      expect(result.outputs.evidence).toMatchObject({ reason: "sufficient", partial: false, counters: { iterations: count, totalItems: count } });
      expect(requests).toHaveLength(count * 2);
      expect(new Set(requests.map(r => r.nodeId)).size).toBe(count * 2);
      const final = checkpoints.at(-1);
      expect(final?.state.runtime?.manifest).toHaveLength(1 + count * 3);
    }
  });
  it("repairs malformed and gap-unlinked decisions on the same evaluator instance", async () => {
    const { result, requests } = await execute([{ ...more, tasks: [{ gapId: "unknown", item: initial }] }, enough]);
    expect(result.outputs.evidence).toMatchObject({ reason: "sufficient", counters: { iterations: 1 } });
    const judges = requests.filter(r => r.agentType === "judge");
    expect(judges).toHaveLength(2);
    expect(judges[0]?.nodeId).toBe(judges[1]?.nodeId);
  });
  it.each([
    ["iteration limit", { maxIterations: 1 }, more],
    ["item limit", { maxTotalItems: 1 }, more],
    ["item limit", { maxItemsPerIteration: 1 }, { ...more, tasks: [more.tasks[0], more.tasks[0]] }],
    ["no progress", {}, { ...more, tasks: [{ gapId: "g", item: { query: "first", kind: "local" } }] }],
    ["evaluator failure", {}, {}],
  ])("terminates with %s without a successor", async (reason, bounds, decision) => {
    const { result, requests } = await execute([decision, decision], { ...feedback, ...bounds });
    expect(result.outputs.evidence).toMatchObject({ reason, partial: true, counters: { iterations: 1 } });
    expect(requests.filter(r => r.agentType === "worker")).toHaveLength(1);
  });
  it("restores each intent/materialization/dispatch boundary without minting replacement IDs", async () => {
    const { checkpoints } = await execute([more, enough]);
    for (const saved of checkpoints) {
      const allocated: string[] = [];
      const result = await runGraph(saved.graph, { tasks: [initial] }, {
        restore: saved.state, reclaimedDeadWriter: true, onCheckpoint: (state, effectiveGraph) => {
          validateGraphRestore(state, effectiveGraph, { tasks: [initial] });
          for (const row of saved.state.runtime?.manifest ?? []) expect(state.runtime?.manifest).toContainEqual(row);
        },
        host: { reconcileDrain: async () => true, spawnAgent: async request => {
          allocated.push(request.nodeId);
          return { ok: true, output: JSON.stringify(request.agentType === "judge" ? (saved.state.runtime?.manifest.length === 4 ? more : enough) : { evidence: request.nodeId }) };
        } },
      });
      expect(result.status).toBe("completed");
      expect(new Set(allocated).size).toBe(allocated.length);
      expect(Object.keys(result.nodes).length).toBeLessThanOrEqual(7);
    }
  });
  it("cancels with explicit partial accumulation", async () => {
    const controller = new AbortController();
    const execution = deferred<{ ok: boolean }>();
    const pending = runGraph(graph(), { tasks: [initial] }, { signal: controller.signal, onCheckpoint: () => {}, host: { spawnAgent: async () => { controller.abort(); return execution.promise; } } });
    await releaseAfterPending(pending, () => execution.resolve({ ok: true }));
    const result = await pending;
    expect(result.status).toBe("aborted");
    expect(result.outputs.evidence).toMatchObject({ reason: "cancellation", partial: true });
  });
});

it("retains partial failures and stops when a successor adds no distinct validated result", async () => {
  let evaluations = 0;
  const result = await runGraph(graph(), { tasks: [initial, { ...initial, query: "bad" }] }, {
    onCheckpoint: () => {},
    host: { spawnAgent: async request => request.agentType === "judge"
      ? { ok: true, output: JSON.stringify(evaluations++ === 0 ? more : enough) }
      : request.prompt.includes('"bad"') ? { ok: false, error: "offline" } : { ok: true, output: '{"evidence":1}' } },
  });
  expect(result.outputs.evidence).toMatchObject({ reason: "no progress", partial: true, iterations: [
    { results: [{ status: "completed" }, { status: "failed", error: "offline" }] },
    { results: [{ status: "completed" }] },
  ] });
});

it("fails closed on corrupt restored feedback before dispatch or checkpoint replacement", async () => {
  const { checkpoints } = await execute([more, enough]);
  const saved = checkpoints.find(row => row.state.runtime?.feedback?.research?.active);
  if (!saved?.state.runtime?.feedback?.research?.active) throw new Error("missing fixture checkpoint");
  const corrupt = structuredClone(saved);
  const state = corrupt.state.runtime?.feedback?.research;
  const active = state?.active;
  if (!state || !active) throw new Error("missing active iteration");
  state.active = { ...active, work: "missing" };
  const spawnAgent = vi.fn();
  const onCheckpoint = vi.fn();
  await expect(runGraph(corrupt.graph, { tasks: [initial] }, { restore: corrupt.state, onCheckpoint, host: { spawnAgent } })).rejects.toThrow();
  expect(spawnAgent).not.toHaveBeenCalled();
  expect(onCheckpoint).not.toHaveBeenCalled();
});

it("blocks node and item ceilings before materializing iteration rows", async () => {
  const many: AgentGraph = { ...graph(), nodes: { ...graph().nodes } };
  for (let index = 0; index < 497; index++) many.nodes[`static${index}`] = { type: "agent", agent: "worker", prompt: "static" };
  let count = 0; let checkpoints = 0;
  const clone = vi.spyOn(globalThis, "structuredClone");
  const result = await runGraph(many, { tasks: [initial] }, { onCheckpoint: state => { count = state.runtime?.manifest.length ?? 0; checkpoints++; }, host: { spawnAgent: async () => ({ ok: true, output: "ok" }) } });
  expect(result.nodes.research.output).toMatchObject({ reason: "materialization failure", exhaustedBounds: ["node limit"] });
  expect(count).toBe(498);
  expect(checkpoints).toBeLessThan(135);
  expect(clone.mock.calls.length).toBeLessThan(140);
  clone.mockRestore();
  expect(validateGraph(graph({ ...feedback, deadline: 100 })).ok).toBe(true);
  expect(validateGraph(graph({ ...feedback, spendLimit: 1 })).ok).toBe(true);
});

it.each(["before intent", "after intent", "before manifest", "after manifest"])("restores a crash %s with one successor", async boundary => {
  let saved: { state: SchedulerState; graph: AgentGraph } | undefined;
  const host = { spawnAgent: async (request: { agentType: string; prompt: string; nodeId: string }) => {
    const context: unknown = request.agentType === "judge" ? JSON.parse(request.prompt) : undefined;
    const first = typeof context === "object" && context !== null && "iterations" in context && Array.isArray(context.iterations) && context.iterations.length === 1;
    return { ok: true, output: JSON.stringify(request.agentType === "judge" ? first ? more : enough : { evidence: request.nodeId }) };
  } };
  await expect(runGraph(graph(), { tasks: [initial] }, { host, onCheckpoint: (state, effective) => {
    const feedbackState = state.runtime?.feedback?.research;
    const crash = boundary.endsWith("intent") ? feedbackState?.intent?.iteration === 2 : feedbackState?.active?.iteration === 2;
    if (crash && boundary.startsWith("before")) throw new Error("simulated process loss");
    saved = { state, graph: effective };
    if (crash) throw new Error("simulated process loss");
  } })).rejects.toThrow("simulated process loss");
  if (!saved) throw new Error("missing crash checkpoint");
  const original = saved.state.runtime?.manifest ?? [];
  const resumed = await runGraph(saved.graph, { tasks: [initial] }, { host, restore: saved.state, onCheckpoint: state => {
    for (const row of original) expect(state.runtime?.manifest).toContainEqual(row);
    expect(state.runtime?.manifest.length).toBeLessThanOrEqual(7);
  } });
  expect(resumed.outputs.evidence).toMatchObject({ reason: "sufficient", counters: { iterations: 2, totalItems: 2 } });
});

it("uses restored authoritative run counts before materializing feedback", async () => {
  const { checkpoints } = await execute([enough]);
  const initialCheckpoint = checkpoints[0];
  if (!initialCheckpoint) throw new Error("missing initial checkpoint");
  const state = structuredClone(initialCheckpoint.state);
  state.nodes.research.attempt = 998;
  const spawnAgent = vi.fn();
  const result = await runGraph(graph(), { tasks: [initial] }, { restore: state, onCheckpoint: () => {}, host: { spawnAgent } });
  expect(result.feedback?.research).toMatchObject({ reason: "materialization failure", exhaustedBounds: ["run limit"] });
  expect(spawnAgent).not.toHaveBeenCalled();
});

it("rejects a corrupted terminal accumulator before downstream synthesis", async () => {
  const { checkpoints } = await execute([enough]);
  const saved = checkpoints.at(-1);
  if (!saved) throw new Error("missing terminal checkpoint");
  const state = structuredClone(saved.state);
  state.nodes.research.output = { reason: "sufficient" };
  const spawnAgent = vi.fn();
  await expect(runGraph(saved.graph, { tasks: [initial] }, { restore: state, onCheckpoint: () => {}, host: { spawnAgent } })).rejects.toThrow();
  expect(spawnAgent).not.toHaveBeenCalled();
});

it("validates the public v2 authoring fixture", () => {
  const fixture: unknown = JSON.parse(readFileSync(new URL("./fixtures/bounded-feedback.graph.json", import.meta.url), "utf8"));
  expect(validateGraph(fixture)).toEqual({ ok: true, errors: [] });
});

it("suspends on lifecycle reload without converting durable work into cancellation", async () => {
  const controller = new AbortController();
  let saved: { state: SchedulerState; graph: AgentGraph } | undefined;
  const execution = deferred<{ ok: boolean }>();
  const pending = runGraph(graph(), { tasks: [initial] }, { signal: controller.signal, onCheckpoint: (state, effective) => { saved = { state, graph: effective }; }, host: { spawnAgent: async () => { controller.abort("reload"); return execution.promise; } } });
  await releaseAfterPending(pending, () => execution.resolve({ ok: true }));
  await pending;
  if (!saved) throw new Error("missing lifecycle checkpoint");
  expect(saved.state.runtime?.cancelled).not.toBe(true);
  const result = await runGraph(saved.graph, { tasks: [initial] }, { restore: saved.state, allocateInstanceId: () => { throw new Error("replacement identity"); }, onCheckpoint: () => {}, host: { spawnAgent: async request => ({ ok: true, output: JSON.stringify(request.agentType === "judge" ? enough : { evidence: 1 }) }) } });
  expect(result.outputs.evidence).toMatchObject({ reason: "sufficient", partial: false });
});

it("preserves the evaluator repair budget across a restart", async () => {
  const { checkpoints } = await execute([{}, enough]);
  const saved = checkpoints.find(row => row.state.runtime?.feedback?.research?.retryFailures === 1);
  if (!saved) throw new Error("missing repair checkpoint");
  const spawnAgent = vi.fn(async () => ({ ok: true, output: "{}" }));
  const result = await runGraph(saved.graph, { tasks: [initial] }, { restore: saved.state, reclaimedDeadWriter: true, onCheckpoint: () => {}, host: { spawnAgent, reconcileDrain: async () => true } });
  expect(result.outputs.evidence).toMatchObject({ reason: "evaluator failure", partial: true });
  expect(spawnAgent).toHaveBeenCalledTimes(0);
});

it.each(["child agent", "child prompt", "child schema", "child parent", "child iteration", "child item", "result status", "result attempt", "result output", "result error", "false sufficient", "false partial", "bounds"])("rejects forged v2 %s before replacement or dispatch", async mutation => {
  const { checkpoints } = await execute(mutation === "false sufficient" ? [more, more] : [enough]);
  const saved = structuredClone(checkpoints.at(-1));
  const state = saved?.state.runtime?.feedback?.research;
  if (!saved?.state.runtime || !state?.terminal) throw new Error("missing fixture");
  const row = state.iterations[0]; const childKey = `${row.work}:item:0`;
  const instance = saved.state.runtime.manifest.find(entry => entry.binding === childKey);
  if (!instance) throw new Error("missing child");
  if (mutation === "child agent") Object.assign(saved.graph.nodes[childKey], { agent: "forbidden" });
  if (mutation === "child prompt") Object.assign(saved.graph.nodes[childKey], { prompt: "forged" });
  if (mutation === "child schema") Object.assign(saved.graph.nodes[childKey], { outputSchema: {} });
  if (mutation === "child parent") Object.assign(instance, { parentInstanceId: row.evaluatorInstanceId });
  if (mutation === "child iteration") Object.assign(instance, { iteration: 99 });
  if (mutation === "child item") Object.assign(instance, { itemIndex: 99 });
  if (mutation === "result status") Object.assign(row.results[0], { status: "failed" });
  if (mutation === "result attempt") Object.assign(row.results[0], { attempt: 999 });
  if (mutation === "result output") Object.assign(row.results[0], { output: { forged: true } });
  if (mutation === "result error") Object.assign(row.results[0], { error: "forged" });
  if (mutation === "false sufficient") { state.gaps = []; Object.assign(state.terminal, { reason: "sufficient", partial: false, gaps: [] }); }
  if (mutation === "false partial") Object.assign(state.terminal, { partial: true });
  if (mutation === "bounds") Object.assign(state.terminal, { exhaustedBounds: ["made up"] });
  Object.assign(state.terminal, { iterations: structuredClone(state.iterations) });
  saved.state.nodes.research.output = structuredClone(state.terminal);
  const onCheckpoint = vi.fn(); const spawnAgent = vi.fn();
  await expect(runGraph(saved.graph, { tasks: [initial] }, { restore: saved.state, onCheckpoint, host: { spawnAgent } })).rejects.toThrow();
  expect(onCheckpoint).not.toHaveBeenCalled(); expect(spawnAgent).not.toHaveBeenCalled();
});

it("rejects a continuation intent beyond maxIterations before any allocation", async () => {
  const { checkpoints } = await execute([enough], { ...feedback, maxIterations: 1 });
  const saved = structuredClone(checkpoints.at(-1)); const state = saved?.state.runtime?.feedback?.research;
  if (!saved || !state) throw new Error("missing fixture");
  delete state.terminal; state.intent = { iteration: 2, tasks: more.tasks.map(task => task.item) };
  saved.state.nodes.research = { status: "running", attempt: 1 };
  const allocate = vi.fn(); const onCheckpoint = vi.fn(); const spawnAgent = vi.fn();
  await expect(runGraph(saved.graph, { tasks: [initial] }, { restore: saved.state, allocateInstanceId: allocate, onCheckpoint, host: { spawnAgent } })).rejects.toThrow();
  expect(allocate).not.toHaveBeenCalled(); expect(onCheckpoint).not.toHaveBeenCalled(); expect(spawnAgent).not.toHaveBeenCalled();
});

it("continues host evaluator attempt provenance after restore", async () => {
  const { checkpoints } = await execute([{}, enough], { ...feedback, evaluator: { ...feedback.evaluator, retry: { maxAttempts: 3 } } });
  const saved = checkpoints.find(row => row.state.runtime?.feedback?.research?.retryFailures === 1);
  if (!saved) throw new Error("missing repair checkpoint");
  const requests: number[] = [];
  await runGraph(saved.graph, { tasks: [initial] }, { restore: saved.state, reclaimedDeadWriter: true, onCheckpoint: () => {}, host: { reconcileDrain: async () => true, spawnAgent: async request => { requests.push(request.attempt); return { ok: true, output: JSON.stringify(enough) }; } } });
  expect(requests).toEqual([3]);
});

describe("configured deadline and USD spend", () => {
  it("validates exact budget fields and units", () => {
    expect(validateGraph(graph({ ...feedback, deadline: 100, spendLimit: 0.25 })).ok).toBe(true);
    for (const deadline of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) expect(validateGraph(graph({ ...feedback, deadline })).ok).toBe(false);
    for (const spendLimit of [0, -1, NaN, Infinity]) expect(validateGraph(graph({ ...feedback, spendLimit })).ok).toBe(false);
    expect(validateGraph({ ...graph(), nodes: { research: { ...feedback, deadlineMs: 100 } } }).ok).toBe(false);
  });
  it.each(["initial", "evaluator", "restored intent"])("checks deadline at %s without successor allocation", async boundary => {
    let time = 1000; const checkpoints: { state: SchedulerState; graph: AgentGraph }[] = [];
    const spawnAgent = vi.fn(async (request: { agentType: string }) => {
      if (request.agentType === "judge" && boundary === "evaluator") time = 1100;
      return { ok: true, costUsd: 0.1, output: JSON.stringify(request.agentType === "judge" ? more : { evidence: 1 }) };
    });
    const definition = graph({ ...feedback, deadline: 100 });
    const result = await runGraph(definition, { tasks: [initial] }, { now: () => time, host: { spawnAgent }, onCheckpoint: (state, graph) => { checkpoints.push({ state, graph }); if (boundary === "initial") time = 1100; } });
    if (boundary === "restored intent") {
      const saved = checkpoints.find(row => row.state.runtime?.feedback?.research?.intent?.iteration === 2);
      if (!saved) throw new Error("missing continuation");
      time = 1100; const allocateInstanceId = vi.fn(); spawnAgent.mockClear();
      const resumed = await runGraph(saved.graph, { tasks: [initial] }, { now: () => time, restore: saved.state, allocateInstanceId, host: { spawnAgent }, onCheckpoint: () => {} });
      expect(resumed.feedback?.research).toMatchObject({ reason: "deadline/spend limit", partial: true, exhaustedBounds: ["deadline"], counters: { iterations: 1 } });
      expect(allocateInstanceId).not.toHaveBeenCalled(); expect(spawnAgent).not.toHaveBeenCalled();
    } else {
      expect(result.feedback?.research).toMatchObject({ reason: "deadline/spend limit", partial: true, exhaustedBounds: ["deadline"], counters: { iterations: boundary === "initial" ? 0 : 1 } });
      expect(checkpoints.at(-1)?.state.runtime?.manifest).toHaveLength(boundary === "initial" ? 1 : 4);
      expect(spawnAgent).toHaveBeenCalledTimes(boundary === "initial" ? 0 : 2);
      expect(checkpoints.some(row => row.state.runtime?.feedback?.research?.intent?.iteration === 2)).toBe(false);
    }
  });
  it.each([false, true])("stops on actual spend or missing accounting (missing=%s)", async missing => {
    let saved: SchedulerState | undefined;
    const spawnAgent = vi.fn(async (request: { agentType: string }) => ({ ok: true, ...(missing ? {} : { costUsd: request.agentType === "judge" ? 0.3 : 0.2 }), output: JSON.stringify(request.agentType === "judge" ? more : { evidence: 1 }) }));
    const result = await runGraph(graph({ ...feedback, spendLimit: 0.5 }), { tasks: [initial] }, { now: () => 1000, host: { spawnAgent }, onCheckpoint: state => { saved = state; } });
    expect(result.feedback?.research).toMatchObject({ reason: "deadline/spend limit", partial: true, exhaustedBounds: [missing ? "spend accounting unavailable" : "spendLimit"], counters: { iterations: 1 } });
    expect(saved?.runtime?.manifest).toHaveLength(4); expect(spawnAgent).toHaveBeenCalledTimes(2);
  });
  it("persists start and cumulative costs through evaluator repair and restore; fresh replay starts anew", async () => {
    let time = 1000; let judge = 0; let saved: { state: SchedulerState; graph: AgentGraph } | undefined;
    const definition = graph({ ...feedback, deadline: 1000, spendLimit: 2 });
    const result = await runGraph(definition, { tasks: [initial] }, { now: () => time, onCheckpoint: (state, graph) => { saved = { state, graph }; }, host: { spawnAgent: async request => ({ ok: true, costUsd: 0.2, output: JSON.stringify(request.agentType === "judge" ? (++judge === 1 ? {} : enough) : { evidence: 1 }) }) } });
    expect(result.feedback?.research.reason).toBe("sufficient");
    if (!saved) throw new Error("missing checkpoint");
    expect(saved.state.runtime?.startedAt).toBe(1000);
    expect(Object.entries(saved.state.nodes).find(([key]) => key.endsWith(":evaluator"))?.[1].costUsd).toBeCloseTo(0.4);
    const spawnAgent = vi.fn(); time = 1500;
    await runGraph(saved.graph, { tasks: [initial] }, { now: () => time, restore: saved.state, host: { spawnAgent }, onCheckpoint: state => { expect(state.runtime?.startedAt).toBe(1000); expect(state.nodes).toMatchObject(saved?.state.nodes ?? {}); } });
    expect(spawnAgent).not.toHaveBeenCalled();
    await runGraph(definition, { tasks: [initial] }, { now: () => time, host: { spawnAgent: async request => ({ ok: true, costUsd: 0, output: JSON.stringify(request.agentType === "judge" ? enough : { evidence: 1 }) }) }, onCheckpoint: state => expect(state.runtime?.startedAt).toBe(1500) });
  });
});

it("retains evaluator repair spend on the same UUID after interruption", async () => {
  let repair: { state: SchedulerState; graph: AgentGraph } | undefined; let judge = 0;
  const definition = graph({ ...feedback, evaluator: { ...feedback.evaluator, retry: { maxAttempts: 3 } }, spendLimit: 0.6 });
  await runGraph(definition, { tasks: [initial] }, { now: () => 1000, onCheckpoint: (state, graph) => { if (!repair && state.runtime?.feedback?.research?.retryFailures === 1 && state.nodes["research:iteration:1:evaluator"].attempt === 1) repair = { state, graph }; }, host: { spawnAgent: async request => ({ ok: true, costUsd: 0.2, output: JSON.stringify(request.agentType === "judge" ? (++judge === 1 ? {} : enough) : { evidence: 1 }) }) } });
  if (!repair) throw new Error("missing repair checkpoint");
  const saved = repair; const evaluator = saved.state.runtime?.manifest.find(row => row.binding.endsWith(":evaluator"));
  const spawnAgent = vi.fn(async () => ({ ok: true, costUsd: 0.2, output: JSON.stringify(enough) }));
  const result = await runGraph(saved.graph, { tasks: [initial] }, { restore: saved.state, reclaimedDeadWriter: true, now: () => 2000, host: { spawnAgent, reconcileDrain: async () => true }, onCheckpoint: () => {} });
  expect(spawnAgent).toHaveBeenCalledWith(expect.objectContaining({ nodeId: evaluator?.instanceId, attempt: 3 }), expect.any(AbortSignal));
  expect(result.feedback?.research).toMatchObject({ reason: "deadline/spend limit", exhaustedBounds: ["spend accounting unavailable", "spendLimit"], counters: { iterations: 1 } });
});

it("fails spend accounting closed when a later evaluator execution throws without a cost", async () => {
  let judge = 0;
  const result = await runGraph(graph({ ...feedback, spendLimit: 10 }), { tasks: [initial] }, { onCheckpoint: () => {}, host: { spawnAgent: async request => {
    if (request.agentType === "judge" && ++judge === 2) throw new Error("lost accounting");
    return { ok: true, costUsd: 0.2, output: JSON.stringify(request.agentType === "judge" ? {} : { evidence: 1 }) };
  } } });
  expect(result.feedback?.research).toMatchObject({ reason: "deadline/spend limit", exhaustedBounds: ["spend accounting unavailable"] });
});

it("rejects a deadline snapshot missing its start before any feedback has begun", async () => {
  let saved: SchedulerState | undefined; const definition = graph({ ...feedback, deadline: 100 });
  await runGraph(definition, { tasks: [initial] }, { now: () => 1000, onCheckpoint: state => { saved ??= state; }, host: { spawnAgent: async request => ({ ok: true, output: JSON.stringify(request.agentType === "judge" ? enough : { evidence: 1 }) }) } });
  if (!saved?.runtime) throw new Error("missing checkpoint");
  Reflect.deleteProperty(saved.runtime, "startedAt");
  const onCheckpoint = vi.fn(); const spawnAgent = vi.fn(); const allocateInstanceId = vi.fn();
  await expect(runGraph(definition, { tasks: [initial] }, { restore: saved, onCheckpoint, allocateInstanceId, host: { spawnAgent } })).rejects.toThrow(/persisted run start/);
  expect(onCheckpoint).not.toHaveBeenCalled(); expect(spawnAgent).not.toHaveBeenCalled(); expect(allocateInstanceId).not.toHaveBeenCalled();
});

it.each([false, true])("rejects a sufficient terminal that conceals an exhausted spend bound (missing check=%s)", async missingCheck => {
  let saved: { state: SchedulerState; graph: AgentGraph } | undefined;
  await runGraph(graph({ ...feedback, spendLimit: 0.4 }), { tasks: [initial] }, { onCheckpoint: (state, graph) => { saved = { state, graph }; }, host: { spawnAgent: async request => ({ ok: true, costUsd: 0.2, output: JSON.stringify(request.agentType === "judge" ? enough : { evidence: 1 }) }) } });
  if (!saved?.state.runtime?.feedback?.research.terminal) throw new Error("missing terminal");
  const terminal = { ...saved.state.runtime.feedback.research.terminal, reason: "sufficient" as const, partial: false, exhaustedBounds: [] };
  saved.state.runtime.feedback.research.terminal = terminal; saved.state.nodes.research.output = terminal;
  if (missingCheck) delete saved.state.runtime.feedback.research.budgetCheckedAt;
  const onCheckpoint = vi.fn(); const spawnAgent = vi.fn();
  await expect(runGraph(saved.graph, { tasks: [initial] }, { restore: saved.state, onCheckpoint, host: { spawnAgent } })).rejects.toThrow(/terminal/);
  expect(onCheckpoint).not.toHaveBeenCalled(); expect(spawnAgent).not.toHaveBeenCalled();
});

function durableFeedbackCheckpoints() {
  const checkpoints: GraphRunSnapshot[] = [];
  const onCheckpoint = (state: SchedulerState, graph: AgentGraph) => {
    const input = { tasks: [initial] };
    validateGraphRestore(state, graph, input);
    // Replacement validation compares serialized snapshots, as the durable writer does.
    const snapshot: GraphRunSnapshot = JSON.parse(JSON.stringify({ version: 2, runId: state.runtime?.runId ?? "", state, graph, input, waitingGate: "", savedAt: 0 } satisfies GraphRunSnapshot));
    const previous = checkpoints.at(-1);
    if (previous) validateCheckpointTransition(previous, snapshot);
    checkpoints.push(snapshot);
  };
  return { checkpoints, onCheckpoint };
}

describe("feedback skip and cancellation durability", () => {
  it.each(["conditional", "operator", "stuck cycle"])("restores a never-admitted %s skip without dispatch", async mode => {
    const definition = graph();
    definition.nodes.other = feedback;
    if (mode === "conditional") {
      definition.nodes.source = { type: "agent", agent: "source", prompt: "source" };
      definition.edges = ["research", "other"].map(to => ({ from: "source", to, when: { eq: [{ path: "$.enabled" }, true] } }));
    } else if (mode === "stuck cycle") {
      definition.edges = [{ from: "research", to: "other" }, { from: "other", to: "research" }];
    }
    const { checkpoints, onCheckpoint } = durableFeedbackCheckpoints();
    const spawnAgent = vi.fn(async () => ({ ok: true, output: "source" }));
    const result = await runGraph(definition, { tasks: [initial] }, { host: { spawnAgent }, onCheckpoint,
      onControl: control => { if (mode === "operator") { expect(control.skip(0)).toBe(true); expect(control.skip(1)).toBe(true); } },
    });
    for (const id of ["research", "other"]) {
      expect(result.nodes[id]).toMatchObject({ status: "skipped", attempt: 0 });
      expect(result.feedback?.[id]).toMatchObject({ reason: "skipped before admission", counters: { iterations: 0, totalItems: 0 } });
    }
    expect(spawnAgent).toHaveBeenCalledTimes(mode === "conditional" ? 1 : 0);
    const saved = checkpoints.at(-1);
    if (!saved) throw new Error("missing terminal skip");
    for (const mutation of ["attempt", "output", "intent"]) {
      const forged = structuredClone(saved.state);
      const terminal = forged.runtime?.feedback?.research;
      if (!terminal) throw new Error("missing skipped state");
      if (mutation === "attempt") forged.nodes.research.attempt = 1;
      if (mutation === "output") forged.nodes.research.output = terminal.terminal;
      if (mutation === "intent") terminal.stoppedIntent = { iteration: 1, tasks: [initial] };
      expect(() => validateGraphRestore(forged, saved.graph, saved.input)).toThrow();
    }
    spawnAgent.mockClear();
    const restored = await runGraph(saved.graph, { tasks: [initial] }, { restore: saved.state, host: { spawnAgent }, onCheckpoint });
    expect(restored.nodes).toEqual(result.nodes);
    expect(restored.feedback).toEqual(result.feedback);
    expect(spawnAgent).not.toHaveBeenCalled();
  });

  it.each(["before admission", "active"])("durably cancels %s without redispatch on restore", async mode => {
    const definition = graph();
    definition.nodes.other = feedback;
    const controller = new AbortController();
    const { checkpoints, onCheckpoint } = durableFeedbackCheckpoints();
    if (mode === "before admission") controller.abort();
    const spawnAgent = vi.fn(async () => { controller.abort(); return { ok: true, output: "{}" }; });
    const result = await runGraph(definition, { tasks: [initial] }, { signal: controller.signal, host: { spawnAgent }, onCheckpoint });
    expect(result.status).toBe("aborted");
    for (const id of ["research", "other"]) {
      expect(result.feedback?.[id]?.reason).toBe("cancellation");
      expect(result.nodes[id].status).toBe(mode === "before admission" ? "skipped" : "completed");
      expect(result.nodes[id].attempt).toBe(mode === "before admission" ? 0 : 1);
    }
    const saved = checkpoints.at(-1);
    if (!saved) throw new Error("missing terminal cancellation");
    const forged = structuredClone(saved.state);
    if (!forged.runtime) throw new Error("missing runtime");
    delete forged.runtime.cancelled;
    expect(() => validateGraphRestore(forged, saved.graph, saved.input)).toThrow("Forged cancellation");
    spawnAgent.mockClear();
    const restored = await runGraph(saved.graph, { tasks: [initial] }, { restore: saved.state, host: { spawnAgent }, onCheckpoint });
    expect(restored.status).toBe("aborted");
    expect(restored.feedback).toEqual(result.feedback);
    expect(restored.nodes).toEqual(result.nodes);
    expect(spawnAgent).not.toHaveBeenCalled();
  });
});

it("counts only evaluator failures after an operator retry, not cancelled admissions", async () => {
  const { checkpoints, onCheckpoint } = durableFeedbackCheckpoints();
  let control: GraphControl | undefined; let judges = 0;
  const started = deferred<void>(); const interrupted = deferred<{ ok: boolean; output: string }>();
  const pending = runGraph(graph(), { tasks: [initial] }, { onCheckpoint, onControl: value => { control = value; }, host: { spawnAgent: async request => {
    if (request.agentType !== "judge") return { ok: true, output: '{"evidence":1}' };
    if (++judges === 1) { started.resolve(); return interrupted.promise; }
    return { ok: true, output: JSON.stringify(judges === 2 ? {} : enough) };
  } } });
  try {
    await started.promise; expect(control?.retry(2)).toBe(true);
  } finally { interrupted.resolve({ ok: true, output: JSON.stringify(enough) }); }
  const result = await pending;
  expect(judges).toBe(3); expect(result.feedback?.research.reason).toBe("sufficient");
  expect(result.nodes["research:iteration:1:evaluator"].attempt).toBe(2);
  const states = checkpoints.flatMap(row => row.state.runtime?.feedback?.research ?? []);
  expect(Math.max(...states.map(state => state.retryFailures ?? 0))).toBe(1);
  expect(states.at(-1)).toMatchObject({ retryFailures: 1, retryError: expect.any(String) });
});

it("rejects forged evaluator failure counts and error rewrites at durable replacement/restore", async () => {
  const { checkpoints } = await execute([{}, "invalid", enough], { ...feedback, evaluator: { ...feedback.evaluator, retry: { maxAttempts: 3 } } });
  const snapshots: GraphRunSnapshot[] = checkpoints.map(row => JSON.parse(JSON.stringify({ ...row, version: 2, runId: row.state.runtime?.runId, input: { tasks: [initial] }, waitingGate: "", savedAt: 0 })));
  for (const [index, saved] of snapshots.entries()) {
    validateGraphRestore(saved.state, saved.graph, saved.input);
    if (index) validateCheckpointTransition(snapshots[index - 1], saved);
  }
  const first = snapshots.find(row => row.state.runtime?.feedback?.research?.retryFailures === 1);
  if (!first) throw new Error("missing evaluator failure fixture");
  for (const mutation of ["single increment", "jump", "decrease", "count removal", "error replacement", "error removal", "both removal"]) {
    const forged = structuredClone(first); const state = forged.state.runtime?.feedback?.research;
    if (!state) throw new Error("missing feedback state");
    if (mutation === "single increment") state.retryFailures = 2;
    if (mutation === "jump") state.retryFailures = 3;
    if (mutation === "decrease") state.retryFailures = 0;
    if (mutation === "count removal" || mutation === "both removal") delete state.retryFailures;
    if (mutation === "error replacement") state.retryError = "forged replacement";
    if (mutation === "error removal" || mutation === "both removal") delete state.retryError;
    expect(() => validateCheckpointTransition(first, forged)).toThrow(/evaluator/);
    // Outcome rows do not retain the original error string.
    if (mutation !== "error replacement") expect(() => validateGraphRestore(forged.state, forged.graph, forged.input)).toThrow(/retry|repair/);
  }
  const omitted = structuredClone(first);
  if (!omitted.state.runtime?.feedback) throw new Error("missing feedback");
  delete omitted.state.runtime.feedback.research.retryFailures; delete omitted.state.runtime.feedback.research.retryError;
  expect(() => validateCheckpointTransition(snapshots[snapshots.indexOf(first) - 1], omitted)).toThrow(/execution outcomes/);
  const legacy = structuredClone(first);
  if (!legacy.state.runtime) throw new Error("missing runtime");
  Reflect.deleteProperty(legacy.state.runtime, "executionProtocolVersion");
  Reflect.deleteProperty(legacy.state.runtime, "executionLedger");
  for (const run of Object.values(legacy.state.nodes)) { delete run.currentExecutionAttemptId; delete run.activation; delete run.graphAttempt; }
  expect(() => validateGraphRestore(legacy.state, legacy.graph, legacy.input)).not.toThrow();
});

it("initializes failure evidence at zero and resets it only for successor materialization", async () => {
  const { checkpoints } = await execute([{}, more, enough]);
  const snapshots: GraphRunSnapshot[] = checkpoints.map(row => JSON.parse(JSON.stringify({ ...row, version: 2, runId: row.state.runtime?.runId, input: { tasks: [initial] }, waitingGate: "", savedAt: 0 })));
  let resets = 0; let initializations = 0;
  for (let index = 1; index < snapshots.length; index++) {
    const previous = snapshots[index - 1]; const next = snapshots[index];
    validateCheckpointTransition(previous, next); validateGraphRestore(next.state, next.graph, next.input);
    const before = previous.state.runtime?.feedback?.research; const after = next.state.runtime?.feedback?.research;
    if (!after) continue;
    if (after.intent?.iteration === 2) expect(after.retryFailures).toBe(1);
    if (!before || after.active && after.active.evaluator !== before.active?.evaluator) {
      initializations++; if (after.active?.iteration === 2) resets++;
      const forged = structuredClone(next); const state = forged.state.runtime?.feedback?.research;
      if (!state) throw new Error("missing feedback state");
      state.retryFailures = 1; state.retryError = "premature failure";
      expect(() => validateCheckpointTransition(previous, forged)).toThrow(/initializes evaluator/);
      expect(() => validateGraphRestore(forged.state, forged.graph, forged.input)).toThrow(/repair count/);
    } else if (before.retryFailures === 1 && after.retryFailures === 1 && !after.active) {
      const forged = structuredClone(next); const state = forged.state.runtime?.feedback?.research;
      if (!state) throw new Error("missing feedback state");
      state.retryFailures = 0; delete state.retryError;
      expect(() => validateCheckpointTransition(previous, forged)).toThrow(/evaluator failure evidence/);
    }
  }
  expect(initializations).toBe(3); expect(resets).toBe(1);
  const materialized = snapshots.find(row => row.state.runtime?.feedback?.research?.active?.iteration === 1);
  if (!materialized?.state.runtime?.feedback?.research) throw new Error("missing initial manifest");
  delete materialized.state.runtime.feedback.research.retryFailures;
  expect(() => validateGraphRestore(materialized.state, materialized.graph, materialized.input)).not.toThrow();
});

it.each([0, 1])("reconciles post-baseline failures while retaining %i historical legacy failures", async historical => {
  const { checkpoints: original } = await execute([{}, enough], { ...feedback, evaluator: { ...feedback.evaluator, retry: { maxAttempts: 3 } } });
  const saved = structuredClone(original.find(row => row.state.runtime?.feedback?.research?.retryFailures === 1));
  if (!saved?.state.runtime?.feedback) throw new Error("missing repair checkpoint");
  Reflect.deleteProperty(saved.state.runtime, "executionProtocolVersion"); Reflect.deleteProperty(saved.state.runtime, "executionLedger");
  for (const run of Object.values(saved.state.nodes)) { delete run.currentExecutionAttemptId; delete run.activation; delete run.graphAttempt; }
  saved.state.runtime.feedback.research.retryFailures = historical;
  if (!historical) delete saved.state.runtime.feedback.research.retryError;
  const { checkpoints, onCheckpoint } = durableFeedbackCheckpoints();
  onCheckpoint(saved.state, saved.graph);
  let judges = 0;
  const result = await runGraph(saved.graph, { tasks: [initial] }, { restore: saved.state, onCheckpoint, host: { spawnAgent: async () => ({ ok: true, output: JSON.stringify(++judges === 1 ? {} : enough) }) } });
  expect(result.feedback?.research.reason).toBe("sufficient"); expect(judges).toBe(2);
  const repaired = checkpoints.find(row => row.state.runtime?.feedback?.research?.retryFailures === historical + 1);
  if (!repaired?.state.runtime?.feedback) throw new Error("missing post-baseline repair");
  expect(repaired.state.runtime.executionLedger?.some(row => "kind" in row && row.kind === "legacy-baseline")).toBe(true);
  const forged = structuredClone(repaired);
  if (!forged.state.runtime?.feedback) throw new Error("missing feedback");
  delete forged.state.runtime.feedback.research.retryFailures; delete forged.state.runtime.feedback.research.retryError;
  expect(() => validateGraphRestore(forged.state, forged.graph, forged.input)).toThrow(/execution outcomes/);
  for (const field of ["executionProtocolVersion", "executionLedger"]) {
    const partial = structuredClone(repaired); Reflect.deleteProperty(partial.state.runtime ?? {}, field);
    expect(() => validateGraphRestore(partial.state, partial.graph, partial.input)).toThrow(TypeError);
  }
  const unknown = structuredClone(repaired); Reflect.set(unknown.state.runtime ?? {}, "executionProtocolVersion", 2);
  expect(() => validateGraphRestore(unknown.state, unknown.graph, unknown.input)).toThrow(TypeError);
});
