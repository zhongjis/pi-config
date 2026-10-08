import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { deleteGraphSnapshot, type GraphRunSnapshot, graphRunsDir, ownGraphRun, readGraphSnapshots, writeGraphSnapshot } from "../src/graph/graph-persist.js";
import type { AgentGraph } from "../src/graph/ir.js";
import { runGraph } from "../src/graph/run-graph.js";
import type { SchedulerState } from "../src/graph/scheduler.js";

const dirs: string[] = [];
function directory() { const path = mkdtempSync(join(tmpdir(), "graph-security-")); dirs.push(path); return path; }
afterEach(() => { for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true }); });
const graph: AgentGraph = { nodes: { a: { type: "agent", agent: "worker", prompt: "x", outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] } } }, edges: [] };
const runId = "agr_abcdef123456";
const gateGraph: AgentGraph = { nodes: { a: { type: "decision_gate", state: {}, questions: { approved: { type: "bool", instructions: "fixture", criteria: { true: "yes", false: "no" } } } } }, edges: [] };
const host = { spawnAgent: async () => ({ ok: true, output: '{"ok":true}' }), decide: async () => ({ ok: true as const, answers: { approved: { value: true, confidence: 1 } }, decidedBy: "classifier" as const, model: "fixture" }) };
async function checkpoint(cwd: string, source: AgentGraph = graph): Promise<GraphRunSnapshot> {
  let saved: GraphRunSnapshot | undefined;
  await runGraph(source, {}, { runId, onCheckpoint: (state, effective) => { saved = structuredClone({ version: 2, runId, graph: effective, input: {}, waitingGate: "", savedAt: 0, state }); writeGraphSnapshot(cwd, saved); }, host });
  if (!saved?.state.runtime) throw new Error("missing fixture");
  return saved;
}

it("contains every snapshot write/delete/lease and rejects mismatched filenames", async () => {
  const cwd = directory();
  const saved = await checkpoint(cwd);
  expect(readGraphSnapshots(cwd)).toEqual([saved]);
  const outside = join(cwd, ".pi", "outside.json");
  writeFileSync(outside, "untouched");
  const bad = { ...saved, runId: "../outside" };
  writeFileSync(join(graphRunsDir(cwd), `${runId}.json`), JSON.stringify(bad));
  const invalid = vi.fn();
  expect(readGraphSnapshots(cwd, invalid)).toEqual([]);
  expect(invalid).toHaveBeenCalledWith(expect.stringMatching(/Unsupported or corrupt/));
  const unsafe = /Invalid graph run ID|escapes|Unsafe checkpoint/;
  for (const badId of ["../outside", "agr_../../outside", "agr_abc/def", "agr_abc\\def", "agr_short", "", "/tmp/outside"]) {
    const forged = structuredClone(saved); forged.runId = badId;
    if (forged.state.runtime) Object.assign(forged.state.runtime, { runId: badId, executionLedger: forged.state.runtime.executionLedger?.map(row => ({ ...row, runId: badId })) });
    // An empty run ID fails runtime identity validation before the path guard.
    expect(() => writeGraphSnapshot(cwd, forged)).toThrow(badId ? unsafe : /Invalid/);
    expect(() => deleteGraphSnapshot(cwd, badId)).toThrow(unsafe);
    expect(() => ownGraphRun(cwd, badId)).toThrow(unsafe);
  }
  invalid.mockClear();
  writeFileSync(join(graphRunsDir(cwd), `${runId}.json`), JSON.stringify({ ...saved, runId: "agr_123456abcdef" }));
  expect(readGraphSnapshots(cwd, invalid)).toEqual([]);
  expect(invalid).toHaveBeenCalledWith(expect.stringMatching(/Unsupported or corrupt/));
  expect(readFileSync(outside, "utf8")).toBe("untouched");
});

it("rejects symlinked checkpoint directories and files", async () => {
  const saved = await checkpoint(directory());
  const cwd = directory(); const outside = directory();
  mkdirSync(join(cwd, ".pi"));
  symlinkSync(outside, graphRunsDir(cwd), "dir");
  expect(() => writeGraphSnapshot(cwd, saved)).toThrow(/Unsafe checkpoint/);
  expect(() => deleteGraphSnapshot(cwd, saved.runId)).toThrow(/Unsafe checkpoint/);
  expect(() => ownGraphRun(cwd, saved.runId)).toThrow(/Unsafe checkpoint/);
  expect(readdirSync(outside)).toEqual([]);
  rmSync(graphRunsDir(cwd)); mkdirSync(graphRunsDir(cwd));
  const target = join(outside, "target.json"); writeFileSync(target, JSON.stringify(saved));
  symlinkSync(target, join(graphRunsDir(cwd), `${saved.runId}.json`));
  expect(readGraphSnapshots(cwd, vi.fn())).toEqual([]);
  expect(() => writeGraphSnapshot(cwd, saved)).toThrow(/Unsafe checkpoint/);
});

it.each([graph, gateGraph])("restores an unmodified completed checkpoint without dispatch", async source => {
  const saved = await checkpoint(directory(), source);
  const spawnAgent = vi.fn(); const onCheckpoint = vi.fn();
  await expect(runGraph(saved.graph, saved.input, { runId: saved.runId, restore: saved.state, host: { spawnAgent }, onCheckpoint })).resolves.toMatchObject({ status: "completed" });
  expect(spawnAgent).not.toHaveBeenCalled();
});

it.each(["missing", "unknown", "status", "attempt", "loops", "output", "gate output"])("rejects forged restore %s before writes or dispatch", async kind => {
  const saved = await checkpoint(directory(), kind === "gate output" ? gateGraph : graph);
  if (kind === "missing") delete saved.state.nodes.a;
  if (kind === "unknown") saved.state.nodes.extra = { status: "pending", attempt: 0 };
  if (kind === "status") Object.assign(saved.state.nodes.a, { status: "invented" });
  if (kind === "attempt") saved.state.nodes.a.attempt = -1;
  if (kind === "loops") saved.state.loopCounts["missing->a"] = 1;
  if (kind === "output") saved.state.nodes.a.output = { ok: "forged" };
  if (kind === "gate output") saved.state.nodes.a.output = { answers: { approved: { value: "forged", confidence: 1 } }, decidedBy: "classifier" };
  const spawnAgent = vi.fn(); const onCheckpoint = vi.fn();
  await expect(runGraph(saved.graph, saved.input, { runId: saved.runId, restore: saved.state, host: { spawnAgent }, onCheckpoint })).rejects.toThrow();
  expect(onCheckpoint).not.toHaveBeenCalled(); expect(spawnAgent).not.toHaveBeenCalled();
});

it("rejects identity replacement even with the correct next revision", async () => {
  const cwd = directory(); const saved = await checkpoint(cwd);
  const before = readFileSync(join(graphRunsDir(cwd), `${saved.runId}.json`), "utf8");
  const next = structuredClone(saved); if (!next.state.runtime) throw new Error("missing runtime");
  next.state.runtime.revision++;
  Object.assign(next.state.runtime.manifest[0], { instanceId: "00000000-0000-4000-8000-000000000001" });
  expect(() => writeGraphSnapshot(cwd, next)).toThrow();
  expect(readFileSync(join(graphRunsDir(cwd), `${saved.runId}.json`), "utf8")).toBe(before);
});

it.each(["partial", "owner", "cost", "budget", "resources"])("rejects forged execution %s before writes or dispatch", async mutation => {
  const { GraphInstances } = await import("../src/graph/graph-instance-id.js");
  const { executionAttemptId } = await import("../src/graph/graph-execution.js");
  const instances = new GraphInstances("agr_abcdef123456"); instances.add("a", { nodeKey: "a" });
  const runtime = instances.state; const instanceId = runtime.manifest[0].instanceId;
  const state: SchedulerState = { nodes: { a: { status: "pending", attempt: 0 } }, loopCounts: {}, runtime: { ...runtime, executionProtocolVersion: 1, executionLedger: [{ runId: runtime.runId, instanceId, activation: 1, graphAttempt: 1, executionAttemptId: executionAttemptId("00000000-0000-4000-8000-000000000001"), payload: { kind: "admitted", resources: [], budget: { maxExecutions: 1 } } }] } };
  const restoredRuntime = state.runtime;
  if (!restoredRuntime?.executionLedger) throw new Error("missing execution ledger");
  const ledger = restoredRuntime.executionLedger;
  if (mutation === "partial") Reflect.deleteProperty(restoredRuntime, "executionProtocolVersion");
  if (mutation === "owner") Reflect.set(ledger[0], "runId", "other");
  if (mutation === "budget" || mutation === "resources") Reflect.set(ledger[0], "payload", { kind: "admitted", resources: mutation === "resources" ? ["forged"] : [], budget: { maxExecutions: mutation === "budget" ? 100 : 1 } });
  if (mutation === "cost") Reflect.set(restoredRuntime, "executionLedger", [...ledger, { ...ledger[0], payload: { kind: "dispatched", target: "agent" } }, { ...ledger[0], payload: { kind: "cost", costUsd: 100 } }]);
  const onCheckpoint = vi.fn(); const spawnAgent = vi.fn();
  await expect(runGraph(graph, {}, { restore: state, onCheckpoint, host: { spawnAgent } })).rejects.toThrow();
  expect(onCheckpoint).not.toHaveBeenCalled(); expect(spawnAgent).not.toHaveBeenCalled();
});

it("isolates nested protocol ledgers and rejects partial recursive checkpoints", async () => {
  const { validateGraphRestore } = await import("../src/graph/graph-restore-validation.js");
  const { validateCheckpointTransition } = await import("../src/graph/graph-checkpoint-transition.js");
  const parent: AgentGraph = { nodes: { sub: { type: "graph", graph: "child" } }, edges: [] };
  let saved: SchedulerState | undefined;
  await runGraph(parent, {}, { runId: "agr_abcdef123456", loadGraph: () => graph, host: { spawnAgent: async () => ({ ok: true, output: '{"ok":true}' }) }, onCheckpoint: state => { saved = structuredClone(state); } });
  const savedState = saved;
  const nested = savedState?.runtime?.nested?.sub;
  if (!savedState || !nested) throw new Error("missing nested runtime");
  validateGraphRestore(savedState, parent);
  const snapshot: GraphRunSnapshot = { version: 2, runId: "agr_abcdef123456", graph: parent, state: savedState, input: {}, waitingGate: "", savedAt: 0 };
  for (const mutation of ["partial", "owner", "remove"] as const) {
    const next = structuredClone(snapshot); const runtime = next.state.runtime?.nested?.sub.state.runtime;
    if (!runtime) throw new Error("missing cloned nested runtime");
    if (mutation === "partial") Reflect.deleteProperty(runtime, "executionProtocolVersion");
    if (mutation === "owner") {
      const [entry] = runtime.executionLedger ?? [];
      const [instance] = next.state.runtime?.manifest ?? [];
      if (!entry || !instance) throw new Error("missing execution identity");
      Reflect.set(entry, "instanceId", instance.instanceId);
    }
    if (mutation === "remove") { Reflect.deleteProperty(runtime, "executionProtocolVersion"); Reflect.deleteProperty(runtime, "executionLedger"); }
    if (mutation !== "remove") expect(() => validateGraphRestore(next.state, parent)).toThrow();
    expect(() => validateCheckpointTransition(snapshot, next)).toThrow();
  }
});
