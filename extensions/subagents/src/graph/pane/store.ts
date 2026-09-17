/**
 * store.ts — the per-pane state directory the extension writes and the viewer
 * reads.
 *
 * The extension is the single source of truth for what the pane shows: it owns
 * the layout (see `render.ts`) and drops styled ANSI lines into `state.json`,
 * which the plain-Node viewer prints. Every file here is read by a separate
 * process while this one rewrites it, so each write is tmp-then-rename — a reader
 * only ever sees a whole, previous or next version, never a half-written one.
 *
 * Three files live in the directory:
 *   - `state.json`    — the rendered snapshot the viewer paints (extension → viewer)
 *   - `pane.json`     — the ownership record, so we only ever touch the pane we
 *                        created and can honour a manual close (extension ↔ viewer)
 *   - `viewport.json` — the viewer's terminal size, so the extension can render at
 *                        the pane's real width (viewer → extension)
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const STATE_FILE = "state.json";
export const RECORD_FILE = "pane.json";
export const VIEWPORT_FILE = "viewport.json";
export const INPUT_FILE = "input.json";

/** The rendered snapshot the viewer paints. */
export interface PaneSnapshot {
  version: 1;
  sessionId: string;
  updatedAt: number;
  connected: boolean;
  lines: string[];
}

/**
 * The ownership record. `sentinel` is the pane label we set with `rename`; the
 * controller re-checks it before touching a pane, so a pane the user renamed or
 * repurposed reads as "not ours" and is left alone. `closedByUser` survives a
 * manual close so the pane is not auto-reopened until `/graph-runs`.
 */
export interface PaneRecord {
  paneId: string;
  sentinel: string;
  closedByUser: boolean;
}

/** The viewer's terminal geometry, written on start and on resize. */
export interface Viewport {
  cols: number;
  rows: number;
  pid: number;
}

/**
 * The single-slot input channel (viewer → extension). The viewer captures raw
 * stdin and drops the bytes here base64-encoded, so control characters and
 * arrow-key ESC sequences survive JSON. `seq` monotonically increases so the
 * extension applies each chunk exactly once and ignores stale re-reads.
 */
export interface PaneInput {
  seq: number;
  /** base64 of the raw stdin bytes. */
  data: string;
}

/**
 * A stable directory for one pane's state, keyed on the triple that identifies a
 * pane within one Herdr server: which socket, which parent pane, which session.
 * The same trick herdr-btw/omo use for their view keys — a hash keeps the path
 * short and filesystem-safe whatever the inputs contain.
 */
export function paneDirFor(sessionId: string, parentPaneId: string, socket: string): string {
  const hash = createHash("sha256")
    .update([socket, parentPaneId, sessionId].join("\0"))
    .digest("hex")
    .slice(0, 16);
  return join(tmpdir(), "pi-subagents-wfpane", hash);
}

/** Write `data` to `filePath` atomically: a reader sees the old or new file, never a torn one. */
function writeJsonAtomic(filePath: string, data: unknown): void {
  mkdirSync(join(filePath, ".."), { recursive: true });
  const tmp = `${filePath}.tmp.${randomBytes(6).toString("hex")}`;
  try {
    writeFileSync(tmp, JSON.stringify(data), "utf8");
    renameSync(tmp, filePath);
  } catch (err) {
    // Never leave the scratch file behind when the rename could not complete.
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** Parse a JSON file, returning undefined for a missing or malformed one. */
function readJson(filePath: string): unknown {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return undefined;
  }
}

export function writeSnapshotAtomic(dir: string, snapshot: PaneSnapshot): void {
  writeJsonAtomic(join(dir, STATE_FILE), snapshot);
}

export function writeRecord(dir: string, record: PaneRecord): void {
  writeJsonAtomic(join(dir, RECORD_FILE), record);
}

export function readRecord(dir: string): PaneRecord | undefined {
  const parsed = readJson(join(dir, RECORD_FILE));
  if (
    parsed !== null &&
    typeof parsed === "object" &&
    typeof (parsed as PaneRecord).paneId === "string" &&
    typeof (parsed as PaneRecord).sentinel === "string" &&
    typeof (parsed as PaneRecord).closedByUser === "boolean"
  ) {
    const { paneId, sentinel, closedByUser } = parsed as PaneRecord;
    return { paneId, sentinel, closedByUser };
  }
  return undefined;
}

export function clearRecord(dir: string): void {
  rmSync(join(dir, RECORD_FILE), { force: true });
}

export function writeViewport(dir: string, viewport: Viewport): void {
  writeJsonAtomic(join(dir, VIEWPORT_FILE), viewport);
}

export function readViewport(dir: string): Viewport | undefined {
  const parsed = readJson(join(dir, VIEWPORT_FILE));
  if (
    parsed !== null &&
    typeof parsed === "object" &&
    typeof (parsed as Viewport).cols === "number" &&
    typeof (parsed as Viewport).rows === "number" &&
    typeof (parsed as Viewport).pid === "number"
  ) {
    const { cols, rows, pid } = parsed as Viewport;
    return { cols, rows, pid };
  }
  return undefined;
}

export function writeInputAtomic(dir: string, input: PaneInput): void {
  writeJsonAtomic(join(dir, INPUT_FILE), input);
}

export function readInput(dir: string): PaneInput | undefined {
  const parsed = readJson(join(dir, INPUT_FILE));
  if (
    parsed !== null &&
    typeof parsed === "object" &&
    typeof (parsed as PaneInput).seq === "number" &&
    typeof (parsed as PaneInput).data === "string"
  ) {
    const { seq, data } = parsed as PaneInput;
    return { seq, data };
  }
  return undefined;
}

/** Whether the pane's state directory still exists — the viewer exits when it does not. */
export function paneDirExists(dir: string): boolean {
  return existsSync(dir);
}
