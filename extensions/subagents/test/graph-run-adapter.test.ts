import { describe, expect, it, vi } from "vitest";
import { completeGraphTask, GraphRunReporter } from "../src/graph/graph-run-adapter.js";
import type { AgentGraph } from "../src/graph/ir.js";
import type { NodeHost, NodeSpawnResult } from "../src/graph/node-host.js";
import { collapse } from "../src/graph/progress.js";
import { type RunGraphResult, runGraph } from "../src/graph/run-graph.js";
import type { NodeRun } from "../src/graph/scheduler.js";
import { createWorkflowTask } from "../src/graph/task.js";
import { initialPanelState } from "../src/ui/observability-panel.js";

// The pane needs the installed TUI helpers; the default unit stub intentionally omits them.
vi.mock("@earendil-works/pi-tui", () => import("../../../node_modules/@earendil-works/pi-tui/dist/index.js"));

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
  it("maps node states onto the progress log, carrying each node's prompt", () => {
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
    expect(a?.promptPreview).toBe("a");
    expect(b?.state).toBe("start");
    expect(b?.startedAt).toBeDefined();
    expect(b?.promptPreview).toBe("b");
    // Nodes are grouped by topological stage for a graph-shaped monitor view.
    expect(a?.phaseIndex).toBe(0);
    expect(a?.phaseTitle).toBe("Stage 1");
    expect(b?.phaseIndex).toBe(1);
    expect(b?.phaseTitle).toBe("Stage 2");
    expect(t.agentCount).toBe(2);
    expect(t.doneCount).toBe(1);
  });

  it("truncates a long node prompt with preview() and omits promptPreview for prompt-less nodes", () => {
    const long = "investigate the auth flow ".repeat(20).trim(); // > 200 chars, single line
    const promptGraph: AgentGraph = {
      nodes: {
        big: { type: "agent", agent: "jintong", prompt: long },
        sub: { type: "graph", graph: "other" },
      },
      edges: [{ from: "big", to: "sub" }],
    };
    const t = task();
    const reporter = new GraphRunReporter(t, promptGraph);
    reporter.update("big", { status: "running", attempt: 1 });
    reporter.update("sub", { status: "running", attempt: 1 });
    const { agents } = collapse(t.workflowProgress);
    const big = agents.find(entry => entry.label === "big");
    const sub = agents.find(entry => entry.label === "sub");
    // A prompt over the 200-char cap is truncated with an ellipsis.
    expect(big?.promptPreview?.length).toBeLessThanOrEqual(200);
    expect(big?.promptPreview?.endsWith("\u2026")).toBe(true);
    // A subgraph node has no prompt, so the field is omitted entirely.
    expect(sub?.promptPreview).toBeUndefined();
  });

  it("retains complete node output while keeping prompt previews capped", () => {
    const t = task();
    const reporter = new GraphRunReporter(t, graph);
    const output = "retained output ".repeat(40).trim();
    reporter.update("a", { status: "completed", attempt: 1, output });
    const entry = collapse(t.workflowProgress).agents.find(agent => agent.label === "a");
    expect(entry?.resultPreview).toBe(output);

    reporter.update("b", { status: "completed", attempt: 1, output: Symbol("result") });
    const b = collapse(t.workflowProgress).agents.find(agent => agent.label === "b");
    expect(b?.resultPreview).toBe("Symbol(result)");
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

  it("pins startedAt across re-emits within an attempt and resets it on a new attempt", () => {
    const t = task();
    let activity: { toolCalls?: number; tokens?: number } | undefined = { toolCalls: 1 };
    const reporter = new GraphRunReporter(t, graph, 1_000, () => activity);

    // First running emit stamps startedAt; re-emits from setResolved/refresh must not restamp it.
    reporter.update("a", { status: "running", attempt: 1 }, 1_000);
    reporter.setResolved("a", { recordId: "r1" }, 5_000);
    activity = { toolCalls: 9 };
    reporter.refresh(9_000);
    expect(collapse(t.workflowProgress).agents.find(e => e.label === "a")?.startedAt).toBe(1_000);

    // A new attempt (retry / loop re-entry) resets startedAt to the new start.
    reporter.update("a", { status: "running", attempt: 2 }, 20_000);
    expect(collapse(t.workflowProgress).agents.find(e => e.label === "a")?.startedAt).toBe(20_000);

    // A terminal emit anchors to the current attempt's start, not `now`.
    reporter.update("a", { status: "completed", attempt: 2, output: "x" }, 25_000);
    expect(collapse(t.workflowProgress).agents.find(e => e.label === "a")?.startedAt).toBe(20_000);
  });
});

describe("GraphRunReporter — static graph progress", () => {
  it("pre-seeds all static stages through runGraph updates before synthesize starts", async () => {
    const staged: AgentGraph = {
      nodes: {
        research: { type: "agent", agent: "jintong", prompt: "research" },
        review: { type: "agent", agent: "jintong", prompt: "review" },
        test: { type: "agent", agent: "jintong", prompt: "test" },
        document: { type: "agent", agent: "jintong", prompt: "document" },
        synthesize: { type: "agent", agent: "jintong", prompt: "synthesize" },
      },
      edges: [
        { from: "research", to: "synthesize" },
        { from: "review", to: "synthesize" },
        { from: "test", to: "synthesize" },
        { from: "document", to: "synthesize" },
      ],
    };
    const t = task();
    const reporter = new GraphRunReporter(t, staged, 1_700_000_000_000);
    const controller = new AbortController();
    const roots = new Map<string, (result: NodeSpawnResult) => void>();
    const graphHost: NodeHost = {
      spawnAgent: request => {
        if (request.nodeId === "synthesize") return Promise.resolve({ ok: true, output: "done" });
        return new Promise(resolve => roots.set(request.nodeId, resolve));
      },
    };

    const run = runGraph(staged, {}, {
      host: graphHost,
      signal: controller.signal,
      onNodeUpdate: (id, node) => reporter.update(id, { ...node } satisfies NodeRun, 1_700_000_000_000),
    });
    await vi.waitFor(() => expect(roots.size).toBe(4));
    roots.get("research")?.({ ok: true, output: "research complete" });
    await vi.waitFor(() => {
      expect(collapse(t.workflowProgress).agents.find(agent => agent.label === "research")?.state).toBe("done");
    });

    const { agents } = collapse(t.workflowProgress);
    expect(agents).toHaveLength(5);
    expect(agents.find(agent => agent.label === "synthesize")?.phaseIndex).toBe(1);
    const { renderObservabilityPaneLines, toPaneSource } = await import("../src/graph/pane/render.js");
    const rendered = renderObservabilityPaneLines(
      [{ id: t.id, name: "demo", status: t.status, source: toPaneSource(t) }],
      initialPanelState(),
      { width: 100, rows: 40, now: 1_700_000_000_000 },
    ).join("\n");
    expect(rendered).toContain("1/5 agents");
    expect(rendered).toContain("Stage 2");
    expect(rendered).toContain("synthesize");

    controller.abort();
    await expect(run).resolves.toMatchObject({ status: "aborted" });
  });
});
