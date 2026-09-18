// workflow-pane-manager.test.ts (Wave 2) — the input channel + per-pane view
// state. The manager imports the pi-tui-backed renderer, so the real layout must
// stand in for the ASCII unit stub.
vi.mock("@earendil-works/pi-tui", () => import("../../../node_modules/@earendil-works/pi-tui/dist/index.js"));

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkflowPaneManager, type WorkflowPaneManager } from "../src/graph/pane/manager.js";
import { readRecord, STATE_FILE, writeInputAtomic, writeRecord } from "../src/graph/pane/store.js";
import { createWorkflowTask, type WorkflowTask } from "../src/graph/task.js";

let dir: string;
let managers: WorkflowPaneManager[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wfpane-mgr-"));
  managers = [];
});
afterEach(async () => {
  for (const mgr of managers) await mgr.dispose();
  rmSync(dir, { recursive: true, force: true });
});

const ok = async () => ({ code: 0, stdout: "", stderr: "", killed: false });

function twoPhaseTask(id: string, startTime: number): WorkflowTask {
  const task = createWorkflowTask({
    id,
    script: "x",
    meta: { name: "audit", description: "d", phases: [{ title: "Discover" }, { title: "Review" }] },
    startTime,
  });
  task.workflowName = "audit";
  task.status = "running";
  task.agentCount = 2;
  task.workflowProgress = [
    { type: "workflow_phase", index: 0, title: "Discover" },
    { type: "workflow_phase", index: 1, title: "Review" },
    { type: "workflow_agent", index: 0, label: "a0", phaseIndex: 0, state: "done", recordId: "rec-a0" },
    { type: "workflow_agent", index: 1, label: "a1", phaseIndex: 1, state: "progress" },
  ];
  return task;
}

function manager(getTasks: () => WorkflowTask[], viewAgentConversation?: (recordId: string) => void) {
  const mgr = createWorkflowPaneManager({
    enabled: true,
    exec: vi.fn(ok) as any,
    parentPaneId: "%p0",
    socket: "sock",
    cwd: "/work",
    sessionId: "sess1234",
    ppid: 4242,
    getTasks,
    viewerPath: "/viewer/viewer.mjs",
    dir,
    viewAgentConversation,
  });
  managers.push(mgr);
  return mgr;
}

const b64 = (s: string) => Buffer.from(s).toString("base64");
const panelState = (mgr: WorkflowPaneManager) => (mgr as unknown as { panelState: { cursor?: { kind: "stage"; stage: number } | { kind: "node"; id: string }; runIndex: number; scroll: number } }).panelState;
const processInput = (mgr: WorkflowPaneManager) => (mgr as unknown as { processInputFile: () => Promise<void> }).processInputFile();

describe("input channel", () => {
  it("drives the panel view state from a forwarded key and writes a fresh snapshot", () => {
    const task = twoPhaseTask("wf_a", 1000);
    const mgr = manager(() => [task]);

    // `j` walks the stage-ordered targets (stage 0, a0, stage 1, a1); four downs reach a1.
    for (const seq of [1, 2, 3, 4]) {
      writeInputAtomic(dir, { seq, data: b64("j") });
      processInput(mgr);
    }

    expect(panelState(mgr).cursor).toEqual({ kind: "node", id: "a1" });
    const snap = JSON.parse(readFileSync(join(dir, STATE_FILE), "utf8"));
    expect(Array.isArray(snap.lines)).toBe(true);
    expect(snap.lines.length).toBeGreaterThan(0);
  });

  it("ignores a duplicate sequence number", () => {
    const task = twoPhaseTask("wf_a", 1000);
    const mgr = manager(() => [task]);

    // Two downs land the cursor on the first node (stage 0 header, then a0).
    writeInputAtomic(dir, { seq: 1, data: b64("j") });
    processInput(mgr);
    writeInputAtomic(dir, { seq: 2, data: b64("j") });
    processInput(mgr);
    expect(panelState(mgr).cursor).toEqual({ kind: "node", id: "a0" });

    // Same seq, different key — must be ignored (stale/echo).
    writeInputAtomic(dir, { seq: 2, data: b64("k") });
    processInput(mgr);
    expect(panelState(mgr).cursor).toEqual({ kind: "node", id: "a0" });

    // A higher seq is honoured again (`k` moves the cursor back up to the stage header).
    writeInputAtomic(dir, { seq: 3, data: b64("k") });
    processInput(mgr);
    expect(panelState(mgr).cursor).toEqual({ kind: "stage", stage: 0 });
  });

  it("decodes control-byte ESC sequences (down arrow) from base64", () => {
    const task = twoPhaseTask("wf_a", 1000);
    const mgr = manager(() => [task]);

    writeInputAtomic(dir, { seq: 1, data: b64("\x1b[B") });
    processInput(mgr);
    expect(panelState(mgr).cursor).toEqual({ kind: "stage", stage: 0 });
  });

  it("resets node selection when the shown run changes", async () => {
    let tasks = [twoPhaseTask("wf_a", 1000)];
    const mgr = manager(() => tasks);

    // Move the cursor in run A.
    writeInputAtomic(dir, { seq: 1, data: b64("j") });
    processInput(mgr);
    expect(panelState(mgr).cursor).toEqual({ kind: "stage", stage: 0 });

    // A newer run appears; the next render must start it with no cursor.
    tasks = [twoPhaseTask("wf_b", 2000)];
    await (mgr as unknown as { syncNow: (force: boolean) => Promise<void> }).syncNow(false);
    expect(panelState(mgr).cursor).toBeUndefined();
    expect(panelState(mgr).scroll).toBe(0);
  });

  it("opens the selected node's conversation on c without closing the pane", async () => {
    const view = vi.fn();
    const task = twoPhaseTask("wf_a", 1000);
    const mgr = manager(() => [task], view);
    // Walk the cursor to the node with a recordId (stage 0 header, then a0).
    writeInputAtomic(dir, { seq: 1, data: b64("j") });
    processInput(mgr);
    writeInputAtomic(dir, { seq: 2, data: b64("j") });
    processInput(mgr);
    expect(panelState(mgr).cursor).toEqual({ kind: "node", id: "a0" });

    writeInputAtomic(dir, { seq: 3, data: b64("c") });
    await processInput(mgr);
    expect(view).toHaveBeenCalledWith("rec-a0");
    // Open is not a close: the snapshot is still written for that keystroke.
    expect(existsSync(join(dir, STATE_FILE))).toBe(true);
  });
});

describe("external stage folding", () => {
  it("forwards Space to fold and reopen the selected stage", async () => {
    const task = twoPhaseTask("wf_a", 1000);
    const mgr = manager(() => [task]);
    writeInputAtomic(dir, { seq: 1, data: b64("j") });
    await processInput(mgr);
    writeInputAtomic(dir, { seq: 2, data: b64(" ") });
    await processInput(mgr);
    expect((panelState(mgr) as { collapsedStages?: number[] }).collapsedStages).toContain(0);
    writeInputAtomic(dir, { seq: 3, data: b64(" ") });
    await processInput(mgr);
    expect((panelState(mgr) as { collapsedStages?: number[] }).collapsedStages).not.toContain(0);
  });
});

describe("esc-at-overview closes via the extension", () => {
  it("closes the recorded pane, marks closedByUser, and writes no new snapshot", async () => {
    const task = twoPhaseTask("wf_a", 1000);
    const exec = vi.fn(ok);
    const mgr = createWorkflowPaneManager({
      enabled: true,
      exec: exec as any,
      parentPaneId: "%p0",
      socket: "sock",
      cwd: "/work",
      sessionId: "sess1234",
      ppid: 4242,
      getTasks: () => [task],
      viewerPath: "/viewer/viewer.mjs",
      dir,
    });
    managers.push(mgr);
    writeRecord(dir, { paneId: "%p9", sentinel: "Workflow · sess1234", closedByUser: false });

    // esc at the overview level → cancel → the extension closes the pane.
    writeInputAtomic(dir, { seq: 1, data: b64("\x1b") });
    await processInput(mgr);

    expect(exec).toHaveBeenCalledWith("herdr", ["pane", "close", "%p9"], expect.anything());
    expect(readRecord(dir)?.closedByUser).toBe(true);
    // The close path returns before writing a snapshot.
    expect(existsSync(join(dir, STATE_FILE))).toBe(false);
  });

  it("still writes a snapshot for a navigation key", async () => {
    const task = twoPhaseTask("wf_a", 1000);
    const mgr = manager(() => [task]);
    writeInputAtomic(dir, { seq: 1, data: b64("j") });
    await processInput(mgr);
    expect(existsSync(join(dir, STATE_FILE))).toBe(true);
  });
});

describe("auto-open gating", () => {
  const splitCalled = (exec: any) =>
    exec.mock.calls.some((c: any[]) => c[0] === "herdr" && c[1]?.[1] === "split");
  const syncNow = (mgr: WorkflowPaneManager, force: boolean) =>
    (mgr as unknown as { syncNow: (f: boolean) => Promise<void> }).syncNow(force);
  function mgrWith(exec: any, getTasks: () => WorkflowTask[]) {
    const mgr = createWorkflowPaneManager({
      enabled: true,
      exec,
      parentPaneId: "%p0",
      socket: "sock",
      cwd: "/work",
      sessionId: "sess1234",
      ppid: 4242,
      getTasks,
      viewerPath: "/viewer/viewer.mjs",
      dir,
    });
    managers.push(mgr);
    return mgr;
  }

  it("does not split a pane on sync when no run exists", async () => {
    const exec = vi.fn(ok);
    const mgr = mgrWith(exec as any, () => []);
    await syncNow(mgr, false);
    expect(splitCalled(exec)).toBe(false);
  });

  it("splits a pane on sync once a run exists", async () => {
    const exec = vi.fn(ok);
    const mgr = mgrWith(exec as any, () => [twoPhaseTask("wf_a", 1000)]);
    await syncNow(mgr, false);
    expect(splitCalled(exec)).toBe(true);
  });

  it("force-opens on demand even with no run", async () => {
    const exec = vi.fn(ok);
    const mgr = mgrWith(exec as any, () => []);
    await syncNow(mgr, true);
    expect(splitCalled(exec)).toBe(true);
  });
});

describe("disabled manager", () => {
  it("never processes input and holds no view state machinery", () => {
    const mgr = createWorkflowPaneManager({
      enabled: false,
      exec: vi.fn(ok) as any,
      parentPaneId: "",
      socket: "",
      cwd: "/work",
      sessionId: "s",
      ppid: 1,
      getTasks: () => [],
    });
    // Processing is a no-op and touches nothing.
    expect(() => (mgr as unknown as { processInputFile: () => void }).processInputFile()).not.toThrow();
  });
});
