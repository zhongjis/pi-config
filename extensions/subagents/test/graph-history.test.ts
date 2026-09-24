import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GraphRunReporter } from "../src/graph/graph-run-adapter.js";
import { boundHistory, decodeHistory, GraphHistoryStore, HISTORY_FILE_BYTES, snapshotHistory } from "../src/graph/history.js";
import { createGraphRunTask } from "../src/graph/task.js";

function required<T>(value: T | null | undefined): T {
  assert.ok(value != null);
  return value;
}

function task(id = "run", startTime = 1) {
  const value = createGraphRunTask({ id, script: "SECRET_SCRIPT", meta: { name: "test", description: "Configured description" } });
  Object.assign(value, { status: "completed", startTime, endTime: startTime + 1, args: "SECRET_INPUT", value: "SECRET_OUTPUT", error: "SECRET_ERROR", scriptPath: "SECRET_PATH", resultPath: "SECRET_PATH", journalPath: "SECRET_PATH", logs: ["SECRET_LOG"], outcome: { status: "partial", reason: "SECRET_REASON" } });
  value.graphRunProgress = [{ type: "workflow_agent", index: 0, label: "node\n\u001b[31mname\u001b[0m", state: "error", promptPreview: "SECRET_PROMPT", resultPreview: "SECRET_RESULT", error: "SECRET_ERROR", recordId: "SECRET_RECORD", modelId: "provider/model", attempt: 2, lastAttemptReason: "loop", deps: ["upstream"] }];
  return value;
}

describe("graph metadata history", () => {
  it.each(["loop", "restore"] as const)("allowlists %s metadata, sanitizes display strings and never hydrates runtime/content", reason => {
    const value = task(); Object.assign(value.graphRunProgress[0], { lastAttemptReason: reason });
    const snapshot = snapshotHistory(value);
    expect(snapshot).toBeDefined();
    const encoded = JSON.stringify(snapshot);
    expect(encoded).not.toContain("SECRET_");
    expect(encoded).not.toContain("abortController");
    expect(snapshot?.nodes[0].label).toBe("node name");
    expect(snapshot?.outcome).toBe("partial");
    expect(snapshot?.nodes[0].lastAttemptReason).toBe(reason);
    expect(decodeHistory(JSON.stringify({ version: 2, runs: [snapshot] })).runs).toEqual([snapshot]);
    const injected = { ...snapshot, input: "SECRET_INPUT", error: "SECRET_ERROR", nodes: required(snapshot).nodes.map(node => ({ ...node, recordId: "SECRET_RECORD", prompt: "SECRET_PROMPT" })) };
    expect(JSON.stringify(decodeHistory(JSON.stringify({ version: 2, runs: [injected] })))).not.toContain("SECRET_");
  });

  it("removes v1 bindings while preserving dependency indices", () => {
    const value = createGraphRunTask({ id: "legacy", script: "" });
    const first = { type: "agent", name: "First", agent: "worker", prompt: "one" } as const;
    const second = { type: "agent", name: "Second", agent: "reviewer", prompt: "two" } as const;
    const reporter = new GraphRunReporter(value, { nodes: { PRIVATE_FIRST: first, PRIVATE_SECOND: second }, edges: [{ from: "PRIVATE_FIRST", to: "PRIVATE_SECOND" }] });
    reporter.update("PRIVATE_FIRST", { status: "completed", attempt: 1, output: "one" });
    reporter.update("PRIVATE_SECOND", { status: "completed", attempt: 1, output: "two" });
    Object.assign(value, { status: "completed", endTime: Date.now() });
    const snapshot = required(snapshotHistory(value));
    expect(JSON.stringify(snapshot)).not.toContain("PRIVATE_");
    expect(snapshot.nodes.map(node => node.label)).toEqual(["First", "Second"]);
    expect(snapshot.nodes[1]?.depIndices).toEqual([0]);
  });

  it("keeps the newest 20 unique runs and bounds nodes, phases, dependencies and strings", () => {
    const value = task();
    value.graphRunProgress = Array.from({ length: 205 }, (_, index) => ({ type: "workflow_agent", index, label: "x".repeat(200), state: "done", deps: Array.from({ length: 40 }, () => "d".repeat(200)), phaseIndex: index, phaseTitle: "p".repeat(200) }));
    const snapshot = required(snapshotHistory(value));
    expect(snapshot.nodes).toHaveLength(200);
    expect(snapshot.omittedNodeCount).toBe(5);
    expect(snapshot.phases).toHaveLength(64);
    expect(snapshot.nodes[0].deps).toHaveLength(0);
    expect(snapshot.nodes[0].label).toHaveLength(160);
    const runs = Array.from({ length: 21 }, (_, index) => required(snapshotHistory(task(`run-${index}`, index))));
    const bounded = boundHistory([...runs, runs[20]]);
    expect(bounded).toHaveLength(20);
    expect(bounded[0].id).toBe("run-20");
    expect(bounded.some(run => run.id === "run-0")).toBe(false);
    const small = boundHistory([snapshot], 30000);
    expect(Buffer.byteLength(JSON.stringify({ version: 1, runs: small }))).toBeLessThanOrEqual(30000);
    expect(small[0].omittedNodeCount).toBeGreaterThan(5);
  });

  it("recovers malformed JSON and rows, but disables writes for unknown versions", () => {
    expect(decodeHistory("{")).toEqual({ runs: [], writable: true });
    expect(decodeHistory('{"version":99,"runs":[]}')).toEqual({ runs: [], writable: false });
    const valid = snapshotHistory(task());
    expect(decodeHistory(JSON.stringify({ version: 2, runs: [null, { ...valid, startTime: "bad" }, valid] })).runs).toEqual([valid]);
  });

  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "graph-history-")); vi.stubEnv("PI_CODING_AGENT_DIR", root); });
  afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

  it("flushes whole-file history for exact session ID, reloads it, and isolates other IDs", async () => {
    const store = await GraphHistoryStore.load("session-a");
    store.capture(task());
    expect(store.runs).toHaveLength(1);
    await store.flush();
    expect((await GraphHistoryStore.load("session-a")).runs).toEqual(store.runs);
    expect((await GraphHistoryStore.load("session-b")).runs).toEqual([]);
    expect(await readFile(join(root, "local/session-a/graph-history.json"), "utf8")).not.toContain("SECRET_");
  });

  it("preserves unknown-version bytes and warns once generically on I/O failures", async () => {
    const store = await GraphHistoryStore.load("session-a");
    store.capture(task());
    await store.flush();
    const path = join(root, "local/session-a/graph-history.json");
    const unknown = '{"version":99,"secret":"must preserve"}';
    await writeFile(path, unknown);
    const future = await GraphHistoryStore.load("session-a");
    future.capture(task("new"));
    await future.flush();
    expect(await readFile(path, "utf8")).toBe(unknown);
    expect(future.runs).toEqual([]);
    const warning = vi.fn();
    const broken = await GraphHistoryStore.load("../SECRET_PATH", warning);
    broken.capture(task());
    broken.capture(task("two"));
    await broken.flush();
    expect(warning).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warning.mock.calls)).not.toContain("SECRET_");
  });
});

it("enforces the actual 8 MiB ceiling by evicting oldest runs before touching node tails", () => {
  const value = task();
  value.graphRunProgress = Array.from({ length: 200 }, (_, index) => ({
    type: "workflow_agent", index, label: `node-${index}`, state: "done",
    deps: Array.from({ length: 32 }, () => "界".repeat(160)),
  }));
  const snapshot = required(snapshotHistory(value));
  // Legacy label dependencies remain bounded on migration and exercise byte eviction.
  snapshot.nodes = snapshot.nodes.map(node => ({ ...node, deps: Array.from({ length: 32 }, () => "界".repeat(160)) }));
  delete snapshot.topologyVersion;
  delete snapshot.description;
  const input = Array.from({ length: 20 }, (_, index) => ({ ...snapshot, id: `run-${index}`, startTime: index }));
  expect(Buffer.byteLength(JSON.stringify({ version: 1, runs: input }))).toBeGreaterThan(HISTORY_FILE_BYTES);
  const bounded = boundHistory(input);
  expect(Buffer.byteLength(JSON.stringify({ version: 1, runs: bounded }))).toBeLessThanOrEqual(HISTORY_FILE_BYTES);
  expect(bounded[0].id).toBe("run-19");
  expect(bounded.length).toBeLessThan(20);
  expect(bounded.every(run => run.omittedNodeCount === 0)).toBe(true);
});

it.each([
  { parentIndex: 0 }, { parentIndex: 99 }, { parentIndex: -1 }, { iteration: 1.5 },
  { itemIndex: Number.MAX_SAFE_INTEGER + 1 }, { kind: "unknown" }, { role: "unknown" },
  { name: 1 }, { name: "x".repeat(161) },
  { connections: [{ index: 99, direction: "upstream", kind: "loop" }] },
  { connections: [{ index: 0, direction: "sideways", kind: "loop" }] },
  { connections: Array.from({ length: 33 }, () => ({ index: 0, direction: "upstream", kind: "loop" })) },
  { iterations: [{ iteration: 1, decision: "bad" }] },
  { iterations: Array.from({ length: 65 }, (_, iteration) => ({ iteration })) },
])("fails closed on malformed v2 topology %j", patch => {
  const run = required(snapshotHistory(task()));
  expect(decodeHistory(JSON.stringify({ version: 2, runs: [run] }))).toEqual({ runs: [run], writable: true });
  const node = { ...run.nodes[0], topology: { kind: "agent", name: "Node", ...patch } };
  expect(decodeHistory(JSON.stringify({ version: 2, runs: [{ ...run, nodes: [node] }] })).runs).toEqual([]);
});

it("rejects v2 cycles, duplicate indices and dangling dependency references", () => {
  const run = required(snapshotHistory(task()));
  const first = { ...run.nodes[0], topology: { kind: "fanout", name: "A", parentIndex: 1 } };
  const second = { ...first, index: 1, topology: { ...first.topology, parentIndex: 0 } };
  const invalidOwner = { ...run.nodes[0], topology: { kind: "agent", name: "Owner" } };
  const invalidChild = { ...invalidOwner, index: 1, topology: { kind: "agent", name: "Item", parentIndex: 0, itemIndex: 0 } };
  const fanoutOwner = { ...run.nodes[0], topology: { kind: "fanout", name: "Fanout" } };
  const fanoutItem = { ...fanoutOwner, index: 1, topology: { kind: "fanout", name: "Nested", parentIndex: 0, itemIndex: 0 } };
  const feedbackOwner = { ...run.nodes[0], topology: { kind: "bounded_feedback", name: "Feedback" } };
  const feedbackWork = { ...feedbackOwner, index: 1, topology: { kind: "bounded_feedback", name: "Work", parentIndex: 0, iteration: 1, role: "work" } };
  for (const nodes of [[first, second], [first, first], [{ ...first, depIndices: [99], topology: undefined }], [invalidOwner, invalidChild], [fanoutOwner, fanoutItem], [feedbackOwner, feedbackWork]]) {
    expect(decodeHistory(JSON.stringify({ version: 2, runs: [{ ...run, nodes }] })).runs).toEqual([]);
  }
});

it("bounds captured topology and keeps all references valid after tail eviction", () => {
  const value = task();
  value.graphRunProgress = Array.from({ length: 205 }, (_, index) => ({
    type: "workflow_agent", index: index * 2, label: `Node ${index}`, state: "done",
    nodeBinding: `binding-${index}`, instanceId: `instance-${index}`,
    deps: Array.from({ length: 40 }, (_, n) => `binding-${n}`),
    dependents: ["binding-204"],
    presentation: { kind: "bounded_feedback", name: "Display", parentInstanceId: index === 204 ? undefined : "instance-204",
      connections: Array.from({ length: 40 }, (_, n) => ({ binding: `binding-${n}`, direction: "downstream", kind: "loop" })),
      iterations: Array.from({ length: 70 }, (_, n) => ({ iteration: n + 1, decision: "continue" })),
    },
  }));
  const run = required(snapshotHistory(value));
  expect(run.nodes).toHaveLength(200);
  expect(run.nodes[0].depIndices).toHaveLength(32);
  expect(run.nodes[0].topology?.connections).toHaveLength(32);
  expect(run.nodes[0].topology?.iterations).toHaveLength(64);
  expect(run.nodes[0].topology?.parentIndex).toBeUndefined();
  expect(run.nodes[0].dependentIndices).toEqual([]);
  const bounded = boundHistory([run], 20000);
  expect(bounded[0].omittedNodeCount).toBeGreaterThan(5);
  expect(decodeHistory(JSON.stringify({ version: 2, runs: bounded })).runs).toEqual(bounded);
});

it("discards injected topology fields while preserving legacy flat runs on v2 writes", () => {
  const run = required(snapshotHistory(task()));
  const injected = { ...run, nodes: [{ ...run.nodes[0], topology: { kind: "agent", name: "Safe", prompt: "PRIVATE_PROMPT", instanceId: "PRIVATE_UUID", connections: [{ index: 0, direction: "upstream", kind: "loop", binding: "PRIVATE_BINDING" }], iterations: [{ iteration: 1, decision: "continue", reason: "PRIVATE_REASON" }] } }] };
  const decoded = decodeHistory(JSON.stringify({ version: 2, runs: [injected] }));
  expect(decoded.runs).toHaveLength(1);
  expect(JSON.stringify(decoded)).not.toContain("PRIVATE_");
  const legacy = decodeHistory(JSON.stringify({ version: 1, runs: [injected] })).runs;
  expect(JSON.stringify(legacy)).not.toMatch(/topology|description|depIndices|dependentIndices/);
  expect(decodeHistory(JSON.stringify({ version: 2, runs: legacy })).runs).toEqual(legacy);
});
