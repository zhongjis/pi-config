import { describe, expect, it, vi } from "vitest";

// vi.mock is hoisted — must be at top level
vi.mock("node:child_process", () => ({
  spawn: () => {
    const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
    const stdin = { end: () => {} };
    const stderr = {
      on: (event: string, cb: (...args: unknown[]) => void) => {
        listeners[event] = listeners[event] ?? [];
        listeners[event].push(cb);
      },
    };
    return {
      stdin,
      stderr,
      on: (event: string, cb: (...args: unknown[]) => void) => {
        if (event === "error") {
          // Emit error asynchronously to simulate process failure
          setTimeout(() => cb(new Error("not found")), 0);
        }
        listeners[event] = listeners[event] ?? [];
        listeners[event].push(cb);
      },
    };
  },
}));

import { writeClipboard } from "../clipboard.js";

// ---------------------------------------------------------------------------
// writeClipboard — fallback / error paths
// ---------------------------------------------------------------------------

describe("writeClipboard", () => {
  it("throws a descriptive error when all backends fail", async () => {
    await expect(writeClipboard("test text")).rejects.toThrow("Clipboard copy failed");
  });
});
