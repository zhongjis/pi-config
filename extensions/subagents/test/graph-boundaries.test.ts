import { describe, expect, it } from "vitest";
import { isWorkflowEntryData } from "../src/graph/entry-validation.js";
import type { AgentGraph, FanoutNode, GraphFragment } from "../src/graph/ir.js";
import { runGraph } from "../src/graph/run-graph.js";
import { Scheduler, type SchedulerState } from "../src/graph/scheduler.js";
import { validateFragment } from "../src/graph/validate.js";

const agent = { type: "agent", agent: "worker", prompt: "fixture" } as const;
const fanout: FanoutNode = {
  type: "fanout", items: { path: "$.tasks" }, itemSchema: { type: "object" },
  dispatch: { path: "$.source", cases: { project: "worker" } }, prompt: `\${item}`,
};

describe("placed expansion boundary", () => {
  it.each([false, true])("validates effective IDs atomically (collision=%s)", async collision => {
    const fragment: GraphFragment = { nodes: { a: agent, b: agent }, edges: [{ from: "a", to: "b" }] };
    const graph: AgentGraph = {
      nodes: { exp: { type: "expand", source: { path: "$" }, namespace: "ns" }, [collision ? "ns:a" : "a"]: agent },
      edges: [],
    };
    const added: string[] = [];
    const result = await runGraph(graph, fragment, {
      host: { spawnAgent: async () => ({ ok: true, output: "original" }) },
      onNodeAdded: id => added.push(id),
    });
    expect(result.status).toBe(collision ? "failed" : "completed");
    expect(added).toEqual(collision ? [] : ["ns:a", "ns:b"]);
    expect(result.nodes[collision ? "ns:a" : "a"].output).toBe("original");
    if (collision) expect(result.nodes.exp.error).toContain("collid");
  });

  it("rejects fanout selectors in runtime fragments", () => {
    const result = validateFragment({ nodes: { hidden: fanout }, edges: [] }, []);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/fanout.*preflight/i);
  });
});

function restored() {
  const graph: AgentGraph = { nodes: { research: fanout, "research:item:0": agent, "research:item:1": agent }, edges: [] };
  const state: SchedulerState = {
    nodes: { research: { status: "running", attempt: 1 }, "research:item:0": { status: "completed", attempt: 1 }, "research:item:1": { status: "running", attempt: 1 } },
    loopCounts: {}, collections: { research: [{ nodeId: "research:item:0", item: {} }, { nodeId: "research:item:1", item: {} }] },
  };
  return { graph, state };
}

describe("collection hydration boundary", () => {
  const corruptions: [string, (fixture: ReturnType<typeof restored>) => void][] = [
    ["missing parent state", ({ state }) => { delete state.nodes.research; }],
    ["missing parent definition", ({ graph }) => { delete graph.nodes.research; }],
    ["wrong parent definition", ({ graph }) => { graph.nodes.research = agent; }],
    ["missing child state", ({ state }) => { delete state.nodes["research:item:0"]; }],
    ["missing child definition", ({ graph }) => { delete graph.nodes["research:item:0"]; }],
    ["wrong child definition", ({ graph }) => { graph.nodes["research:item:0"] = fanout; }],
    ["duplicate child", ({ state }) => { state.collections = { research: [{ nodeId: "research:item:0", item: {} }, { nodeId: "research:item:0", item: {} }] }; }],
    ["out of order", ({ state }) => { state.collections = { research: [{ nodeId: "research:item:1", item: {} }, { nodeId: "research:item:0", item: {} }] }; }],
    ["duplicate ownership", ({ graph, state }) => {
      graph.nodes.other = fanout;
      state.nodes.other = { status: "running", attempt: 1 };
      state.collections = { ...state.collections, other: [{ nodeId: "research:item:0", item: {} }] };
    }],
  ];
  it.each(corruptions)("rejects %s before mutating scheduler state", (_name, corrupt) => {
    const fixture = restored();
    corrupt(fixture);
    const scheduler = new Scheduler(fixture.graph, {});
    const before = scheduler.snapshotState();
    expect(() => scheduler.hydrate(fixture.state)).toThrow(/collection/i);
    expect(scheduler.snapshotState()).toEqual(before);
  });

  it("rejects malformed collections through runGraph before callbacks or spawns", async () => {
    const { graph, state } = restored();
    delete state.nodes["research:item:0"];
    const events: string[] = [];
    await expect(runGraph(graph, {}, {
      restore: state,
      host: { spawnAgent: async () => { events.push("spawn"); return { ok: true }; } },
      onNodeUpdate: id => events.push(id),
    })).rejects.toThrow(/collection/i);
    expect(events).toEqual([]);
  });
});

describe("entry dependency boundary", () => {
  it.each(["deps", "dependents"])("validates optional %s as string arrays", field => {
    const entry = (value: unknown) => ({
      name: "fixture", status: "completed", startTime: 0, agentCount: 1, totalTokens: 0,
      progress: [{ type: "workflow_agent", index: 0, label: "a", state: "done", [field]: value }],
    });
    for (const valid of [undefined, [], ["a", "b"]]) expect(isWorkflowEntryData(entry(valid))).toBe(true);
    for (const invalid of [null, "a", 1, {}, [1], ["a", null]]) expect(isWorkflowEntryData(entry(invalid))).toBe(false);
  });
});
