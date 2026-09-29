import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("xstate", async importOriginal => {
  const actual = await importOriginal<typeof import("xstate")>();
  return { ...actual, createActor: vi.fn(actual.createActor) };
});

import { createActor } from "xstate";
import type { AgentGraph } from "../src/graph/ir.js";
import type { NodeHost } from "../src/graph/node-host.js";
import { runGraph } from "../src/graph/run-graph.js";
import { graphRuntimeLogPath, openGraphRuntimeLog } from "../src/graph/trace.js";

const host: NodeHost = { spawnAgent: async request => ({ ok: true, output: `${request.nodeId}-SECRET-OUTPUT` }) };
const inner: AgentGraph = { nodes: { inner: { type: "agent", agent: "x", prompt: "inner" } }, edges: [], outputs: { r: { node: "inner", path: "$" } } };
const graph: AgentGraph = {
  nodes: { a: { type: "agent", agent: "x", prompt: "a" }, sub: { type: "graph", graph: "inner" } },
  edges: [{ from: "a", to: "sub" }],
  outputs: { r: { node: "sub", path: "$" } },
};
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "graph-runtime-log-")); vi.mocked(createActor).mockClear(); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
const rows = (path: string) => readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);

describe("graph runtime inspection log", () => {
  it("addresses the exact-session task area beside the trace", () => {
    expect(graphRuntimeLogPath("/work/repo", "sess", "agr_abc123")).toMatch(/pi-subagents-\d+\/work-repo\/sess\/tasks\/agr_abc123\.runtime\.jsonl$/);
    expect(() => graphRuntimeLogPath("/work/repo", "sess", "../x")).toThrow(/Invalid graph run ID/);
  });

  it("passes no inspect option to createActor unless one is provided", async () => {
    await runGraph(graph, {}, { host, loadGraph: () => inner });
    expect(vi.mocked(createActor).mock.calls[0]?.[1]).not.toHaveProperty("inspect");
    const inspect = vi.fn();
    await runGraph(graph, {}, { host, loadGraph: () => inner, inspect });
    expect(vi.mocked(createActor).mock.calls[1]?.[1]).toHaveProperty("inspect", inspect);
    expect(inspect).toHaveBeenCalled();
  });

  it("records only event/microstep lines without context or payloads, including nested graph actors", async () => {
    const path = join(dir, "run.runtime.jsonl");
    const log = openGraphRuntimeLog({ create: () => path, warn: vi.fn() });
    const result = await runGraph(graph, {}, { host, loadGraph: () => inner, inspect: log.inspect });
    log.close();
    expect(result.status).toBe("completed");
    const lines = rows(path);
    expect(lines.length).toBeGreaterThan(10);
    expect(new Set(lines.map(line => line.type))).toEqual(new Set(["@xstate.event", "@xstate.microstep"]));
    for (const line of lines) {
      expect(Object.keys(line).every(key => ["seq", "at", "type", "actor", "session", "event", "value", "tags"].includes(key))).toBe(true);
      expect(typeof line.event).toBe("string");
    }
    expect(lines.map(line => line.seq)).toEqual(lines.map((_, index) => index + 1));
    expect(readFileSync(path, "utf8")).not.toContain("SECRET-OUTPUT");
    expect(readFileSync(path, "utf8")).not.toContain("context");
    const actors = new Set(lines.map(line => line.actor));
    expect(actors).toContain("node:a");
    expect(actors).toContain("node:sub");
    expect(actors).toContain("graph");
    expect(actors).toContain("node:inner");
    expect(lines.some(line => line.type === "@xstate.microstep" && line.value !== undefined)).toBe(true);
  });

  it("caps the log with one truncated line", async () => {
    const path = join(dir, "run.runtime.jsonl");
    const log = openGraphRuntimeLog({ create: () => path, warn: vi.fn(), maxBytes: 1_500 });
    await runGraph(graph, {}, { host, loadGraph: () => inner, inspect: log.inspect });
    log.close();
    const lines = rows(path);
    expect(lines.at(-1)).toMatchObject({ type: "truncated" });
    expect(lines.filter(line => line.type === "truncated")).toHaveLength(1);
    expect(readFileSync(path, "utf8").length).toBeLessThanOrEqual(1_600);
  });

  it("keeps execution unaffected by I/O failure and warns once", async () => {
    const blocker = join(dir, "file");
    writeFileSync(blocker, "");
    const warn = vi.fn();
    const log = openGraphRuntimeLog({ create: () => join(blocker, "nested", "run.runtime.jsonl"), warn });
    const result = await runGraph(graph, {}, { host, loadGraph: () => inner, inspect: log.inspect });
    log.close();
    expect(result.status).toBe("completed");
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
