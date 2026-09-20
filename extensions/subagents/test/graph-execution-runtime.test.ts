import { expect, it, vi } from "vitest";
import { appendExecution, type ExecutionEvent, executionAttemptId } from "../src/graph/graph-execution.js";
import { GraphExecutions } from "../src/graph/graph-execution-runtime.js";
import type { GraphRuntimeState, NodeInstanceId } from "../src/graph/graph-instance-id.js";
import { validateGraphRestore } from "../src/graph/graph-restore-validation.js";
import type { AgentGraph } from "../src/graph/ir.js";
import type { NodeHost, NodeSpawnRequest } from "../src/graph/node-host.js";
import { type GraphControl, runGraph } from "../src/graph/run-graph.js";
import type { SchedulerState } from "../src/graph/scheduler.js";

const worker = { type: "agent" as const, agent: "worker", prompt: "x", outputSchema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } }, retry: { maxAttempts: 2 } };
const graph: AgentGraph = { version: 2, nodes: { a: worker }, edges: [] };
function requireValue<T>(value: T | undefined, message = "missing test value"): T {
  if (value === undefined) throw new Error(message);
  return value;
}
it("batches admission and completion without monitor checkpoints", async () => {
  const frames: SchedulerState[] = []; let calls = 0;
  const result = await runGraph({ version: 2, nodes: Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`a${i}`, worker])), edges: [] }, {}, {
    onCheckpoint: state => frames.push(state), host: { spawnAgent: async request => {
      expect(frames.at(-1)?.runtime?.executionLedger?.length).toBe(16);
      expect(request.correlation?.executionAttemptId).toMatch(/^[0-9a-f-]{36}$/); calls++;
      return { ok: true, output: '{"ok":true}', costUsd: 0.1 };
    } },
  });
  expect(result.status).toBe("completed"); expect(calls).toBe(8); expect(frames).toHaveLength(4); // initialization, admission, settlement, terminal
});
it("repairs keep graph counters, distinct execution IDs, and reject stale resolution", async () => {
  const frames: SchedulerState[] = []; const requests: NodeSpawnRequest[] = []; const resolved = vi.fn();
  const result = await runGraph(graph, {}, { onCheckpoint: state => frames.push(state), onNodeResolved: resolved, host: { spawnAgent: async request => {
    requests.push(request);
    if (requests.length === 2) requests[0].onResolved?.({ recordId: "stale" });
    request.onResolved?.({ recordId: "current" });
    return { ok: true, output: requests.length === 1 ? "{}" : '{"ok":true}', costUsd: 0.1 };
  } } });
  expect(result.nodes.a).toMatchObject({ attempt: 1, activation: 1, graphAttempt: 1, costAttempts: 2, costUsd: 0.2 });
  expect(requests[0].correlation?.executionAttemptId).not.toBe(requests[1].correlation?.executionAttemptId);
  expect(resolved.mock.calls.map(call => call[1].recordId)).toEqual(["current", "current"]);
  expect(resolved.mock.calls[0][2]).toEqual(requests[0].correlation);
  const lastFrame = requireValue(frames.at(-1), "missing final checkpoint");
  const executionLedger = requireValue(requireValue(lastFrame.runtime, "missing runtime").executionLedger, "missing execution ledger");
  expect(executionLedger.filter(row => "payload" in row).map(row => "payload" in row && row.payload.kind)).toEqual(["admitted", "dispatched", "cost", "outcome", "drain-ack", "admitted", "dispatched", "cost", "outcome", "drain-ack"]);
});
it.each(["admitted", "drain-ack"])("checkpoint failure at %s blocks effects/replacements", async boundary => {
  const spawnAgent = vi.fn(async () => ({ ok: true, output: "{}" }));
  await expect(runGraph(graph, {}, { onCheckpoint: state => {
    const last = state.runtime?.executionLedger?.at(-1);
    if (last && "payload" in last && (boundary === "admitted" ? last.payload.kind === "dispatched" : state.runtime?.executionLedger?.some(row => "payload" in row && row.payload.kind === "drain-ack"))) throw new Error("write failed");
  }, host: { spawnAgent } })).rejects.toThrow("write failed");
  expect(spawnAgent).toHaveBeenCalledTimes(boundary === "admitted" ? 0 : 1);
});
it("does not replay the admission committed atomically with a drained repair", async () => {
  let saved: SchedulerState | undefined;
  await runGraph(graph, {}, { onCheckpoint: state => {
    const last = state.runtime?.executionLedger?.at(-1);
    if (!saved && last && "payload" in last && state.runtime?.executionLedger?.some(row => "payload" in row && row.payload.kind === "drain-ack") && state.nodes.a.status === "running") saved = state;
  }, host: { spawnAgent: async () => ({ ok: true, output: "{}" }) } });
  expect(saved).toBeDefined(); const spawnAgent = vi.fn(async () => ({ ok: true, output: "{}" })); let latest: SchedulerState | undefined;
  const result = await runGraph(graph, {}, { restore: saved, reclaimedDeadWriter: true, onCheckpoint: state => { latest = state; }, host: { spawnAgent, reconcileDrain: async () => true } });
  expect(spawnAgent).toHaveBeenCalledTimes(0); expect(result.nodes.a.attempt).toBe(1);
  await runGraph(graph, {}, { restore: latest, onCheckpoint: () => {}, host: { spawnAgent, reconcileDrain: async () => true } });
  expect(spawnAgent).toHaveBeenCalledTimes(0);
});
it.each(["agent", "human-gate", "validation-gate"] as const)("recovery of %s requires proof and positive host reconciliation", async target => {
  const definition: AgentGraph = { version: 2, nodes: { a: target === "human-gate" ? { type: "human_gate", prompt: "x", outputSchema: { type: "object" } } : { ...worker, ...(target === "validation-gate" ? { validation: { gate: "true" } } : {}) } }, edges: [] };
  let saved: SchedulerState | undefined;
  await runGraph(definition, {}, { onCheckpoint: state => {
    const last = state.runtime?.executionLedger?.at(-1);
    if (!saved && last && "payload" in last && last.payload.kind === "dispatched" && last.payload.target === target) saved = state;
  }, host: { spawnAgent: async () => ({ ok: true, output: '{"ok":true}' }), runGate: async () => ({ ok: true, output: "" }), awaitHumanGate: async () => ({ ok: true, output: "{}" }) } });
  expect(saved).toBeDefined();
  const host = { spawnAgent: vi.fn(async () => ({ ok: true, output: '{"ok":true}' })), reconcileDrain: vi.fn(async () => true), awaitHumanGate: vi.fn(async () => ({ ok: true, output: "{}" })), runGate: vi.fn() };
  await expect(runGraph(definition, {}, { restore: saved, onCheckpoint: () => {}, host })).rejects.toThrow(/drain/i);
  expect(host.spawnAgent).not.toHaveBeenCalled(); expect(host.reconcileDrain).not.toHaveBeenCalled();
  host.reconcileDrain.mockResolvedValueOnce(false);
  await expect(runGraph(definition, {}, { restore: saved, reclaimedDeadWriter: true, onCheckpoint: () => {}, host })).rejects.toThrow(/drain/i);
  const recovered = runGraph(definition, {}, { restore: saved, reclaimedDeadWriter: true, onCheckpoint: () => {}, host });
  if (target === "validation-gate") await expect(recovered).rejects.toThrow(/drain/i); else await recovered;
});

it("rejects all five stale identity fields and ordinary effects after cancellation; matching drains are idempotent", () => {
  const runtime: GraphRuntimeState = { version: 2, runId: "run", revision: 0, manifest: [{ binding: "a", nodeKey: "a", ordinal: 0, instanceId: "10000000-0000-4000-8000-000000000001" as NodeInstanceId }], executionProtocolVersion: 1, executionLedger: [] };
  const executions = new GraphExecutions(runtime, new Map([["a", { status: "running", attempt: 1, activation: 1, graphAttempt: 1 }]]));
  const correlation = requireValue(executions.begin("a", worker), "missing execution correlation");
  for (const wrong of [{ runId: "other" }, { instanceId: "10000000-0000-4000-8000-000000000002" as NodeInstanceId }, { activation: 2 }, { graphAttempt: 2 }, { executionAttemptId: executionAttemptId("10000000-0000-4000-8000-000000000003") }]) {
    expect(executions.emit("a", { ...correlation, ...wrong, payload: { kind: "cancel-requested", reason: "retry" } })).toBe(false);
    expect(executions.emit("a", { ...correlation, ...wrong, payload: { kind: "cost", costUsd: 7 } })).toBe(false);
    expect(executions.emit("a", { ...correlation, ...wrong, payload: { kind: "drain-ack", source: "live" } })).toBe(false);
  }
  executions.cancel("a", "skip");
  for (const payload of [{ kind: "cost", costUsd: 7 }, { kind: "outcome", status: "success" }, { kind: "dispatched", target: "validation-gate" }] satisfies ExecutionEvent["payload"][]) expect(executions.emit("a", { ...correlation, payload })).toBe(false);
  executions.finish("a", correlation, { ok: true, costUsd: 7 }, false, true); executions.flush();
  const ledger = runtime.executionLedger;
  expect(ledger).toHaveLength(5);
  expect(executions.emit("a", { ...correlation, payload: { kind: "drain-ack", source: "live" } })).toBe(true);
  executions.flush(); expect(runtime.executionLedger).toBe(ledger);
  const next = requireValue(executions.begin("a", worker), "missing next execution");
  expect(executions.emit("a", { ...correlation, payload: { kind: "cancel-requested", reason: "retry" } })).toBe(false);
  expect(executions.recoveryProposal().restarts).toEqual([]);
  expect(executions.accepts("a", next)).toBe(true);
});
it("does not accept an unproven recovery acknowledgement", () => {
  const correlation = { runId: "run", instanceId: "10000000-0000-4000-8000-000000000001" as NodeInstanceId, activation: 1, graphAttempt: 1, executionAttemptId: executionAttemptId("10000000-0000-4000-8000-000000000002") };
  const ledger = appendExecution(appendExecution([], { ...correlation, payload: { kind: "admitted", budget: { maxExecutions: 2 }, resources: [] } }), { ...correlation, payload: { kind: "dispatched", target: "agent" } });
  const drain: ExecutionEvent = { ...correlation, payload: { kind: "drain-ack", source: "recovery" } };
  expect(() => appendExecution(ledger, drain)).toThrow();
  expect(() => appendExecution(ledger, drain, { reclaimedDeadWriter: true, reconciled: false })).toThrow();
  expect(appendExecution(ledger, drain, { reclaimedDeadWriter: true, reconciled: true })).toHaveLength(3);
});
it("checks live delegation before initial dispatch and before a repair", async () => {
  let denied = false; const spawnAgent = vi.fn(async () => ({ ok: true, output: "{}" }));
  await runGraph(graph, {}, { host: { spawnAgent }, authorizeAgent: () => denied ? "Policy changed" : undefined, onCheckpoint: state => {
    if (state.runtime?.executionLedger?.some(row => "payload" in row && row.payload.kind === "drain-ack")) denied = true;
  } });
  expect(spawnAgent).toHaveBeenCalledTimes(1);
  await runGraph(graph, {}, { host: { spawnAgent }, authorizeAgent: () => "Policy changed", onCheckpoint: () => {} });
  expect(spawnAgent).toHaveBeenCalledTimes(1);
});
it.each(["human-gate", "validation-gate"] as const)("rechecks %s capability after the dispatch checkpoint", async target => {
  const gate = vi.fn(async () => ({ ok: true, output: "{}" }));
  const host: NodeHost = { spawnAgent: async () => ({ ok: true, output: '{"ok":true}' }), awaitHumanGate: gate, runGate: gate };
  const definition: AgentGraph = { version: 2, nodes: { a: target === "human-gate" ? { type: "human_gate", prompt: "x", outputSchema: { type: "object" } } : { ...worker, retry: { maxAttempts: 1 }, validation: { gate: "true" } } }, edges: [] };
  const result = await runGraph(definition, {}, { host, onCheckpoint: state => {
    const last = state.runtime?.executionLedger?.at(-1);
    if (last && "payload" in last && last.payload.kind === "dispatched" && last.payload.target === target) { if (target === "human-gate") delete host.awaitHumanGate; else delete host.runGate; }
  } });
  expect(result.status).toBe("failed"); expect(gate).not.toHaveBeenCalled();
});
it("validates aggregate cost, graph starts, projections, and gated success before callbacks", async () => {
  let saved: SchedulerState | undefined; let admitted: SchedulerState | undefined;
  const gated: AgentGraph = { ...graph, nodes: { a: { ...worker, validation: { gate: "true" } } } };
  await runGraph(gated, {}, { host: { spawnAgent: async () => ({ ok: true, output: '{"ok":true}', costUsd: 1 }), runGate: async () => ({ ok: true, output: "" }) }, onCheckpoint: state => { saved = state; if (!admitted && state.nodes.a.status === "running") admitted = state; } });
  expect(() => validateGraphRestore(requireValue(admitted, "missing admitted checkpoint"), gated)).not.toThrow();
  for (const mutate of [
    (state: SchedulerState) => { state.nodes.a.costUsd = 2; },
    (state: SchedulerState) => { state.nodes.a.costAttempts = 2; },
    (state: SchedulerState) => { state.nodes.a.attempt = 2; },
    (state: SchedulerState) => { state.nodes.a.graphAttempt = 2; },
    (state: SchedulerState) => { state.nodes.a.status = "pending"; },
    (state: SchedulerState) => {
      const runtime = requireValue(state.runtime, "missing runtime");
      const executionLedger = requireValue(runtime.executionLedger, "missing execution ledger");
      Object.assign(runtime, { executionLedger: executionLedger.filter(row => !("payload" in row && row.payload.kind === "dispatched" && row.payload.target === "validation-gate")) });
    },
  ]) {
    const state = structuredClone(requireValue(saved, "missing saved checkpoint")); mutate(state);
    const callback = vi.fn(); const spawnAgent = vi.fn();
    await expect(runGraph(gated, {}, { restore: state, host: { spawnAgent }, onCheckpoint: callback, onNodeAdded: callback })).rejects.toThrow();
    expect(callback).not.toHaveBeenCalled(); expect(spawnAgent).not.toHaveBeenCalled();
  }
});
it("keeps non-durable correlation transient", async () => {
  let correlation: NodeSpawnRequest["correlation"]; let snapshot: SchedulerState | undefined;
  await runGraph({ version: 1, nodes: { a: { type: "human_gate", prompt: "x", outputSchema: { type: "object" } } }, edges: [] }, {}, { host: { spawnAgent: vi.fn(), awaitHumanGate: async request => { correlation = request.correlation; return { ok: true, output: "{}" }; } }, onGateWaiting: (_id, state) => { snapshot = state; } });
  expect(correlation?.executionAttemptId).toBeDefined(); expect(snapshot).toBeDefined(); expect(snapshot?.runtime).toBeUndefined();
});
it.each(["agent", "human_gate"] as const)("failed %s final drain never releases capacity to a sibling", async type => {
  const effect = vi.fn(async () => ({ ok: true, output: '{"ok":true}', costUsd: 1 }));
  const node = type === "agent" ? { ...worker, resources: ["browser"] } : { type, prompt: "x", outputSchema: { type: "object" } };
  await expect(runGraph({ version: 2, nodes: { a: node, b: node }, edges: [] }, {}, { concurrency: 1, resources: { browser: { capacity: 1 } }, host: { spawnAgent: effect, awaitHumanGate: effect }, onCheckpoint: state => {
    const last = state.runtime?.executionLedger?.at(-1); if (last && "payload" in last && last.payload.kind === "drain-ack") throw new Error("settlement failed");
  } })).rejects.toThrow("settlement failed");
  expect(effect).toHaveBeenCalledTimes(1);
});
it("fails a whole admission batch without dispatch", async () => {
  const spawnAgent = vi.fn();
  await expect(runGraph({ version: 2, nodes: { a: worker, b: worker }, edges: [] }, {}, { host: { spawnAgent }, onCheckpoint: state => {
    if (state.runtime?.executionLedger?.length) { expect(state.runtime.executionLedger).toHaveLength(4); throw new Error("batch failed"); }
  } })).rejects.toThrow("batch failed");
  expect(spawnAgent).not.toHaveBeenCalled();
});
it("reconciles nested executions before any sibling can dispatch", async () => {
  const child: AgentGraph = { ...graph, nodes: { a: { ...worker, validation: { gate: "true" } } } };
  const parent: AgentGraph = { version: 2, nodes: { nested: { type: "graph", graph: "child" }, sibling: worker }, edges: [] };
  let saved: SchedulerState | undefined;
  await runGraph(parent, {}, { loadGraph: () => child, host: { spawnAgent: async () => ({ ok: true, output: '{"ok":true}' }), runGate: async () => ({ ok: true, output: "" }) }, onCheckpoint: state => {
    if (!saved && state.runtime?.nested?.nested.state.runtime?.executionLedger?.some(row => "payload" in row && row.payload.kind === "dispatched" && row.payload.target === "validation-gate")) saved = state;
  } });
  expect(saved).toBeDefined(); const effect = vi.fn();
  await expect(runGraph(parent, {}, { restore: saved, reclaimedDeadWriter: true, host: { spawnAgent: effect, reconcileDrain: async () => true }, onCheckpoint: effect })).rejects.toThrow(/drain/i);
  expect(effect).not.toHaveBeenCalled();
});
it("wakes on a cancellation checkpoint failure and preserves it through physical drain", async () => {
  let control: GraphControl | undefined; let release: (() => void) | undefined; let stopped = false; let settled = false;
  const spawnAgent = vi.fn(async (_request: NodeSpawnRequest, signal: AbortSignal) => {
    signal.addEventListener("abort", () => { stopped = true; });
    await new Promise<void>(resolve => { release = resolve; }); return { ok: true, output: '{"ok":true}' };
  });
  const run = runGraph(graph, {}, { host: { spawnAgent }, onControl: value => { control = value; }, onCheckpoint: state => {
    if (state.runtime?.executionLedger?.some(row => "payload" in row && row.payload.kind === "cancel-requested")) throw new Error("cancel checkpoint failed");
  } }).then(() => { settled = true; }, error => { settled = true; return error; });
  await vi.waitFor(() => expect(spawnAgent).toHaveBeenCalledTimes(1));
  expect(requireValue(control, "missing graph control").skip(0)).toBe(true);
  await vi.waitFor(() => expect(stopped).toBe(true));
  expect(settled).toBe(false); requireValue(release, "missing release")();
  expect(await run).toMatchObject({ message: "cancel checkpoint failed" });
});
