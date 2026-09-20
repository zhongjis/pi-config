import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { checkGraphDelegation } from "../src/graph/delegation-preflight.js";
import type { AgentGraph, BoundedFeedbackNode } from "../src/graph/ir.js";
import { runGraph } from "../src/graph/run-graph.js";
import type { SchedulerState } from "../src/graph/scheduler.js";
import { validateGraph } from "../src/graph/validate.js";

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
        restore: saved.state, onCheckpoint: state => {
          for (const row of saved.state.runtime?.manifest ?? []) expect(state.runtime?.manifest).toContainEqual(row);
        },
        host: { spawnAgent: async request => {
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
    const result = await runGraph(graph(), { tasks: [initial] }, { signal: controller.signal, onCheckpoint: () => {}, host: { spawnAgent: async () => { controller.abort(); return new Promise(() => {}); } } });
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
  let count = 0;
  const result = await runGraph(many, { tasks: [initial] }, { onCheckpoint: state => { count = state.runtime?.manifest.length ?? 0; }, host: { spawnAgent: async () => ({ ok: true, output: "ok" }) } });
  expect(result.nodes.research.output).toMatchObject({ reason: "materialization failure", exhaustedBounds: ["node limit"] });
  expect(count).toBe(498);
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
  state.nodes.research.attempt = 997;
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
  await runGraph(graph(), { tasks: [initial] }, { signal: controller.signal, onCheckpoint: (state, effective) => { saved = { state, graph: effective }; }, host: { spawnAgent: async () => { controller.abort("reload"); return new Promise(() => {}); } } });
  if (!saved) throw new Error("missing lifecycle checkpoint");
  expect(saved.state.runtime?.cancelled).not.toBe(true);
  const result = await runGraph(saved.graph, { tasks: [initial] }, { restore: saved.state, allocateInstanceId: () => { throw new Error("replacement identity"); }, onCheckpoint: () => {}, host: { spawnAgent: async request => ({ ok: true, output: JSON.stringify(request.agentType === "judge" ? enough : { evidence: 1 }) }) } });
  expect(result.outputs.evidence).toMatchObject({ reason: "sufficient", partial: false });
});

it("preserves the evaluator repair budget across a restart", async () => {
  const { checkpoints } = await execute([{}, enough]);
  const saved = checkpoints.find(row => Object.entries(row.state.nodes).some(([key, node]) => key.endsWith(":evaluator") && node.status === "running" && node.attempt === 2));
  if (!saved) throw new Error("missing repair checkpoint");
  const spawnAgent = vi.fn(async () => ({ ok: true, output: "{}" }));
  const result = await runGraph(saved.graph, { tasks: [initial] }, { restore: saved.state, onCheckpoint: () => {}, host: { spawnAgent } });
  expect(result.outputs.evidence).toMatchObject({ reason: "evaluator failure", partial: true });
  expect(spawnAgent).toHaveBeenCalledTimes(1);
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
  const { checkpoints } = await execute([{}, enough]);
  const saved = checkpoints.find(row => Object.entries(row.state.nodes).some(([key, node]) => key.endsWith(":evaluator") && node.status === "running" && node.attempt === 2));
  if (!saved) throw new Error("missing repair checkpoint");
  const requests: number[] = [];
  await runGraph(saved.graph, { tasks: [initial] }, { restore: saved.state, onCheckpoint: () => {}, host: { spawnAgent: async request => { requests.push(request.attempt); return { ok: true, output: JSON.stringify(enough) }; } } });
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
  const definition = graph({ ...feedback, spendLimit: 0.6 });
  await runGraph(definition, { tasks: [initial] }, { now: () => 1000, onCheckpoint: (state, graph) => { if (state.runtime?.feedback?.research?.retryFailures === 1 && state.nodes["research:iteration:1:evaluator"].attempt === 1) repair = { state, graph }; }, host: { spawnAgent: async request => ({ ok: true, costUsd: 0.2, output: JSON.stringify(request.agentType === "judge" ? (++judge === 1 ? {} : enough) : { evidence: 1 }) }) } });
  if (!repair) throw new Error("missing repair checkpoint");
  const saved = repair; const evaluator = saved.state.runtime?.manifest.find(row => row.binding.endsWith(":evaluator"));
  const spawnAgent = vi.fn(async () => ({ ok: true, costUsd: 0.2, output: JSON.stringify(enough) }));
  const result = await runGraph(saved.graph, { tasks: [initial] }, { restore: saved.state, now: () => 2000, host: { spawnAgent }, onCheckpoint: () => {} });
  expect(spawnAgent).toHaveBeenCalledWith(expect.objectContaining({ nodeId: evaluator?.instanceId, attempt: 2 }), expect.any(AbortSignal));
  expect(result.feedback?.research).toMatchObject({ reason: "deadline/spend limit", exhaustedBounds: ["spendLimit"], counters: { iterations: 1 } });
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
