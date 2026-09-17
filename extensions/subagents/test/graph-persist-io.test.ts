import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  deleteGraphSnapshot,
  type GraphRunSnapshot,
  graphRunsDir,
  readGraphSnapshots,
  writeGraphSnapshot,
} from "../src/graph/graph-persist.js";

let cwd: string | undefined;
afterEach(() => {
  if (cwd) rmSync(cwd, { recursive: true, force: true });
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
    writeGraphSnapshot(cwd, snapshot("wf_1"));
    writeGraphSnapshot(cwd, snapshot("wf_2"));
    expect(readGraphSnapshots(cwd).map(s => s.runId).sort()).toEqual(["wf_1", "wf_2"]);
    deleteGraphSnapshot(cwd, "wf_1");
    expect(readGraphSnapshots(cwd).map(s => s.runId)).toEqual(["wf_2"]);
  });

  it("preserves the restorable state round-trip", () => {
    cwd = mkdtempSync(join(tmpdir(), "gp-"));
    writeGraphSnapshot(cwd, snapshot("wf_x"));
    const [loaded] = readGraphSnapshots(cwd);
    expect(loaded.waitingGate).toBe("gate");
    expect(loaded.state.nodes.a).toEqual({ status: "completed", attempt: 1, output: "x" });
    expect(loaded.graph.nodes.a).toBeDefined();
  });

  it("skips corrupt or wrong-version files", () => {
    cwd = mkdtempSync(join(tmpdir(), "gp-"));
    writeGraphSnapshot(cwd, snapshot("wf_ok"));
    writeFileSync(join(graphRunsDir(cwd), "bad.json"), "{ not json", "utf-8");
    writeFileSync(join(graphRunsDir(cwd), "wrong.json"), JSON.stringify({ version: 2, runId: "x" }), "utf-8");
    expect(readGraphSnapshots(cwd).map(s => s.runId)).toEqual(["wf_ok"]);
  });

  it("returns empty when the directory does not exist", () => {
    cwd = mkdtempSync(join(tmpdir(), "gp-"));
    expect(readGraphSnapshots(cwd)).toEqual([]);
  });
});
