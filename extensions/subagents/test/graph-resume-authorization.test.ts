import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import * as delegation from "../src/graph/delegation-preflight.js";
import * as persistence from "../src/graph/graph-persist.js";
import type { AgentGraph } from "../src/graph/ir.js";
import { runGraph } from "../src/graph/run-graph.js";
import * as tasks from "../src/graph/task.js";
import { boot, required } from "./workflow-registration.fixture.js";

it.each(["invalid graph", "denied graph", "denied nested graph"])("preserves %s without creating a task, checkpoint or child", async kind => {
  const session = boot({ workflowsEnabled: true });
  const { runAgent } = await import("../src/agent-runner.js");
  const child: AgentGraph = { nodes: { a: { type: "agent", agent: "forbidden", prompt: "work" } }, edges: [] };
  const graph: AgentGraph = kind === "denied nested graph" ? { nodes: { sub: { type: "graph", graph: "saved-child" } }, edges: [] } : child;
  const runId = "wf_abcdef123456";
  let saved: persistence.GraphRunSnapshot | undefined;
  await runGraph(graph, {}, { runId, loadGraph: () => child, onCheckpoint: (state, effective) => { saved = { version: 2, runId, graph: effective, state, input: {}, waitingGate: "", savedAt: 0 }; }, host: { spawnAgent: async () => ({ ok: true, output: "ok" }) } });
  if (!saved) throw new Error("missing fixture");
  if (kind === "invalid graph") saved.graph.edges.push({ from: "missing", to: "a" });
  mkdirSync(persistence.graphRunsDir(session.ctx.cwd), { recursive: true });
  const path = join(persistence.graphRunsDir(session.ctx.cwd), `${runId}.json`);
  const original = JSON.stringify(saved); writeFileSync(path, original);
  vi.spyOn(delegation, "checkGraphDelegation").mockImplementation(current => Object.values(current.nodes).some(node => node.type === "agent" && node.agent === "forbidden") ? { ok: false, error: "delegation_policy_denied: forbidden" } : { ok: true });
  const create = vi.spyOn(tasks, "createWorkflowTask"); const write = vi.spyOn(persistence, "writeGraphSnapshot"); const lease = vi.spyOn(persistence, "ownGraphRun");
  await session.lifecycle("session_start");
  expect(create).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled(); expect(lease).not.toHaveBeenCalled(); expect(runAgent).not.toHaveBeenCalled();
  expect(session.ui.notify).toHaveBeenCalled(); expect(readFileSync(path, "utf8")).toBe(original);
});

it("removes explicit terminal cancellation rather than resuming it each restart", async () => {
  const session = boot({ workflowsEnabled: true });
  const { runAgent } = await import("../src/agent-runner.js");
  const graph: AgentGraph = { version: 2, nodes: { a: { type: "agent", agent: "fixture", prompt: "work" } }, edges: [] };
  const runId = "wf_abcdef123456"; const controller = new AbortController(); controller.abort();
  await runGraph(graph, {}, { runId, signal: controller.signal, onCheckpoint: (state, effective) => persistence.writeGraphSnapshot(session.ctx.cwd, { version: 2, runId, graph: effective, state, input: {}, waitingGate: "", savedAt: 0 }), host: { spawnAgent: vi.fn() } });
  const create = vi.spyOn(tasks, "createWorkflowTask");
  await session.lifecycle("session_start");
  expect(create).not.toHaveBeenCalled(); expect(runAgent).not.toHaveBeenCalled();
  expect(persistence.readGraphSnapshots(session.ctx.cwd)).toEqual([]);
  expect(readdirSync(persistence.graphRunsDir(session.ctx.cwd))).toEqual([]);
});

it("removes a live explicitly-cancelled snapshot before notifying completion", async () => {
  const session = boot({ workflowsEnabled: true });
  await session.lifecycle("session_start");
  session.ui.select.mockReturnValue(new Promise(() => {}));
  const create = vi.spyOn(tasks, "createWorkflowTask");
  const graph: AgentGraph = { version: 2, nodes: { gate: { type: "human_gate", prompt: "approve?", outputSchema: { type: "object", properties: { approved: { type: "boolean" } }, required: ["approved"] } }, after: { type: "agent", agent: "fixture", prompt: "after" } }, edges: [{ from: "gate", to: "after" }] };
  const result = await required(session.tools.get("agent_graph")).execute("call", { graph, input: {} }, undefined, undefined, session.ctx);
  const runId = required(result.details?.taskId);
  await vi.waitFor(() => expect(persistence.readGraphSnapshots(session.ctx.cwd).some(snapshot => snapshot.state.nodes.gate?.status === "running")).toBe(true));
  required(create.mock.results[0]?.value).abortController.abort("user-cancel");
  await session.notification(runId);
  expect(persistence.readGraphSnapshots(session.ctx.cwd)).toEqual([]);
});
