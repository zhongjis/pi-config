import { describe, expect, it } from "vitest";
import { detectPaneHost } from "../pane-host.js";

describe("detectPaneHost", () => {
  it("detects Herdr from its env pair", () => {
    expect(detectPaneHost({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" })).toBe("herdr");
  });

  it("detects Orca from the terminal handle", () => {
    expect(detectPaneHost({ ORCA_TERMINAL_HANDLE: "term_1" })).toBe("orca");
  });

  it("prefers Herdr over stale Orca variables", () => {
    expect(detectPaneHost({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", ORCA_TERMINAL_HANDLE: "term_1" })).toBe("herdr");
  });

  it.each([
    {},
    { HERDR_ENV: "1" },
    { HERDR_PANE_ID: "w1:p1" },
    { HERDR_ENV: "0", HERDR_PANE_ID: "w1:p1" },
    { ORCA_TERMINAL_HANDLE: "" },
  ])("returns undefined without a usable host: %j", (env) => {
    expect(detectPaneHost(env)).toBeUndefined();
  });
});
