import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPaneContext, renamePane } from "../herdr.js";
import { parseHerdrAppPanes } from "../../lib/herdr-app.mjs";

beforeEach(() => {
  vi.stubEnv("HC_TERMINAL_ID", "t-current");
  vi.stubEnv("HERDR_ENV", "1");
  vi.stubEnv("HERDR_PANE_ID", "stale-native");
  vi.stubEnv("ORCA_TERMINAL_HANDLE", "stale-orca");
});
afterEach(() => vi.unstubAllEnvs());
const layout = (name: string, terminal = "t-current") => JSON.stringify({ spaces: [{ tabs: [
  { id: "tab-focused", name: "manual focused", terminals: [{ terminal: "t-other", pane: "p-other" }] },
  { id: "tab-current", name, terminals: [{ terminal, pane: "p-current" }] },
] }] });

describe("herdr-app tab titles", () => {
  it.each(["1", "12", "[w] old"])("renames only the exact terminal's eligible tab %s", async name => {
    const exec = vi.fn<ExtensionAPI["exec"]>().mockResolvedValue({ code: 0, stdout: layout(name), stderr: "", killed: false });
    const context = getPaneContext();
    expect(context).toEqual({ host: "herdr-app", terminalId: "t-current" });
    if (!context) throw new Error("Expected current app context");
    await renamePane({ exec }, context, "fix deployment");
    expect(exec.mock.calls.map(call => [call[0], call[1]])).toEqual([
      ["herdr-app", ["ls"]],
      ["herdr-app", ["do", "tab.rename", "--id", "tab-current", "--name", "[w] fix deployment"]],
    ]);
  });
  it.each([layout("my manual name"), layout("[o] owned"), layout("1", "t-missing"), "{}", "invalid", '{"spaces":[{"tabs":[null]}]}'])("does not mutate an unowned or missing association", async stdout => {
    const exec = vi.fn<ExtensionAPI["exec"]>().mockResolvedValue({ code: 0, stdout, stderr: "", killed: false });
    await renamePane({ exec }, { host: "herdr-app", terminalId: "t-current" }, "fix deployment");
    expect(exec.mock.calls.map(call => call[1])).toEqual([["ls"]]);
  });
  it.each([
    { id: "", terminal: "t-current", pane: "p-current" },
    { id: "tab-current", terminal: "", pane: "p-current" },
    { id: "tab-current", terminal: "t-current", pane: "" },
  ])("rejects empty identifiers without renaming or falling back: %j", async ({ id, terminal, pane }) => {
    const stdout = JSON.stringify({ spaces: [{ tabs: [{ id, name: "1", terminals: [{ terminal, pane }] }] }] });
    expect(parseHerdrAppPanes(stdout)).toBeUndefined();
    const exec = vi.fn<ExtensionAPI["exec"]>().mockResolvedValue({ code: 0, stdout, stderr: "", killed: false });
    await renamePane({ exec }, { host: "herdr-app", terminalId: "t-current" }, "fix deployment");
    expect(exec.mock.calls.map(call => [call[0], call[1]])).toEqual([["herdr-app", ["ls"]]]);
  });
  it("accepts an empty display name with usable identifiers", () => {
    expect(parseHerdrAppPanes(layout(""))?.[1]).toEqual({ terminalId: "t-current", paneId: "p-current", tabId: "tab-current", tabName: "" });
  });
  it("rejects malformed nested terminal data", () => {
    expect(parseHerdrAppPanes('{"spaces":[{"tabs":[{"id":"tab","name":"1","terminals":[{}]}]}]}')).toBeUndefined();
  });
});
