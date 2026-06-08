import { describe, expect, it } from "vitest";
import { isTui } from "../mode.js";

// ---------------------------------------------------------------------------
// isTui
// ---------------------------------------------------------------------------

describe("isTui", () => {
  it("returns true only for mode === 'tui'", () => {
    expect(isTui({ mode: "tui" })).toBe(true);
  });

  it("returns false for mode === 'rpc' (custom() returns undefined under RPC)", () => {
    expect(isTui({ mode: "rpc" })).toBe(false);
  });

  it("returns false for mode === 'json' and 'print'", () => {
    expect(isTui({ mode: "json" })).toBe(false);
    expect(isTui({ mode: "print" })).toBe(false);
  });
});
