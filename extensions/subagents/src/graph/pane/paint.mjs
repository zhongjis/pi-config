/**
 * paint.mjs — one in-place frame for the Herdr pane.
 *
 * Herdr composes the pane mid-stream, so a full-screen erase blinks. Each frame
 * homes every row and overwrites it; DEC 2026 makes that update atomic. Plain
 * JS (no deps) so both the `.mjs` viewer and vitest can import it.
 */
const SYNC_BEGIN = "\x1b[?2026h"; // DEC 2026 synchronized output: the frame lands atomically
const SYNC_END = "\x1b[?2026l";
const SGR_RESET = "\x1b[m";
export const ENDED_NOTICE = "Pi session ended — press q to close";
/** Clamp to the pane height; once the parent is gone keep the notice on the last rows. */
export function shownLines(lines, { rows, parentGone }) {
  const tail = parentGone ? ["", ENDED_NOTICE] : [];
  if (!(rows > 0)) return [...lines, ...tail];
  return [...lines.slice(0, Math.max(0, rows - tail.length)), ...tail].slice(0, rows);
}
/** One synchronized frame that overwrites each row in place and never erases the whole screen. */
export function paintFrame(shown, rows) {
  let out = SYNC_BEGIN;
  shown.forEach((line, i) => { out += `\x1b[${i + 1};1H${SGR_RESET}\x1b[2K${line}`; });
  if (rows > 0 && shown.length < rows) out += `\x1b[${shown.length + 1};1H${SGR_RESET}\x1b[J`;
  return out + SGR_RESET + SYNC_END;
}
