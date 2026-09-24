// graph-run-pane-controller.test.ts (S2 + S4) — the Herdr pane lifecycle. Every
// `herdr` call goes through an injected exec, so these assert the EXACT argv the
// controller shells out with, and the own-only-what-you-create rules: never
// close a pane the user renamed/repurposed, and never reopen after a manual
// close unless forced.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GraphRunPaneController, isHerdrPaneEnabled } from "../src/graph/pane/controller.js";
import { readRecord, writeRecord } from "../src/graph/pane/store.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wfpane-ctrl-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const SENTINEL = "Graph run · sess1234";

function controller(exec: ReturnType<typeof vi.fn>) {
  return new GraphRunPaneController({
    exec: exec as any,
    dir,
    parentPaneId: "%p0",
    cwd: "/work/dir",
    sessionId: "sess1234",
    viewerPath: "/viewer/viewer.mjs",
    ppid: 4242,
    sentinel: SENTINEL,
  });
}

const ok = (stdout = "") => ({ code: 0, stdout, stderr: "", killed: false });
const fail = (stderr = "") => ({ code: 1, stdout: "", stderr, killed: false });
const splitOut = (paneId: string) => JSON.stringify({ result: { pane: { pane_id: paneId } } });
const getOut = (paneId: string, label: string) =>
  JSON.stringify({ result: { pane: { pane_id: paneId, title: label } } });

describe("isHerdrPaneEnabled", () => {
  it("is true only inside a Herdr-managed TUI pane", () => {
    const base = { HERDR_ENV: "1", HERDR_PANE_ID: "%p0" } as NodeJS.ProcessEnv;
    expect(isHerdrPaneEnabled(base, "tui")).toBe(true);
    expect(isHerdrPaneEnabled(base, "rpc")).toBe(false);
    expect(isHerdrPaneEnabled(base, "print")).toBe(false);
    expect(isHerdrPaneEnabled({ HERDR_PANE_ID: "%p0" } as NodeJS.ProcessEnv, "tui")).toBe(false);
    expect(isHerdrPaneEnabled({ HERDR_ENV: "1" } as NodeJS.ProcessEnv, "tui")).toBe(false);
    expect(isHerdrPaneEnabled({ HERDR_ENV: "0", HERDR_PANE_ID: "%p0" } as NodeJS.ProcessEnv, "tui")).toBe(false);
  });
});

describe("ensurePane — fresh split", () => {
  it("splits with the exact argv, renames, runs the viewer, and records the pane", async () => {
    const exec = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === "pane" && args[1] === "split") return ok(splitOut("%p9"));
      return ok();
    });
    await controller(exec).ensurePane(false);

    expect(exec).toHaveBeenCalledWith(
      "herdr",
      [
        "pane",
        "split",
        "--pane",
        "%p0",
        "--direction",
        "right",
        "--ratio",
        "0.65",
        "--cwd",
        "/work/dir",
        "--env",
        `PI_GRAPH_RUN_PANE_DIR=${dir}`,
        "--no-focus",
      ],
      expect.anything(),
    );
    expect(exec).toHaveBeenCalledWith("herdr", ["pane", "rename", "%p9", SENTINEL], expect.anything());
    expect(exec).toHaveBeenCalledWith(
      "herdr",
      ["pane", "run", "%p9", "node", "/viewer/viewer.mjs", "--dir", dir, "--ppid", "4242", "--pane", "%p9"],
      expect.anything(),
    );
    expect(readRecord(dir)).toEqual({ paneId: "%p9", sentinel: SENTINEL, closedByUser: false });
  });
});

describe("ensurePane — adopt / gone / repurposed", () => {
  it("adopts a live pane that is still ours without splitting again", async () => {
    writeRecord(dir, { paneId: "%p9", sentinel: SENTINEL, closedByUser: false });
    const exec = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === "pane" && args[1] === "get") return ok(getOut("%p9", SENTINEL));
      return ok();
    });
    await controller(exec).ensurePane(false);
    expect(exec).toHaveBeenCalledWith("herdr", ["pane", "get", "%p9"], expect.anything());
    expect(exec).not.toHaveBeenCalledWith("herdr", expect.arrayContaining(["split"]), expect.anything());
    expect(readRecord(dir)?.paneId).toBe("%p9");
  });

  it("never closes a pane the user renamed/repurposed, and splits a fresh one", async () => {
    writeRecord(dir, { paneId: "%p9", sentinel: SENTINEL, closedByUser: false });
    const exec = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === "pane" && args[1] === "get") return ok(getOut("%p9", "my editor"));
      if (args[0] === "pane" && args[1] === "split") return ok(splitOut("%pNEW"));
      return ok();
    });
    await controller(exec).ensurePane(false);
    expect(exec).not.toHaveBeenCalledWith("herdr", ["pane", "close", "%p9"], expect.anything());
    expect(exec).toHaveBeenCalledWith("herdr", expect.arrayContaining(["pane", "split"]), expect.anything());
    expect(readRecord(dir)?.paneId).toBe("%pNEW");
  });

  it("does not close a pane that `get` reports as gone; it splits a fresh one", async () => {
    writeRecord(dir, { paneId: "%p9", sentinel: SENTINEL, closedByUser: false });
    const exec = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === "pane" && args[1] === "get") return fail("no such pane");
      if (args[0] === "pane" && args[1] === "split") return ok(splitOut("%pNEW"));
      return ok();
    });
    await controller(exec).ensurePane(false);
    expect(exec).not.toHaveBeenCalledWith("herdr", ["pane", "close", "%p9"], expect.anything());
    expect(readRecord(dir)?.paneId).toBe("%pNEW");
  });
});

describe("closedByUser", () => {
  it("blocks ensurePane(false) with zero shell-outs", async () => {
    writeRecord(dir, { paneId: "%pX", sentinel: SENTINEL, closedByUser: true });
    const exec = vi.fn(async () => ok());
    await controller(exec).ensurePane(false);
    expect(exec).not.toHaveBeenCalled();
    expect(readRecord(dir)?.closedByUser).toBe(true);
  });

  it("is overridden by ensurePane(true), which reopens and clears the flag", async () => {
    writeRecord(dir, { paneId: "%pX", sentinel: SENTINEL, closedByUser: true });
    const exec = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === "pane" && args[1] === "get") return fail("gone");
      if (args[0] === "pane" && args[1] === "split") return ok(splitOut("%pNEW"));
      return ok();
    });
    await controller(exec).ensurePane(true);
    expect(exec).toHaveBeenCalled();
    expect(readRecord(dir)).toEqual({ paneId: "%pNEW", sentinel: SENTINEL, closedByUser: false });
  });
});

describe("closeOwned", () => {
  it("closes only the recorded pane id, best-effort", async () => {
    writeRecord(dir, { paneId: "%p9", sentinel: SENTINEL, closedByUser: false });
    const exec = vi.fn(async () => ok());
    await controller(exec).closeOwned();
    expect(exec).toHaveBeenCalledWith("herdr", ["pane", "close", "%p9"], expect.anything());
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when there is no recorded pane", async () => {
    const exec = vi.fn(async () => ok());
    await controller(exec).closeOwned();
    expect(exec).not.toHaveBeenCalled();
  });
});

describe("closeForUser", () => {
  it("closes the recorded pane but KEEPS the record with closedByUser set", async () => {
    writeRecord(dir, { paneId: "%p9", sentinel: SENTINEL, closedByUser: false });
    const exec = vi.fn(async () => ok());
    await controller(exec).closeForUser();
    expect(exec).toHaveBeenCalledWith("herdr", ["pane", "close", "%p9"], expect.anything());
    // Unlike closeOwned, the record is preserved (paneId intact) with the user-close flag.
    expect(readRecord(dir)).toEqual({ paneId: "%p9", sentinel: SENTINEL, closedByUser: true });
  });
});

describe("reconcile", () => {
  it("adopts an alive pane and clears a dead record", async () => {
    // Alive + ours: keep it.
    writeRecord(dir, { paneId: "%p9", sentinel: SENTINEL, closedByUser: false });
    let exec = vi.fn(async (_cmd: string, args: string[]) =>
      args[1] === "get" ? ok(getOut("%p9", SENTINEL)) : ok(),
    );
    await controller(exec).reconcile();
    expect(readRecord(dir)?.paneId).toBe("%p9");
    expect(exec).not.toHaveBeenCalledWith("herdr", expect.arrayContaining(["close"]), expect.anything());

    // Dead: forget it, without closing anything.
    exec = vi.fn(async (_cmd: string, args: string[]) => (args[1] === "get" ? fail("gone") : ok()));
    await controller(exec).reconcile();
    expect(readRecord(dir)).toBeUndefined();
    expect(exec).not.toHaveBeenCalledWith("herdr", expect.arrayContaining(["close"]), expect.anything());
  });
});
