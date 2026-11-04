import { describe, expect, it } from "vitest";
import { detectPaneHost } from "../pane-host.js";

describe("detectPaneHost", () => {
  it("prefers HC over inherited native hosts", () => {
    expect(detectPaneHost({ HC_TERMINAL_ID: "t-current", HERDR_ENV: "1", HERDR_PANE_ID: "stale", ORCA_TERMINAL_HANDLE: "stale-orca" })).toBe("herdr-app");
  });
  it("detects Orca from the terminal handle", () => {
    expect(detectPaneHost({ ORCA_TERMINAL_HANDLE: "term_1" })).toBe("orca");
  });

  it("detects Orca despite stale native Herdr variables", () => {
    expect(detectPaneHost({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", ORCA_TERMINAL_HANDLE: "term_1" })).toBe("orca");
  });

  it.each([
    {},
    { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" },
    { HERDR_ENV: "1" },
    { HERDR_PANE_ID: "w1:p1" },
    { HERDR_ENV: "0", HERDR_PANE_ID: "w1:p1" },
    { ORCA_TERMINAL_HANDLE: "" },
  ])("returns undefined without a usable host: %j", (env) => {
    expect(detectPaneHost(env)).toBeUndefined();
  });
});
