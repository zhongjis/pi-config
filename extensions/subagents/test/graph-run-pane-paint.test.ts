// Herdr composes the pane mid-stream, so a full-screen erase on every safety
// poll blinks. The viewer must paint one synchronized in-place frame and skip
// a rewrite when the frame has not changed.
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyPaneKey } from "../src/graph/pane/input-filter.mjs";
import { ENDED_NOTICE, paintFrame, shownLines } from "../src/graph/pane/paint.mjs";

const ALT_ENTER = "\x1b[?1049h\x1b[?25l";
const SAFETY_POLL_MS = 400;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wfpane-paint-"));
  writeFileSync(join(dir, "state.json"), JSON.stringify({
    version: 1, sessionId: "s", updatedAt: 1, connected: true, lines: ["alpha", "beta"],
  }));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

type Timer = { cb: () => void; ms: number; cleared: boolean };

function startViewer() {
  const writes: string[] = [];
  const timeouts: Timer[] = [];
  const intervals: Timer[] = [];
  const stdin = Object.assign(new EventEmitter(), { isTTY: true, setRawMode() {}, resume() {} });
  const stdout = Object.assign(new EventEmitter(), {
    rows: 5,
    columns: 40,
    write(chunk: string | Uint8Array) {
      writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    },
  });
  const proc = Object.assign(new EventEmitter(), {
    argv: ["node", "viewer.mjs", "--dir", dir],
    pid: process.pid,
    stdin,
    stdout,
    stderr: { write() {} },
    exit() { throw new Error("viewer exited"); },
    kill() { return true; },
  });
  const source = readFileSync(new URL("../src/graph/pane/viewer.mjs", import.meta.url), "utf8");
  runInNewContext(source.replace(/^import .+;$/gm, ""), {
    process: proc,
    Buffer, existsSync, readFileSync, renameSync, writeFileSync, join, classifyPaneKey,
    paintFrame, shownLines,
    watch: () => ({ close() {} }),
    setTimeout: vi.fn((cb: () => void, ms?: number) => {
      const timer: Timer = { cb, ms: ms ?? 0, cleared: false };
      timeouts.push(timer);
      return timer;
    }),
    clearTimeout: vi.fn((timer?: Timer) => { if (timer) timer.cleared = true; }),
    setInterval: vi.fn((cb: () => void, ms?: number) => {
      const timer: Timer = { cb, ms: ms ?? 0, cleared: false };
      intervals.push(timer);
      return timer;
    }),
    clearInterval: vi.fn((timer?: Timer) => { if (timer) timer.cleared = true; }),
  });

  function flushDebounce() {
    const pending = timeouts.filter(timer => !timer.cleared);
    for (const timer of pending) timer.cleared = true;
    for (const timer of pending) timer.cb();
  }
  function triggerSafetyPoll() {
    const poll = intervals.find(timer => timer.ms === SAFETY_POLL_MS && !timer.cleared);
    if (!poll) throw new Error("safety poll was not scheduled");
    poll.cb();
    flushDebounce();
  }
  const frames = () => writes.filter(chunk => chunk !== ALT_ENTER);
  return { frames, stdout, proc, triggerSafetyPoll, flushDebounce };
}

function expectSynchronized(frames: string[]) {
  expect(frames.length).toBeGreaterThan(0);
  for (const frame of frames) {
    expect(frame).not.toContain("\x1b[2J");
    expect(frame).not.toContain("\x1b[3J");
    expect(frame.startsWith("\x1b[?2026h")).toBe(true);
    expect(frame.endsWith("\x1b[?2026l")).toBe(true);
  }
}

describe("viewer", () => {
  it("paints synchronized in-place frames and never erases the screen", () => {
    const viewer = startViewer();
    expectSynchronized(viewer.frames());
  });

  it("does not write a frame when the safety poll sees unchanged lines", () => {
    const viewer = startViewer();
    const before = viewer.frames().length;
    for (let i = 0; i < 5; i++) viewer.triggerSafetyPoll();
    expect(viewer.frames().length).toBe(before);
    expectSynchronized(viewer.frames());
  });

  it("writes exactly one frame when state.json lines change", () => {
    const viewer = startViewer();
    writeFileSync(join(dir, "state.json"), JSON.stringify({
      version: 1, sessionId: "s", updatedAt: 2, connected: true, lines: ["gamma"],
    }));
    const before = viewer.frames().length;
    viewer.triggerSafetyPoll();
    const frames = viewer.frames();
    expect(frames.length).toBe(before + 1);
    expect(frames.at(-1)).toContain("gamma");
    expect(frames.at(-1)).not.toContain("alpha");
    expectSynchronized(frames);
  });

  it("writes one frame when the pane is resized with unchanged lines", () => {
    const viewer = startViewer();
    const before = viewer.frames().length;
    viewer.stdout.emit("resize");
    viewer.flushDebounce();
    expect(viewer.frames().length).toBe(before + 1);
    expectSynchronized(viewer.frames());
  });

  it("writes one frame on SIGWINCH with unchanged lines", () => {
    const viewer = startViewer();
    const before = viewer.frames().length;
    viewer.proc.emit("SIGWINCH");
    viewer.flushDebounce();
    expect(viewer.frames().length).toBe(before + 1);
    expectSynchronized(viewer.frames());
  });
});

describe("paintFrame", () => {
  it("overwrites each row in place inside a synchronized frame", () => {
    const frame = paintFrame(["a", "b"], 4);
    expect(frame).not.toContain("\x1b[2J");
    expect(frame).not.toContain("\x1b[3J");
    expect(frame.startsWith("\x1b[?2026h")).toBe(true);
    expect(frame.endsWith("\x1b[?2026l")).toBe(true);
    expect(frame).toContain("\x1b[1;1H\x1b[m\x1b[2Ka");
    expect(frame).toContain("\x1b[2;1H\x1b[m\x1b[2Kb");
    expect(frame).toContain("\x1b[3;1H\x1b[m\x1b[J");
  });

  it("does not erase below a full-height frame", () => {
    expect(paintFrame(["a", "b"], 2)).not.toContain("\x1b[J");
  });
});

describe("shownLines", () => {
  it("clamps to the pane height", () => {
    expect(shownLines(["a", "b", "c", "d"], { rows: 2, parentGone: false })).toEqual(["a", "b"]);
  });

  it("keeps the ended notice on the last rows when the parent is gone", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `L${i}`);
    expect(ENDED_NOTICE).toBe("Pi session ended — press q to close");
    expect(shownLines(lines, { rows: 5, parentGone: true })).toEqual(["L0", "L1", "L2", "", ENDED_NOTICE]);
  });

  it("appends the notice unclamped when rows is not positive", () => {
    expect(shownLines(["a", "b"], { rows: 0, parentGone: true })).toEqual(["a", "b", "", ENDED_NOTICE]);
  });
});
