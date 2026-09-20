import { describe, expect, it } from "vitest";
import type { AgentGraph } from "../src/graph/ir.js";
import type { NodeHost, NodeSpawnResult } from "../src/graph/node-host.js";
import { coerceGraphInput, runGraph } from "../src/graph/run-graph.js";
import type { NodeRun } from "../src/graph/scheduler.js";

/** A host that scripts each spawn by node id + attempt. */
function host(script: (nodeId: string, attempt: number) => NodeSpawnResult): NodeHost {
  return { spawnAgent: async request => script(request.nodeId, request.attempt) };
}
const okText = (output: string): NodeSpawnResult => ({ ok: true, output });

const reviewGraph: AgentGraph = {
  nodes: {
    implement: { type: "agent", agent: "x", prompt: "implement" },
    review: {
      type: "agent",
      agent: "x",
      prompt: "review",
      outputSchema: { type: "object", properties: { approved: { type: "boolean" } }, required: ["approved"] },
    },
    fix: { type: "agent", agent: "x", prompt: "fix" },
    done: { type: "agent", agent: "x", prompt: "done" },
  },
  edges: [
    { from: "implement", to: "review" },
    { from: "review", to: "done", when: { eq: [{ node: "review", path: "$.approved" }, true] } },
    { from: "review", to: "fix", when: { eq: [{ node: "review", path: "$.approved" }, false] } },
    { from: "fix", to: "review", loop: { maxIterations: 3 } },
  ],
  outputs: { approved: { node: "review", path: "$.approved" } },
};

describe("runGraph — end to end via XState actors", () => {
  it("runs a linear graph and resolves outputs", async () => {
    const graph: AgentGraph = {
      nodes: { a: { type: "agent", agent: "x", prompt: "a" }, b: { type: "agent", agent: "x", prompt: "b" } },
      edges: [{ from: "a", to: "b" }],
      outputs: { r: { node: "b", path: "$" } },
    };
    const result = await runGraph(graph, {}, { host: host(() => okText("out")) });
    expect(result.status).toBe("completed");
    expect(result.nodes.a.status).toBe("completed");
    expect(result.nodes.b.status).toBe("completed");
    expect(result.outputs).toEqual({ r: "out" });
  });

  it("coerces a JSON-string graph input so input placeholders resolve", async () => {
    // A model often passes structured `input` to the tool as a JSON string; the
    // run must still substitute `${task}` from `$.task` rather than send it literally.
    const graph: AgentGraph = {
      nodes: { a: { type: "agent", agent: "x", prompt: `Do \${task}`, input: { task: { path: "$.task" } } } },
      edges: [],
      outputs: { r: { node: "a", path: "$" } },
    };
    const prompts: string[] = [];
    const recording: NodeHost = {
      spawnAgent: async request => {
        prompts.push(request.prompt);
        return okText("ok");
      },
    };
    const result = await runGraph(graph, '{"task":"HELLO"}', { host: recording });
    expect(result.status).toBe("completed");
    expect(prompts).toContain("Do HELLO");
  });

  it("normalizes JSON objects without changing scalar input", () => {
    expect(coerceGraphInput('{"task":"HELLO"}')).toEqual({ task: "HELLO" });
    expect(coerceGraphInput("HELLO")).toBe("HELLO");
  });

  it("drives a review->fix loop to approval through real actors", async () => {
    // Approve on the 3rd scheduler-level run of review (loop iterations), counted
    // here since request.attempt is the node-internal retry counter, not the loop.
    let reviews = 0;
    const result = await runGraph(reviewGraph, {}, {
      host: host(id => {
        if (id !== "review") return okText("ok");
        reviews++;
        return okText(JSON.stringify({ approved: reviews >= 3 }));
      }),
    });
    expect(result.status).toBe("completed");
    expect(result.nodes.review).toMatchObject({ attempt: 3, activation: 3, graphAttempt: 1 });
    expect(result.nodes.fix).toMatchObject({ attempt: 2, activation: 2, graphAttempt: 1 });
    expect(result.nodes.done.status).toBe("completed");
    expect(result.outputs).toEqual({ approved: true });
  });

  it("fails a node whose structured output violates its schema", async () => {
    const result = await runGraph(reviewGraph, {}, {
      host: host((id) => (id === "review" ? okText('{"approved":"yes"}') : okText("ok"))),
    });
    expect(result.status).toBe("failed");
    expect(result.nodes.review.status).toBe("failed");
    expect(result.nodes.done.status).toBe("skipped");
  });

  it("returns aborted when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runGraph(reviewGraph, {}, { host: host(() => okText("ok")), signal: controller.signal });
    expect(result.status).toBe("aborted");
  });

  it("fails a human_gate when the host cannot await human input", async () => {
    const graph: AgentGraph = {
      nodes: { g: { type: "human_gate", prompt: "approve?", outputSchema: { type: "object" } } },
      edges: [],
    };
    const result = await runGraph(graph, {}, { host: host(() => okText("x")) });
    expect(result.status).toBe("failed");
    expect(result.nodes.g.error).toContain("await human input");
  });

  it("reports node updates as the run progresses", async () => {
    const seen: string[] = [];
    await runGraph(reviewGraph, {}, {
      host: host((id, attempt) => (id === "review" ? okText(JSON.stringify({ approved: attempt >= 1 })) : okText("ok"))),
      onNodeUpdate: (id, run) => seen.push(`${id}:${run.status}`),
    });
    expect(seen).toContain("implement:running");
    expect(seen).toContain("done:completed");
  });
});

describe("runGraph — a throwing host is a soft failure, not a crash", () => {
  it("resolves with the node failed when spawnAgent rejects with a non-abort error", async () => {
    const graph: AgentGraph = {
      nodes: { a: { type: "agent", agent: "x", prompt: "a" } },
      edges: [],
      outputs: { r: { node: "a", path: "$" } },
    };
    const throwing: NodeHost = {
      spawnAgent: async () => {
        throw new Error("delegation_policy_denied: cannot delegate to x");
      },
    };
    // Must settle to a failed result rather than escaping as an uncaught actor error.
    const result = await runGraph(graph, {}, { host: throwing });
    expect(result.status).toBe("failed");
    expect(result.nodes.a.status).toBe("failed");
    expect(result.nodes.a.error).toContain("delegation_policy_denied");
  }, 4000);
});

type NodeUpdate = { id: string; run: NodeRun };

/** Copy callback values immediately: scheduler-owned NodeRun objects are live references. */
function snapshotNodeUpdate(id: string, run: Readonly<NodeRun>): NodeUpdate {
  return { id, run: { ...run } };
}

describe("runGraph — static progress reporting", () => {
  const graph: AgentGraph = {
    nodes: {
      first: { type: "agent", agent: "x", prompt: "first" },
      second: { type: "agent", agent: "x", prompt: "second" },
    },
    edges: [{ from: "first", to: "second" }],
  };

  it("reports the post-hydration static topology in declaration order before scheduling, even when aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const events: string[] = [];
    const updates: NodeUpdate[] = [];

    const result = await runGraph(graph, {}, {
      host: host(() => okText("unused")),
      signal: controller.signal,
      onControl: () => events.push("control"),
      onNodeUpdate: (id, run) => {
        updates.push(snapshotNodeUpdate(id, run));
        events.push(`${id}:${run.status}`);
      },
    });

    expect(result.status).toBe("aborted");
    expect(events).toEqual(["control", "first:pending", "second:pending"]);
    expect(updates).toEqual([
      { id: "first", run: { status: "pending", attempt: 0 } },
      { id: "second", run: { status: "pending", attempt: 0 } },
    ]);
  });

  it("reports restored statuses faithfully before scheduling", async () => {
    const updates: NodeUpdate[] = [];
    await runGraph(graph, {}, {
      host: host(() => okText("done")),
      restore: {
        nodes: {
          first: { status: "completed", attempt: 1, output: "saved" },
          second: { status: "running", attempt: 2 },
        },
        loopCounts: {},
      },
      onNodeUpdate: (id, run) => updates.push(snapshotNodeUpdate(id, run)),
    });

    expect(updates.slice(0, 2)).toEqual([
      { id: "first", run: { status: "completed", attempt: 1, output: "saved" } },
      { id: "second", run: { status: "pending", attempt: 2, output: undefined } },
    ]);
  });

  it("reports automatic conditional skips", async () => {
    const updates: NodeUpdate[] = [];
    const conditional: AgentGraph = {
      nodes: {
        root: { type: "agent", agent: "x", prompt: "root" },
        branch: { type: "agent", agent: "x", prompt: "branch" },
      },
      edges: [{ from: "root", to: "branch", when: { eq: [{ node: "root", path: "$" }, "yes"] } }],
    };

    await runGraph(conditional, {}, {
      host: host(() => okText("no")),
      onNodeUpdate: (id, run) => updates.push(snapshotNodeUpdate(id, run)),
    });

    expect(updates.filter(update => update.id === "branch").map(update => update.run.status)).toEqual([
      "pending",
      "skipped",
    ]);
  });

  it("reports every node force-skipped from a stuck cycle", async () => {
    const updates: NodeUpdate[] = [];
    const cycle: AgentGraph = {
      nodes: {
        left: { type: "agent", agent: "x", prompt: "left" },
        right: { type: "agent", agent: "x", prompt: "right" },
      },
      edges: [
        { from: "left", to: "right" },
        { from: "right", to: "left" },
      ],
    };

    await runGraph(cycle, {}, {
      host: host(() => okText("unused")),
      onNodeUpdate: (id, run) => updates.push(snapshotNodeUpdate(id, run)),
    });

    expect(updates.map(update => `${update.id}:${update.run.status}`)).toEqual([
      "left:pending",
      "right:pending",
      "left:skipped",
      "right:skipped",
    ]);
  });
});
