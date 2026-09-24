// graph-run-pane-store.test.ts (S3) — the per-pane state directory and its atomic
// writes. The viewer reads these files while the extension rewrites them, so
// every write has to land whole (tmp + rename) and leave no debris.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearRecord,
  INPUT_FILE,
  type PaneInput,
  paneDirFor,
  readInput,
  readRecord,
  readViewport,
  STATE_FILE,
  writeInputAtomic,
  writeRecord,
  writeSnapshotAtomic,
  writeViewport,
} from "../src/graph/pane/store.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wfpane-store-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("writeSnapshotAtomic", () => {
  it("writes valid JSON with the snapshot fields", () => {
    writeSnapshotAtomic(dir, { version: 1, sessionId: "s1", updatedAt: 42, connected: true, lines: ["a", "b"] });
    const parsed = JSON.parse(readFileSync(join(dir, STATE_FILE), "utf8"));
    expect(parsed).toMatchObject({ version: 1, sessionId: "s1", updatedAt: 42, connected: true, lines: ["a", "b"] });
  });

  it("stays valid and leaves no tmp debris across repeated writes", () => {
    for (let i = 0; i < 8; i++) {
      writeSnapshotAtomic(dir, { version: 1, sessionId: "s1", updatedAt: i, connected: true, lines: [`line-${i}`] });
    }
    const parsed = JSON.parse(readFileSync(join(dir, STATE_FILE), "utf8"));
    expect(parsed.lines).toEqual(["line-7"]);
    const debris = readdirSync(dir).filter(name => name.includes(".tmp."));
    expect(debris).toEqual([]);
  });
});

describe("record helpers", () => {
  it("round-trips the ownership record and clears it", () => {
    expect(readRecord(dir)).toBeUndefined();
    writeRecord(dir, { paneId: "%p9", sentinel: "Graph run · sess1234", closedByUser: false });
    expect(readRecord(dir)).toEqual({ paneId: "%p9", sentinel: "Graph run · sess1234", closedByUser: false });
    clearRecord(dir);
    expect(readRecord(dir)).toBeUndefined();
  });

  it("returns undefined for a malformed record rather than throwing", () => {
    writeRecord(dir, { paneId: "%p9", sentinel: "s", closedByUser: false });
    // Corrupt it.
    rmSync(join(dir, "pane.json"));
    expect(readRecord(dir)).toBeUndefined();
  });
});

describe("viewport", () => {
  it("round-trips the viewport atomically", () => {
    expect(readViewport(dir)).toBeUndefined();
    writeViewport(dir, { cols: 120, rows: 40, pid: 4242 });
    expect(readViewport(dir)).toEqual({ cols: 120, rows: 40, pid: 4242 });
  });
});

describe("input channel", () => {
  it("round-trips the input slot atomically", () => {
    expect(readInput(dir)).toBeUndefined();
    const input: PaneInput = { seq: 3, data: Buffer.from("j").toString("base64") };
    writeInputAtomic(dir, input);
    expect(readInput(dir)).toEqual(input);
    // Written to the documented filename.
    const parsed = JSON.parse(readFileSync(join(dir, INPUT_FILE), "utf8"));
    expect(parsed).toMatchObject({ seq: 3 });
  });

  it("survives base64-encoded control bytes (arrow-key ESC sequences)", () => {
    const raw = Buffer.from("\x1b[B", "binary");
    writeInputAtomic(dir, { seq: 1, data: raw.toString("base64") });
    const back = readInput(dir);
    expect(back).toBeDefined();
    expect(Buffer.from(back!.data, "base64").toString("utf8")).toBe("\x1b[B");
  });

  it("rejects a malformed input slot rather than throwing", () => {
    writeInputAtomic(dir, { seq: 1, data: "x" });
    rmSync(join(dir, INPUT_FILE));
    expect(readInput(dir)).toBeUndefined();
    // A record with the wrong field types is rejected too.
    writeSnapshotAtomic(dir, { version: 1, sessionId: "s", updatedAt: 0, connected: true, lines: [] });
    // state.json is not an input slot; readInput only reads input.json.
    expect(readInput(dir)).toBeUndefined();
  });
});

describe("paneDirFor", () => {
  it("is stable for the same inputs and distinct for different ones", () => {
    expect(paneDirFor("s", "p", "sock")).toBe(paneDirFor("s", "p", "sock"));
    expect(paneDirFor("s", "p", "sock")).not.toBe(paneDirFor("s2", "p", "sock"));
    expect(paneDirFor("s", "p", "sock")).not.toBe(paneDirFor("s", "p2", "sock"));
    expect(paneDirFor("s", "p", "sock")).not.toBe(paneDirFor("s", "p", "sock2"));
  });

  it("lands under the shared per-user tmp root", () => {
    expect(paneDirFor("s", "p", "sock").startsWith(join(tmpdir(), "pi-subagents-wfpane"))).toBe(true);
  });
});
