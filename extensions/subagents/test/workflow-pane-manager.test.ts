// workflow-pane-manager.test.ts (Wave 2) — the input channel + per-pane view
// state. The manager imports the pi-tui-backed renderer, so the real layout must
// stand in for the ASCII unit stub.
vi.mock("@earendil-works/pi-tui", () => import("../../../node_modules/@earendil-works/pi-tui/dist/index.js"));

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkflowPaneManager, type WorkflowPaneManager } from "../src/workflow/pane/manager.js";
import { readRecord, STATE_FILE, writeInputAtomic, writeRecord } from "../src/workflow/pane/store.js";
import { createWorkflowTask, type WorkflowTask } from "../src/workflow/task.js";

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
    { type: "workflow_agent", index: 0, label: "a0", phaseIndex: 0, state: "done" },
    { type: "workflow_agent", index: 1, label: "a1", phaseIndex: 1, state: "progress" },
  ];
  return task;
}

function manager(getTasks: () => WorkflowTask[]) {
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
  });
  managers.push(mgr);
  return mgr;
}

const b64 = (s: string) => Buffer.from(s).toString("base64");
const paneState = (mgr: WorkflowPaneManager) => (mgr as unknown as { paneState: { selectedPhase: number; level: string } }).paneState;
const processInput = (mgr: WorkflowPaneManager) => (mgr as unknown as { processInputFile: () => Promise<void> }).processInputFile();

describe("input channel", () => {
  it("applies a forwarded key to the per-pane view state and writes a fresh snapshot", () => {
    const task = twoPhaseTask("wf_a", 1000);
    const mgr = manager(() => [task]);

    writeInputAtomic(dir, { seq: 1, data: b64("j") });
    processInput(mgr);

    expect(paneState(mgr).selectedPhase).toBe(1);
    const snap = JSON.parse(readFileSync(join(dir, STATE_FILE), "utf8"));
    expect(Array.isArray(snap.lines)).toBe(true);
    expect(snap.lines.length).toBeGreaterThan(0);
  });

  it("ignores a duplicate sequence number", () => {
    const task = twoPhaseTask("wf_a", 1000);
    const mgr = manager(() => [task]);

    writeInputAtomic(dir, { seq: 1, data: b64("j") });
    processInput(mgr);
    expect(paneState(mgr).selectedPhase).toBe(1);

    // Same seq, different key — must be ignored (stale/echo).
    writeInputAtomic(dir, { seq: 1, data: b64("k") });
    processInput(mgr);
    expect(paneState(mgr).selectedPhase).toBe(1);

    // A higher seq is honoured again.
    writeInputAtomic(dir, { seq: 2, data: b64("k") });
    processInput(mgr);
    expect(paneState(mgr).selectedPhase).toBe(0);
  });

  it("decodes control-byte ESC sequences (down arrow) from base64", () => {
    const task = twoPhaseTask("wf_a", 1000);
    const mgr = manager(() => [task]);

    writeInputAtomic(dir, { seq: 1, data: b64("\x1b[B") });
    processInput(mgr);
    expect(paneState(mgr).selectedPhase).toBe(1);
  });

  it("resets the view to the overview when the shown run changes", async () => {
    let tasks = [twoPhaseTask("wf_a", 1000)];
    const mgr = manager(() => tasks);

    // Drill into run A.
    writeInputAtomic(dir, { seq: 1, data: b64("j") });
    processInput(mgr);
    writeInputAtomic(dir, { seq: 2, data: b64("\r") });
    processInput(mgr);
    expect(paneState(mgr).level).toBe("agent");

    // A newer run appears; the next render must start it at the overview.
    tasks = [twoPhaseTask("wf_b", 2000)];
    await (mgr as unknown as { syncNow: (force: boolean) => Promise<void> }).syncNow(false);
    expect(paneState(mgr).level).toBe("phases");
    expect(paneState(mgr).selectedPhase).toBe(0);
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
