import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentGraph } from "../src/graph/ir.js";
import { runGraph } from "../src/graph/run-graph.js";
import type { SchedulerState } from "../src/graph/scheduler.js";
import { canonicalJson, type GraphTrace, graphTracePath, openGraphTrace, schemaHash } from "../src/graph/trace.js";
import { instanceBindings } from "./graph-bindings.fixture.js";

const graph: AgentGraph = {
  nodes: {
    a: { type: "agent", agent: "x", prompt: "a", outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] } },
    b: { type: "agent", agent: "x", prompt: "b" },
  },
  edges: [{ from: "a", to: "b", when: { eq: [{ node: "a", path: "$.ok" }, true] } }],
  outputs: { r: { node: "b", path: "$" } },
};
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "graph-trace-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
const lines = (path: string) => readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);

/** Same wiring graph-runtime uses: node lines come only from post-commit publications. */
async function traced(trace: GraphTrace, onCheckpoint?: (state: SchedulerState) => void) {
  const { onNodeAdded, binding } = instanceBindings();
  const result = await runGraph(graph, { task: "t" }, {
    host: { spawnAgent: async request => ({ ok: true, output: binding(request.nodeId) === "a" ? '{"ok":true}' : "done" }) },
    onCheckpoint: state => onCheckpoint?.(state),
    onNodeAdded: (id, node, metadata) => { onNodeAdded(id, node, metadata); trace.added(id, node); },
    onNodeUpdate: (id, run) => trace.update(id, run),
  });
  trace.end(result);
  return result;
}

describe("graph trace artifact", () => {
  it("addresses the exact-session task area and rejects non-run IDs", () => {
    expect(graphTracePath("/work/repo", "sess", "agr_abc123")).toMatch(/pi-subagents-\d+\/work-repo\/sess\/tasks\/agr_abc123\.trace\.jsonl$/);
    expect(() => graphTracePath("/work/repo", "sess", "../agr_abc123")).toThrow(/Invalid graph run ID/);
    expect(canonicalJson({ b: 1, a: [{ d: 1, c: 2 }] })).toBe('{"a":[{"c":2,"d":1}],"b":1}');
  });

  it("writes header, committed node lines, and end; node status always matches the last commit", async () => {
    const path = join(dir, "run.trace.jsonl");
    const committed = new Map<string, string>();
    const observed: [string, string, string | undefined][] = [];
    const trace = openGraphTrace({ create: () => path, runId: "agr_abc123", graph, input: { task: "t" }, warn: vi.fn() });
    const probe: GraphTrace = { ...trace, update: (id, run) => { observed.push([id, run.status, committed.get(id)]); trace.update(id, run); } };
    await traced(probe, state => { for (const [id, run] of Object.entries(state.nodes)) committed.set(id, run.status); });
    for (const [, status, last] of observed) expect(status).toBe(last);
    const [header, ...rest] = lines(path);
    expect(header).toMatchObject({ type: "header", version: 1, runId: "agr_abc123", graph, input: { task: "t" },
      schemaHashes: { a: schemaHash(graph.nodes.a), b: schemaHash(graph.nodes.b) } });
    expect(typeof header.startedAt).toBe("number");
    const nodes = rest.filter(line => line.type === "node");
    expect(nodes.map(line => line.seq)).toEqual(nodes.map((_, index) => index + 2));
    expect(nodes.find(line => line.nodeId === "a" && line.status === "completed")).toMatchObject({ attempt: 1, output: { ok: true } });
    expect(nodes.filter(line => line.event === "added").map(line => line.nodeId).sort()).toEqual(["a", "b"]);
    expect(nodes.every(line => line.node === undefined)).toBe(true);
    expect(rest.at(-1)).toMatchObject({ type: "end", status: "completed" });
  });

  it("includes the definition for dynamically added nodes and the declared outcome at end", () => {
    const path = join(dir, "run.trace.jsonl");
    const trace = openGraphTrace({ create: () => path, runId: "agr_abc123", graph, input: {}, warn: vi.fn() });
    const dynamic = { type: "agent" as const, agent: "x", prompt: "dyn" };
    trace.added("e:item:0", dynamic);
    trace.update("e:item:0", { status: "pending", attempt: 0 });
    trace.end({ status: "completed", outputs: { $agentGraphOutcome: { status: "partial", reason: "gap" } }, nodes: {} });
    const [, added, end] = lines(path);
    expect(added).toMatchObject({ event: "added", nodeId: "e:item:0", status: "pending", node: dynamic });
    expect(end).toMatchObject({ type: "end", status: "completed", outcome: { status: "partial", reason: "gap" } });
  });

  it("caps the trace with one truncated line and then stops writing", () => {
    const path = join(dir, "run.trace.jsonl");
    const trace = openGraphTrace({ create: () => path, runId: "agr_abc123", graph, input: {}, warn: vi.fn(), maxBytes: 2_000 });
    for (let i = 0; i < 50; i++) trace.update("a", { status: "running", attempt: 1, output: "x".repeat(100) });
    trace.end({ status: "completed", outputs: {}, nodes: {} });
    const all = lines(path);
    expect(all.at(-1)).toMatchObject({ type: "truncated" });
    expect(all.filter(line => line.type === "truncated")).toHaveLength(1);
    expect(all.some(line => line.type === "end")).toBe(false);
    expect(readFileSync(path, "utf8").length).toBeLessThanOrEqual(2_000 + 100);
  });

  it("keeps execution unaffected by I/O failure and warns once", async () => {
    const blocker = join(dir, "file");
    writeFileSync(blocker, "");
    const warn = vi.fn();
    const trace = openGraphTrace({ create: () => join(blocker, "nested", "run.trace.jsonl"), runId: "agr_abc123", graph, input: {}, warn });
    const result = await traced(trace);
    expect(result.status).toBe("completed");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("appends a resume line and continues sequence numbers on checkpoint resume", () => {
    const path = join(dir, "run.trace.jsonl");
    const first = openGraphTrace({ create: () => path, runId: "agr_abc123", graph, input: {}, warn: vi.fn() });
    first.update("a", { status: "running", attempt: 1 });
    const resumed = openGraphTrace({ create: () => path, runId: "agr_abc123", graph, input: {}, warn: vi.fn(), resume: true });
    resumed.update("a", { status: "completed", attempt: 1, output: { ok: true } });
    const all = lines(path);
    expect(all.map(line => line.type)).toEqual(["header", "node", "resume", "node"]);
    expect(all[3]).toMatchObject({ seq: 4, event: "update" });
  });
});
