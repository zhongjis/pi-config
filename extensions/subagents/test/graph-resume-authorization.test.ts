import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import * as delegation from "../src/graph/delegation-preflight.js";
import * as persistence from "../src/graph/graph-persist.js";
import type { AgentGraph } from "../src/graph/ir.js";
import { runGraph } from "../src/graph/run-graph.js";
import * as tasks from "../src/graph/task.js";
import { deferred, releaseAfterPending } from "./graph-drain.fixture.js";
import { boot, required } from "./graph-run-registration.fixture.js";

it.each(["invalid graph", "denied graph", "denied nested graph"])("preserves %s without creating a task, checkpoint or child", async kind => {
  const session = boot({ workflowsEnabled: true });
  const { runAgent } = await import("../src/agent-runner.js");
  const child: AgentGraph = { nodes: { a: { type: "agent", agent: "forbidden", prompt: "work" } }, edges: [] };
  const graph: AgentGraph = kind === "denied nested graph" ? { nodes: { sub: { type: "graph", graph: "saved-child" } }, edges: [] } : child;
  const runId = "wf_abcdef123456";
  let saved: persistence.GraphRunSnapshot | undefined;
  await runGraph(graph, {}, { runId, loadGraph: () => child, onCheckpoint: (state, effective) => { saved = { version: 2, runId, ownerSessionId: session.ctx.sessionManager.getSessionId(), graph: effective, state, input: {}, waitingGate: "", savedAt: 0 }; }, host: { spawnAgent: async () => ({ ok: true, output: "ok" }) } });
  if (!saved) throw new Error("missing fixture");
  if (kind === "invalid graph") saved.graph.edges.push({ from: "missing", to: "a" });
  mkdirSync(persistence.graphRunsDir(session.ctx.cwd), { recursive: true });
  const path = join(persistence.graphRunsDir(session.ctx.cwd), `${runId}.json`);
  const original = JSON.stringify(saved); writeFileSync(path, original);
  vi.spyOn(delegation, "checkGraphDelegation").mockImplementation(current => Object.values(current.nodes).some(node => node.type === "agent" && node.agent === "forbidden") ? { ok: false, error: "delegation_policy_denied: forbidden" } : { ok: true });
  const create = vi.spyOn(tasks, "createGraphRunTask"); const write = vi.spyOn(persistence, "writeGraphSnapshot"); const lease = vi.spyOn(persistence, "ownGraphRun");
  await session.lifecycle("session_start");
  expect(create).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled(); expect(lease).not.toHaveBeenCalled(); expect(runAgent).not.toHaveBeenCalled();
  expect(session.ui.notify).toHaveBeenCalled(); expect(readFileSync(path, "utf8")).toBe(original);
});

it("removes explicit terminal cancellation rather than resuming it each restart", async () => {
  const session = boot({ workflowsEnabled: true });
  const { runAgent } = await import("../src/agent-runner.js");
  const graph: AgentGraph = { version: 2, nodes: { a: { type: "agent", agent: "fixture", prompt: "work" } }, edges: [] };
  const runId = "wf_abcdef123456"; const controller = new AbortController(); controller.abort();
  await runGraph(graph, {}, { runId, signal: controller.signal, onCheckpoint: (state, effective) => persistence.writeGraphSnapshot(session.ctx.cwd, { version: 2, runId, ownerSessionId: session.ctx.sessionManager.getSessionId(), graph: effective, state, input: {}, waitingGate: "", savedAt: 0 }), host: { spawnAgent: vi.fn() } });
  const create = vi.spyOn(tasks, "createGraphRunTask");
  await session.lifecycle("session_start");
  await vi.waitFor(() => expect(required(create.mock.results[0]?.value).status).toBe("killed"));
  expect(runAgent).not.toHaveBeenCalled();
  expect(persistence.readGraphSnapshots(session.ctx.cwd)).toEqual([]);
  expect(readdirSync(persistence.graphRunsDir(session.ctx.cwd))).toEqual([]);
});

it("removes a live explicitly-cancelled snapshot before notifying completion", async () => {
  const session = boot({ workflowsEnabled: true });
  await session.lifecycle("session_start");
  const human = deferred<string>();
  session.ui.select.mockReturnValue(human.promise);
  const create = vi.spyOn(tasks, "createGraphRunTask");
  const graph: AgentGraph = { version: 2, nodes: { gate: { type: "human_gate", prompt: "approve?", outputSchema: { type: "object", properties: { approved: { type: "boolean" } }, required: ["approved"] } }, after: { type: "agent", agent: "fixture", prompt: "after" } }, edges: [{ from: "gate", to: "after" }] };
  const result = await required(session.tools.get("agent_graph")).execute("call", { graph, input: {} }, undefined, undefined, session.ctx);
  const runId = required(result.details?.taskId);
  await vi.waitFor(() => expect(persistence.readGraphSnapshots(session.ctx.cwd).some(snapshot => snapshot.state.nodes.gate?.status === "running")).toBe(true));
  required(create.mock.results[0]?.value).abortController.abort("user-cancel");
  const notification = session.notification(runId);
  await releaseAfterPending(notification, () => human.resolve("Approve"));
  await notification;
  expect(persistence.readGraphSnapshots(session.ctx.cwd)).toEqual([]);
});

it("preserves a cancelled validation-gate checkpoint when resume cannot reconcile its drain", async () => {
  const session = boot({ workflowsEnabled: true });
  const graph: AgentGraph = { version: 2, nodes: { a: { type: "agent", agent: "fixture", prompt: "work", validation: { gate: "true" } } }, edges: [] };
  const runId = "wf_abcdef123456"; const controller = new AbortController(); const gate = deferred<{ ok: boolean; output: string }>();
  let saved: persistence.GraphRunSnapshot | undefined; let entered = false;
  const running = runGraph(graph, {}, { runId, signal: controller.signal, onCheckpoint: (state, effective) => {
    if (state.runtime?.cancelled && !saved) saved = { version: 2, runId, ownerSessionId: session.ctx.sessionManager.getSessionId(), graph: effective, state, input: {}, waitingGate: "", savedAt: 0 };
  }, host: { spawnAgent: async () => ({ ok: true, output: "ok" }), runGate: async () => { entered = true; return gate.promise; } } });
  await vi.waitFor(() => expect(entered).toBe(true)); controller.abort(); gate.resolve({ ok: true, output: "" }); await running;
  const checkpoint = required(saved);
  mkdirSync(persistence.graphRunsDir(session.ctx.cwd), { recursive: true });
  const path = join(persistence.graphRunsDir(session.ctx.cwd), `${runId}.json`); const original = JSON.stringify(checkpoint); writeFileSync(path, original);
  const create = vi.spyOn(tasks, "createGraphRunTask"); const lease = vi.spyOn(persistence, "ownGraphRun"); const remove = vi.spyOn(persistence, "deleteGraphSnapshot");
  await session.lifecycle("session_start");
  await vi.waitFor(() => expect(required(create.mock.results[0]?.value).status).toBe("failed"));
  expect(required(create.mock.results[0]?.value).error).toContain("Unreconciled execution drain");
  expect(lease).toHaveBeenCalledOnce(); expect(remove).not.toHaveBeenCalled();
  expect(readFileSync(path, "utf8")).toBe(original);
});
