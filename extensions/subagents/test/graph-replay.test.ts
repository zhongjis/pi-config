import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentGraph } from "../src/graph/ir.js";
import type { NodeSpawnResult } from "../src/graph/node-host.js";
import { type ParsedTrace, parseTrace, replayTrace } from "../src/graph/replay.js";
import { runGraph } from "../src/graph/run-graph.js";
import { openGraphTrace, schemaHash } from "../src/graph/trace.js";
import { instanceBindings } from "./graph-bindings.fixture.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** Record a real run through the same trace wiring graph-runtime uses. */
async function record(graph: AgentGraph, script: (id: string, count: number) => NodeSpawnResult, input: unknown = {}): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "graph-replay-")); dirs.push(dir);
  const path = join(dir, "run.trace.jsonl");
  const trace = openGraphTrace({ create: () => path, runId: "agr_abc123", graph, input, warn: vi.fn() });
  const counts = new Map<string, number>();
  const bindings = instanceBindings();
  const result = await runGraph(graph, input, {
    host: { spawnAgent: async request => { const id = bindings.binding(request.nodeId); const count = (counts.get(id) ?? 0) + 1; counts.set(id, count); return script(id, count); } },
    onNodeAdded: (id, node, metadata) => { bindings.onNodeAdded(id, node, metadata); trace.added(id, node); }, onNodeUpdate: (id, run) => trace.update(id, run),
  });
  trace.end(result);
  return readFileSync(path, "utf8");
}
function parsed(text: string): ParsedTrace {
  const trace = parseTrace(text);
  if ("error" in trace) throw new Error(trace.error);
  return trace;
}
const ok = (output: unknown): NodeSpawnResult => ({ ok: true, output: typeof output === "string" ? output : JSON.stringify(output) });
const flag = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };
const branch: AgentGraph = {
  nodes: { a: { type: "agent", agent: "x", prompt: "a", outputSchema: flag }, b: { type: "agent", agent: "x", prompt: "b" }, c: { type: "agent", agent: "x", prompt: "c" } },
  edges: [{ from: "a", to: "b", when: { eq: [{ node: "a", path: "$.ok" }, true] } }, { from: "a", to: "c", when: { eq: [{ node: "a", path: "$.ok" }, false] } }],
  outputs: { r: { node: "b", path: "$" }, $agentGraphOutcome: { node: "a", path: "$.outcome" } },
};
const branchScript = (id: string) => id === "a" ? ok({ ok: true, outcome: { status: "succeeded" } }) : ok(`${id}-out`);
const review: AgentGraph = {
  nodes: {
    implement: { type: "agent", agent: "x", prompt: "implement" },
    review: { type: "agent", agent: "x", prompt: "review", outputSchema: { type: "object", properties: { approved: { type: "boolean" } }, required: ["approved"] } },
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
const status = (report: ReturnType<typeof replayTrace>) => Object.fromEntries(report.nodes.map(node => [node.id, [node.baseline, node.candidate]]));

describe("graph trace replay", () => {
  it("replays the identical graph with no differences and a consistent baseline", async () => {
    const trace = parsed(await record(branch, branchScript));
    const report = replayTrace(trace, branch);
    expect(report.selfConsistency).toEqual({ ok: true, mismatches: [] });
    expect(report.nodes.every(node => node.baseline === node.candidate)).toBe(true);
    expect(status(report)).toEqual({ a: ["completed", "completed"], b: ["completed", "completed"], c: ["skipped", "skipped"] });
    expect(report.edges).toEqual([
      { from: "a", to: "b", baselineActive: true, candidateActive: true },
      { from: "a", to: "c", baselineActive: false, candidateActive: false },
    ]);
    expect(report.outputs.candidate).toEqual({ r: "b-out", $agentGraphOutcome: { status: "succeeded" } });
    expect(report.outcome).toEqual({ baseline: { status: "succeeded" }, candidate: { status: "succeeded" } });
    expect(report.needsLiveRun).toEqual([]);
    expect(report.truncated).toBe(false);
    expect(report.ended).toBe(true);
  });

  it("diffs edges and statuses when a candidate changes an edge condition", async () => {
    const trace = parsed(await record(branch, branchScript));
    const candidate: AgentGraph = { ...branch, edges: [
      { from: "a", to: "b", when: { eq: [{ node: "a", path: "$.ok" }, false] } },
      { from: "a", to: "c", when: { eq: [{ node: "a", path: "$.ok" }, true] } },
    ] };
    const report = replayTrace(trace, candidate);
    expect(status(report)).toEqual({ a: ["completed", "completed"], b: ["completed", "skipped"], c: ["skipped", "needs-live-run"] });
    expect(report.edges).toEqual([
      { from: "a", to: "b", baselineActive: true, candidateActive: false },
      { from: "a", to: "c", baselineActive: false, candidateActive: true },
    ]);
    expect(report.needsLiveRun).toEqual(["c"]);
    expect(report.outputs.candidate).toEqual({ $agentGraphOutcome: { status: "succeeded" } });
  });

  it("requires a live run for a changed output schema and blocks its descendants", async () => {
    const trace = parsed(await record(branch, branchScript));
    const candidate: AgentGraph = { ...branch, nodes: { ...branch.nodes, a: { type: "agent", agent: "x", prompt: "a", outputSchema: { ...flag, required: ["ok", "why"] } } } };
    const report = replayTrace(trace, candidate);
    expect(status(report)).toEqual({ a: ["completed", "needs-live-run"], b: ["completed", "blocked"], c: ["skipped", "blocked"] });
    expect(report.needsLiveRun).toEqual(["a"]);
    expect(trace.header.schemaHashes.a).toBe(schemaHash(branch.nodes.a));
  });

  it("replays loop re-entry by occurrence and reports loop counts", async () => {
    const trace = parsed(await record(review, (id, count) => id === "review" ? ok({ approved: count >= 3 }) : ok(`${id}-${count}`)));
    const same = replayTrace(trace, review);
    expect(same.selfConsistency.ok).toBe(true);
    expect(same.loopCounts).toEqual({ baseline: { "fix->review": 2 }, candidate: { "fix->review": 2 } });
    expect(same.outputs.candidate).toEqual({ approved: true });
    const bounded = replayTrace(trace, { ...review, edges: review.edges.map(edge => edge.loop ? { ...edge, loop: { maxIterations: 1 } } : edge) });
    expect(status(bounded)).toMatchObject({ review: ["completed", "completed"], fix: ["completed", "completed"], done: ["completed", "skipped"] });
    expect(bounded.loopCounts.candidate).toEqual({ "fix->review": 1 });
    expect(bounded.outputs.candidate).toEqual({ approved: false });
    expect(bounded.edges.find(edge => edge.to === "done")).toMatchObject({ baselineActive: true, candidateActive: false });
  });

  it("replays fanout and bounded_feedback atomically from recorded top-level outputs", () => {
    const work = { type: "fanout", items: { path: "$.items" }, itemSchema: { type: "string" }, dispatch: { path: "$", cases: { x: "x" } }, prompt: "p" } as const;
    const graph: AgentGraph = {
      nodes: {
        f: work,
        loop: { type: "bounded_feedback", work, evaluator: { type: "agent", agent: "x", prompt: "e" }, maxIterations: 2, maxItemsPerIteration: 2, maxTotalItems: 4 },
        next: { type: "agent", agent: "x", prompt: "n" },
      },
      edges: [{ from: "f", to: "loop" }, { from: "loop", to: "next", when: { eq: [{ node: "loop", path: "$.status" }, "converged"] } }],
      outputs: { results: { node: "f", path: "$.results" } },
    };
    const results = [{ nodeId: "f:item:0", index: 0, item: "x", status: "completed", attempt: 1, output: "r" }];
    const rows = [
      { type: "header", version: 1, runId: "agr_abc123", startedAt: 1, graph, input: { items: ["x"] }, schemaHashes: Object.fromEntries(Object.entries(graph.nodes).map(([id, node]) => [id, schemaHash(node)])) },
      { type: "node", seq: 2, at: 2, event: "update", nodeId: "f", status: "running", attempt: 1 },
      { type: "node", seq: 3, at: 3, event: "added", nodeId: "f:item:0", status: "pending", attempt: 0, node: { type: "agent", agent: "x", prompt: "p" } },
      { type: "node", seq: 4, at: 4, event: "update", nodeId: "f:item:0", status: "running", attempt: 1 },
      { type: "node", seq: 5, at: 5, event: "update", nodeId: "f:item:0", status: "completed", attempt: 1, output: "r" },
      { type: "node", seq: 6, at: 6, event: "update", nodeId: "f", status: "completed", attempt: 1, output: { results } },
      { type: "node", seq: 7, at: 7, event: "update", nodeId: "loop", status: "running", attempt: 1 },
      { type: "node", seq: 8, at: 8, event: "update", nodeId: "loop", status: "completed", attempt: 1, output: { status: "converged" } },
      { type: "node", seq: 9, at: 9, event: "update", nodeId: "next", status: "running", attempt: 1 },
      { type: "node", seq: 10, at: 10, event: "update", nodeId: "next", status: "completed", attempt: 1, output: "n" },
      { type: "end", at: 11, status: "completed" },
    ];
    const report = replayTrace(parsed(rows.map(row => JSON.stringify(row)).join("\n")), graph);
    expect(report.selfConsistency.ok).toBe(true);
    expect(status(report)).toEqual({ f: ["completed", "completed"], loop: ["completed", "completed"], next: ["completed", "completed"] });
    expect(report.outputs.candidate).toEqual({ results });
    expect(report.nodes.map(node => node.id)).not.toContain("f:item:0");
  });

  it("flags truncated traces and leaves unrecorded work to a live run", async () => {
    const text = await record(branch, branchScript);
    const lines = text.trim().split("\n");
    const cut = lines.findIndex(line => line.includes('"nodeId":"b"') && line.includes('"completed"'));
    const partial = parsed(`${lines.slice(0, cut).join("\n")}\n${lines[cut].slice(0, 20)}`);
    const report = replayTrace(partial, branch);
    expect(report.truncated).toBe(true);
    expect(report.ended).toBe(false);
    expect(status(report).b).toEqual(["needs-live-run", "needs-live-run"]);
    expect(report.selfConsistency.ok).toBe(true);
    const capped = parsed(`${lines.slice(0, cut).join("\n")}\n${JSON.stringify({ type: "truncated", at: 1 })}\n`);
    expect(replayTrace(capped, branch).truncated).toBe(true);
    expect(parseTrace("not json\n")).toEqual({ error: expect.stringMatching(/header/) });
  });
});
