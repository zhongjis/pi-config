import { describe, expect, it } from "vitest";
import { detectPaneHost } from "../pane-host.js";

describe("detectPaneHost", () => {
  it("detects the current HC terminal", () => {
    expect(detectPaneHost({ HC_TERMINAL_ID: "t-current", HERDR_ENV: "1", HERDR_PANE_ID: "stale" })).toBe("herdr-app");
  });
  it.each([
    {},
    { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" },
    { HERDR_ENV: "1" },
    { HERDR_PANE_ID: "w1:p1" },
    { HERDR_ENV: "0", HERDR_PANE_ID: "w1:p1" },
    { HC_TERMINAL_ID: "" },
  ])("returns undefined without a usable host: %j", (env) => {
    expect(detectPaneHost(env)).toBeUndefined();
  });
});
