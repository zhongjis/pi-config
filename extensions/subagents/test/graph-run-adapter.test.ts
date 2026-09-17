import { describe, expect, it } from "vitest";
import { completeGraphTask, GraphRunReporter } from "../src/graph/graph-run-adapter.js";
import type { AgentGraph } from "../src/graph/ir.js";
import { collapse } from "../src/graph/progress.js";
import type { RunGraphResult } from "../src/graph/run-graph.js";
import { createWorkflowTask } from "../src/graph/task.js";

const graph: AgentGraph = {
  nodes: {
    a: { type: "agent", agent: "jintong", prompt: "a" },
    b: { type: "agent", agent: "yanluo", prompt: "b" },
  },
  edges: [{ from: "a", to: "b" }],
};

function task() {
  return createWorkflowTask({ id: "wf_test", script: "", meta: { name: "demo", description: "demo graph" } });
}

describe("GraphRunReporter", () => {
  it("maps node states onto the progress log with dependency hints", () => {
    const t = task();
    const reporter = new GraphRunReporter(t, graph);
    reporter.update("a", { status: "running", attempt: 1 });
    reporter.update("a", { status: "completed", attempt: 1, output: { diff: "x" } });
    reporter.update("b", { status: "running", attempt: 1 });

    const { agents } = collapse(t.workflowProgress);
    const a = agents.find(entry => entry.label === "a");
    const b = agents.find(entry => entry.label === "b");
    expect(a?.state).toBe("done");
    expect(a?.resultPreview).toContain("diff");
    expect(a?.promptPreview).toBe("entry node");
    expect(b?.state).toBe("start");
    expect(b?.startedAt).toBeDefined();
    expect(b?.promptPreview).toBe("depends on: a");
    // Nodes are grouped by topological stage for a graph-shaped monitor view.
    expect(a?.phaseIndex).toBe(0);
    expect(a?.phaseTitle).toBe("Stage 1");
    expect(b?.phaseIndex).toBe(1);
    expect(b?.phaseTitle).toBe("Stage 2");
    expect(t.agentCount).toBe(2);
    expect(t.doneCount).toBe(1);
  });

  it("renders a pending node as blocked and a skipped node as skipped", () => {
    const t = task();
    const reporter = new GraphRunReporter(t, graph);
    reporter.update("a", { status: "pending", attempt: 0 });
    reporter.update("b", { status: "skipped", attempt: 0 });
    const { agents } = collapse(t.workflowProgress);
    expect(agents.find(e => e.label === "a")?.blocked).toBe(true);
    expect(agents.find(e => e.label === "b")?.skipped).toBe(true);
  });

  it("completeGraphTask settles a completed run with its outputs", () => {
    const t = task();
    const result: RunGraphResult = {
      status: "completed",
      outputs: { r: 1 },
      nodes: { a: { status: "completed", attempt: 1 }, b: { status: "completed", attempt: 1 } },
    };
    completeGraphTask(t, result);
    expect(t.status).toBe("completed");
    expect(t.value).toEqual({ r: 1 });
    expect(t.endTime).toBeDefined();
  });

  it("completeGraphTask surfaces failed node errors", () => {
    const t = task();
    const result: RunGraphResult = {
      status: "failed",
      outputs: {},
      nodes: { a: { status: "completed", attempt: 1 }, b: { status: "failed", attempt: 1, error: "boom" } },
    };
    completeGraphTask(t, result);
    expect(t.status).toBe("failed");
    expect(t.error).toContain("b: boom");
  });

  it("maps an aborted run to killed", () => {
    const t = task();
    completeGraphTask(t, { status: "aborted", outputs: {}, nodes: {} });
    expect(t.status).toBe("killed");
  });

  it("setResolved plumbs model and modelId into the node's progress entry", () => {
    const t = task();
    const reporter = new GraphRunReporter(t, graph);
    reporter.update("a", { status: "running", attempt: 1 });
    reporter.setResolved("a", { modelName: "haiku 4.5", modelId: "anthropic/claude-haiku-4-5" });
    const { agents } = collapse(t.workflowProgress);
    const a = agents.find(e => e.label === "a");
    expect(a?.model).toBe("haiku 4.5");
    expect(a?.modelId).toBe("anthropic/claude-haiku-4-5");
  });

  it("setResolved merges recordId and model across calls without clobbering, in either order", () => {
    const t = task();
    const reporter = new GraphRunReporter(t, graph);
    reporter.update("a", { status: "running", attempt: 1 });
    reporter.setResolved("a", { recordId: "r1" });
    reporter.setResolved("a", { modelName: "haiku 4.5", modelId: "anthropic/claude-haiku-4-5" });
    const a = collapse(t.workflowProgress).agents.find(e => e.label === "a");
    expect(a?.recordId).toBe("r1");
    expect(a?.model).toBe("haiku 4.5");
    expect(a?.modelId).toBe("anthropic/claude-haiku-4-5");

    // Reverse order clobbers nothing either.
    const t2 = task();
    const r2 = new GraphRunReporter(t2, graph);
    r2.update("a", { status: "running", attempt: 1 });
    r2.setResolved("a", { modelName: "sonnet", modelId: "mid" });
    r2.setResolved("a", { recordId: "r2" });
    const a2 = collapse(t2.workflowProgress).agents.find(e => e.label === "a");
    expect(a2?.recordId).toBe("r2");
    expect(a2?.model).toBe("sonnet");
    expect(a2?.modelId).toBe("mid");
  });

  it("plumbs live tool-call and token counts from getActivity, re-emitting only on change", () => {
    const t = task();
    let activity: { toolCalls?: number; tokens?: number } | undefined = { toolCalls: 2, tokens: 100 };
    const reporter = new GraphRunReporter(t, graph, Date.now(), () => activity);
    reporter.update("a", { status: "running", attempt: 1 });
    reporter.setResolved("a", { recordId: "r1" });

    const first = collapse(t.workflowProgress).agents.find(e => e.label === "a");
    expect(first?.toolCalls).toBe(2);
    expect(first?.tokens).toBe(100);

    // A refresh after the counts climb re-emits the running node's entry with the new counts.
    const beforeChange = t.workflowProgress.length;
    activity = { toolCalls: 5, tokens: 250 };
    reporter.refresh();
    expect(t.workflowProgress.length).toBeGreaterThan(beforeChange);
    const updated = collapse(t.workflowProgress).agents.find(e => e.label === "a");
    expect(updated?.toolCalls).toBe(5);
    expect(updated?.tokens).toBe(250);

    // A refresh with unchanged counts appends nothing.
    const afterChange = t.workflowProgress.length;
    reporter.refresh();
    expect(t.workflowProgress.length).toBe(afterChange);
  });
});
