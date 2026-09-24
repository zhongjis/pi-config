import { describe, expect, it, vi } from "vitest";
import { type ExecutionCorrelation, executionAttemptId } from "../src/graph/graph-execution.js";
import type { NodeInstanceId } from "../src/graph/graph-instance-id.js";
import { completeGraphTask, GraphRunReporter } from "../src/graph/graph-run-adapter.js";
import type { AgentGraph } from "../src/graph/ir.js";
import type { NodeHost, NodeSpawnResult } from "../src/graph/node-host.js";
import { outcomeLabel, GRAPH_OUTCOME_KEY } from "../src/graph/outcome.js";
import { collapse } from "../src/graph/progress.js";
import { type RunGraphResult, runGraph } from "../src/graph/run-graph.js";
import type { NodeRun } from "../src/graph/scheduler.js";
import { createGraphRunTask } from "../src/graph/task.js";
import { initialPanelState } from "../src/ui/observability-panel.js";
import { releaseAfterPending } from "./graph-drain.fixture.js";

function correlation(
  id: string,
  overrides: Partial<Omit<ExecutionCorrelation, "executionAttemptId">> = {},
): ExecutionCorrelation {
  return {
    runId: "run",
    instanceId: "11111111-1111-4111-8111-111111111111" as NodeInstanceId,
    activation: 1,
    graphAttempt: 1,
    ...overrides,
    executionAttemptId: executionAttemptId(id),
  };
}

function running(identity: ExecutionCorrelation, attempt = 1): NodeRun {
  return {
    status: "running",
    attempt,
    activation: identity.activation,
    graphAttempt: identity.graphAttempt,
    currentExecutionAttemptId: identity.executionAttemptId,
  };
}

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
  return createGraphRunTask({ id: "agr_test", script: "", meta: { name: "demo", description: "demo graph" } });
}

describe("GraphRunReporter", () => {
  it("maps node states onto the progress log, carrying each node's prompt", () => {
    const t = task();
    const reporter = new GraphRunReporter(t, graph);
    reporter.update("a", { status: "running", attempt: 1 });
    reporter.update("a", { status: "completed", attempt: 1, output: { diff: "x" } });
    reporter.update("b", { status: "running", attempt: 1 });

    const { agents } = collapse(t.graphRunProgress);
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
    const { agents } = collapse(t.graphRunProgress);
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
    const entry = collapse(t.graphRunProgress).agents.find(agent => agent.label === "a");
    expect(entry?.resultPreview).toBe(output);

    reporter.update("b", { status: "completed", attempt: 1, output: Symbol("result") });
    const b = collapse(t.graphRunProgress).agents.find(agent => agent.label === "b");
    expect(b?.resultPreview).toBe("Symbol(result)");
  });

  it("renders a pending node as blocked and a skipped node as skipped", () => {
    const t = task();
    const reporter = new GraphRunReporter(t, graph);
    reporter.update("a", { status: "pending", attempt: 0 });
    reporter.update("b", { status: "skipped", attempt: 0 });
    const { agents } = collapse(t.graphRunProgress);
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

  it("completeGraphTask consumes a declared outcome envelope and strips it from the value", () => {
    const t = task();
    const result: RunGraphResult = {
      status: "completed",
      outputs: { r: 1, [GRAPH_OUTCOME_KEY]: { status: "partial", reason: "x" } },
      nodes: { a: { status: "completed", attempt: 1 }, b: { status: "completed", attempt: 1 } },
    };
    completeGraphTask(t, result);
    expect(t.outcome).toEqual({ status: "partial", reason: "x" });
    expect(t.value).toEqual({ r: 1 });
    expect((t.value as Record<string, unknown>)[GRAPH_OUTCOME_KEY]).toBeUndefined();
  });

  it("completeGraphTask leaves outcome undefined and returns outputs verbatim without a declared envelope", () => {
    const t = task();
    completeGraphTask(t, {
      status: "completed",
      outputs: { r: 1 },
      nodes: { a: { status: "completed", attempt: 1 }, b: { status: "completed", attempt: 1 } },
    });
    expect(t.outcome).toBeUndefined();
    expect(t.value).toEqual({ r: 1 });
  });

  it("completeGraphTask strips a malformed outcome envelope without failing the completed run", () => {
    const t = task();
    completeGraphTask(t, {
      status: "completed",
      outputs: { r: 1, [GRAPH_OUTCOME_KEY]: { status: "bogus" } },
      nodes: { a: { status: "completed", attempt: 1 }, b: { status: "completed", attempt: 1 } },
    });
    expect(t.status).toBe("completed");
    expect(t.outcome).toBeUndefined();
    expect(t.value).toEqual({ r: 1 });
    expect((t.value as Record<string, unknown>)[GRAPH_OUTCOME_KEY]).toBeUndefined();
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
    const identity = correlation("11111111-1111-4111-8111-111111111111");
    reporter.update("a", running(identity), identity);
    reporter.setResolved("a", { modelName: "haiku 4.5", modelId: "anthropic/claude-haiku-4-5" }, identity);
    const { agents } = collapse(t.graphRunProgress);
    const a = agents.find(e => e.label === "a");
    expect(a?.model).toBe("haiku 4.5");
    expect(a?.modelId).toBe("anthropic/claude-haiku-4-5");
  });

  it("setResolved merges recordId and model across calls without clobbering, in either order", () => {
    const t = task();
    const reporter = new GraphRunReporter(t, graph);
    const identity = correlation("22222222-2222-4222-8222-222222222222");
    reporter.update("a", running(identity), identity);
    reporter.setResolved("a", { recordId: "r1" }, identity);
    reporter.setResolved("a", { modelName: "haiku 4.5", modelId: "anthropic/claude-haiku-4-5" }, identity);
    const a = collapse(t.graphRunProgress).agents.find(e => e.label === "a");
    expect(a?.recordId).toBe("r1");
    expect(a?.model).toBe("haiku 4.5");
    expect(a?.modelId).toBe("anthropic/claude-haiku-4-5");

    // Reverse order clobbers nothing either.
    const t2 = task();
    const r2 = new GraphRunReporter(t2, graph);
    const secondIdentity = correlation("33333333-3333-4333-8333-333333333333");
    r2.update("a", running(secondIdentity), secondIdentity);
    r2.setResolved("a", { modelName: "sonnet", modelId: "mid" }, secondIdentity);
    r2.setResolved("a", { recordId: "r2" }, secondIdentity);
    const a2 = collapse(t2.graphRunProgress).agents.find(e => e.label === "a");
    expect(a2?.recordId).toBe("r2");
    expect(a2?.model).toBe("sonnet");
    expect(a2?.modelId).toBe("mid");
  });

  it("runtime filters late pre-retry resolution before reporter delivery", async () => {
    const t = task();
    const activity = new Map([["old", { toolCalls: 1, tokens: 10 }], ["current", { toolCalls: 9, tokens: 90 }]]);
    const reporter = new GraphRunReporter(t, graph, 1_000, recordId => activity.get(recordId));
    let control: import("../src/graph/run-graph.js").GraphControl | undefined;
    let stale: ((info: { recordId?: string; modelName?: string }) => void) | undefined;
    let releaseFirst: ((result: NodeSpawnResult) => void) | undefined;
    let starts = 0;
    const run = runGraph({ nodes: { a: graph.nodes.a }, edges: [] }, {}, {
      host: {
        spawnAgent: request => {
          starts++;
          if (starts === 1) {
            stale = request.onResolved;
            return new Promise<NodeSpawnResult>(resolve => { releaseFirst = resolve; });
          }
          request.onResolved?.({ recordId: "current", modelName: "current-model" });
          return Promise.resolve({ ok: true, output: "current" });
        },
      },
      onControl: value => { control = value; },
      onNodeUpdate: (id, node, identity) => reporter.update(id, node, identity),
      onNodeResolved: (id, info, identity) => reporter.setResolved(id, info, identity),
    });
    await vi.waitFor(() => expect(control).toBeDefined());
    expect(control?.retry(0)).toBe(true);
    const release = releaseFirst;
    if (!release) throw new Error("Initial execution did not start");
    release({ ok: true, output: "old" });
    await vi.waitFor(() => expect(starts).toBe(2));
    const late = stale;
    if (!late) throw new Error("Initial resolution callback was not captured");
    late({ recordId: "old", modelName: "old-model" });
    expect((await run).status).toBe("completed");
    expect(collapse(t.graphRunProgress).agents.find(entry => entry.label === "a")).toMatchObject({
      attempt: 2, recordId: "current", model: "current-model", toolCalls: 9, tokens: 90,
    });
  });

  it("keeps only the current full execution correlation in the collapsed row", () => {
    const t = task();
    const activity = new Map([["old", { toolCalls: 1, tokens: 10 }], ["current", { toolCalls: 9, tokens: 90 }]]);
    const reporter = new GraphRunReporter(t, graph, 1_000, recordId => activity.get(recordId));
    const current = correlation("44444444-4444-4444-8444-444444444444");
    reporter.update("a", { ...running(current, 2), attemptReason: "user-retry" }, current, 1_000);
    reporter.setResolved("a", { recordId: "old", modelName: "old-model" }, current, 2_000);
    for (const stale of [
      correlation("55555555-5555-4555-8555-555555555555", { runId: "other-run" }),
      correlation("66666666-6666-4666-8666-666666666666", { instanceId: "77777777-7777-4777-8777-777777777777" as NodeInstanceId }),
      correlation("88888888-8888-4888-8888-888888888888", { activation: 2 }),
      correlation("99999999-9999-4999-8999-999999999999", { graphAttempt: 2 }),
      correlation("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
    ]) reporter.setResolved("a", { recordId: "current", modelName: "current-model" }, stale, 3_000);
    expect(collapse(t.graphRunProgress).agents.find(entry => entry.label === "a")).toMatchObject({
      attempt: 2, recordId: "old", model: "old-model", toolCalls: 1, tokens: 10, lastProgressAt: 2_000,
    });
    const replacement = correlation("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    reporter.update("a", { ...running(replacement, 2), attemptReason: "user-retry" }, replacement, 4_000);
    reporter.setResolved("a", { recordId: "current" }, replacement, 5_000);
    expect(collapse(t.graphRunProgress).agents.find(entry => entry.label === "a")).toMatchObject({
      attempt: 2, recordId: "current", toolCalls: 9, tokens: 90, lastProgressAt: 5_000,
    });
    expect(collapse(t.graphRunProgress).agents.find(entry => entry.label === "a")?.model).toBeUndefined();
  });

  it("plumbs live tool-call and token counts from getActivity, re-emitting only on change", () => {
    const t = task();
    let activity: { toolCalls?: number; tokens?: number } | undefined = { toolCalls: 2, tokens: 100 };
    const reporter = new GraphRunReporter(t, graph, Date.now(), () => activity);
    const identity = correlation("cccccccc-cccc-4ccc-8ccc-cccccccccccc");
    reporter.update("a", running(identity), identity);
    reporter.setResolved("a", { recordId: "r1" }, identity);

    const first = collapse(t.graphRunProgress).agents.find(e => e.label === "a");
    expect(first?.toolCalls).toBe(2);
    expect(first?.tokens).toBe(100);

    // A refresh after the counts climb re-emits the running node's entry with the new counts.
    const beforeChange = t.graphRunProgress.length;
    activity = { toolCalls: 5, tokens: 250 };
    reporter.refresh();
    expect(t.graphRunProgress.length).toBeGreaterThan(beforeChange);
    const updated = collapse(t.graphRunProgress).agents.find(e => e.label === "a");
    expect(updated?.toolCalls).toBe(5);
    expect(updated?.tokens).toBe(250);

    // A refresh with unchanged counts appends nothing.
    const afterChange = t.graphRunProgress.length;
    reporter.refresh();
    expect(t.graphRunProgress.length).toBe(afterChange);
  });

  it("pins startedAt across re-emits within an attempt and resets it on a new attempt", () => {
    const t = task();
    let activity: { toolCalls?: number; tokens?: number } | undefined = { toolCalls: 1 };
    const reporter = new GraphRunReporter(t, graph, 1_000, () => activity);

    // First running emit stamps startedAt; re-emits from setResolved/refresh must not restamp it.
    const identity = correlation("dddddddd-dddd-4ddd-8ddd-dddddddddddd");
    reporter.update("a", running(identity), identity, 1_000);
    reporter.setResolved("a", { recordId: "r1" }, identity, 5_000);
    activity = { toolCalls: 9 };
    reporter.refresh(9_000);
    expect(collapse(t.graphRunProgress).agents.find(e => e.label === "a")?.startedAt).toBe(1_000);

    // A new attempt (retry / loop re-entry) resets startedAt to the new start.
    reporter.update("a", { status: "running", attempt: 2 }, 20_000);
    expect(collapse(t.graphRunProgress).agents.find(e => e.label === "a")?.startedAt).toBe(20_000);

    // A terminal emit anchors to the current attempt's start, not `now`.
    reporter.update("a", { status: "completed", attempt: 2, output: "x" }, 25_000);
    expect(collapse(t.graphRunProgress).agents.find(e => e.label === "a")?.startedAt).toBe(20_000);
  });

  it("registers dynamic nodes with stable metadata before their updates", () => {
    const t = task();
    const reporter = new GraphRunReporter(t, graph, 1_000);
    reporter.update("a", { status: "completed", attempt: 1, output: "done" }, 2_000);

    reporter.registerNode(
      "round-1:item:0",
      { type: "agent", agent: "chengfeng", prompt: "research item" },
      { dependencies: ["a"], phase: { index: 0, title: "Round 1/2" } },
    );
    const identity = correlation("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee");
    reporter.update("round-1:item:0", { ...running(identity, 2), attemptReason: "loop" }, identity, 3_000);
    reporter.setResolved("round-1:item:0", { recordId: "record-1", modelId: "provider/model" }, identity, 4_000);

    const first = collapse(t.graphRunProgress);
    const child = first.agents.find(entry => entry.label === "round-1:item:0");
    expect(child).toMatchObject({
      index: 2, agentType: "chengfeng", promptPreview: "research item",
      deps: ["a"], phaseIndex: 0, phaseTitle: "Round 1/2",
      attempt: 2, lastAttemptReason: "loop", recordId: "record-1", modelId: "provider/model",
    });
    expect(first.agents.find(entry => entry.label === "a")?.dependents).toContain("round-1:item:0");
    expect(t.agentCount).toBe(3);

    reporter.registerNode(
      "round-1:item:0",
      { type: "agent", agent: "chengfeng", prompt: "ignored" },
      { dependencies: [], phase: { index: 9, title: "Ignored" } },
    );
    reporter.registerNode(
      "round-2:item:0",
      { type: "agent", agent: "wenchang", prompt: "follow up" },
      { dependencies: ["round-1:item:0"], phase: { index: 1, title: "Round 2/2" } },
    );
    reporter.update("round-2:item:0", { status: "pending", attempt: 0 });
    const second = collapse(t.graphRunProgress).agents.find(entry => entry.label === "round-2:item:0");
    expect(second).toMatchObject({ index: 3, phaseIndex: 1, phaseTitle: "Round 2/2" });
    expect(t.agentCount).toBe(4);
  });

  it("enriches pre-seeded restored fanout children without changing their indices", () => {
    const restored: AgentGraph = {
      nodes: {
        research: {
          type: "fanout", items: { path: "$.items" }, itemSchema: {},
          dispatch: { path: "$.kind", cases: { code: "chengfeng" } },
          prompt: `research \${item}`, phase: { index: 0, title: "Round 1/2" },
        },
        "research:item:0": { type: "agent", agent: "chengfeng", prompt: "research item" },
      },
      edges: [],
    };
    const t = task();
    const reporter = new GraphRunReporter(t, restored, 1_000);
    reporter.update("research", { status: "running", attempt: 1 }, 1_500);
    reporter.update("research:item:0", { status: "pending", attempt: 0 }, 2_000);
    expect(collapse(t.graphRunProgress).agents.find(entry => entry.label === "research:item:0")).toMatchObject({
      index: 1, deps: [], phaseIndex: 0, phaseTitle: "Stage 1",
    });

    reporter.registerNode(
      "research:item:0",
      restored.nodes["research:item:0"],
      { dependencies: [], phase: { index: 0, title: "Round 1/2" } },
    );
    const child = collapse(t.graphRunProgress).agents.find(entry => entry.label === "research:item:0");
    expect(child).toMatchObject({ index: 1, deps: [], phaseIndex: 0, phaseTitle: "Round 1/2" });
    expect(collapse(t.graphRunProgress).agents.find(entry => entry.label === "research")?.dependents).toEqual([]);
    expect(t.agentCount).toBe(2);

    reporter.registerNode(
      "research:item:0",
      restored.nodes["research:item:0"],
      { dependencies: [], phase: { index: 9, title: "Ignored" } },
    );
    expect(collapse(t.graphRunProgress).agents.find(entry => entry.label === "research:item:0")).toMatchObject({
      index: 1, deps: [], phaseIndex: 0, phaseTitle: "Round 1/2",
    });
  });

  it("recomputes legacy dynamic stages when dependencies register in reverse order", () => {
    const t = task();
    const reporter = new GraphRunReporter(t, graph, 1_000);
    reporter.registerNode(
      "late-child",
      { type: "agent", agent: "chengfeng", prompt: "child" },
      { dependencies: ["late-parent"] },
    );
    reporter.update("late-child", { status: "pending", attempt: 0 }, 2_000);
    expect(collapse(t.graphRunProgress).agents.find(entry => entry.label === "late-child")).toMatchObject({
      index: 2, phaseIndex: 0, phaseTitle: "Stage 1",
    });
    const childEmits = t.graphRunProgress.filter(entry => entry.type === "graph_run_agent" && entry.label === "late-child").length;

    reporter.registerNode(
      "late-parent",
      { type: "agent", agent: "wenchang", prompt: "parent" },
      { dependencies: ["b"] },
    );
    reporter.update("late-parent", { status: "pending", attempt: 0 }, 3_000);

    const agents = collapse(t.graphRunProgress).agents;
    expect(agents.find(entry => entry.label === "late-parent")).toMatchObject({
      index: 3, phaseIndex: 2, phaseTitle: "Stage 3",
    });
    expect(agents.find(entry => entry.label === "late-child")).toMatchObject({
      index: 2, phaseIndex: 3, phaseTitle: "Stage 4",
    });
    expect(t.graphRunProgress.filter(entry => entry.type === "graph_run_agent" && entry.label === "late-child")).toHaveLength(childEmits + 1);
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
      onNodeUpdate: (id, node, identity) => reporter.update(id, { ...node } satisfies NodeRun, identity, 1_700_000_000_000),
    });
    await vi.waitFor(() => expect(roots.size).toBe(4));
    roots.get("research")?.({ ok: true, output: "research complete" });
    await vi.waitFor(() => {
      expect(collapse(t.graphRunProgress).agents.find(agent => agent.label === "research")?.state).toBe("done");
    });

    const { agents } = collapse(t.graphRunProgress);
    expect(agents).toHaveLength(5);
    expect(agents.find(agent => agent.label === "synthesize")?.phaseIndex).toBe(1);
    const { renderObservabilityPaneLines, toPaneSource } = await import("../src/graph/pane/render.js");
    const rendered = renderObservabilityPaneLines(
      [{ id: t.id, name: "demo", status: t.status, source: toPaneSource(t) }],
      initialPanelState(),
      { width: 100, rows: 40, now: 1_700_000_000_000 },
    ).join("\n");
    expect(rendered).toContain("1/5 nodes");
    expect(rendered).toContain("5 agents");
    expect(rendered).toContain("synthesize");

    controller.abort();
    await releaseAfterPending(run, () => { for (const finish of roots.values()) finish({ ok: true }); });
    await expect(run).resolves.toMatchObject({ status: "aborted" });
  });
});

it("v2 publishes only materialized rows with name-first labels and persisted ordering", async () => {
  const { GraphInstances } = await import("../src/graph/graph-instance-id.js");
  const identities = new GraphInstances("run");
  const first = identities.add("first", { nodeKey: "research", iteration: 1 });
  const second = identities.add("second", { nodeKey: "research", parentInstanceId: first.instanceId, iteration: 1, itemIndex: 0 });
  const t = task();
  const reporter = new GraphRunReporter(t, { ...graph, version: 2 });
  expect(t.agentCount).toBe(0);
  reporter.registerNode("second", { type: "agent", agent: "worker", name: "Research", prompt: "x" }, { dependencies: ["first"], instance: second });
  reporter.update("second", { status: "running", attempt: 1 });
  reporter.registerNode("first", { type: "fanout", name: "Research", items: { path: "$" }, itemSchema: {}, dispatch: { path: "$.x", cases: { x: "worker" } }, prompt: `\${item}` }, { dependencies: [], instance: first });
  reporter.update("first", { status: "running", attempt: 1 });
  const rows = collapse(t.graphRunProgress).agents;
  expect(rows.map(row => row.index)).toEqual([0, 1]);
  expect(rows.map(row => row.phaseIndex)).toEqual([0, 0]);
  expect(rows.map(row => row.label)).toEqual(["Research · iteration 1", "Research · iteration 1 · item 1"]);
  expect(rows[1]).toMatchObject({ nodeKey: "research", instanceId: second.instanceId, materializationOrdinal: 1 });
  expect(rows.some(row => row.label.includes("iteration 2"))).toBe(false);
});

it("keeps duplicate v2 labels navigable and identity details width-safe", async () => {
  const { GraphInstances } = await import("../src/graph/graph-instance-id.js");
  const { renderObservabilityPaneLines, toPaneSource } = await import("../src/graph/pane/render.js");
  const { visibleWidth } = await import("@earendil-works/pi-tui");
  const t = task();
  const reporter = new GraphRunReporter(t, { version: 2, nodes: {}, edges: [] });
  const identities = new GraphInstances("run");
  const left = identities.add("left", { nodeKey: "left" });
  const right = identities.add("right", { nodeKey: "right" });
  for (const instance of [left, right]) reporter.registerNode(instance.binding, { type: "agent", agent: "worker", name: "Same 漢字", prompt: "x" }, { dependencies: [], instance });
  reporter.update("left", { status: "completed", attempt: 1, output: "left outcome" });
  reporter.update("right", { status: "failed", attempt: 1, error: "right error" });
  const runs = [{ id: t.id, name: "demo", status: t.status, source: toPaneSource(t) }];
  const state = { ...initialPanelState(), cursor: { kind: "node", id: "right" } as const, expandedSections: ["identity"] };
  const wide = renderObservabilityPaneLines(runs, state, { width: 120, rows: 60 }).join("\n");
  expect(wide).toContain("right error");
  expect(wide).toContain(right.instanceId);
  expect(wide).not.toContain(left.instanceId);
  for (const width of [0, 1, 2, 8, 20, 40, 80, 120]) {
    for (const line of renderObservabilityPaneLines(runs, state, { width, rows: 60 })) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
  }
});

it("retains typed v2 terminal metadata in the workflow result on materialization failure", () => {
  const t = task();
  const feedback = { reason: "materialization failure", partial: true, iterations: [], gaps: [], counters: { iterations: 0, totalItems: 0 }, exhaustedBounds: ["node limit"] } as const;
  completeGraphTask(t, { status: "failed", nodes: {}, outputs: {}, feedback: { research: feedback } });
  expect(t.value).toEqual({ outputs: {}, feedback: { research: feedback } });
});

it("validates provenance fields at the notification boundary", async () => {
  const { isGraphRunEntryData } = await import("../src/graph/entry-validation.js");
  const entry = { name: "demo", status: "running", startTime: 0, agentCount: 1, totalTokens: 0, progress: [{ type: "graph_run_agent", index: 0, label: "Same", state: "progress", nodeBinding: 42 }] };
  expect(isGraphRunEntryData(entry)).toBe(false);
});

describe("outcomeLabel", () => {
  it("defaults an undeclared outcome to Completed", () => {
    expect(outcomeLabel(undefined)).toBe("Completed");
  });

  it("labels declared outcomes explicitly", () => {
    expect(outcomeLabel({ status: "succeeded" })).toBe("Outcome succeeded");
    expect(outcomeLabel({ status: "partial", reason: "x" })).toBe("Outcome partial: x");
    expect(outcomeLabel({ status: "failed", reason: "y" })).toBe("Outcome failed: y");
  });
});

it("projects committed feedback ownership and decisions through real dynamic materialization", async () => {
  const dynamic: AgentGraph = { version: 2, nodes: { research: {
    type: "bounded_feedback", name: "Names are not structure", maxIterations: 2, maxItemsPerIteration: 1, maxTotalItems: 2,
    work: { type: "fanout", name: "Work", items: { path: "$.tasks" }, itemSchema: { type: "object", properties: { kind: { type: "string" }, query: { type: "string" } }, required: ["kind", "query"], additionalProperties: false }, dispatch: { path: "$.kind", cases: { local: "worker" } }, prompt: "${item}", outputSchema: { type: "object" } },
    evaluator: { type: "agent", name: "Judge", agent: "judge", prompt: "${feedback}" },
  } }, edges: [] };
  const t = task(); const reporter = new GraphRunReporter(t, dynamic);
  const input = { tasks: [{ kind: "local", query: "first" }] };
  let evaluations = 0; let work = 0;
  const result = await runGraph(dynamic, input, {
    onCheckpoint: state => { expect(JSON.stringify(state)).not.toContain('"presentation"'); },
    onNodeAdded: (id, node, metadata) => reporter.registerNode(id, node, metadata),
    onNodeUpdate: (id, run, correlation, presentation) => reporter.update(id, run, correlation, undefined, presentation),
    host: { spawnAgent: async request => ({ ok: true, output: JSON.stringify(request.agentType !== "judge" ? { evidence: ++work } : ++evaluations === 1
      ? { decision: "continue", gaps: [{ id: "gap", description: "missing" }], tasks: [{ gapId: "gap", item: { kind: "local", query: "second" } }] }
      : { decision: "sufficient", gaps: [], tasks: [] }) }) },
  });
  expect(result.status).toBe("completed"); expect(work).toBe(2); expect(evaluations).toBe(2);
  const rows = collapse(t.graphRunProgress).agents;
  expect(rows).toHaveLength(7);
  const owner = rows.find(row => row.presentation?.kind === "bounded_feedback");
  expect(owner?.presentation?.iterations).toEqual([{ iteration: 1, decision: "continue" }, { iteration: 2, decision: "sufficient" }]);
  for (const iteration of [1, 2]) {
    const fanout = rows.find(row => row.presentation?.kind === "fanout" && row.presentation.iteration === iteration);
    const evaluator = rows.find(row => row.presentation?.role === "evaluator" && row.presentation.iteration === iteration);
    const item = rows.find(row => row.presentation?.role === "item" && row.presentation.iteration === iteration);
    expect(fanout?.presentation).toMatchObject({ role: "work", parentInstanceId: owner?.instanceId });
    expect(evaluator?.presentation?.parentInstanceId).toBe(owner?.instanceId);
    expect(item?.presentation).toMatchObject({ itemIndex: 0, parentInstanceId: fanout?.instanceId });
  }
  expect(JSON.parse(JSON.stringify(rows))).toEqual(rows);
  const { renderObservabilityPaneLines, toPaneSource } = await import("../src/graph/pane/render.js");
  const output = renderObservabilityPaneLines([{ id: t.id, name: "dynamic", status: "completed", source: toPaneSource(t) }], initialPanelState(), { width: 120 }).join("\n");
  expect(output).toContain("4 agents · 3 coordination nodes · 2 iterations");
  expect(output).toContain("continue"); expect(output).toContain("sufficient");
});
