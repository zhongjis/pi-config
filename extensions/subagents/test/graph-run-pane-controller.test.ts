// Shared lifecycle mechanics exercised through the herdr-app backend.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GraphRunPaneController, isPaneHostEnabled, type PaneExec } from "../src/graph/pane/controller.js";
import { readRecord, writeRecord } from "../src/graph/pane/store.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "wfpane-ctrl-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
const sentinel = "Graph run · sess1234";
const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
function controller(exec: PaneExec) {
  return new GraphRunPaneController({
    exec, host: "herdr-app", dir, parentPaneId: "term_parent", cwd: "/work/dir",
    sessionId: "sess1234", viewerPath: "/viewer/viewer.mjs", ppid: 4242, sentinel,
  });
}

describe("isPaneHostEnabled", () => {
  it("accepts herdr-app only in TUI mode", () => {
    const env = { HC_TERMINAL_ID: "t1" };
    expect(isPaneHostEnabled(env, "tui")).toBe(true);
    expect(isPaneHostEnabled(env, "rpc")).toBe(false);
    expect(isPaneHostEnabled(env, "print")).toBe(false);
    expect(isPaneHostEnabled({ HERDR_ENV: "1", HERDR_PANE_ID: "%p0" }, "tui")).toBe(false);
  });
});

describe("shared pane lifecycle", () => {
  it("coalesces concurrent ensures into a single split", async () => {
    const exec = vi.fn<PaneExec>(async (_command, args) =>
      ok(args[1] === "pane.split" ? '{"pane":"term_new","terminal":"t-new"}' : ""));
    const pane = controller(exec);
    await Promise.all([pane.ensurePane(false), pane.ensurePane(false), pane.ensurePane(false)]);
    expect(exec.mock.calls.filter(([, args]) => args[1] === "pane.split")).toHaveLength(1);
  });

  it("force reopens a manually closed pane and clears the close flag", async () => {
    writeRecord(dir, { paneId: "term_old", sentinel, closedByUser: true });
    const exec = vi.fn<PaneExec>(async (_command, args) =>
      ok(args[1] === "pane.split" ? '{"pane":"term_new","terminal":"t-new"}' : ""));
    await controller(exec).ensurePane(true);
    expect(readRecord(dir)).toEqual({ paneId: "term_new", sentinel, closedByUser: false });
  });

  it("keeps a live pane while clearing a stale manual-close flag on force", async () => {
    writeRecord(dir, { paneId: "term_live", sentinel, closedByUser: true });
    const exec = vi.fn<PaneExec>(async (command) => ok(JSON.stringify(command === "herdr-app"
      ? { spaces: [{ tabs: [{ id: "tab", name: "1", terminals: [{ terminal: "t-live", pane: "term_live" }] }] }] }
      : { address: "t-live", state: "live", labels: { "pi.graph-owner": sentinel } })));
    await controller(exec).ensurePane(true);
    expect(readRecord(dir)).toEqual({ paneId: "term_live", sentinel, closedByUser: false });
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it("does not invoke a host when closing without a record", async () => {
    const exec = vi.fn<PaneExec>(async () => ok());
    await controller(exec).closeOwned();
    expect(exec).not.toHaveBeenCalled();
  });

  it("remembers a user close even without a pane record", async () => {
    const exec = vi.fn<PaneExec>(async () => ok());
    const pane = controller(exec);
    await pane.closeForUser();
    await pane.ensurePane(false);
    expect(exec).not.toHaveBeenCalled();
    expect(readRecord(dir)?.closedByUser).toBe(true);
  });
});
