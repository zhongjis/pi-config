import { beforeEach, describe, expect, it } from "vitest";
import {
  getAgentConfig,
  getAllTypes,
  getAvailableTypes,
  isValidType,
  registerAgents,
  resolveType,
} from "./agent-types.js";
import type { AgentConfig } from "./types.js";

function agent(name: string, enabled = true): AgentConfig {
  return {
    name,
    description: `${name} description`,
    builtinToolNames: ["read"],
    extensions: true,
    skills: true,
    systemPrompt: `${name} prompt`,
    promptMode: "replace",
    enabled,
    source: "project",
  };
}

describe("agent type registry", () => {
  beforeEach(() => {
    registerAgents(new Map());
  });

  it("does not register extension-shipped default agents", () => {
    registerAgents(new Map());

    expect(getAllTypes()).toEqual([]);
    expect(getAvailableTypes()).toEqual([]);
    expect(resolveType("general-purpose")).toBeUndefined();
    expect(resolveType("Explore")).toBeUndefined();
    expect(resolveType("Plan")).toBeUndefined();
  });

  it("resolves custom agents case-insensitively and hides disabled agents from available types", () => {
    registerAgents(new Map([
      ["MyAgent", agent("MyAgent")],
      ["DisabledAgent", agent("DisabledAgent", false)],
    ]));

    expect(resolveType("myagent")).toBe("MyAgent");
    expect(getAgentConfig("MYAGENT")?.name).toBe("MyAgent");
    expect(getAllTypes()).toEqual(["MyAgent", "DisabledAgent"]);
    expect(getAvailableTypes()).toEqual(["MyAgent"]);
    expect(isValidType("disabledagent")).toBe(false);
  });
});
