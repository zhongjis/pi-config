import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPaneContext, renamePane, restorePane } from "../herdr.js";
import { parseHerdrAppPanes } from "../../lib/herdr-app.mjs";

beforeEach(() => {
  vi.stubEnv("HC_TERMINAL_ID", "t-current");
  vi.stubEnv("HERDR_ENV", "1");
  vi.stubEnv("HERDR_PANE_ID", "stale-native");
  vi.stubEnv("ORCA_TERMINAL_HANDLE", "stale-orca");
});
afterEach(() => vi.unstubAllEnvs());
const layout = (name: string, terminal = "t-current", app?: string) => JSON.stringify({ spaces: [{ tabs: [
  { id: "tab-focused", name: "manual focused", terminals: [{ terminal: "t-other", pane: "p-other" }] },
  { id: "tab-current", name, terminals: [{ terminal, pane: "p-current", app }] },
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
  it.each([layout("my manual name"), layout("[o] owned"), layout("1", "t-missing"), layout("Pi"), layout("Pi", "t-current", "claude"), "{}", "invalid", '{"spaces":[{"tabs":[null]}]}'])("does not mutate an unowned or missing association", async stdout => {
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
  it("claims the tab it renamed", async () => {
    const exec = vi.fn<ExtensionAPI["exec"]>().mockResolvedValue({ code: 0, stdout: layout("2"), stderr: "", killed: false });
    expect(await renamePane({ exec }, { host: "herdr-app", terminalId: "t-current" }, "fix deployment"))
      .toEqual({ host: "herdr-app", terminalId: "t-current", tabId: "tab-current", written: "[w] fix deployment", restore: "" });
  });
  it("takes over the agent-named tab Herdr's + menu creates and claims that name back", async () => {
    const exec = vi.fn<ExtensionAPI["exec"]>().mockResolvedValue({ code: 0, stdout: layout("Pi", "t-current", "pi"), stderr: "", killed: false });
    expect(await renamePane({ exec }, { host: "herdr-app", terminalId: "t-current" }, "fix deployment"))
      .toEqual({ host: "herdr-app", terminalId: "t-current", tabId: "tab-current", written: "[w] fix deployment", restore: "Pi" });
  });
  it("keeps the first claim's restore target across later renames", async () => {
    const exec = vi.fn<ExtensionAPI["exec"]>().mockResolvedValue({ code: 0, stdout: layout("[w] fix deployment", "t-current", "pi"), stderr: "", killed: false });
    const previous = { host: "herdr-app" as const, terminalId: "t-current", tabId: "tab-current", written: "[w] fix deployment", restore: "Pi" };
    expect(await renamePane({ exec }, { host: "herdr-app", terminalId: "t-current" }, "ship fix", previous))
      .toEqual({ ...previous, written: "[w] ship fix" });
  });
  const claim = { host: "herdr-app" as const, terminalId: "t-current", tabId: "tab-current", written: "[w] fix deployment", restore: "" };
  it("resets the tab to its number while it still shows its own title", async () => {
    const exec = vi.fn<ExtensionAPI["exec"]>().mockResolvedValue({ code: 0, stdout: layout(claim.written), stderr: "", killed: false });
    await restorePane({ exec }, claim);
    expect(exec.mock.calls.map(call => call[1])).toEqual([["ls"], ["do", "tab.rename", "--id", "tab-current", "--name", ""]]);
  });
  it("restores the agent name it took over", async () => {
    const exec = vi.fn<ExtensionAPI["exec"]>().mockResolvedValue({ code: 0, stdout: layout(claim.written, "t-current", "pi"), stderr: "", killed: false });
    await restorePane({ exec }, { ...claim, restore: "Pi" });
    expect(exec.mock.calls.map(call => call[1])).toEqual([["ls"], ["do", "tab.rename", "--id", "tab-current", "--name", "Pi"]]);
  });
  it.each(["my manual name", "[w] other title"])("leaves a renamed tab alone: %s", async name => {
    const exec = vi.fn<ExtensionAPI["exec"]>().mockResolvedValue({ code: 0, stdout: layout(name), stderr: "", killed: false });
    await restorePane({ exec }, claim);
    expect(exec.mock.calls.map(call => call[1])).toEqual([["ls"]]);
  });
});
