import { expect, it, vi } from "vitest";
import { GraphRunReporter } from "../src/graph/graph-run-adapter.js";
import { snapshotHistory } from "../src/graph/history.js";
import type { AgentGraph } from "../src/graph/ir.js";
import { toPaneSource } from "../src/graph/pane/render.js";
import { collapse } from "../src/graph/progress.js";
import { type RunGraphOptions, runGraph } from "../src/graph/run-graph.js";
import type { SchedulerState } from "../src/graph/scheduler.js";
import { createGraphRunTask } from "../src/graph/task.js";
import { initialPanelState, renderPanelLines } from "../src/ui/observability-panel.js";

it("leaves v1 dynamic children unclassified without authoritative ownership", async () => {
  const graph: AgentGraph = { nodes: { fan: { type: "fanout", items: { path: "$" }, itemSchema: { type: "object" }, dispatch: { path: "$.kind", cases: { x: "worker" } }, prompt: String.raw`\${item}` } }, edges: [] };
  const task = createGraphRunTask({ id: "v1", script: "" });
  const reporter = new GraphRunReporter(task, graph);
  await runGraph(graph, [{ kind: "x" }], {
    host: { spawnAgent: async () => ({ ok: true, output: "ok" }) },
    onNodeAdded: (id, node, metadata) => reporter.registerNode(id, node, metadata),
    onNodeUpdate: (id, run, correlation, presentation) => reporter.update(id, run, correlation, undefined, presentation),
  });
  const rows = collapse(task.graphRunProgress).agents;
  expect(rows.find(row => row.label === "fan:item:0")?.presentation).toBeUndefined();
  const output = renderPanelLines([{ id: task.id, name: "v1", status: "completed", source: toPaneSource(task) }], initialPanelState(), { width: 120 }).flat().map(segment => segment.text).join("");
  expect(output).toContain("Flat fallback");
  expect(output).toContain("1 unclassified node");
});

it("publishes identical transient nested v2 metadata on live and settled restore paths", async () => {
  const leaf: AgentGraph = { version: 2, nodes: {
    research: { type: "bounded_feedback", maxIterations: 2, maxItemsPerIteration: 1, maxTotalItems: 2,
      work: { type: "fanout", name: "Work", items: { path: "$.tasks" }, itemSchema: { type: "object", properties: { kind: { type: "string" }, query: { type: "string" } }, required: ["kind", "query"], additionalProperties: false }, dispatch: { path: "$.kind", cases: { x: "worker" } }, prompt: String.raw`\${item}`, outputSchema: { type: "object" } },
      evaluator: { type: "agent", name: "Judge", agent: "judge", prompt: String.raw`\${feedback}` },
    },
    finish: { type: "agent", name: "Finish", agent: "worker", prompt: "finish", outputSchema: { type: "object" } },
    again: { type: "agent", name: "Again", agent: "worker", prompt: "again", outputSchema: { type: "object" } },
  }, edges: [
    { from: "research", to: "finish", when: { exists: { node: "research", path: "$" } } },
    { from: "finish", to: "again" },
    { from: "again", to: "finish", when: { eq: [{ node: "again", path: "$.repeat" }, true] }, loop: { maxIterations: 2 } },
  ] };
  const middle: AgentGraph = { version: 2, nodes: { inner: { type: "graph", graph: "leaf", input: { tasks: { path: "$.tasks" } } } }, edges: [] };
  const graph: AgentGraph = { version: 2, nodes: { outer: { type: "graph", graph: "middle", input: { tasks: { path: "$.tasks" } } } }, edges: [] };
  const input = { tasks: [{ kind: "x", query: "first" }] };
  let saved: SchedulerState | undefined;
  let evaluations = 0;
  const task = createGraphRunTask({ id: "nested", script: "" });
  const reporter = new GraphRunReporter(task, graph);
  const added = new Map<string, Parameters<NonNullable<RunGraphOptions["onNodeAdded"]>>[2]>();
  const result = await runGraph(graph, input, {
    loadGraph: name => name === "middle" ? middle : leaf,
    onCheckpoint: state => { saved = state; },
    onNodeAdded: (id, node, metadata) => { added.set(id, metadata); reporter.registerNode(id, node, metadata); },
    onNodeUpdate: (id, run, correlation, presentation) => reporter.update(id, run, correlation, undefined, presentation),
    host: { spawnAgent: async request => ({ ok: true, output: JSON.stringify(request.agentType !== "judge" ? { repeat: false } : ++evaluations === 1
      ? { decision: "continue", gaps: [{ id: "gap", description: "missing" }], tasks: [{ gapId: "gap", item: { kind: "x", query: "second" } }] }
      : { decision: "sufficient", gaps: [], tasks: [] }) }) },
  });
  expect(result.status, JSON.stringify(saved)).toBe("completed");
  if (!saved) throw new Error("Missing checkpoint");
  expect(JSON.stringify(saved)).not.toContain('"presentation"');
  const live = collapse(task.graphRunProgress).agents;
  const owner = live.find(row => row.presentation?.kind === "bounded_feedback");
  expect(owner?.presentation?.iterations).toEqual([{ iteration: 1, decision: "continue" }, { iteration: 2, decision: "sufficient" }]);
  expect(added.get("outer/inner/finish")?.presentation?.connections).toContainEqual({ binding: "outer/inner/research", direction: "upstream", kind: "conditional" });
  const restoredTask = createGraphRunTask({ id: "restored", script: "" });
  const restored = new GraphRunReporter(restoredTask, graph);
  const spawnAgent = vi.fn();
  const restoredAdded = new Map<string, Parameters<NonNullable<RunGraphOptions["onNodeAdded"]>>[2]>();
  await runGraph(graph, input, {
    restore: saved, host: { spawnAgent }, onCheckpoint: () => {},
    onNodeAdded: (id, node, metadata) => { restoredAdded.set(id, metadata); restored.registerNode(id, node, metadata); },
    onNodeUpdate: (id, run, correlation, presentation) => restored.update(id, run, correlation, undefined, presentation),
  });
  expect(spawnAgent).not.toHaveBeenCalled();
  const rows = collapse(restoredTask.graphRunProgress).agents;
  expect(rows.map(row => [row.nodeBinding, row.presentation])).toEqual(live.map(row => [row.nodeBinding, row.presentation]));
  for (const row of rows.filter(row => row.nodeBinding?.includes("/"))) {
    expect(restoredAdded.get(row.nodeBinding ?? "")?.presentation).toEqual(row.presentation);
  }
  Object.assign(restoredTask, { status: "completed", endTime: Date.now() });
  const history = snapshotHistory(restoredTask);
  expect(JSON.stringify(history)).not.toMatch(/parentInstanceId|instanceId|nodeBinding/);
  expect(JSON.stringify(history)).toMatch(/connections|decision/);
});
