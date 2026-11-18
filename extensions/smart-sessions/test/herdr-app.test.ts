import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearPaneLabel, getPaneContext, labelPane } from "../herdr.js";
import { parseHerdrAppPanes } from "../../lib/herdr-app.mjs";

beforeEach(() => {
  vi.stubEnv("HC_TERMINAL_ID", "t-current");
  vi.stubEnv("HERDR_ENV", "1");
  vi.stubEnv("HERDR_PANE_ID", "stale-native");
});
afterEach(() => vi.unstubAllEnvs());
const layout = (name: string, terminal = "t-current", app?: string) => JSON.stringify({ spaces: [{ tabs: [
  { id: "tab-focused", name: "manual focused", terminals: [{ terminal: "t-other", pane: "p-other" }] },
  { id: "tab-current", name, terminals: [{ terminal, pane: "p-current", app }] },
] }] });

describe("herdr-app layout parsing", () => {
  it.each([
    { id: "", terminal: "t-current", pane: "p-current" },
    { id: "tab-current", terminal: "", pane: "p-current" },
    { id: "tab-current", terminal: "t-current", pane: "" },
  ])("rejects empty identifiers: %j", ({ id, terminal, pane }) => {
    expect(parseHerdrAppPanes(JSON.stringify({ spaces: [{ tabs: [{ id, name: "1", terminals: [{ terminal, pane }] }] }] }))).toBeUndefined();
  });
  it("accepts an empty display name with usable identifiers", () => {
    expect(parseHerdrAppPanes(layout(""))?.[1]).toEqual({ terminalId: "t-current", paneId: "p-current", tabId: "tab-current", tabName: "" });
  });
  it("rejects malformed nested terminal data", () => {
    expect(parseHerdrAppPanes('{"spaces":[{"tabs":[{"id":"tab","name":"1","terminals":[{}]}]}]}')).toBeUndefined();
  });
});

describe("per-pane session label", () => {
  it("targets the current HC terminal inside herdr-app", () => {
    expect(getPaneContext()).toEqual({ host: "herdr-app", terminalId: "t-current" });
  });
  const context = { host: "herdr-app" as const, terminalId: "t-current" };
  it("labels only its own terminal and never renames the tab", async () => {
    const exec = vi.fn<ExtensionAPI["exec"]>().mockResolvedValue({ code: 0, stdout: "", stderr: "", killed: false, truncated: false });
    expect(await labelPane({ exec }, context, "fix deployment")).toBe(true);
    await clearPaneLabel({ exec }, context);
    expect(exec.mock.calls.map(call => [call[0], call[1]])).toEqual([
      ["hc", ["label", "t-current", "pi.session=[w] fix deployment"]],
      ["hc", ["label", "t-current", "pi.session="]],
    ]);
  });
  it("reports a refused label and skips an empty title", async () => {
    const exec = vi.fn<ExtensionAPI["exec"]>().mockResolvedValue({ code: 1, stdout: "", stderr: "no such terminal", killed: false, truncated: false });
    expect(await labelPane({ exec }, context, "fix deployment")).toBe(false);
    expect(await labelPane({ exec }, context, "")).toBe(false);
    expect(exec).toHaveBeenCalledTimes(1);
  });
});
