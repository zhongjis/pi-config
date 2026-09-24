#!/usr/bin/env node
/**
 * viewer.mjs — the plain-Node reader that runs inside the Herdr side pane.
 *
 * It owns no layout. The extension renders the graph run overview in-process (see
 * render.ts), writes styled ANSI lines to `<dir>/state.json` with an atomic
 * rename, and this process paints them: clear, home, print, repeat on change.
 * That keeps the shared layout the single source of truth and needs no bundler,
 * no dist, and no runtime dependencies here — only Node built-ins.
 *
 * Invocation:  node viewer.mjs --dir <paneStateDir> --ppid <piPid>
 *
 * It repaints on `fs.watch` (debounced) plus a slow safety poll (watch is
 * unreliable on macOS), reports its terminal size back through `viewport.json`,
 * self-terminates when the parent pi process is gone or the state directory is
 * removed, and quits on q / Ctrl+C / Ctrl+D — marking the close as the user's so
 * the extension does not reopen the pane until a detach (`o` in the Agent Monitor or graph panel).
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import { classifyPaneKey } from "./input-filter.mjs";

const REPAINT_DEBOUNCE_MS = 30;
const SAFETY_POLL_MS = 400;
const PARENT_POLL_MS = 1000;

function parseArgs(argv) {
  const out = { dir: undefined, ppid: undefined, pane: undefined };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dir") out.dir = argv[++i];
    else if (argv[i] === "--ppid") out.ppid = Number(argv[++i]);
    else if (argv[i] === "--pane") out.pane = argv[++i];
  }
  return out;
}

const { dir, ppid, pane } = parseArgs(process.argv.slice(2));

if (!dir) {
  process.stderr.write("viewer.mjs: --dir <paneStateDir> is required\n");
  process.exit(2);
}

const stateFile = join(dir, "state.json");
const viewportFile = join(dir, "viewport.json");
const recordFile = join(dir, "pane.json");
const inputFile = join(dir, "input.json");

let repaintTimer = null;
let watcher = null;
let safetyTimer = null;
let parentTimer = null;
let parentGone = false;
let lastLines = [];
let inputSeq = 0;
try {
  const input = JSON.parse(readFileSync(inputFile, "utf8"));
  if (input && Number.isSafeInteger(input.seq) && input.seq >= 0 && typeof input.data === "string") {
    inputSeq = input.seq;
  }
} catch {
  // A missing or malformed slot starts a fresh input sequence.
}
let escPending = false;
let escTimer = null;

/** Write JSON atomically with the same tmp+rename contract the extension uses. */
function writeJsonAtomic(filePath, data) {
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  try {
    writeFileSync(tmp, JSON.stringify(data));
    renameSync(tmp, filePath);
  } catch {
    // Best-effort; a failed viewport/record write is not worth crashing the pane.
  }
}

function writeViewport() {
  writeJsonAtomic(viewportFile, {
    cols: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
    pid: process.pid,
  });
}

function markClosedByUser() {
  let record = {};
  try {
    const parsed = JSON.parse(readFileSync(recordFile, "utf8"));
    if (parsed && typeof parsed === "object") record = parsed;
  } catch {
    // No record yet, or unreadable — a fresh object still records the intent.
  }
  record.closedByUser = true;
  writeJsonAtomic(recordFile, record);
}

function readLines() {
  try {
    const parsed = JSON.parse(readFileSync(stateFile, "utf8"));
    if (parsed && Array.isArray(parsed.lines)) return parsed.lines;
  } catch {
    // Partial writes cannot happen (atomic rename), but stay defensive anyway.
  }
  return null;
}

function paint(lines) {
  // Clear scrollback + screen, home the cursor, then print each row from column
  // zero (\r\n, since raw-mode stdin can disable the tty's LF→CRLF translation).
  let out = "\x1b[2J\x1b[3J\x1b[H";
  out += lines.join("\r\n");
  process.stdout.write(out);
}

function repaint() {
  if (!existsSync(dir)) {
    // The extension tore the pane's state down — nothing left to show.
    quit(false);
    return;
  }
  const lines = readLines();
  if (lines) lastLines = lines;
  const shown = parentGone ? [...lastLines, "", "Pi session ended — press q to close"] : lastLines;
  paint(shown);
}

function scheduleRepaint() {
  if (repaintTimer) clearTimeout(repaintTimer);
  repaintTimer = setTimeout(() => {
    repaintTimer = null;
    repaint();
  }, REPAINT_DEBOUNCE_MS);
}

function stopWatching() {
  if (watcher) {
    try {
      watcher.close();
    } catch {
      // ignore
    }
    watcher = null;
  }
  if (safetyTimer) {
    clearInterval(safetyTimer);
    safetyTimer = null;
  }
}

function checkParent() {
  if (!ppid || parentGone) return;
  try {
    process.kill(ppid, 0);
  } catch {
    parentGone = true;
    stopWatching();
    if (parentTimer) {
      clearInterval(parentTimer);
      parentTimer = null;
    }
    repaint();
  }
}

function restoreTerminal() {
  try {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
  } catch {
    // ignore
  }
  // Show the cursor and leave the alternate screen.
  process.stdout.write("\x1b[?25h\x1b[?1049l");
}

let exiting = false;
function quit(userInitiated) {
  if (exiting) return;
  exiting = true;
  if (userInitiated) markClosedByUser();
  stopWatching();
  if (parentTimer) {
    clearInterval(parentTimer);
    parentTimer = null;
  }
  if (repaintTimer) {
    clearTimeout(repaintTimer);
    repaintTimer = null;
  }
  restoreTerminal();
  // A user-initiated quit (q / Ctrl+C / Ctrl+D) also closes this herdr pane so
  // it is not left as an empty shell. Best-effort, and only for the pane we were
  // told to own; a SIGTERM / parent-gone / dir-removed quit leaves it alone.
  if (userInitiated && pane) {
    try {
      execFileSync("herdr", ["pane", "close", pane], { timeout: 5000, stdio: "ignore" });
    } catch {
      // The pane may already be gone; nothing to do.
    }
  }
  process.stdout.write("\x1b[2J\x1b[H");
  process.exit(0);
}

/**
 * Forward one raw stdin chunk to the extension. The bytes are base64-encoded so
 * control characters and arrow-key ESC sequences survive JSON; the extension
 * decodes and interprets them with pi-tui's matchesKey. `onKey` decides WHAT is
 * forwarded — only real nav keys — so terminal noise never reaches the handler.
 */
function forwardInput(buf) {
  inputSeq++;
  writeJsonAtomic(inputFile, { seq: inputSeq, data: Buffer.from(buf).toString("base64") });
}

/** Resolve a buffered lone ESC as a real Escape once no continuation arrived. */
function flushEsc() {
  escTimer = null;
  if (!escPending) return;
  escPending = false;
  forwardInput(Buffer.from("\x1b", "latin1"));
}

function onKey(buf) {
  const s = buf.toString("latin1");
  // A lone ESC is buffered (below); the next chunk may complete a split escape
  // sequence — combine and re-classify so mouse/focus/reply sequences torn
  // across reads are dropped instead of read as an Escape.
  if (escPending) {
    escPending = false;
    if (escTimer) {
      clearTimeout(escTimer);
      escTimer = null;
    }
    const combined = `\x1b${s}`;
    if (classifyPaneKey(combined) === "forward") forwardInput(Buffer.from(combined, "latin1"));
    return; // otherwise it was noise (e.g. \x1b[M… mouse); drop it
  }
  // q, Ctrl+C, Ctrl+D close the pane LOCALLY (and mark it a user close).
  if (s === "q" || s === "\x03" || s === "\x04") {
    quit(true);
    return;
  }
  // Raw stdin in a live terminal also carries mouse reports, focus events,
  // device replies and paste markers — only whitelisted nav keys are forwarded.
  const kind = classifyPaneKey(s);
  if (kind === "forward") {
    forwardInput(buf);
    return;
  }
  if (kind === "escape") {
    // Hold a lone ESC briefly: forward it as Escape only if nothing follows, so
    // the first byte of a split sequence does not read as a close.
    escPending = true;
    escTimer = setTimeout(flushEsc, 60);
  }
  // else drop
}

function main() {
  // Enter the alternate screen and hide the cursor.
  process.stdout.write("\x1b[?1049h\x1b[?25l");
  writeViewport();
  repaint();

  try {
    watcher = watch(dir, () => scheduleRepaint());
  } catch {
    // fs.watch can fail on some filesystems; the safety poll covers it.
  }
  safetyTimer = setInterval(scheduleRepaint, SAFETY_POLL_MS);
  parentTimer = setInterval(checkParent, PARENT_POLL_MS);

  if (process.stdin.isTTY) {
    try {
      process.stdin.setRawMode(true);
    } catch {
      // ignore
    }
    process.stdin.resume();
    process.stdin.on("data", onKey);
  }

  process.stdout.on("resize", () => {
    writeViewport();
    scheduleRepaint();
  });
  process.on("SIGWINCH", () => {
    writeViewport();
    scheduleRepaint();
  });
  process.on("SIGTERM", () => quit(false));
  process.on("SIGINT", () => quit(true));
}

main();
