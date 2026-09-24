// Restart coverage executes the real viewer startup/handler with a ready terminal.
vi.mock("@earendil-works/pi-tui", () => import("../../../node_modules/@earendil-works/pi-tui/dist/index.js"));

import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyPaneKey } from "../src/graph/pane/input-filter.mjs";
import { createGraphRunPaneManager, type GraphRunPaneManager } from "../src/graph/pane/manager.js";
import { readInput, writeInputAtomic } from "../src/graph/pane/store.js";
import { createGraphRunTask } from "../src/graph/task.js";

let dir: string;
let managers: GraphRunPaneManager[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wfpane-restart-"));
  managers = [];
});
afterEach(async () => {
  for (const mgr of managers) await mgr.dispose();
  rmSync(dir, { recursive: true, force: true });
});

function manager() {
  const task = createGraphRunTask({
    id: "wf_a", script: "x", startTime: 1000,
    meta: { name: "audit", description: "d", phases: [{ title: "Discover" }, { title: "Review" }] },
  });
  task.graphRunName = "audit";
  task.status = "running";
  task.agentCount = 2;
  task.graphRunProgress = [
    { type: "workflow_phase", index: 0, title: "Discover" },
    { type: "workflow_phase", index: 1, title: "Review" },
    { type: "workflow_agent", index: 0, label: "a0", phaseIndex: 0, state: "done", recordId: "rec-a0" },
    { type: "workflow_agent", index: 1, label: "a1", phaseIndex: 1, state: "progress" },
  ];
  const mgr = createGraphRunPaneManager({
    enabled: true,
    exec: vi.fn(async () => ({ code: 0, stdout: "", stderr: "", killed: false })),
    parentPaneId: "%p0", socket: "sock", cwd: "/work", sessionId: "sess1234", ppid: 4242,
    getTasks: () => [task], viewerPath: "/viewer/viewer.mjs", dir,
  });
  managers.push(mgr);
  return mgr;
}

const b64 = (s: string) => Buffer.from(s).toString("base64");
// Typed private access keeps deterministic dispatch independent of fs.watch timing.
const panelState = (mgr: GraphRunPaneManager) => mgr["panelState"];
const processInput = (mgr: GraphRunPaneManager) => mgr["processInputFile"]();

// Execute the actual viewer startup and stdin handler, with a ready terminal and
// inert timers/watchers. Real file IO preserves the persisted restart boundary.
function startViewer() {
  const stdin = Object.assign(new EventEmitter(), { isTTY: true, setRawMode() {}, resume() {} });
  const stdout = Object.assign(new EventEmitter(), { write() {} });
  const source = readFileSync(new URL("../src/graph/pane/viewer.mjs", import.meta.url), "utf8");
  runInNewContext(source.replace(/^import .+;$/gm, ""), {
    process: Object.assign(new EventEmitter(), {
      argv: ["node", "viewer.mjs", "--dir", dir], pid: process.pid, stdin, stdout,
    }),
    Buffer, existsSync, readFileSync, renameSync, writeFileSync, join, classifyPaneKey,
    watch: () => ({ close() {} }),
    setTimeout: vi.fn(), clearTimeout: vi.fn(), setInterval: vi.fn(), clearInterval: vi.fn(),
  });
  expect(stdin.listenerCount("data")).toBe(1);
  return (key: string) => stdin.emit("data", Buffer.from(key));
}

describe("input restart", () => {
  it.each(["j", "k", "\x1b[B", "\x1b[A"])("dispatches the first %j immediately on each viewer restart", async key => {
    const mgr = manager();
    writeInputAtomic(dir, { seq: 7, data: b64("j") });
    await processInput(mgr);

    for (const seq of [8, 9]) {
      // Start from a node so both up and down produce an observable move.
      panelState(mgr).cursor = { kind: "node", id: "a0" };
      const send = startViewer();
      send("\x1b[I"); // Focus reports are noise, not a readiness handshake.
      send("\x1b[O");
      expect(readInput(dir)?.seq).toBe(seq - 1);
      send(key);
      // No timer advancement, repeated input, or focus change is needed.
      expect(readInput(dir)).toEqual({ seq, data: b64(key) });
      await processInput(mgr);
      expect(panelState(mgr).cursor).toEqual(key === "j" || key === "\x1b[B"
        ? { kind: "node", id: "a1" }
        : { kind: "stage", stage: 0 });
    }
  });

  it("does not replay persisted input after manager recreation", async () => {
    const previous = manager();
    writeInputAtomic(dir, { seq: 7, data: b64("j") });
    await processInput(previous);
    await previous.dispose();

    const mgr = manager();
    await processInput(mgr); // Any viewport/state write can trigger this directory watcher.
    expect(panelState(mgr).cursor).toBeUndefined();
    expect(readInput(dir)?.seq).toBe(7);
    const send = startViewer();
    send("j");
    await processInput(mgr);
    expect(readInput(dir)?.seq).toBe(8);
    expect(panelState(mgr).cursor).toEqual({ kind: "stage", stage: 0 });
  });
});
