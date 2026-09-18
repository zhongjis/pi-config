/**
 * input-filter.mjs — decide whether a raw stdin chunk from the pane is a real
 * navigation key the extension should act on.
 *
 * The viewer runs in a live terminal in raw mode, so its stdin carries far more
 * than keystrokes: mouse reports, focus in/out events, device-attribute and
 * cursor-position replies, bracketed-paste markers, and escape sequences split
 * across reads. Forwarding those unfiltered let a stray ESC reach the
 * extension, which read it as `cancel` and closed the pane on its own (the
 * "pane seems crashed" bug). Only whitelisted nav keys are forwarded; a lone
 * ESC is reported separately so the viewer can disambiguate a real Escape from
 * the first byte of a split sequence.
 *
 * Plain JS (no deps) so both the `.mjs` viewer and the vitest suite can import
 * it — the viewer cannot import the project's TypeScript modules.
 *
 * @param {string} chunk one raw stdin chunk (latin1/utf8 bytes as a string)
 * @returns {"forward" | "escape" | "drop"}
 */
export function classifyPaneKey(chunk) {
  if (chunk === "\x1b") return "escape"; // a lone ESC — a real Escape key, or a split-sequence head
  if (FORWARD.has(chunk)) return "forward";
  return "drop"; // mouse, focus, DA/cursor replies, paste markers, and every non-nav key
}

/**
 * The exact keys the read-only inspector reacts to: arrows (normal + application
 * cursor mode), page up/down, Enter, Space, and the single-char nav keys `j k f e`.
 * Everything else — including mutating keys (`x p s r c`), tab, and `q` (handled
 * locally as close) — is intentionally absent so it is dropped rather than forwarded.
 */
const FORWARD = new Set([
  "\x1b[A", "\x1b[B", "\x1b[C", "\x1b[D", // arrow keys
  "\x1bOA", "\x1bOB", "\x1bOC", "\x1bOD", // arrows in application cursor mode
  "\x1b[5~", "\x1b[6~", // page up / page down
  "\r", "\n", // enter
  " ", "j", "k", "f", "e", // fold / down / up / filter / expand
]);
