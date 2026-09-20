import * as fs from "node:fs";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isInstanceId } from "../src/graph/graph-instance-id.js";
import {
  deleteGraphSnapshot,
  type GraphRunSnapshot,
  graphRunsDir,
  readGraphSnapshots,
  writeGraphSnapshot,
} from "../src/graph/graph-persist.js";

vi.mock("node:fs", async importOriginal => ({ ...await importOriginal<typeof import("node:fs")>() }));

let cwd: string | undefined;
afterEach(() => {
  if (cwd) rmSync(cwd, { recursive: true, force: true });
  vi.restoreAllMocks();
  cwd = undefined;
});

function snapshot(runId: string): GraphRunSnapshot {
  return {
    version: 1,
    runId,
    name: "demo",
    graph: { nodes: { a: { type: "agent", agent: "x", prompt: "p" } }, edges: [] },
    input: { task: "t" },
    waitingGate: "gate",
    state: { nodes: { a: { status: "completed", attempt: 1, output: "x" } }, loopCounts: {} },
    savedAt: 1,
  };
}

describe("graph-persist file IO", () => {
  it("writes, reads, and deletes snapshots", () => {
    cwd = mkdtempSync(join(tmpdir(), "gp-"));
    writeGraphSnapshot(cwd, snapshot("wf_first1"));
    writeGraphSnapshot(cwd, snapshot("wf_second"));
    expect(readGraphSnapshots(cwd).map(s => s.runId).sort()).toEqual(["wf_first1", "wf_second"]);
    deleteGraphSnapshot(cwd, "wf_first1");
    expect(readGraphSnapshots(cwd).map(s => s.runId)).toEqual(["wf_second"]);
  });

  it("preserves the restorable state round-trip", () => {
    cwd = mkdtempSync(join(tmpdir(), "gp-"));
    writeGraphSnapshot(cwd, snapshot("wf_xxxxxx"));
    const [loaded] = readGraphSnapshots(cwd);
    expect(loaded.waitingGate).toBe("gate");
    expect(loaded.state.nodes.a).toEqual({ status: "completed", attempt: 1, output: "x" });
    expect(loaded.graph.nodes.a).toBeDefined();
  });

  it("skips corrupt or wrong-version files", () => {
    cwd = mkdtempSync(join(tmpdir(), "gp-"));
    writeGraphSnapshot(cwd, snapshot("wf_okxxxx"));
    writeFileSync(join(graphRunsDir(cwd), "bad.json"), "{ not json", "utf-8");
    writeFileSync(join(graphRunsDir(cwd), "wrong.json"), JSON.stringify({ version: 2, runId: "x" }), "utf-8");
    expect(readGraphSnapshots(cwd).map(s => s.runId)).toEqual(["wf_okxxxx"]);
  });

  it("returns empty when the directory does not exist", () => {
    cwd = mkdtempSync(join(tmpdir(), "gp-"));
    expect(readGraphSnapshots(cwd)).toEqual([]);
  });
});

it("round-trips effective dynamic definitions, collection order, failures, and attempt reasons in v1", () => {
  cwd = mkdtempSync(join(tmpdir(), "gp-"));
  const saved = snapshot("wf_dynamic");
  saved.graph.nodes.a = {
    type: "fanout", items: { path: "$.tasks" }, itemSchema: { type: "object" },
    dispatch: { path: "$.source", cases: { project: "x" } }, prompt: `\${item}`,
  };
  saved.graph.nodes["a:item:0"] = { type: "agent", agent: "x", prompt: "fixture" };
  saved.state.nodes.a = { status: "running", attempt: 1 };
  saved.state.nodes["a:item:0"] = { status: "failed", attempt: 2, attemptReason: "user-retry", error: "offline" };
  saved.state.collections = { a: [{ nodeId: "a:item:0", item: { source: "project" } }] };
  writeGraphSnapshot(cwd, saved);
  expect(readGraphSnapshots(cwd)).toEqual([saved]);
});

describe("atomic graph checkpoint replacement", () => {
  it.each(["write", "file sync", "rename", "directory sync"])("keeps a complete checkpoint after %s fails", stage => {
    const directory = mkdtempSync(join(tmpdir(), "gp-atomic-"));
    cwd = directory;
    const prior = snapshot("wf_atomic");
    writeGraphSnapshot(cwd, prior);
    const next = { ...prior, savedAt: 2 };
    const failure = new Error(`injected ${stage} failure`);
    if (stage === "write") {
      const write = fs.writeFileSync;
      vi.spyOn(fs, "writeFileSync").mockImplementation((file, data, options) => {
        if (typeof data === "string" && data.startsWith("{") && data.includes('"graph"')) {
          write(file, "{ torn", options);
          throw failure;
        }
        write(file, data, options); // owner PID, not the checkpoint payload
      });
    } else if (stage === "rename") {
      vi.spyOn(fs, "renameSync").mockImplementationOnce(() => { throw failure; });
    } else {
      const sync = fs.fsyncSync;
      let count = 0;
      vi.spyOn(fs, "fsyncSync").mockImplementation(fd => {
        count += 1;
        if (count === (stage === "file sync" ? 1 : 2)) throw failure;
        sync(fd);
      });
    }
    expect(() => writeGraphSnapshot(directory, next)).toThrow(failure);
    const persisted: unknown = JSON.parse(readFileSync(join(graphRunsDir(cwd), "wf_atomic.json"), "utf8"));
    expect(persisted).toEqual(stage === "directory sync" ? next : prior);
    expect(readdirSync(graphRunsDir(cwd))).toEqual(["wf_atomic.json"]);
  });

  it("syncs the file before rename and the directory after rename", () => {
    cwd = mkdtempSync(join(tmpdir(), "gp-atomic-"));
    const events: string[] = [];
    const sync = fs.fsyncSync;
    const rename = fs.renameSync;
    vi.spyOn(fs, "fsyncSync").mockImplementation(fd => { events.push("sync"); sync(fd); });
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      events.push("rename");
      expect(String(from)).toContain(graphRunsDir(cwd ?? ""));
      rename(from, to);
    });
    writeGraphSnapshot(cwd, snapshot("wf_atomic"));
    expect(events).toEqual(["sync", "rename", "sync"]);
  });
});

it("rejects stale checkpoint owners and reports unknown or corrupt v2 snapshots", () => {
  cwd = mkdtempSync(join(tmpdir(), "gp-v2-"));
  const base = snapshot("wf_version2");
  const instanceId = "00000000-0000-4000-8000-000000000001";
  if (!isInstanceId(instanceId)) throw new Error("invalid fixture ID");
  const next: GraphRunSnapshot = { ...base, version: 2, state: { ...base.state, runtime: { version: 2, runId: base.runId, startedAt: 1000, revision: 1, manifest: [{ binding: "a", nodeKey: "a", ordinal: 0, instanceId }] } } };
  writeGraphSnapshot(cwd, next);
  const directory = cwd;
  expect(() => writeGraphSnapshot(directory, next)).toThrow(/stale/i);
  expect(readGraphSnapshots(cwd)).toEqual([next]);
  const invalid = vi.fn();
  writeFileSync(join(graphRunsDir(cwd), "future.json"), JSON.stringify({ ...next, version: 99 }));
  writeFileSync(join(graphRunsDir(cwd), "corrupt.json"), JSON.stringify({ ...next, state: {} }));
  expect(readGraphSnapshots(cwd, invalid)).toEqual([next]);
  expect(invalid).toHaveBeenCalledTimes(2);
});

it("atomically upgrades legacy state before dispatch and retains IDs on the next restore", async () => {
  const { runGraph } = await import("../src/graph/run-graph.js");
  cwd = mkdtempSync(join(tmpdir(), "gp-upgrade-"));
  const directory = cwd;
  const legacy = snapshot("wf_upgrade");
  legacy.state.nodes.a = { status: "pending", attempt: 0 };
  writeGraphSnapshot(directory, legacy);
  const writer = (state: GraphRunSnapshot["state"], graph: GraphRunSnapshot["graph"]) => {
    writeGraphSnapshot(directory, { ...legacy, version: 2, state, graph });
  };
  const spawnAgent = vi.fn(async (request: { nodeId: string }) => {
    expect(readGraphSnapshots(directory)[0]?.version).toBe(2);
    expect(request.nodeId).toBe("a"); // v1 dispatch/result IDs remain authored bindings
    return { ok: true, output: "ok" };
  });
  await runGraph(legacy.graph, legacy.input, { runId: legacy.runId, restore: legacy.state, onCheckpoint: writer, host: { spawnAgent } });
  const saved = readGraphSnapshots(directory)[0];
  if (!saved?.state.runtime) throw new Error("missing upgraded checkpoint");
  const ids = saved.state.runtime.manifest;
  const allocate = vi.fn(() => "bad");
  await runGraph(saved.graph, saved.input, { runId: saved.runId, restore: saved.state, onCheckpoint: writer, allocateInstanceId: allocate, host: { spawnAgent } });
  expect(allocate).not.toHaveBeenCalled();
  expect(spawnAgent).toHaveBeenCalledTimes(1);
  expect(readGraphSnapshots(directory)[0]?.state.runtime?.manifest).toEqual(ids);
  expect(() => writeGraphSnapshot(directory, legacy)).toThrow(/Stale/);
});

it("holds one live run owner across multiple checkpoints until release", async () => {
  const { ownGraphRun } = await import("../src/graph/graph-persist.js");
  cwd = mkdtempSync(join(tmpdir(), "gp-owner-"));
  const directory = cwd;
  const release = ownGraphRun(directory, "wf_owner1");
  try { expect(() => ownGraphRun(directory, "wf_owner1")).toThrow(/live writer/); }
  finally { release(); }
  const releaseNext = ownGraphRun(directory, "wf_owner1");
  releaseNext();
  expect(readdirSync(graphRunsDir(directory))).toEqual([]);
});
