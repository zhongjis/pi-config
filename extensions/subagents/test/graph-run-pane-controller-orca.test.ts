// graph-run-pane-controller-orca.test.ts — the Orca pane lifecycle behind the same
// controller seam. Every `orca` call goes through an injected exec; these assert the
// ownership rules (sentinel via paneTitle, stale-handle recovery, close only our own).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GraphRunPaneController, isPaneHostEnabled } from "../src/graph/pane/controller.js";
import { readRecord, writeRecord } from "../src/graph/pane/store.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wfpane-orca-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const SENTINEL = "Graph run · sess1234";

function controller(exec: ReturnType<typeof vi.fn>) {
  return new GraphRunPaneController({
    exec: exec as any,
    host: "orca",
    dir,
    parentPaneId: "term_parent",
    cwd: "/work/it's dir",
    sessionId: "sess1234",
    viewerPath: "/viewer/viewer.mjs",
    ppid: 4242,
    sentinel: SENTINEL,
  });
}

const ok = (stdout = "") => ({ code: 0, stdout, stderr: "", killed: false });
const fail = () => ({ code: 1, stdout: "", stderr: "gone", killed: false });
const splitOut = (handle: string) => JSON.stringify({ result: { split: { handle } } });
const showOut = (paneTitle?: string) =>
  JSON.stringify({ result: { terminal: paneTitle === undefined ? { title: "zsh" } : { title: "zsh", paneTitle } } });
const listOut = (...rows: Array<{ handle: string; paneTitle?: string }>) => JSON.stringify({ terminals: rows });

/** Route exec by Orca subcommand. */
function router(routes: Partial<Record<"split" | "show" | "list" | "close" | "switch" | "set-pane-title", ReturnType<typeof ok>>>) {
  return vi.fn(async (_cmd: string, args: string[]) => routes[args[1] as keyof typeof routes] ?? ok());
}
const calls = (exec: ReturnType<typeof vi.fn>) => exec.mock.calls.map((c) => c[1] as string[]);

describe("isPaneHostEnabled", () => {
  it("accepts an Orca TUI pane only", () => {
    expect(isPaneHostEnabled({ ORCA_TERMINAL_HANDLE: "term_1" }, "tui")).toBe(true);
    expect(isPaneHostEnabled({ ORCA_TERMINAL_HANDLE: "term_1" }, "rpc")).toBe(false);
    expect(isPaneHostEnabled({}, "tui")).toBe(false);
  });
});

describe("Orca ensurePane — fresh split", () => {
  it("splits from the parent, restores focus, titles the pane, and records it", async () => {
    const exec = router({ split: ok(splitOut("term_new")) });
    await controller(exec).ensurePane(false);

    const [split, ...rest] = calls(exec);
    expect(split?.slice(0, 6)).toEqual(["terminal", "split", "--terminal", "term_parent", "--direction", "vertical"]);
    expect(split).toContain("--json");
    const command = split?.[split.indexOf("--command") + 1] ?? "";
    expect(command).toContain(`PI_GRAPH_RUN_PANE_DIR='${dir}'`);
    expect(command).toContain("'/work/it'\\''s dir'");
    expect(command).toContain("'/viewer/viewer.mjs'");
    expect(rest).toEqual([
      ["terminal", "switch", "--terminal", "term_parent"],
      ["terminal", "set-pane-title", "--terminal", "term_new", "--title", SENTINEL],
    ]);
    expect(readRecord(dir)).toEqual({ paneId: "term_new", sentinel: SENTINEL, closedByUser: false });
  });

  it("leaves no record and never switches when the split fails", async () => {
    const exec = router({ split: fail() });
    await controller(exec).ensurePane(false);
    expect(calls(exec)).toHaveLength(1);
    expect(readRecord(dir)).toBeUndefined();
  });
});

describe("Orca ensurePane — adopt / stale / repurposed", () => {
  it("adopts a live terminal that still carries the sentinel", async () => {
    writeRecord(dir, { paneId: "term_9", sentinel: SENTINEL, closedByUser: false });
    const exec = router({ show: ok(showOut(SENTINEL)) });
    await controller(exec).ensurePane(false);
    expect(calls(exec)).toEqual([["terminal", "show", "--terminal", "term_9", "--json"]]);
  });

  it("re-finds a restarted-runtime terminal by sentinel and updates the record", async () => {
    writeRecord(dir, { paneId: "term_old", sentinel: SENTINEL, closedByUser: false });
    const exec = router({ show: fail(), list: ok(listOut({ handle: "term_other", paneTitle: "mine" }, { handle: "term_re", paneTitle: SENTINEL })) });
    await controller(exec).ensurePane(false);
    expect(calls(exec).some((a) => a[1] === "split")).toBe(false);
    expect(readRecord(dir)?.paneId).toBe("term_re");
  });

  it("splits fresh and closes nothing when the terminal is gone or repurposed", async () => {
    writeRecord(dir, { paneId: "term_9", sentinel: SENTINEL, closedByUser: false });
    const exec = router({ show: ok(showOut("my editor")), list: ok(listOut({ handle: "term_9", paneTitle: "my editor" })), split: ok(splitOut("term_new")) });
    await controller(exec).ensurePane(false);
    expect(calls(exec).some((a) => a[1] === "close")).toBe(false);
    expect(readRecord(dir)?.paneId).toBe("term_new");
  });

  it("does not reopen after a manual close unless forced", async () => {
    writeRecord(dir, { paneId: "term_x", sentinel: SENTINEL, closedByUser: true });
    const exec = router({});
    await controller(exec).ensurePane(false);
    expect(exec).not.toHaveBeenCalled();
  });
});

describe("Orca close paths", () => {
  it("closeOwned closes only a validated own terminal", async () => {
    writeRecord(dir, { paneId: "term_9", sentinel: SENTINEL, closedByUser: false });
    const exec = router({ show: ok(showOut(SENTINEL)) });
    await controller(exec).closeOwned();
    expect(calls(exec)).toEqual([
      ["terminal", "show", "--terminal", "term_9", "--json"],
      ["terminal", "close", "--terminal", "term_9"],
    ]);
    expect(readRecord(dir)).toBeUndefined();
  });

  it("closeOwned skips the close when the terminal is no longer ours", async () => {
    writeRecord(dir, { paneId: "term_9", sentinel: SENTINEL, closedByUser: false });
    const exec = router({ show: ok(showOut("my editor")), list: ok(listOut()) });
    await controller(exec).closeOwned();
    expect(calls(exec).some((a) => a[1] === "close")).toBe(false);
    expect(readRecord(dir)).toBeUndefined();
  });

  it("closeForUser keeps the record flagged closedByUser", async () => {
    writeRecord(dir, { paneId: "term_9", sentinel: SENTINEL, closedByUser: false });
    const exec = router({ show: ok(showOut(SENTINEL)) });
    await controller(exec).closeForUser();
    expect(calls(exec)).toContainEqual(["terminal", "close", "--terminal", "term_9"]);
    expect(readRecord(dir)).toEqual({ paneId: "term_9", sentinel: SENTINEL, closedByUser: true });
  });

  it("reconcile clears a dead record without closing anything", async () => {
    writeRecord(dir, { paneId: "term_9", sentinel: SENTINEL, closedByUser: false });
    const exec = router({ show: fail(), list: ok(listOut()) });
    await controller(exec).reconcile();
    expect(readRecord(dir)).toBeUndefined();
    expect(calls(exec).some((a) => a[1] === "close")).toBe(false);
  });
});
