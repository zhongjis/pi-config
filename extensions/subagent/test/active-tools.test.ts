import { describe, expect, it } from "vitest";
import { computeActiveToolNames } from "../src/active-tools.js";

const builtinToolUniverse = ["read", "bash", "edit", "write", "grep", "find", "ls"];

type Policy = Partial<Parameters<typeof computeActiveToolNames>[0]>;

function compute(policy: Policy = {}) {
  return computeActiveToolNames({
    availableToolNames: ["read", "bash", "web_search", "mcp_lookup", "Agent", "get_subagent_result", "steer_subagent"],
    builtinToolNames: ["read", "bash"],
    builtinToolUniverse,
    extensions: true,
    ...policy,
  });
}

describe("computeActiveToolNames", () => {
  it("keeps selected built-ins and all available extension tools when extension_tools is omitted and extensions are enabled", () => {
    expect(compute()).toEqual(["read", "bash", "web_search", "mcp_lookup"]);
  });

  it("treats extension_tools: none as no extension tools", () => {
    expect(compute({ extensionTools: false })).toEqual(["read", "bash"]);
    expect(compute({ extensionTools: [] })).toEqual(["read", "bash"]);
  });

  it("matches extension_tools CSV values exactly", () => {
    expect(compute({ extensionTools: ["web_search"] })).toEqual(["read", "bash", "web_search"]);
    expect(compute({ extensionTools: ["web"] })).toEqual(["read", "bash"]);
    expect(compute({ extensionTools: ["search"] })).toEqual(["read", "bash"]);
  });

  it("does not let extension_tools select built-in tools", () => {
    expect(compute({ builtinToolNames: [], extensionTools: ["read", "web_search"] })).toEqual(["web_search"]);
  });

  it("disables extension tools when extensions are false regardless of extension_tools", () => {
    expect(compute({ extensions: false })).toEqual(["read", "bash"]);
    expect(compute({ extensions: false, extensionTools: ["web_search"] })).toEqual(["read", "bash"]);
  });

  it("disables extension tools when isolated is true regardless of extensions or extension_tools", () => {
    expect(compute({ isolated: true })).toEqual(["read", "bash"]);
    expect(compute({ isolated: true, extensionTools: ["web_search"] })).toEqual(["read", "bash"]);
  });

  it("treats extensions CSV as enabled source scope, not a fuzzy tool-name filter", () => {
    expect(compute({ extensions: ["web"] })).toEqual(["read", "bash", "web_search", "mcp_lookup"]);
  });

  it("allows extension_tools exact filtering when extensions CSV enables extension tools", () => {
    expect(compute({ extensions: ["web"], extensionTools: ["mcp_lookup"] })).toEqual(["read", "bash", "mcp_lookup"]);
  });

  it("ignores non-built-in names in builtinToolNames", () => {
    expect(compute({
      builtinToolNames: ["read", "web_search"],
      extensionTools: false,
    })).toEqual(["read"]);
  });

  it("removes nested subagent tools unless allow_nesting is true", () => {
    expect(compute({ extensionTools: ["Agent", "get_subagent_result", "steer_subagent"] })).toEqual(["read", "bash"]);
    expect(compute({
      allowNesting: true,
      extensionTools: ["Agent", "get_subagent_result", "steer_subagent"],
    })).toEqual(["read", "bash", "Agent", "get_subagent_result", "steer_subagent"]);
  });

  it("allows nested subagent tools with allow_nesting when otherwise selected by default extension tools", () => {
    expect(compute({ allowNesting: true })).toEqual([
      "read",
      "bash",
      "web_search",
      "mcp_lookup",
      "Agent",
      "get_subagent_result",
      "steer_subagent",
    ]);
  });
});
