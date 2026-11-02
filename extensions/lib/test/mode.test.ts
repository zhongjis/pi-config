import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createMockPi } from "../../../test/fixtures/mock-pi.js";
import { isTui, registerTuiCommand, registerTuiShortcut } from "../mode.js";

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

// ---------------------------------------------------------------------------
// registerTuiCommand / registerTuiShortcut
// ---------------------------------------------------------------------------

describe("registerTuiCommand / registerTuiShortcut", () => {
  const setup = () => {
    const mock = createMockPi();
    const pi = mock.pi as unknown as ExtensionAPI;
    registerTuiCommand(pi, "probe", { description: "probe", handler: async () => {} });
    registerTuiShortcut(pi, "alt+p", { handler: () => {} });
    return mock;
  };

  it("registers nothing before session_start", () => {
    const mock = setup();
    expect(mock.commands.size).toBe(0);
    expect(mock.shortcuts.size).toBe(0);
  });

  it.each(["rpc", "json", "print"])("registers nothing in %s sessions", async (mode) => {
    const mock = setup();
    await mock.fireLifecycle("session_start", { type: "session_start" }, { mode });
    expect(mock.commands.size).toBe(0);
    expect(mock.shortcuts.size).toBe(0);
  });

  it("registers the command and shortcut in tui sessions", async () => {
    const mock = setup();
    await mock.fireLifecycle("session_start", { type: "session_start" }, { mode: "tui" });
    expect([...mock.commands.keys()]).toEqual(["probe"]);
    expect([...mock.shortcuts.keys()]).toEqual(["alt+p"]);
  });
});
