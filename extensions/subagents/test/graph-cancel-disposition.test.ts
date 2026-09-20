import { expect, it, vi } from "vitest";
import { appendExecution, type ExecutionCorrelation, type ExecutionLedgerEntry } from "../src/graph/graph-execution.js";
import { validateGraphRestore } from "../src/graph/graph-restore-validation.js";
import type { AgentGraph } from "../src/graph/ir.js";
import { type GraphControl, runGraph } from "../src/graph/run-graph.js";
import type { SchedulerState } from "../src/graph/scheduler.js";

const agent = { type: "agent" as const, agent: "worker", prompt: "x", retry: { maxAttempts: 2 } };
function requireValue<T>(value: T | undefined, message = "missing test value"): T {
  if (value === undefined) throw new Error(message);
  return value;
}
const ledger = (state: SchedulerState) => requireValue(requireValue(state.runtime, "missing runtime").executionLedger, "missing execution ledger");
const drained = (state: SchedulerState) => ledger(state).some(row => "payload" in row && row.payload.kind === "drain-ack");

it.each(["skip", "retry"] as const)("restores durable %s before and after recovery drain", async reason => {
  const graph: AgentGraph = { version: 2, nodes: { a: agent }, edges: [] };
  let control: GraphControl | undefined; let release: (() => void) | undefined;
  const frames: SchedulerState[] = []; let starts = 0;
  const running = runGraph(graph, {}, { onControl: value => { control = value; }, onCheckpoint: state => frames.push(state), host: { spawnAgent: async () => {
    if (++starts === 1) await new Promise<void>(resolve => { release = resolve; }); return { ok: true, output: "ok" };
  } } });
  await vi.waitFor(() => expect(release).toBeDefined());
  const graphControl = requireValue(control, "missing graph control");
  expect(graphControl[reason](0)).toBe(true);
  expect(graphControl[reason === "skip" ? "retry" : "skip"](0)).toBe(false);
  requireValue(release, "missing release")(); await running;
  const before = requireValue(frames.find(state => !drained(state) && ledger(state).some(row => "payload" in row && row.payload.kind === "cancel-requested")), "missing cancellation checkpoint");
  let recovered: SchedulerState | undefined;
  for (const saved of [before, undefined]) {
    const state = saved ?? requireValue(recovered, "missing recovered checkpoint");
    const calls: ExecutionCorrelation[] = []; let latest: SchedulerState | undefined;
    const result = await runGraph(graph, {}, { restore: state, reclaimedDeadWriter: true, onCheckpoint: checkpoint => {
      validateGraphRestore(checkpoint, graph); recovered ??= checkpoint; latest = checkpoint;
    }, host: { reconcileDrain: async () => true, spawnAgent: async request => { calls.push(requireValue(request.correlation, "missing execution correlation")); return { ok: true, output: "ok" }; } } });
    expect(calls).toHaveLength(reason === "skip" ? 0 : 1);
    expect(result.nodes.a.status).toBe(reason === "skip" ? "skipped" : "completed");
    if (reason === "retry") {
      expect(calls[0]).toMatchObject({ activation: 1, graphAttempt: 2 });
      expect(calls[0].executionAttemptId).not.toBe(before.nodes.a.currentExecutionAttemptId);
      expect(result.nodes.a.attempt).toBe(2);
    }
    const spawnAgent = vi.fn();
    await runGraph(graph, {}, { restore: latest, onCheckpoint: () => {}, host: { spawnAgent } });
    expect(spawnAgent).not.toHaveBeenCalled();
  }
});

it.each((["reload", "switch", "shutdown"] as const).flatMap(reason => (["agent", "human_gate"] as const).map(type => ({ reason, type }))))("$reason restarts one-attempt $type in a new graph attempt", async ({ reason, type }) => {
  const graph: AgentGraph = { version: 2, nodes: { a: type === "agent" ? { ...agent, retry: { maxAttempts: 1 } } : { type, prompt: "x", outputSchema: { type: "object" } } }, edges: [] };
  const controller = new AbortController(); let release: (() => void) | undefined; const frames: SchedulerState[] = [];
  const effect = async () => { await new Promise<void>(resolve => { release = resolve; }); return { ok: true, output: "{}" }; };
  const running = runGraph(graph, {}, { signal: controller.signal, onCheckpoint: state => frames.push(state), host: { spawnAgent: effect, awaitHumanGate: effect } });
  await vi.waitFor(() => expect(release).toBeDefined()); controller.abort(reason); requireValue(release, "missing release")(); await running;
  const before = requireValue(frames.find(state => !drained(state) && ledger(state).some(row => "payload" in row && row.payload.kind === "cancel-requested")), "missing cancellation checkpoint");
  for (const saved of [before, requireValue(frames.at(-1), "missing terminal checkpoint")]) {
    let latest: SchedulerState | undefined; let admission: SchedulerState | undefined; const identities: ExecutionCorrelation[] = [];
    const replacement = async (request: { correlation?: ExecutionCorrelation }) => { identities.push(requireValue(request.correlation, "missing execution correlation")); return { ok: true, output: "{}" }; };
    const result = await runGraph(graph, {}, { restore: saved, reclaimedDeadWriter: true, onCheckpoint: state => { validateGraphRestore(state, graph); latest = state; if (state.nodes.a.status === "running" && state.nodes.a.graphAttempt === 2) admission ??= state; }, host: { reconcileDrain: async () => true, spawnAgent: replacement, awaitHumanGate: replacement } });
    expect(result.nodes.a).toMatchObject({ status: "completed", activation: 1, graphAttempt: 2, attempt: 2, attemptReason: "restore" });
    expect(identities).toHaveLength(1); expect(identities[0].executionAttemptId).not.toBe(saved.nodes.a.currentExecutionAttemptId);
    const effect = vi.fn(); await runGraph(graph, {}, { restore: latest, onCheckpoint: () => {}, host: { spawnAgent: effect, awaitHumanGate: effect } });
    expect(effect).not.toHaveBeenCalled();
    // Crashing the replacement is not another lifecycle request: its restart label cannot replenish scope 2.
    let recovery: SchedulerState | undefined;
    for (const interrupted of [requireValue(admission, "missing replacement admission"), undefined]) {
      const resumed = await runGraph(graph, {}, { restore: interrupted ?? requireValue(recovery, "missing recovery checkpoint"), reclaimedDeadWriter: true, onCheckpoint: state => { recovery ??= state; }, host: { reconcileDrain: async () => true, spawnAgent: effect, awaitHumanGate: effect } });
      expect(resumed.nodes.a).toMatchObject({ status: "failed", activation: 1, graphAttempt: 2, attempt: 2 });
      expect(effect).not.toHaveBeenCalled();
    }
  }
});

it("keeps nested skip scoped to its admitted execution", async () => {
  const child: AgentGraph = { version: 2, nodes: { a: agent }, edges: [] };
  const graph: AgentGraph = { version: 2, nodes: { left: { type: "graph", graph: "child" }, right: { type: "graph", graph: "child" } }, edges: [] };
  let saved: SchedulerState | undefined; const release: (() => void)[] = []; const controller = new AbortController();
  const running = runGraph(graph, {}, { loadGraph: () => child, signal: controller.signal, onCheckpoint: state => { saved = state; }, host: { spawnAgent: async () => { await new Promise<void>(resolve => release.push(resolve)); return { ok: true, output: "ok" }; } } });
  await vi.waitFor(() => expect(release).toHaveLength(2)); const state = structuredClone(requireValue(saved, "missing nested checkpoint"));
  controller.abort("reload"); for (const resolve of release) resolve(); await running;
  const savedRuntime = requireValue(requireValue(saved, "missing nested checkpoint").runtime, "missing saved runtime");
  const savedNested = requireValue(savedRuntime.nested, "missing saved nested runs");
  for (const nested of Object.values(savedNested)) expect(requireValue(nested.state.runtime, "missing nested runtime").executionLedger).toContainEqual(expect.objectContaining({ payload: { kind: "cancel-requested", reason: "lifecycle" } }));
  const stateRuntime = requireValue(state.runtime, "missing nested state runtime");
  const nested = requireValue(stateRuntime.nested, "missing nested runs");
  const left = requireValue(nested.left, "missing left nested run").state;
  const runtime = requireValue(left.runtime, "missing left runtime");
  const executionLedger = requireValue(runtime.executionLedger, "missing execution ledger");
  const admitted = requireValue(executionLedger.find(row => "payload" in row && row.payload.kind === "admitted"), "missing admission");
  if (!("payload" in admitted)) throw new Error("Missing admission");
  let ledger: readonly ExecutionLedgerEntry[] = appendExecution(executionLedger, { ...admitted, payload: { kind: "cancel-requested", reason: "skip" } });
  ledger = appendExecution(ledger, { ...admitted, payload: { kind: "drain-ack", source: "recovery" } }, { reclaimedDeadWriter: true, reconciled: true });
  Object.assign(runtime, { executionLedger: ledger });
  const identities: ExecutionCorrelation[] = [];
  await runGraph(graph, {}, { restore: state, reclaimedDeadWriter: true, onCheckpoint: checkpoint => validateGraphRestore(checkpoint, graph), host: { reconcileDrain: async () => true, spawnAgent: async request => { identities.push(requireValue(request.correlation, "missing execution correlation")); return { ok: true, output: "ok" }; } } });
  const rightRuntime = requireValue(requireValue(nested.right, "missing right nested run").state.runtime, "missing right runtime");
  expect(identities).toHaveLength(1); expect(identities[0].runId).toBe(rightRuntime.runId);
});

it("whole-run cancel stays terminal across pre-drain recovery", async () => {
  const graph: AgentGraph = { version: 2, nodes: { a: agent }, edges: [] };
  let release: (() => void) | undefined; let saved: SchedulerState | undefined; const controller = new AbortController();
  const running = runGraph(graph, {}, { signal: controller.signal, onCheckpoint: state => {
    if (!saved && state.runtime?.executionLedger?.some(row => "payload" in row && row.payload.kind === "cancel-requested")) saved = state;
  }, host: { spawnAgent: async () => { await new Promise<void>(resolve => { release = resolve; }); return { ok: true }; } } });
  await vi.waitFor(() => expect(release).toBeDefined()); controller.abort(); requireValue(release, "missing release")(); await running;
  expect(requireValue(requireValue(saved, "missing cancellation checkpoint").runtime, "missing runtime").cancelled).toBe(true);
  const spawnAgent = vi.fn(); const result = await runGraph(graph, {}, { restore: saved, reclaimedDeadWriter: true, onCheckpoint: () => {}, host: { reconcileDrain: async () => true, spawnAgent } });
  expect(result.status).toBe("aborted"); expect(spawnAgent).not.toHaveBeenCalled();
});
