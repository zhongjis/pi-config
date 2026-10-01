import { describe, expect, it } from "vitest";
import { computeActiveToolNames, DEFAULT_BUILTIN_TOOL_NAMES, isToolReachable } from "../active-tools.js";

const exposures: Record<string, string> = {
  direct_tool: "direct",
  model_tool: "model-only",
  code_tool: "codemode",
  deferred_tool: "deferred",
  hidden_tool: "hidden",
};
const available = ["read", "bash", ...Object.keys(exposures), "agent"];
const base = {
  availableToolNames: available,
  builtinToolNames: ["read"],
  builtinToolUniverse: DEFAULT_BUILTIN_TOOL_NAMES,
  extensions: true as const,
  exposureOf: (name: string) => exposures[name],
};

describe("computeActiveToolNames exposure", () => {
  it.each([undefined, ["*"], ["direct_*", "model_*", "code_*", "deferred_*", "hidden_*"]])("never auto-activates codemode/deferred/hidden tools (extensionTools %j)", (extensionTools) => {
    expect(computeActiveToolNames({ ...base, extensionTools })).toEqual(["read", "direct_tool", "model_tool"]);
  });

  it("keeps allowlisted codemode/deferred tools only when already active", () => {
    expect(computeActiveToolNames({
      ...base,
      extensionTools: ["code_tool", "deferred_tool", "hidden_tool"],
      currentActiveToolNames: ["code_tool", "deferred_tool", "hidden_tool"],
    })).toEqual(["read", "code_tool", "deferred_tool"]);
  });

  it("drops active tools the allowlist does not reach", () => {
    expect(computeActiveToolNames({
      ...base,
      extensionTools: ["direct_tool"],
      currentActiveToolNames: ["bash", "code_tool", "agent"],
    })).toEqual(["read", "direct_tool"]);
  });

  it("treats every tool as direct without exposureOf", () => {
    const { exposureOf: _exposureOf, ...legacy } = base;
    expect(computeActiveToolNames(legacy)).toEqual(["read", ...Object.keys(exposures)]);
  });
});

describe("isToolReachable", () => {
  const policy = { builtinToolNames: ["read"], builtinToolUniverse: DEFAULT_BUILTIN_TOOL_NAMES, extensions: true as const };

  it("ignores exposure and active state", () => {
    expect(isToolReachable({ ...policy, extensionTools: ["code_*"] }, "code_tool")).toBe(true);
    expect(isToolReachable({ ...policy, extensionTools: ["direct_tool"] }, "code_tool")).toBe(false);
    expect(isToolReachable(policy, "hidden_tool")).toBe(true);
  });

  it("applies built-in selection, nesting, and extension switches", () => {
    expect(isToolReachable(policy, "read")).toBe(true);
    expect(isToolReachable(policy, "bash")).toBe(false);
    expect(isToolReachable({ ...policy, extensionTools: ["agent"] }, "agent")).toBe(false);
    expect(isToolReachable({ ...policy, extensionTools: ["agent"], allowNesting: true }, "agent")).toBe(true);
    expect(isToolReachable({ ...policy, isolated: true }, "direct_tool")).toBe(false);
    expect(isToolReachable({ ...policy, extensions: false }, "direct_tool")).toBe(false);
    expect(isToolReachable({ ...policy, extensionTools: false }, "direct_tool")).toBe(false);
  });
});
