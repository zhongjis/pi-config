import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { boundHistory, decodeHistory, GraphHistoryStore, HISTORY_FILE_BYTES, snapshotHistory } from "../src/graph/history.js";
import { createWorkflowTask } from "../src/graph/task.js";

function required<T>(value: T | null | undefined): T {
  assert.ok(value != null);
  return value;
}

function task(id = "run", startTime = 1) {
  const value = createWorkflowTask({ id, script: "SECRET_SCRIPT", meta: { name: "test", description: "SECRET_DESCRIPTION" } });
  Object.assign(value, { status: "completed", startTime, endTime: startTime + 1, args: "SECRET_INPUT", value: "SECRET_OUTPUT", error: "SECRET_ERROR", scriptPath: "SECRET_PATH", resultPath: "SECRET_PATH", journalPath: "SECRET_PATH", logs: ["SECRET_LOG"], outcome: { status: "partial", reason: "SECRET_REASON" } });
  value.workflowProgress = [{ type: "workflow_agent", index: 0, label: "node\n\u001b[31mname\u001b[0m", state: "error", promptPreview: "SECRET_PROMPT", resultPreview: "SECRET_RESULT", error: "SECRET_ERROR", recordId: "SECRET_RECORD", modelId: "provider/model", deps: ["upstream"] }];
  return value;
}

describe("graph metadata history", () => {
  it("allowlists metadata, sanitizes display strings and never hydrates runtime/content", () => {
    const snapshot = snapshotHistory(task());
    expect(snapshot).toBeDefined();
    const encoded = JSON.stringify(snapshot);
    expect(encoded).not.toContain("SECRET_");
    expect(encoded).not.toContain("abortController");
    expect(snapshot?.nodes[0].label).toBe("node name");
    expect(snapshot?.outcome).toBe("partial");
    expect(decodeHistory(JSON.stringify({ version: 1, runs: [snapshot] })).runs).toEqual([snapshot]);
    const injected = { ...snapshot, input: "SECRET_INPUT", error: "SECRET_ERROR", nodes: required(snapshot).nodes.map(node => ({ ...node, recordId: "SECRET_RECORD", prompt: "SECRET_PROMPT" })) };
    expect(JSON.stringify(decodeHistory(JSON.stringify({ version: 1, runs: [injected] })))).not.toContain("SECRET_");
  });

  it("keeps the newest 20 unique runs and bounds nodes, phases, dependencies and strings", () => {
    const value = task();
    value.workflowProgress = Array.from({ length: 205 }, (_, index) => ({ type: "workflow_agent", index, label: "x".repeat(200), state: "done", deps: Array.from({ length: 40 }, () => "d".repeat(200)), phaseIndex: index, phaseTitle: "p".repeat(200) }));
    const snapshot = required(snapshotHistory(value));
    expect(snapshot.nodes).toHaveLength(200);
    expect(snapshot.omittedNodeCount).toBe(5);
    expect(snapshot.phases).toHaveLength(64);
    expect(snapshot.nodes[0].deps).toHaveLength(32);
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
    expect(decodeHistory('{"version":2,"runs":[]}')).toEqual({ runs: [], writable: false });
    const valid = snapshotHistory(task());
    expect(decodeHistory(JSON.stringify({ version: 1, runs: [null, { ...valid, startTime: "bad" }, valid] })).runs).toEqual([valid]);
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
  value.workflowProgress = Array.from({ length: 200 }, (_, index) => ({
    type: "workflow_agent", index, label: `node-${index}`, state: "done",
    deps: Array.from({ length: 32 }, () => "界".repeat(160)),
  }));
  const snapshot = required(snapshotHistory(value));
  const input = Array.from({ length: 20 }, (_, index) => ({ ...snapshot, id: `run-${index}`, startTime: index }));
  expect(Buffer.byteLength(JSON.stringify({ version: 1, runs: input }))).toBeGreaterThan(HISTORY_FILE_BYTES);
  const bounded = boundHistory(input);
  expect(Buffer.byteLength(JSON.stringify({ version: 1, runs: bounded }))).toBeLessThanOrEqual(HISTORY_FILE_BYTES);
  expect(bounded[0].id).toBe("run-19");
  expect(bounded.length).toBeLessThan(20);
  expect(bounded.every(run => run.omittedNodeCount === 0)).toBe(true);
});
