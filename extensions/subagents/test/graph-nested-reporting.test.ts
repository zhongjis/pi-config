import { expect, it } from "vitest";
import { type ExecutionCorrelation, executionAttemptId } from "../src/graph/graph-execution.js";
import type { NodeInstanceId } from "../src/graph/graph-instance-id.js";
import { completeGraphTask, GraphRunReporter } from "../src/graph/graph-run-adapter.js";
import type { AgentGraph } from "../src/graph/ir.js";
import { collapse } from "../src/graph/progress.js";
import { type GraphControl, runGraph } from "../src/graph/run-graph.js";
import { createWorkflowTask } from "../src/graph/task.js";

it("forwards nested static and fanout rows without federating direct-graph controls", async () => {
  const child: AgentGraph = {
    nodes: {
      research: {
        type: "fanout", items: { path: "$.tasks" }, itemSchema: { type: "object" },
        dispatch: { path: "$.source", cases: { project: "worker" } }, prompt: `\${item}`,
        phase: { index: 0, title: "Round 1/2" },
      },
      summary: { type: "agent", agent: "writer", prompt: "fixture" },
    },
    edges: [{ from: "research", to: "summary" }], outputs: { answer: { node: "summary", path: "$" } },
  };
  const graph: AgentGraph = {
    nodes: {
      gather: { type: "graph", graph: "context", input: { tasks: { path: "$.tasks" } } },
      "gather/research": { type: "agent", agent: "outer", prompt: "fixture" },
      later: { type: "fanout", items: { path: "$.tasks" }, itemSchema: { type: "object" }, dispatch: { path: "$.source", cases: { project: "direct" } }, prompt: `\${item}` },
    },
    edges: [{ from: "gather", to: "later" }], outputs: { result: { node: "gather", path: "$.answer" } },
  };
  const task = createWorkflowTask({ id: "nested", script: "" });
  const reporter = new GraphRunReporter(task, graph);
  const added = new Map<string, { dependencies: string[] }>();
  const events: string[] = [];
  let control: GraphControl | undefined;
  const result = await runGraph(graph, { tasks: [{ source: "project" }] }, {
    concurrency: 1,
    loadGraph: () => child,
    host: { spawnAgent: async request => {
      request.onResolved?.({ recordId: `record:${request.agentType}`, modelId: "provider/model" });
      if (request.agentType === "worker") {
        const row = collapse(task.workflowProgress).agents.find(agent => agent.agentType === "worker");
        expect(row).toBeDefined();
        expect(control?.skip(row?.index ?? -1)).toBe(false);
        expect(control?.retry(row?.index ?? -1)).toBe(false);
        control?.pause();
      }
      // Pausing the direct graph does not pause a running nested scheduler.
      if (request.agentType === "writer") control?.resume();
      return { ok: true, output: request.agentType };
    } },
    onControl: value => { control = value; },
    onNodeAdded: (id, node, metadata) => {
      added.set(id, metadata);
      events.push(`added:${id}`);
      reporter.registerNode(id, node, metadata);
    },
    onNodeUpdate: (id, state, correlation) => {
      events.push(`update:${id}`);
      reporter.update(id, state, correlation);
      if (id === "later:item:0" && state.status === "pending") {
        const row = collapse(task.workflowProgress).agents.find(agent => agent.label === id);
        expect(control?.skip(row?.index ?? -1)).toBe(true);
      }
    },
    onNodeResolved: (id, info, correlation) => reporter.setResolved(id, info, correlation),
  });
  completeGraphTask(task, result);
  expect(result.status).toBe("completed");
  expect(task.value).toEqual({ result: "writer" });
  expect(Object.keys(result.nodes)).toEqual(["gather", "gather/research", "later", "later:item:0"]);
  expect(result.nodes["later:item:0"].status).toBe("skipped");
  const rows = collapse(task.workflowProgress).agents;
  expect(new Set(rows.map(row => row.index)).size).toBe(rows.length);
  expect(rows).toHaveLength(7);
  const worker = rows.find(row => row.agentType === "worker");
  expect(worker).toMatchObject({ label: "gather/research:item:0", phaseTitle: "Round 1/2", deps: [], state: "done", recordId: "record:worker", modelId: "provider/model" });
  const summary = rows.find(row => row.agentType === "writer");
  expect(summary?.deps).toHaveLength(1);
  expect(summary?.deps?.[0]).not.toBe("gather/research"); // That ID belongs to the outer agent.
  expect(rows.find(row => row.label === summary?.deps?.[0])?.dependents).toContain(summary?.label);
  for (const id of added.keys()) expect(events.indexOf(`added:${id}`)).toBeLessThan(events.indexOf(`update:${id}`));
});

it("keeps deeper descendants distinct from later direct expansion IDs", async () => {
  const leaf: AgentGraph = { nodes: { a: { type: "agent", agent: "leaf", prompt: "fixture" } }, edges: [] };
  const middle: AgentGraph = { nodes: { inner: { type: "graph", graph: "leaf" } }, edges: [] };
  const outer: AgentGraph = {
    nodes: { g: { type: "graph", graph: "middle" }, expand: { type: "expand", source: { path: "$" } } },
    edges: [{ from: "g", to: "expand" }],
  };
  const task = createWorkflowTask({ id: "deep", script: "" });
  const reporter = new GraphRunReporter(task, outer);
  const result = await runGraph(outer, { nodes: { "g/inner/a": { type: "agent", agent: "direct", prompt: "fixture" } }, edges: [] }, {
    loadGraph: name => name === "middle" ? middle : leaf,
    host: { spawnAgent: async request => {
      request.onResolved?.({ recordId: request.agentType });
      return { ok: true, output: request.agentType };
    } },
    onNodeAdded: (id, node, metadata) => reporter.registerNode(id, node, metadata),
    onNodeUpdate: (id, run, correlation) => reporter.update(id, run, correlation),
    onNodeResolved: (id, info, correlation) => reporter.setResolved(id, info, correlation),
  });
  expect(result.status).toBe("completed");
  const rows = collapse(task.workflowProgress).agents;
  expect(rows).toHaveLength(5);
  expect(rows.find(row => row.agentType === "leaf")).toMatchObject({ label: "g/inner/a", recordId: "leaf", state: "done" });
  expect(rows.find(row => row.agentType === "direct")).toMatchObject({ recordId: "direct", state: "done" });
  expect(new Set(rows.map(row => row.label)).size).toBe(5);
});

it("keeps a nested display binding scoped to its current run correlation", () => {
  const graph: AgentGraph = { nodes: { "nested/worker": { type: "agent", agent: "worker", prompt: "fixture" } }, edges: [] };
  const task = createWorkflowTask({ id: "nested-correlation", script: "" });
  const reporter = new GraphRunReporter(task, graph);
  const identity = (runId: string, id: string): ExecutionCorrelation => ({
    runId,
    instanceId: "11111111-1111-4111-8111-111111111111" as NodeInstanceId,
    activation: 1,
    graphAttempt: 1,
    executionAttemptId: executionAttemptId(id),
  });
  const first = identity("parent/first", "11111111-1111-4111-8111-111111111111");
  const second = identity("parent/second", "22222222-2222-4222-8222-222222222222");
  const running = (current: ExecutionCorrelation) => ({
    status: "running" as const, attempt: 1, activation: current.activation, graphAttempt: current.graphAttempt, currentExecutionAttemptId: current.executionAttemptId,
  });
  reporter.update("nested/worker", running(first), first);
  reporter.setResolved("nested/worker", { recordId: "first", modelName: "first-model" }, first);
  reporter.update("nested/worker", running(second), second);
  reporter.setResolved("nested/worker", { recordId: "second", modelName: "second-model" }, second);
  reporter.setResolved("nested/worker", { recordId: "first", modelName: "first-model" }, first);
  expect(collapse(task.workflowProgress).agents.find(row => row.label === "nested/worker")).toMatchObject({ recordId: "second", model: "second-model" });
});
