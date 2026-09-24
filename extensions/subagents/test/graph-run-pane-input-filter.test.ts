// graph-run-pane-input-filter.test.ts — the viewer forwards ONLY real nav keys.
// A raw-stdin pane in a live terminal also receives mouse reports, focus
// events, device-attribute replies, bracketed-paste markers, and escape
// fragments split across reads. Forwarding those made the extension read a
// stray ESC as `cancel` and self-close the pane (the "seems crashed" bug).
import { describe, expect, it } from "vitest";
import { classifyPaneKey } from "../src/graph/pane/input-filter.mjs";

describe("classifyPaneKey", () => {
  it("forwards the nav keys the inspector uses", () => {
    for (const k of ["\x1b[A", "\x1b[B", "\x1b[C", "\x1b[D", "\x1bOA", "\x1bOB", "\x1bOC", "\x1bOD", "\x1b[5~", "\x1b[6~", "\r", "\n", " ", "j", "k", "f", "e"]) {
      expect(classifyPaneKey(k)).toBe("forward");
    }
  });

  it("treats a lone ESC as escape (real Escape key)", () => {
    expect(classifyPaneKey("\x1b")).toBe("escape");
  });

  it("drops terminal noise that must never read as a key", () => {
    for (const k of [
      "\x1b[M   ",        // X10 mouse report
      "\x1b[<0;12;5M",    // SGR mouse press
      "\x1b[<0;12;5m",    // SGR mouse release
      "\x1b[I",           // focus in
      "\x1b[O",           // focus out
      "\x1b[?1;2c",       // primary device attributes reply
      "\x1b[8;40;120t",   // window report
      "\x1b[200~",        // bracketed paste start
      "\x1b[201~",        // bracketed paste end
      "\x1b[H",           // stray CSI
      "\t",               // tab (unused)
      "x", "p", "s", "r", "c", "z", // non-nav / mutating keys the pane must ignore
      "abc",              // multi-byte junk
      "",                 // empty
    ]) {
      expect(classifyPaneKey(k)).toBe("drop");
    }
  });
});
